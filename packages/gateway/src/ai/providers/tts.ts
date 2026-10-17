import {
  CARTESIA_DEFAULT_VERSION,
  CARTESIA_MODEL,
  CARTESIA_RAW_SAMPLE_RATES,
  CARTESIA_TTS_URL,
  CARTESIA_VOICES,
  DEEPGRAM_AU_SPEAK_URL,
} from '../catalog.js';
import { assertEnginePcm, AudioFormat, describeFormat, unwrapWav } from '../audio.js';
import { FetchLike, requestWithRetry } from './http.js';
import { AiProviderError, baseLanguage, TtsProvider } from './types.js';

interface CommonOptions {
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The synthesized audio must be whole 16-bit samples; anything else is not PCM we can play. */
function finishPcm(provider: string, data: Buffer): Buffer {
  if (data.length === 0) throw new AiProviderError(provider, 'tts', 'returned no audio');
  if (data.length % 2 !== 0) throw new AiProviderError(provider, 'tts', 'returned an odd number of bytes for 16-bit PCM');
  return data;
}

/**
 * Cartesia /tts/bytes with a raw pcm_s16le container at the exact sample rate the sink wants, so no
 * resampling is needed. Request shape and the allowed rates are from Cartesia's API reference.
 */
export class CartesiaTts implements TtsProvider {
  readonly name = 'cartesia';

  constructor(
    private readonly options: CommonOptions & { voice: string; language: string; version?: string; model?: string }
  ) {}

  async synthesize(text: string, format: AudioFormat, signal: AbortSignal): Promise<Buffer> {
    assertEnginePcm(format);
    const o = this.options;
    if (!CARTESIA_RAW_SAMPLE_RATES.includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'tts', `Cartesia cannot produce raw ${format.sampleRate} Hz audio`);
    }
    const voiceId = CARTESIA_VOICES[o.voice.toLowerCase()] ?? o.voice;
    const response = await requestWithRetry(
      CARTESIA_TTS_URL,
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
    return finishPcm(this.name, Buffer.from(await response.arrayBuffer()));
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
    assertEnginePcm(format);
    const o = this.options;
    const url = new URL(o.baseUrl ?? DEEPGRAM_AU_SPEAK_URL);
    url.searchParams.set('model', o.voice);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(format.sampleRate));
    url.searchParams.set('container', 'none');

    const response = await requestWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: { Authorization: `Token ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      { provider: this.name, stage: 'tts', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
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
}
