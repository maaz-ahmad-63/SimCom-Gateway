import { AiConfig, readProviderKey } from '../ai/config.js';
import { toWav } from '../ai/audio.js';
import { FetchLike, redactSecrets } from '../ai/providers/http.js';
import { AiProviderError, TtsProvider } from '../ai/providers/types.js';
import { activeRegistry } from '../ai/registry/active.js';
import { CreateContext, protocolById, TtsProtocol } from '../ai/registry/protocols.js';
import { IVR_ASSET_LIMITS, checkWav } from './assets.js';
import { IvrError } from './errors.js';

/**
 * Generate an announcement from text, for the dashboard's audio library.
 *
 * It reuses the model registry and the protocol clients the AI agent speaks through, but it never touches a call: the provider client is
 * built here (not through the AI runtime's factory, whose per-provider limiter is shared with live replies, so a generation could make a
 * caller wait), nothing is written to the audio port, and the result is only returned. Storing it is the existing upload route's job,
 * which checks the file again and keeps the content-hash behaviour.
 */

export const TTS_GENERATE_LIMITS = {
  maxChars: 1000,
  /** Wall-clock cap for one generation, on top of the provider's own timeout. */
  timeoutMs: 60_000,
} as const;

type Env = Record<string, string | undefined>;

export interface TtsGeneratorDeps {
  /** The AI configuration in force: its language and timeouts are used; its TTS selection is replaced for the request. */
  config: () => AiConfig;
  /** Provider credentials: the encrypted store first, then the environment (the AI settings service's effective environment). */
  env: () => Env;
  fetchImpl?: FetchLike;
  /** The rate the IVR audio library requires (8000 on this hardware). */
  sampleRate: () => number;
  /** Test seam: replaces the provider client. */
  createProvider?: (selection: { key: string; voice: string; model: string | null }) => TtsProvider;
}

export interface TtsVoiceChoice {
  name: string;
  label: string;
}

export interface TtsModelChoice {
  key: string;
  label: string;
  provider: string;
  protocol: string | null;
  /** The provider's own model ids that can be picked (empty: the voice decides). */
  models: string[];
  defaultModel: string | null;
  defaultVoice: string;
  voices: TtsVoiceChoice[];
  /** The raw rates the provider documents; the gateway rate is requested directly when listed, otherwise converted down from one. */
  sampleRates: number[];
  available: boolean;
  /** Why it cannot be used, in a sentence; null when available. */
  unavailableReason: string | null;
  /** The model the AI agent currently speaks with. */
  current: boolean;
}

export interface TtsOptionsView {
  sampleRate: number;
  maxChars: number;
  models: TtsModelChoice[];
}

export interface GenerateInput {
  text?: unknown;
  /** The registry key of the TTS model. */
  model?: unknown;
  /** The provider's own model id, when the entry offers several. */
  providerModel?: unknown;
  voice?: unknown;
  confirmBilling?: unknown;
}

export interface GeneratedAudio {
  wav: Buffer;
  info: {
    model: string;
    provider: string;
    providerModel: string | null;
    voice: string;
    chars: number;
    /** What the provider was asked for, and whether it was converted to the IVR rate afterwards. */
    sourceSampleRate: number;
    converted: boolean;
    sampleRate: number;
    channels: 1;
    bitsPerSample: 16;
    bytes: number;
    durationMs: number;
    generationMs: number;
  };
}

const bad = (message: string, path: string, status = 422): IvrError => new IvrError('invalid_tts_request', message, status, [{ path, message }]);

/**
 * Low-pass and downsample 16-bit mono PCM (little-endian) from `fromRate` to `toRate` with a Blackman-windowed sinc, the cutoff at the
 * new Nyquist so nothing folds back as noise. Used only when a provider cannot return the gateway rate itself. Upsampling is not offered.
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return Buffer.from(pcm);
  if (toRate > fromRate) throw new Error(`cannot raise ${fromRate} Hz audio to ${toRate} Hz`);
  const inCount = Math.floor(pcm.length / 2);
  const ratio = fromRate / toRate;
  const outCount = Math.floor(inCount / ratio);
  const cutoff = 0.5 / ratio; // cycles per input sample
  const half = Math.ceil(12 * ratio);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    const centre = i * ratio;
    const first = Math.max(0, Math.ceil(centre - half));
    const last = Math.min(inCount - 1, Math.floor(centre + half));
    let acc = 0;
    let weights = 0;
    for (let n = first; n <= last; n++) {
      const t = n - centre;
      const x = 2 * Math.PI * cutoff * t;
      const sinc = t === 0 ? 1 : Math.sin(x) / x;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
      const k = sinc * w;
      acc += pcm.readInt16LE(n * 2) * k;
      weights += k;
    }
    const v = weights === 0 ? 0 : Math.round(acc / weights);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

/** The raw rate to ask a provider for: the IVR rate when it documents it, else the smallest higher rate it does (a whole multiple first). */
export function chooseSourceRate(supported: number[], target: number): number | null {
  if (supported.includes(target)) return target;
  const higher = supported.filter((r) => r > target).sort((a, b) => a - b);
  return higher.find((r) => r % target === 0) ?? higher[0] ?? null;
}

