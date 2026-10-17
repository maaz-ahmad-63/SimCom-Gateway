import { loadAiConfig, AiConfig } from '../../src/ai/config.js';
import { AudioFormat } from '../../src/ai/audio.js';
import { FetchLike } from '../../src/ai/providers/http.js';

export const FORMAT_8K: AudioFormat = { sampleRate: 8000, channels: 1, bitDepth: 16, endianness: 'little-endian' };
export const SECRET = 'sk-test-SECRET-0123456789abcdef';

/** Environment for an enabled, fully keyed AI setup. Keys are fake; nothing here reaches a network. */
export function aiEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AI_ENABLED: 'true',
    AI_STT: 'nova-3',
    AI_LLM: 'groq_qwen_3_8_27b',
    AI_TTS: 'cartesia',
    AI_AUDIO_SAMPLE_RATE: '8000',
    DEEPGRAM_API_KEY: SECRET,
    GROQ_API_KEY: SECRET,
    CARTESIA_API_KEY: SECRET,
    OPENAI_API_KEY: SECRET,
    TELNYX_API_KEY: SECRET,
    ...overrides,
  };
}

export function makeConfig(overrides: Record<string, string | undefined> = {}): AiConfig {
  const result = loadAiConfig(aiEnv(overrides));
  if (result.errors.length > 0) throw new Error(`test config invalid: ${result.errors.join('; ')}`);
  return result.config;
}

/** Voiced-speech-like PCM: a 120 Hz pulse train with harmonics, loud enough to pass the VAD and the pre-STT gate. */
export function speechPcm(ms: number, rate = 8000, amplitude = 3000): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 120 * h * i) / rate) / h;
    out.writeInt16LE(Math.round(v * amplitude), i * 2);
  }
  return out;
}

/** The idle line seen on the real modem: +/-1..2 LSB of noise. */
export function noiseFloorPcm(ms: number, rate = 8000): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const out = Buffer.alloc(samples * 2);
  let seed = 7;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.writeInt16LE((seed % 5) - 2, i * 2);
  }
  return out;
}

/** White noise loud enough to pass an energy VAD but with no pitch. */
export function loudNoisePcm(ms: number, rate = 8000): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const out = Buffer.alloc(samples * 2);
  let seed = 99;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.writeInt16LE((seed % 6000) - 3000, i * 2);
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RecordedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake fetch that records requests and answers from a queue (an Error is thrown, a Response is returned). */
export function fakeFetch(responses: Array<Response | Error | ((req: RecordedRequest) => Response | Promise<Response>)>) {
  const requests: RecordedRequest[] = [];
  const impl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((value, key) => (headers[key.toLowerCase()] = value));
    const request: RecordedRequest = { url, method: init?.method, headers, body: init?.body };
    requests.push(request);
    const next = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request) : next.clone();
  };
  return { impl, requests };
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

/** An SSE body delivered in awkward chunks so line boundaries are crossed. */
export function sse(events: unknown[], chunkSize = 17): Response {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < text.length; i += chunkSize) controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
}

export const delta = (content: string) => ({ choices: [{ delta: { content } }] });

/** A fetch that never answers until its request is aborted. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
      once: true,
    });
  });
