import {
  DEEPGRAM_AU_LISTEN_URL,
  DEEPGRAM_GLOBAL_LISTEN_URL,
  GROQ_TRANSCRIPTIONS_URL,
} from '../catalog.js';
import { AudioFormat, checkPcmBuffer, toWav } from '../audio.js';
import { FetchLike, requestWithRetry } from './http.js';
import { AiProviderError, baseLanguage, SttProvider, SttResult } from './types.js';

interface CommonOptions {
  apiKey: string;
  language: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}

function guardInput(provider: string, pcm: Buffer, format: AudioFormat): void {
  const check = checkPcmBuffer(pcm, format);
  if (!check.ok) throw new AiProviderError(provider, 'stt', `refusing to upload audio: ${check.reason}`);
}

/**
 * Deepgram pre-recorded transcription of one utterance. The source streams over LiveKit's plugin;
 * the endpointer already cuts utterances, so a single request per utterance is equivalent here and
 * far simpler to bound, cancel and test. Region follows deepgram_stt.py (AU for English, global
 * otherwise). The audio is sent as a WAV so the format is self-describing.
 */
export class DeepgramStt implements SttProvider {
  readonly name = 'deepgram';

  constructor(private readonly options: CommonOptions & { model: string; keyterms: string[]; baseUrl?: string }) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal: AbortSignal): Promise<SttResult> {
    guardInput(this.name, pcm, format);
    const o = this.options;
    const url = new URL(o.baseUrl ?? (o.language === 'en' ? DEEPGRAM_AU_LISTEN_URL : DEEPGRAM_GLOBAL_LISTEN_URL));
    url.searchParams.set('model', o.model);
    url.searchParams.set('smart_format', 'true');
    if (o.language && o.language !== 'en') url.searchParams.set('language', o.language);
    for (const term of o.keyterms) url.searchParams.append('keyterm', term);

    const response = await requestWithRetry(
      url.toString(),
      {
        method: 'POST',
        headers: { Authorization: `Token ${o.apiKey}`, 'Content-Type': 'audio/wav' },
        body: toWav(pcm, format),
      },
      { provider: this.name, stage: 'stt', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new AiProviderError(this.name, 'stt', 'response was not valid JSON');
    }
    const alternative = body?.results?.channels?.[0]?.alternatives?.[0];
    if (!alternative || typeof alternative.transcript !== 'string') {
      throw new AiProviderError(this.name, 'stt', 'response had no transcript field');
    }
    return { text: alternative.transcript.trim(), confidence: typeof alternative.confidence === 'number' ? alternative.confidence : undefined };
  }
}

/**
 * Groq Whisper (OpenAI-compatible transcription endpoint). Groq bills a minimum of 10 s per request,
 * so very short utterances cost the same as 10 s; the pre-STT gate exists partly for that reason.
 */
export class GroqWhisperStt implements SttProvider {
  readonly name = 'groq';

  constructor(private readonly options: CommonOptions & { model: string; url?: string; prompt?: string }) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal: AbortSignal): Promise<SttResult> {
    guardInput(this.name, pcm, format);
    const o = this.options;
    const form = new FormData();
    form.append('file', new Blob([toWav(pcm, format)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', o.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    // Optional vocabulary hint (names, product words): Whisper spells and recognizes them far more reliably.
    if (o.prompt) form.append('prompt', o.prompt.slice(0, 400));
    // Always state the language. Without it Whisper guesses from the audio, and on a one-second phone clip it
    // guesses wildly: "Hello" came back as Russian, French, Spanish and Italian text, and the agent answered in them.
    if (o.language) form.append('language', baseLanguage(o.language));

    const response = await requestWithRetry(
      o.url ?? GROQ_TRANSCRIPTIONS_URL,
      { method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}` }, body: form },
      { provider: this.name, stage: 'stt', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new AiProviderError(this.name, 'stt', 'response was not valid JSON');
    }
    if (typeof body?.text !== 'string') {
      throw new AiProviderError(this.name, 'stt', 'response had no text field');
    }
    return { text: body.text.trim() };
  }
}