export class TtsGenerator {
  private busy = false;

  constructor(private readonly deps: TtsGeneratorDeps) {}

  /** The TTS models in the registry, with whether each could be used right now. Never includes a key, only whether one is set. */
  options(): TtsOptionsView {
    const registry = activeRegistry();
    const env = this.deps.env();
    const current = this.deps.config().tts.key;
    const models = registry.ttsKeys().map((key): TtsModelChoice => {
      const m = registry.tts(key)!;
      const reason = this.unavailableReason(m, env);
      return {
        key,
        label: m.label,
        provider: m.providerName,
        protocol: m.protocol,
        models: m.models,
        defaultModel: m.model,
        defaultVoice: m.defaultVoice,
        voices: m.voices.map((v) => ({ name: v.name, label: v.label ?? v.name })),
        sampleRates: m.sampleRates,
        available: reason === null,
        unavailableReason: reason,
        current: key === current,
      };
    });
    return { sampleRate: this.deps.sampleRate(), maxChars: TTS_GENERATE_LIMITS.maxChars, models };
  }

  private unavailableReason(m: NonNullable<ReturnType<ReturnType<typeof activeRegistry>['tts']>>, env: Env): string | null {
    if (!m.implemented) return m.unavailableReason ?? 'This voice model is not ported to the gateway yet.';
    if (m.disabled) return 'It is switched off in the Model Hub.';
    if (!m.keyEnv || !readProviderKey(env, m.keyEnv)) return `The ${m.providerName} API key is not set (${m.keyEnv ?? 'no credential'}).`;
    const target = this.deps.sampleRate();
    if (chooseSourceRate(m.sampleRates, target) === null) return `${m.providerName} cannot produce audio at ${target} Hz or higher, so it cannot be used here.`;
    return null;
  }

  async generate(input: GenerateInput): Promise<GeneratedAudio> {
    if (input.confirmBilling !== true) {
      throw bad('Generating audio sends the text to the provider and may be billed; confirm to continue.', 'confirmBilling', 400);
    }
    const text = typeof input.text === 'string' ? input.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
    if (text.length === 0) throw bad('Enter the announcement text.', 'text');
    if (text.length > TTS_GENERATE_LIMITS.maxChars) throw bad(`The text is ${text.length} characters; the limit is ${TTS_GENERATE_LIMITS.maxChars}. Split it into shorter announcements.`, 'text');
    const key = typeof input.model === 'string' ? input.model.trim() : '';
    if (!key) throw bad('Choose a voice model.', 'model');
    const registry = activeRegistry();
    const entry = registry.tts(key);
    if (!entry) throw bad(`'${key}' is not a voice model in the Model Hub.`, 'model');

    const env = this.deps.env();
    const reason = this.unavailableReason(entry, env);
    if (reason) throw new IvrError('tts_unavailable', `${entry.label} cannot be used: ${reason}`, 409, [{ path: 'model', message: reason }]);

    const voice = (typeof input.voice === 'string' ? input.voice.trim() : '') || entry.defaultVoice;
    if (!voice) throw bad('Choose a voice.', 'voice');
    if (voice.length > 120) throw bad('The voice name is too long.', 'voice');
    const providerModelRaw = typeof input.providerModel === 'string' ? input.providerModel.trim() : '';
    let providerModel: string | null = null;
    if (providerModelRaw) {
      if (entry.models.length === 0 || !entry.models.includes(providerModelRaw)) {
        throw bad(`'${providerModelRaw}' is not a model of ${entry.label}${entry.models.length ? ` (choose one of: ${entry.models.join(', ')})` : ''}.`, 'providerModel');
      }
      providerModel = providerModelRaw;
    }

    const target = this.deps.sampleRate();
    const sourceRate = chooseSourceRate(entry.sampleRates, target)!;
    if (this.busy) throw new IvrError('tts_busy', 'Another audio generation is still running. Wait for it to finish.', 429);
    this.busy = true;
    const started = performance.now();
    try {
      const provider = this.build(key, voice, providerModel, env);
      const signal = AbortSignal.timeout(TTS_GENERATE_LIMITS.timeoutMs);
      let pcm: Buffer;
      try {
        pcm = await provider.synthesize(text, { sampleRate: sourceRate, channels: 1, bitDepth: 16, endianness: 'little-endian' }, signal);
      } catch (error) {
        throw this.failure(entry.providerName, error);
      }
      return this.finish({ pcm, sourceRate, target, text, key, entry, providerModel, voice, started });
    } finally {
      this.busy = false;
    }
  }

