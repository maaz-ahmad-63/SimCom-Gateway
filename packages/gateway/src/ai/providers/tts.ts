import {
  CARTESIA_DEFAULT_VERSION,
  CARTESIA_MODEL,
  CARTESIA_RAW_SAMPLE_RATES,
  CARTESIA_TTS_URL,
  CARTESIA_VOICES,
  DEEPGRAM_AU_SPEAK_URL,
  INWORLD_TTS_URL,
  MURF_API_URL,
  SONIOX_TTS_URL,
  TTS_PCM_RATES,
  ELEVENLABS_API_BASE,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_PCM_RATES,
} from '../catalog.js';
import { assertEnginePcm, AudioFormat, describeFormat, unwrapWav } from '../audio.js';
import { FetchLike, redactSecrets, requestWithRetry } from './http.js';
import { AiProviderError, baseLanguage, TtsProvider } from './types.js';

interface CommonOptions {
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The synthesized audio must be whole 16-bit samples; anything else is not PCM we can play. */
export function finishPcm(provider: string, data: Buffer): Buffer {
  if (data.length === 0) throw new AiProviderError(provider, 'tts', 'returned no audio');
  if (data.length % 2 !== 0) throw new AiProviderError(provider, 'tts', 'returned an odd number of bytes for 16-bit PCM');
  return data;
}

/**
 * The audio of an HTTP response as it arrives: whole 16-bit samples only (an odd trailing byte is carried into the
 * next chunk). Fails if nothing arrives or the stream ends on a half sample. A caller abort becomes a "cancelled"
 * provider error, like the buffered path; anything else that interrupts the stream is a provider failure.
 */
export async function* readPcmStream(provider: string, response: Response, signal: AbortSignal): AsyncGenerator<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new AiProviderError(provider, 'tts', 'returned no audio');
  let carry: Buffer | null = null;
  let total = 0;
  try {
    for (;;) {
      let read: { done: boolean; value?: Uint8Array };
      try {
        read = await reader.read();
      } catch (error) {
        if (signal.aborted) throw new AiProviderError(provider, 'tts', 'cancelled', { aborted: true });
        throw new AiProviderError(provider, 'tts', `audio stream interrupted: ${(error as Error).message ?? 'unknown'}`, { retryable: true });
      }
      if (read.done) break;
      if (!read.value || read.value.length === 0) continue;
      let chunk = Buffer.from(read.value);
      if (carry) {
        chunk = Buffer.concat([carry, chunk]);
        carry = null;
      }
      if (chunk.length % 2 === 1) {
        carry = chunk.subarray(chunk.length - 1);
        chunk = chunk.subarray(0, chunk.length - 1);
      }
      if (chunk.length === 0) continue;
      total += chunk.length;
      yield chunk;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (total === 0) throw new AiProviderError(provider, 'tts', 'returned no audio');
  if (carry) throw new AiProviderError(provider, 'tts', 'returned an odd number of bytes for 16-bit PCM');
}

/**
 * Cartesia /tts/bytes with a raw pcm_s16le container at the exact sample rate the sink wants, so no
 * resampling is needed. Request shape and the allowed rates are from Cartesia's API reference.
 */
export class CartesiaTts implements TtsProvider {
  readonly name = 'cartesia';

  constructor(
    private readonly options: CommonOptions & { voice: string; language: string; version?: string; model?: string; voices?: Record<string, string>; url?: string }
  ) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request(text, format, signal);
    return finishPcm(this.name, Buffer.from(await response.arrayBuffer()));
  }

  async *synthesizeStream(text: string, format: AudioFormat, signal: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.request(text, format, signal);
    yield* readPcmStream(this.name, response, signal);
  }

  private async request(text: string, format: AudioFormat, signal: AbortSignal): Promise<Response> {
    assertEnginePcm(format);
    const o = this.options;
    if (!CARTESIA_RAW_SAMPLE_RATES.includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'tts', `Cartesia cannot produce raw ${format.sampleRate} Hz audio`);
    }
    const voiceId = (o.voices ?? CARTESIA_VOICES)[o.voice.toLowerCase()] ?? o.voice;
    const response = await requestWithRetry(
      o.url ?? CARTESIA_TTS_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${o.apiKey}`,
          'Cartesia-Version': o.version ?? CARTESIA_DEFAULT_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: o.model ?? CARTESIA_MODEL,
          transcript: text,
          voice: { id: voiceId },
          language: baseLanguage(o.language),
          generation_config: { speed: 1.0 },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: format.sampleRate },
        }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
    return response;
  }
}

/**
 * Deepgram Aura over the v1 REST endpoint (AU region, as in deepgram_tts.py). Deepgram's reference
 * does not list the allowed encoding/sample-rate values, so the response is validated rather than
 * trusted: a WAV reply must declare exactly the requested format, otherwise it is rejected.
 */
export class DeepgramTts implements TtsProvider {
  readonly name = 'deepgram';

  constructor(private readonly options: CommonOptions & { voice: string; baseUrl?: string }) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request(text, format, signal);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF') {
      try {
        return finishPcm(this.name, unwrapWav(data, format));
      } catch (error) {
        throw new AiProviderError(this.name, 'tts', `${(error as Error).message}; wanted ${describeFormat(format)}`);
      }
    }
    return finishPcm(this.name, data);
  }

  /**
   * Raw linear16 is requested (container=none), so the body is PCM from the first byte and playback can start
   * immediately. If a WAV container comes back anyway, the whole reply is read and validated as before.
   */
  async *synthesizeStream(text: string, format: AudioFormat, signal: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.request(text, format, signal);
    let first = true;
    let wav: Buffer[] | null = null;
    for await (const chunk of readPcmStream(this.name, response, signal)) {
      if (first) {
        first = false;
        if (chunk.length >= 12 && chunk.toString('ascii', 0, 4) === 'RIFF') wav = [];
      }
      if (wav) wav.push(chunk);
      else yield chunk;
    }
    if (wav) {
      try {
        yield finishPcm(this.name, unwrapWav(Buffer.concat(wav), format));
      } catch (error) {
        throw new AiProviderError(this.name, 'tts', `${(error as Error).message}; wanted ${describeFormat(format)}`);
      }
    }
  }

  private async request(text: string, format: AudioFormat, signal: AbortSignal): Promise<Response> {
    assertEnginePcm(format);
    const o = this.options;
    const url = new URL(o.baseUrl ?? DEEPGRAM_AU_SPEAK_URL);
    url.searchParams.set('model', o.voice);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(format.sampleRate));
    url.searchParams.set('container', 'none');

    return requestWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: { Authorization: `Token ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
  }
}

/**
 * ElevenLabs text-to-speech. Raw signed 16-bit little-endian mono PCM is requested at exactly the gateway rate
 * (output_format=pcm_<rate>), so nothing is resampled; a rate ElevenLabs does not list is refused before any request.
 * The streaming endpoint returns the same audio as it is generated. The voice must be a voice id of the account.
 */
export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';

