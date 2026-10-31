/**
 * Speech-to-text adapters added to the existing set (providers/stt.ts): Cartesia Ink-Whisper, Soniox, Deepgram Flux.
 * Each implements the same SttProvider interface (one finished utterance in, text out), so the call pipeline is unchanged.
 *
 * Verified against the providers' own documentation on 2026-10-28:
 *  - Cartesia: POST https://api.cartesia.ai/stt, multipart (file, model=ink-whisper, language), Authorization: Bearer,
 *    Cartesia-Version header; JSON reply { text }. https://docs.cartesia.ai/api-reference/stt/transcribe
 *  - Soniox: WebSocket wss://stt-rt.soniox.com/transcribe-websocket; first message JSON { api_key, model, audio_format,
 *    sample_rate, num_channels, language_hints }, then binary audio, an empty text frame to end; replies carry
 *    tokens[{ text, is_final }] and a final { finished: true }. Models stt-rt-v5 (real-time) and stt-async-v5.
 *    https://soniox.com/docs/stt/api-reference/websocket-api  (the key goes in the first message, which the docs mark as
 *    deprecated from 15 January 2027: a Node WebSocket cannot set the Authorization header.)
 *  - Deepgram Flux: WebSocket wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=...;
 *    audio in 80 ms chunks; TurnInfo messages with event EndOfTurn and a transcript. Flux has no batch REST mode.
 *    https://developers.deepgram.com/docs/flux/quickstart
 */
import { CARTESIA_DEFAULT_VERSION } from '../catalog.js';
import { AudioFormat, assertEnginePcm, checkPcmBuffer, toWav } from '../audio.js';
import { FetchLike, redactSecrets, requestWithRetry } from './http.js';
import { nodeWebSocketFactory, WebSocketFactory, WsLike } from './stt-stream.js';
import { AiProviderError, baseLanguage, SttProvider, SttResult } from './types.js';

interface Common {
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

// ---------------------------------------------------------------------------------------------------- Cartesia Ink-Whisper

export class CartesiaInkWhisperStt implements SttProvider {
  readonly name = 'cartesia';