  private build(key: string, voice: string, model: string | null, env: Env): TtsProvider {
    const selection = { key, voice, model };
    if (this.deps.createProvider) return this.deps.createProvider(selection);
    const entry = activeRegistry().tts(key)!;
    const protocol = protocolById(entry.protocol) as TtsProtocol | undefined;
    if (!protocol || protocol.stage !== 'tts') throw new IvrError('tts_unavailable', `${entry.label} has no usable protocol.`, 409);
    const base = this.deps.config();
    const ctx: CreateContext = {
      config: { ...base, tts: selection },
      env,
      fetchImpl: this.deps.fetchImpl ?? ((url, init) => fetch(url, init)),
      maxRetries: 1,
      apiKey: readProviderKey(env, entry.keyEnv!)!,
      endpoint: entry.endpoint ?? undefined,
    };
    return protocol.create(ctx, entry);
  }

  private failure(provider: string, error: unknown): IvrError {
    if (error instanceof IvrError) return error;
    const text = redactSecrets(error instanceof Error ? error.message : String(error));
    const timedOut = (error as Error)?.name === 'TimeoutError' || (error instanceof AiProviderError && error.details.timedOut === true);
    const detail = timedOut ? `${provider} did not answer in time` : text;
    return new IvrError('tts_failed', `${provider} could not generate the audio: ${detail}`, 502, [{ path: 'model', message: detail }]);
  }

  private finish(r: {
    pcm: Buffer;
    sourceRate: number;
    target: number;
    text: string;
    key: string;
    entry: NonNullable<ReturnType<ReturnType<typeof activeRegistry>['tts']>>;
    providerModel: string | null;
    voice: string;
    started: number;
  }): GeneratedAudio {
    const invalid = (message: string) => new IvrError('invalid_asset', `The provider's audio cannot be used: ${message}.`, 502, [{ path: 'audio', message }]);
    if (r.pcm.length === 0) throw invalid('it was empty');
    if (r.pcm.length % 2 !== 0) throw invalid('it is not whole 16-bit samples');
    let peak = 0;
    for (let i = 0; i + 1 < r.pcm.length; i += 2) peak = Math.max(peak, Math.abs(r.pcm.readInt16LE(i)));
    if (peak < 8) throw invalid('it is silent');

    const converted = r.sourceRate !== r.target;
    const samples = converted ? resamplePcm16(r.pcm, r.sourceRate, r.target) : r.pcm;
    const wav = toWav(samples, { sampleRate: r.target, channels: 1, bitDepth: 16, endianness: 'little-endian' });
    // The same check an upload gets, so what is offered for download or upload is exactly what the library would accept.
    const { issues, meta } = checkWav(wav, r.target);
    if (issues.length > 0 || !meta) {
      const tooLong = wav.length > IVR_ASSET_LIMITS.maxBytes || meta?.durationMs! > IVR_ASSET_LIMITS.maxDurationMs;
      throw invalid(`${issues.join('; ')}${tooLong ? ' (use a shorter text)' : ''}`);
    }
    return {
      wav,
      info: {
        model: r.key,
        provider: r.entry.providerName,
        providerModel: r.providerModel ?? r.entry.model,
        voice: r.voice,
        chars: r.text.length,
        sourceSampleRate: r.sourceRate,
        converted,
        sampleRate: r.target,
        channels: 1,
        bitsPerSample: 16,
        bytes: wav.length,
        durationMs: meta.durationMs,
        generationMs: Math.round(performance.now() - r.started),
      },
    };
  }
}