  constructor(private readonly options: CommonOptions & { voice: string; model?: string; baseUrl?: string }) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request(text, format, signal, false);
    return finishPcm(this.name, Buffer.from(await response.arrayBuffer()));
  }

  async *synthesizeStream(text: string, format: AudioFormat, signal: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.request(text, format, signal, true);
    yield* readPcmStream(this.name, response, signal);
  }

  private async request(text: string, format: AudioFormat, signal: AbortSignal, stream: boolean): Promise<Response> {
    assertEnginePcm(format);
    const o = this.options;
    if (!ELEVENLABS_PCM_RATES.includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'tts', `ElevenLabs cannot produce raw ${format.sampleRate} Hz audio (supports ${ELEVENLABS_PCM_RATES.join(', ')})`);
    }
    if (!/^[A-Za-z0-9]{10,40}$/.test(o.voice)) {
      throw new AiProviderError(this.name, 'tts', 'the voice must be an ElevenLabs voice id (letters and digits) from your account');
    }
    const url = new URL(`${(o.baseUrl ?? ELEVENLABS_API_BASE).replace(/\/+$/, '')}/v1/text-to-speech/${o.voice}${stream ? '/stream' : ''}`);
    url.searchParams.set('output_format', `pcm_${format.sampleRate}`);
    return requestWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: { 'xi-api-key': o.apiKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
        body: JSON.stringify({ text, model_id: o.model ?? ELEVENLABS_DEFAULT_MODEL }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
  }
}