  constructor(private readonly options: Common & { model?: string; version?: string; url?: string }) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal: AbortSignal): Promise<SttResult> {
    guardInput(this.name, pcm, format);
    const o = this.options;
    const form = new FormData();
    form.append('file', new Blob([toWav(pcm, format)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', o.model ?? 'ink-whisper');
    if (o.language) form.append('language', baseLanguage(o.language));
    const response = await requestWithRetry(
      o.url ?? 'https://api.cartesia.ai/stt',
      { method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}`, 'Cartesia-Version': o.version ?? CARTESIA_DEFAULT_VERSION }, body: form },
      { provider: this.name, stage: 'stt', fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries, signal, sleep: o.sleep }
    );
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new AiProviderError(this.name, 'stt', 'response was not valid JSON');
    }
    if (typeof body?.text !== 'string') throw new AiProviderError(this.name, 'stt', 'response had no text field');
    return { text: body.text.trim() };
  }
}

// ---------------------------------------------------------------------------------------------------- shared socket helper

interface SocketRun {
  /** Called for every message; return a result to finish, or undefined to keep waiting. */
  onMessage: (data: unknown, send: (d: Buffer | string) => void) => SttResult | undefined;
  /** Called once the socket is open, to send the config and the audio. */
  onOpen: (send: (d: Buffer | string) => void) => void;
  /** Called when the socket closes before a result: what to return, or null to fail. */
  onClosed?: () => SttResult | null;
}

/** One request over a WebSocket, bounded by a timeout and a cancel signal, never retried (it may have been billed). */
function runSocket(provider: string, factory: WebSocketFactory, url: string, protocols: string[], timeoutMs: number, signal: AbortSignal, run: SocketRun): Promise<SttResult> {
  return new Promise<SttResult>((resolve, reject) => {
    let ws: WsLike | null = null;
    let done = false;
    const finish = (result: SttResult | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        ws?.close(1000);
      } catch {
        // already closed
      }
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const fail = (message: string, details: ConstructorParameters<typeof AiProviderError>[3] = {}) => finish(new AiProviderError(provider, 'stt', redactSecrets(message), details));
    const timer = setTimeout(() => fail(`no answer within ${timeoutMs} ms`, { timedOut: true, retryable: false }), timeoutMs);
    const onAbort = () => fail('cancelled', { aborted: true });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      ws = factory(url, protocols);
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'could not open the WebSocket');
    }
    const send = (d: Buffer | string) => ws!.send(d);
    ws.onopen = () => {
      try {
        run.onOpen(send);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'could not send the audio');
      }
    };
    ws.onmessage = (event) => {
      if (done) return; // anything after the result is ignored: a late message must never cause more work
      try {
        const result = run.onMessage(event.data, send);
        if (result) finish(result);
      } catch (error) {
        finish(error instanceof AiProviderError ? error : new AiProviderError(provider, 'stt', redactSecrets(error instanceof Error ? error.message : 'bad message')));
      }
    };
    ws.onerror = () => fail('the connection failed');
    ws.onclose = () => {
      if (done) return;
      const closed = run.onClosed?.() ?? null;
      if (closed) finish(closed);
      else fail('the connection closed before a transcript arrived');
    };
  });
}

const text = (data: unknown): string => (typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data));

// ---------------------------------------------------------------------------------------------------- Soniox

/** Soniox error codes are HTTP-like statuses: 401 key, 402 balance, 403 permission, 429 limits. */
function sonioxAdvice(code: number): string {
  if (code === 401) return 'authentication failed: check SONIOX_API_KEY';
  if (code === 402) return 'payment required: the Soniox balance or budget is exhausted';
  if (code === 403) return 'forbidden: this key has no permission for this request';
  if (code === 429) return 'rate or concurrency limit exceeded';
  if (code === 408) return 'request timeout';
  if (code === 400) return 'bad request (check the model id and audio settings)';
  return 'Soniox error';
}

export class SonioxStt implements SttProvider {
  readonly name = 'soniox';

  constructor(private readonly options: Common & { model: string; url?: string; webSocketFactory?: WebSocketFactory }) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal: AbortSignal): Promise<SttResult> {
    assertEnginePcm(format);
    guardInput(this.name, pcm, format);
    const o = this.options;
    const tokens: string[] = [];
    return runSocket(this.name, o.webSocketFactory ?? nodeWebSocketFactory, o.url ?? 'wss://stt-rt.soniox.com/transcribe-websocket', [], o.timeoutMs, signal, {
      onOpen: (send) => {
        send(
          JSON.stringify({
            api_key: o.apiKey,
            model: o.model,
            audio_format: 's16le',
            sample_rate: format.sampleRate,
            num_channels: 1,
            language_hints: o.language ? [baseLanguage(o.language)] : undefined,
          })
        );
        const chunk = Math.round(format.sampleRate * 0.5) * 2; // half a second per frame
        for (let at = 0; at < pcm.length; at += chunk) send(pcm.subarray(at, Math.min(at + chunk, pcm.length)));
        send(''); // an empty text frame ends the stream (an empty binary frame would not)
      },
      onMessage: (data) => {
        const message = JSON.parse(text(data)) as { error_code?: number; error_message?: string; tokens?: Array<{ text?: string; is_final?: boolean }>; finished?: boolean };
        if (typeof message.error_code === 'number') {
          const code = message.error_code;
          throw new AiProviderError(this.name, 'stt', `HTTP ${code}: ${sonioxAdvice(code)}${message.error_message ? ` (${redactSecrets(message.error_message).slice(0, 160)})` : ''}`, {
            status: code,
            retryable: false,
          });
        }
        for (const token of message.tokens ?? []) if (token.is_final && typeof token.text === 'string' && !/^<.*>$/.test(token.text)) tokens.push(token.text);
        if (message.finished) return { text: tokens.join('').trim() };
        return undefined;
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------------- Deepgram Flux

export class DeepgramFluxStt implements SttProvider {
  readonly name = 'deepgram-flux';

  constructor(private readonly options: Common & { model?: string; baseUrl?: string; webSocketFactory?: WebSocketFactory; trailingSilenceMs?: number }) {}

  async transcribe(pcm: Buffer, format: AudioFormat, signal: AbortSignal): Promise<SttResult> {
    assertEnginePcm(format);
    guardInput(this.name, pcm, format);
    const o = this.options;
    // Flux takes 8000, 16000, 24000, 44100 and 48000 Hz; 16000 is recommended.
    if (![8000, 16000, 24000, 44100, 48000].includes(format.sampleRate)) {
      throw new AiProviderError(this.name, 'stt', `Flux does not accept ${format.sampleRate} Hz audio (8000, 16000, 24000, 44100, 48000)`);
    }
    const english = baseLanguage(o.language || 'en') === 'en';
    const model = o.model ?? (english ? 'flux-general-en' : 'flux-general-multi');
    const url = new URL(o.baseUrl ?? 'wss://api.deepgram.com/v2/listen');
    url.searchParams.set('model', model);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(format.sampleRate));
    let latest = '';
    const finishWith = (): SttResult | null => (latest.trim() ? { text: latest.trim() } : null);
    return runSocket(this.name, o.webSocketFactory ?? nodeWebSocketFactory, url.toString(), ['token', o.apiKey], o.timeoutMs, signal, {
      onOpen: (send) => {
        const chunk = Math.round(format.sampleRate * 0.08) * 2; // Flux wants 80 ms chunks
        for (let at = 0; at < pcm.length; at += chunk) send(pcm.subarray(at, Math.min(at + chunk, pcm.length)));
        // Silence after the speech lets Flux's own turn detection decide the utterance has ended.
        const silence = Buffer.alloc(Math.round(format.sampleRate * ((o.trailingSilenceMs ?? 1200) / 1000)) * 2);
        for (let at = 0; at < silence.length; at += chunk) send(silence.subarray(at, Math.min(at + chunk, silence.length)));
      },
      onMessage: (data, send) => {
        const message = JSON.parse(text(data)) as { type?: string; event?: string; transcript?: string; description?: string; code?: string };
        if (message.type === 'Error' || (message.type === 'FatalError')) {
          throw new AiProviderError(this.name, 'stt', redactSecrets(message.description ?? message.code ?? 'Flux reported an error'));
        }
        if (message.type === 'TurnInfo') {
          if (typeof message.transcript === 'string' && message.transcript.trim()) latest = message.transcript;
          if (message.event === 'EndOfTurn') {
            try {
              send(JSON.stringify({ type: 'CloseStream' }));
            } catch {
              // the result is already in hand
            }
            return { text: latest.trim() };
          }
        }
        return undefined;
      },
      onClosed: finishWith,
    });
  }
}