// ---------------------------------------------------------------------------------------------------- Murf

/**
 * Murf Falcon streaming (https://murf.ai/api/docs/api-reference/text-to-speech/stream): POST /v1/speech/stream, key in the
 * `api-key` header, { text, voiceId, model, format: "PCM", sampleRate, channelType: "MONO" }. Falcon is the only model the
 * documentation lists (falcon-2.1). The voice id comes from the account's voice list (GET /v1/speech/voices).
 */
export class MurfTts implements TtsProvider {
  readonly name = 'murf';

  constructor(private readonly options: CommonOptions & { voice: string; rateKey: string; model?: string; url?: string; locale?: string; sampleRates?: number[] }) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const data = Buffer.from(await (await this.request(text, format, signal)).arrayBuffer());
    return finishPcm(this.name, this.unwrap(data, format));
  }

  async *synthesizeStream(text: string, format: AudioFormat, signal: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.request(text, format, signal);
    let first = true;
    let wav: Buffer[] | null = null;
    for await (const chunk of readPcmStream(this.name, response, signal)) {
      if (first) {
        first = false;
        if (chunk.length >= 12 && chunk.toString('ascii', 0, 4) === 'RIFF') wav = [];
      }
      if (wav) wav.push(chunk);
      else yield chunk;
    }
    if (wav) yield finishPcm(this.name, this.unwrap(Buffer.concat(wav), format));
  }

  /** The documentation does not describe the body of the stream response, so a WAV container is accepted if one comes back. */
  private unwrap(data: Buffer, format: AudioFormat): Buffer {
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF') {
      try {
        return unwrapWav(data, format);
      } catch (error) {
        throw new AiProviderError(this.name, 'tts', `${(error as Error).message}; wanted ${describeFormat(format)}`);
      }
    }
    return data;
  }

  private async request(text: string, format: AudioFormat, signal: AbortSignal): Promise<Response> {
    assertEnginePcm(format);
    const o = this.options;
    const rates = o.sampleRates?.length ? o.sampleRates : (TTS_PCM_RATES[o.rateKey] ?? []);
    if (!rates.includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'tts', `Murf cannot produce raw ${format.sampleRate} Hz audio (supports ${rates.join(', ')})`);
    }
    return requestWithRetry(
      o.url ?? MURF_API_URL,
      {
        method: 'POST',
        headers: { 'api-key': o.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voiceId: o.voice,
          model: o.model ?? 'falcon-2.1',
          format: 'PCM',
          sampleRate: format.sampleRate,
          channelType: 'MONO',
          ...(o.locale ? { locale: o.locale } : {}),
        }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
  }
}

// ---------------------------------------------------------------------------------------------------- Inworld

/**
 * Inworld streaming synthesis (https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech-stream):
 * POST /tts/v1/voice:stream, `Authorization: Basic <key>` (the Portal's Base64 credential, used as given), body { text,
 * voiceId, modelId, audioConfig: { audioEncoding: "PCM", sampleRateHertz } }. The reply is newline-delimited JSON; each line
 * holds base64 audio in result.audioContent, and an error can arrive mid-stream even after HTTP 200. PCM has no header.
 */
export class InworldTts implements TtsProvider {
  readonly name = 'inworld';

  constructor(private readonly options: CommonOptions & { voice: string; model?: string; url?: string; sampleRates?: number[] }) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of this.synthesizeStream(text, format, signal)) parts.push(chunk);
    return finishPcm(this.name, Buffer.concat(parts));
  }

  async *synthesizeStream(text: string, format: AudioFormat, signal: AbortSignal): AsyncGenerator<Buffer> {
    assertEnginePcm(format);
    const o = this.options;
    const rates = o.sampleRates?.length ? o.sampleRates : TTS_PCM_RATES.inworld;
    if (!rates.includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'tts', `Inworld is asked only for ${rates.join(', ')} Hz here; ${format.sampleRate} Hz is not one of them`);
    }
    const response = await requestWithRetry(
      o.url ?? INWORLD_TTS_URL,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId: o.voice, modelId: o.model ?? 'inworld-tts-2', audioConfig: { audioEncoding: 'PCM', sampleRateHertz: format.sampleRate } }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderError(this.name, 'tts', 'returned no audio');
    const decoder = new TextDecoder();
    let pending = '';
    let carry: Buffer | null = null;
    let total = 0;
    const lines = function* (buffer: string, flush: boolean): Generator<string> {
      const parts = buffer.split('\n');
      const rest = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) yield line;
      if (flush && rest.trim()) yield rest;
    };
    const audioOf = (line: string): Buffer | null => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new AiProviderError(this.name, 'tts', 'returned a line that is not JSON');
      }
      if (parsed?.error) {
        const message = typeof parsed.error?.message === 'string' ? parsed.error.message : 'the stream reported an error';
        throw new AiProviderError(this.name, 'tts', redactSecrets(message).slice(0, 200));
      }
      const b64 = parsed?.result?.audioContent;
      return typeof b64 === 'string' && b64.length > 0 ? Buffer.from(b64, 'base64') : null;
    };
    const whole = (audio: Buffer): Buffer | null => {
      let chunk = carry ? Buffer.concat([carry, audio]) : audio;
      carry = null;
      if (chunk.length % 2 === 1) {
        carry = chunk.subarray(chunk.length - 1);
        chunk = chunk.subarray(0, chunk.length - 1);
      }
      return chunk.length > 0 ? chunk : null;
    };
    try {
      for (;;) {
        let read: { done: boolean; value?: Uint8Array };
        try {
          read = await reader.read();
        } catch (error) {
          if (signal.aborted) throw new AiProviderError(this.name, 'tts', 'cancelled', { aborted: true });
          throw new AiProviderError(this.name, 'tts', `audio stream interrupted: ${(error as Error).message ?? 'unknown'}`, { retryable: true });
        }
        if (read.value) pending += decoder.decode(read.value, { stream: !read.done });
        for (const line of lines(pending, read.done)) {
          const audio = audioOf(line);
          const out = audio ? whole(audio) : null;
          if (out) {
            total += out.length;
            yield out;
          }
        }
        pending = pending.slice(pending.lastIndexOf('\n') + 1);
        if (read.done) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    if (total === 0) throw new AiProviderError(this.name, 'tts', 'returned no audio');
    if (carry) throw new AiProviderError(this.name, 'tts', 'returned an odd number of bytes for 16-bit PCM');
  }
}

// ---------------------------------------------------------------------------------------------------- Soniox TTS

/**
 * Soniox text-to-speech REST (https://soniox.com/docs/tts/rest-api/generate-speech): POST https://tts-rt.soniox.com/tts, Bearer
 * key, { model: "tts-rt-v2", language, voice, audio_format: "pcm_s16le", sample_rate, text }; the body is raw audio. Errors
 * before streaming are JSON with error_type; the status is reported, the body is never echoed beyond a short redacted snippet.
 */
export class SonioxTts implements TtsProvider {
  readonly name = 'soniox';

  constructor(private readonly options: CommonOptions & { voice: string; language: string; model?: string; url?: string; sampleRates?: number[] }) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request(text, format, signal);
    return finishPcm(this.name, Buffer.from(await response.arrayBuffer()));
  }

  async *synthesizeStream(text: string, format: AudioFormat, signal: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.request(text, format, signal);
    yield* readPcmStream(this.name, response, signal);
  }

  private async request(text: string, format: AudioFormat, signal: AbortSignal): Promise<Response> {
    assertEnginePcm(format);
    const o = this.options;
    const rates = o.sampleRates?.length ? o.sampleRates : TTS_PCM_RATES.soniox;
    if (!rates.includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'tts', `Soniox cannot produce raw ${format.sampleRate} Hz audio (supports ${rates.join(', ')})`);
    }
    return requestWithRetry(
      o.url ?? SONIOX_TTS_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: o.model ?? 'tts-rt-v2', language: baseLanguage(o.language), voice: o.voice, audio_format: 'pcm_s16le', sample_rate: format.sampleRate, text }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
  }
}
