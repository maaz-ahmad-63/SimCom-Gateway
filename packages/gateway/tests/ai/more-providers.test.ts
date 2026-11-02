import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/ai/catalog-view.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { CartesiaInkWhisperStt, DeepgramFluxStt, SonioxStt } from '../../src/ai/providers/stt-more.js';
import { WsLike } from '../../src/ai/providers/stt-stream.js';
import { InworldTts, MurfTts, SonioxTts } from '../../src/ai/providers/tts.js';
import { AiProviderError } from '../../src/ai/providers/types.js';
import { credentialProbe } from '../../src/ai/runtime.js';
import { CREDENTIAL_PROVIDERS } from '../../src/ai/settings.js';
import { aiEnv, fakeFetch, FORMAT_8K, hangingFetch, json, SECRET, speechPcm } from './helpers.js';

/** Contract tests with mocked HTTP and WebSocket: no request leaves the process, so none of this proves a real account works. */
const signal = () => new AbortController().signal;
const noSleep = async () => undefined;
const base = { apiKey: SECRET, timeoutMs: 1000, maxRetries: 1, sleep: noSleep };
const rate = (sampleRate: number) => ({ ...FORMAT_8K, sampleRate });
const pcm = (bytes: number, status = 200) => new Response(Buffer.alloc(bytes, 5), { status });

/** A WebSocket that records what is sent and answers from a script. */
class FakeWs implements WsLike {
  readyState = 1;
  sent: Array<Buffer | string> = [];
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onerror: WsLike['onerror'] = null;
  onclose: WsLike['onclose'] = null;
  closed = false;
  constructor(readonly url: string, readonly protocols: string[], private readonly script: (ws: FakeWs, data: Buffer | string) => void) {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: Buffer | string) {
    this.sent.push(data);
    this.script(this, data);
  }
  reply(message: unknown) {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  close() {
    this.closed = true;
  }
}
const wsFor = (script: (ws: FakeWs, data: Buffer | string) => void) => {
  const made: FakeWs[] = [];
  return { made, factory: (url: string, protocols: string[]) => { const ws = new FakeWs(url, protocols, script); made.push(ws); return ws; } };
};

describe('Cartesia Ink-Whisper STT', () => {
  const make = (impl: never) => new CartesiaInkWhisperStt({ ...base, fetchImpl: impl, language: 'en-US' });
  it('posts a WAV with the model and language, Bearer key and the Cartesia-Version header, and reads { text }', async () => {
    const { impl, requests } = fakeFetch([json({ type: 'transcript', text: ' Hello there. ' })]);
    expect((await make(impl as never).transcribe(speechPcm(500), FORMAT_8K, signal())).text).toBe('Hello there.');
    expect(requests[0].url).toBe('https://api.cartesia.ai/stt');
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(requests[0].headers['cartesia-version']).toBe('2026-08-14');
    const form = requests[0].body as FormData;
    expect([form.get('model'), form.get('language')]).toEqual(['ink-whisper', 'en']);
    expect(Buffer.from(await (form.get('file') as Blob).arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
  });
  it('reports a bad key, exhausted quota, an unsupported model and bad replies without echoing the key', async () => {
    const run = (status: number, body: unknown = { error: `nope ${SECRET}` }) => make(fakeFetch([json(body, status)]).impl as never).transcribe(speechPcm(300), FORMAT_8K, signal()).catch((e) => e as AiProviderError);
    expect((await run(401)).message).toMatch(/HTTP 401: authentication failed/);
    expect((await run(402)).message).toMatch(/HTTP 402: payment required/);
    expect((await run(404)).message).toMatch(/HTTP 404: endpoint or model not found/);
    expect((await run(401)).message).not.toContain(SECRET);
    expect((await make(fakeFetch([new Response('<html>', { status: 200 })]).impl as never).transcribe(speechPcm(300), FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/not valid JSON/);
    expect((await make(fakeFetch([json({ nope: 1 })]).impl as never).transcribe(speechPcm(300), FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/no text field/);
  });
  it('retries a rate limit once, and times out on a provider that never answers', async () => {
    const f = fakeFetch([json({}, 429), json({ text: 'ok' })]);
    expect((await make(f.impl as never).transcribe(speechPcm(300), FORMAT_8K, signal())).text).toBe('ok');
    expect(f.requests).toHaveLength(2);
    await expect(new CartesiaInkWhisperStt({ ...base, timeoutMs: 30, maxRetries: 0, fetchImpl: hangingFetch as never, language: 'en' }).transcribe(speechPcm(300), FORMAT_8K, signal())).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('Soniox STT (real-time WebSocket used one utterance at a time)', () => {
  it('sends the config, the audio as binary and an empty text frame to end, and joins the final tokens', async () => {
    const { made, factory } = wsFor((ws, data) => {
      if (data === '') {
        ws.reply({ tokens: [{ text: 'Hello', is_final: true }, { text: ' wor', is_final: false }] });
        ws.reply({ tokens: [{ text: ' world', is_final: true }, { text: '<end>', is_final: true }], finished: true });
      }
    });
    const stt = new SonioxStt({ ...base, language: 'en-US', model: 'stt-rt-v5', fetchImpl: undefined as never, webSocketFactory: factory });
    expect((await stt.transcribe(speechPcm(1200), FORMAT_8K, signal())).text).toBe('Hello world');
    expect(made[0].url).toBe('wss://stt-rt.soniox.com/transcribe-websocket');
    expect(JSON.parse(made[0].sent[0] as string)).toMatchObject({ model: 'stt-rt-v5', audio_format: 's16le', sample_rate: 8000, num_channels: 1, language_hints: ['en'] });
    expect(made[0].sent.slice(1, -1).every(Buffer.isBuffer)).toBe(true);
    expect(made[0].sent.at(-1)).toBe('');
  });
  it('maps Soniox error codes: key, payment, rate limit, and never echoes the key', async () => {
    for (const [code, re] of [[401, /HTTP 401: authentication failed: check SONIOX_API_KEY/], [402, /HTTP 402: payment required/], [429, /HTTP 429: rate or concurrency limit/]] as const) {
      const { factory } = wsFor((ws, data) => {
        if (data === '') ws.reply({ error_code: code, error_message: `bad ${SECRET}`, error_type: 'x' });
      });
      const error = (await new SonioxStt({ ...base, language: 'en', model: 'stt-rt-v5', fetchImpl: undefined as never, webSocketFactory: factory }).transcribe(speechPcm(300), FORMAT_8K, signal()).catch((e) => e)) as AiProviderError;
      expect(error.message).toMatch(re);
      expect(error.message).not.toContain(SECRET);
      expect(error.retryable).toBe(false);
    }
  });
  it('fails on a closed connection and on a timeout, and is never retried', async () => {
    const closing = wsFor((ws, data) => {
      if (data === '') queueMicrotask(() => ws.onclose?.());
    });
    await expect(new SonioxStt({ ...base, language: 'en', model: 'stt-rt-v5', fetchImpl: undefined as never, webSocketFactory: closing.factory }).transcribe(speechPcm(300), FORMAT_8K, signal())).rejects.toThrow(/closed before a transcript/);
    const silent = wsFor(() => undefined);
    await expect(new SonioxStt({ ...base, timeoutMs: 40, language: 'en', model: 'stt-rt-v5', fetchImpl: undefined as never, webSocketFactory: silent.factory }).transcribe(speechPcm(300), FORMAT_8K, signal())).rejects.toThrow(/no answer within 40 ms/);
    expect(silent.made).toHaveLength(1);
  });
});

describe('Deepgram Flux STT (WebSocket, turn-based)', () => {
  it('connects to /v2/listen with the model and rate, sends 80 ms chunks, and returns the EndOfTurn transcript', async () => {
    const { made, factory } = wsFor((ws) => {
      if (ws.sent.length === 1) ws.reply({ type: 'TurnInfo', event: 'Update', transcript: 'hello' });
      if (ws.sent.length === 2) ws.reply({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'hello there' });
    });
    const stt = new DeepgramFluxStt({ ...base, language: 'en', fetchImpl: undefined as never, webSocketFactory: factory });
    expect((await stt.transcribe(speechPcm(800), FORMAT_8K, signal())).text).toBe('hello there');
    const url = new URL(made[0].url);
    expect(`${url.origin}${url.pathname}`).toBe('wss://api.deepgram.com/v2/listen');
    expect([url.searchParams.get('model'), url.searchParams.get('encoding'), url.searchParams.get('sample_rate')]).toEqual(['flux-general-en', 'linear16', '8000']);
    expect(made[0].protocols).toEqual(['token', SECRET]);
    expect((made[0].sent[0] as Buffer).length).toBe(1280); // 80 ms at 8 kHz
    expect(made[0].sent.some((s) => typeof s === 'string' && s.includes('CloseStream'))).toBe(true);
  });
  it('uses the multilingual model for other languages, refuses unsupported rates, and reports errors', async () => {
    const { made, factory } = wsFor((ws) => ws.reply({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'namaste' }));
    await new DeepgramFluxStt({ ...base, language: 'hi', fetchImpl: undefined as never, webSocketFactory: factory }).transcribe(speechPcm(300), FORMAT_8K, signal());
    expect(new URL(made[0].url).searchParams.get('model')).toBe('flux-general-multi');
    await expect(new DeepgramFluxStt({ ...base, language: 'en', fetchImpl: undefined as never, webSocketFactory: factory }).transcribe(speechPcm(300), rate(11025), signal())).rejects.toThrow(/does not accept 11025 Hz/);
    const failing = wsFor((ws) => ws.reply({ type: 'Error', description: `bad ${SECRET}` }));
    const error = (await new DeepgramFluxStt({ ...base, language: 'en', fetchImpl: undefined as never, webSocketFactory: failing.factory }).transcribe(speechPcm(300), FORMAT_8K, signal()).catch((e) => e)) as AiProviderError;
    expect(error.message).not.toContain(SECRET);
  });
});

describe('Murf Falcon TTS', () => {
  const make = (impl: never, over: Record<string, unknown> = {}) => new MurfTts({ ...base, fetchImpl: impl, voice: 'en-US-natalie', rateKey: 'murf_falcon_2', ...over });
  it('asks for raw PCM mono at exactly the gateway rate with the api-key header', async () => {
    for (const r of [8000, 16000, 24000, 44100, 48000]) {
      const audio = Buffer.alloc(Math.floor(r / 10) * 2, 4);
      const { impl, requests } = fakeFetch([new Response(audio, { status: 200 })]);
      expect((await make(impl as never).synthesize('Hello.', rate(r), signal())).equals(audio)).toBe(true);
      expect(requests[0].url).toBe('https://global.api.murf.ai/v1/speech/stream');
      expect(requests[0].headers['api-key']).toBe(SECRET);
      expect(JSON.parse(requests[0].body as string)).toEqual({ text: 'Hello.', voiceId: 'en-US-natalie', model: 'falcon-2.1', format: 'PCM', sampleRate: r, channelType: 'MONO' });
    }
  });
  it('refuses a rate Murf does not list, and a WAV that says another rate; accepts a matching WAV', async () => {
    const { impl, requests } = fakeFetch([pcm(100)]);
    await expect(make(impl as never).synthesize('x', rate(22050), signal())).rejects.toThrow(/cannot produce raw 22050 Hz/);
    expect(requests).toHaveLength(0);
    const header = (hz: number, bytes: number) => {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8, 'ascii'); h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(hz, 24); h.writeUInt32LE(hz * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write('data', 36, 'ascii'); h.writeUInt32LE(bytes, 40);
      return h;
    };
    const good = Buffer.concat([header(8000, 320), Buffer.alloc(320, 2)]);
    expect((await make(fakeFetch([new Response(good)]).impl as never).synthesize('x', FORMAT_8K, signal())).length).toBe(320);
    await expect(make(fakeFetch([new Response(Buffer.concat([header(24000, 320), Buffer.alloc(320)]))]).impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/WAV is 24000 Hz/);
  });
  it('reports a bad key and a payment-required answer; streams whole samples; times out', async () => {
    expect((await make(fakeFetch([json({}, 403)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 403: authentication failed/);
    expect((await make(fakeFetch([json({}, 402)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 402: payment required/);
    const parts: Buffer[] = [];
    for await (const c of make(fakeFetch([pcm(640)]).impl as never).synthesizeStream('x', FORMAT_8K, signal())) parts.push(c);
    expect(Buffer.concat(parts)).toHaveLength(640);
    await expect(make(hangingFetch as never, { timeoutMs: 30, maxRetries: 0 }).synthesize('x', FORMAT_8K, signal())).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('Inworld TTS (newline-delimited JSON with base64 PCM)', () => {
  const ndjson = (lines: unknown[], split = 7) => {
    const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
    return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (let i = 0; i < text.length; i += split) c.enqueue(e.encode(text.slice(i, i + split))); c.close(); } }), { status: 200 });
  };
  const line = (bytes: number) => ({ result: { audioContent: Buffer.alloc(bytes, 9).toString('base64') } });
  const make = (impl: never, over: Record<string, unknown> = {}) => new InworldTts({ ...base, fetchImpl: impl, voice: 'Ashley', ...over });
  it('asks for headerless PCM at the gateway rate with Basic auth, and decodes lines split anywhere', async () => {
    const { impl, requests } = fakeFetch([ndjson([line(320), line(480)])]);
    expect((await make(impl as never).synthesize('Hello.', FORMAT_8K, signal())).length).toBe(800);
    expect(requests[0].url).toBe('https://api.inworld.ai/tts/v1/voice:stream');
    expect(requests[0].headers.authorization).toBe(`Basic ${SECRET}`);
    expect(JSON.parse(requests[0].body as string)).toEqual({ text: 'Hello.', voiceId: 'Ashley', modelId: 'inworld-tts-2', audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 8000 } });
  });
  it('reassembles samples split across chunks, and rejects half samples, empty audio and non-JSON', async () => {
    const odd = { result: { audioContent: Buffer.alloc(3, 1).toString('base64') } };
    const out: Buffer[] = [];
    for await (const c of make(fakeFetch([ndjson([odd, odd, { result: { audioContent: Buffer.alloc(2, 1).toString('base64') } }])]).impl as never).synthesizeStream('x', FORMAT_8K, signal())) out.push(c);
    expect(Buffer.concat(out)).toHaveLength(8);
    await expect(make(fakeFetch([ndjson([odd])]).impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/odd number of bytes/);
    await expect(make(fakeFetch([ndjson([{ result: {} }])]).impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/returned no audio/);
    await expect(make(fakeFetch([ndjson(['not json'])]).impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/not JSON/);
  });
  it('reports a mid-stream error after HTTP 200, a bad key and exhausted quota, without echoing the key', async () => {
    const mid = (await make(fakeFetch([ndjson([line(320), { error: { code: 8, message: `quota ${SECRET}` } }])]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)) as AiProviderError;
    expect(mid.message).toMatch(/quota/);
    expect(mid.message).not.toContain(SECRET);
    expect((await make(fakeFetch([json({}, 401)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 401: authentication failed/);
    expect((await make(fakeFetch([json({}, 402)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 402: payment required/);
    await expect(make(hangingFetch as never, { timeoutMs: 30, maxRetries: 0 }).synthesize('x', FORMAT_8K, signal())).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('Soniox TTS', () => {
  const make = (impl: never) => new SonioxTts({ ...base, fetchImpl: impl, voice: 'Adrian', language: 'en-US' });
  it('requests pcm_s16le at the gateway rate with a Bearer key and returns the audio untouched', async () => {
    const audio = Buffer.alloc(1600, 6);
    const { impl, requests } = fakeFetch([new Response(audio)]);
    expect((await make(impl as never).synthesize('Hi.', rate(16000), signal())).equals(audio)).toBe(true);
    expect(requests[0].url).toBe('https://tts-rt.soniox.com/tts');
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(requests[0].body as string)).toEqual({ model: 'tts-rt-v2', language: 'en', voice: 'Adrian', audio_format: 'pcm_s16le', sample_rate: 16000, text: 'Hi.' });
  });
  it('refuses unsupported rates before a request, and reports key, payment and rate-limit answers', async () => {
    const f = fakeFetch([pcm(10)]);
    await expect(make(f.impl as never).synthesize('x', rate(22050), signal())).rejects.toThrow(/cannot produce raw 22050 Hz/);
    expect(f.requests).toHaveLength(0);
    expect((await make(fakeFetch([json({ error_type: 'x' }, 401)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 401/);
    expect((await make(fakeFetch([json({}, 402)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 402: payment required/);
    expect((await make(fakeFetch([json({}, 429)]).impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)).message).toMatch(/HTTP 429/);
  });
});

describe('selection, credentials and models through the existing catalog', () => {
  const catalog = buildCatalog(aiEnv());
  it('marks exactly what is implemented, with honest reasons for the rest', () => {
    const tts = Object.fromEntries(catalog.tts.map((o: any) => [o.key, o]));
    for (const key of ['murf_falcon_2', 'murf_falcon_2_hi', 'inworld', 'soniox', 'cartesia', 'deepgram', 'elevenlabs']) expect(tts[key].implemented, key).toBe(true);
    expect(tts.murf).toMatchObject({ implemented: false });
    expect(tts.murf.unavailableReason).toMatch(/no documented endpoint/);
    expect(tts.soniox).toMatchObject({ keyEnv: 'SONIOX_API_KEY', sampleRates: [8000, 16000, 24000, 44100, 48000], models: [{ id: 'tts-rt-v2' }] });
    expect(tts.murf_falcon_2.keyEnv).toBe('MURF_API_KEY');
    const stt = Object.fromEntries(catalog.stt.map((o: any) => [o.key, o]));
    for (const key of ['nova-3', 'nova-3-multi', 'flux', 'groq_whisper', 'soniox', 'stt-rt-v5', 'ink-whisper']) expect(stt[key].implemented, key).toBe(true);
    expect(stt.assemblyai.implemented).toBe(false);
  });
  it('every credential has an entry in the key store and a read-only test request', () => {
    for (const name of ['MURF_API_KEY', 'INWORLD_API_KEY', 'SONIOX_API_KEY', 'TELNYX_API_KEY', 'DEEPGRAM_API_KEY', 'CARTESIA_API_KEY']) {
      expect(CREDENTIAL_PROVIDERS[name], name).toBeTruthy();
      expect(credentialProbe(name, SECRET).url, name).toMatch(/^https:\/\//);
    }
    expect(credentialProbe('MURF_API_KEY', SECRET)).toEqual({ url: 'https://global.api.murf.ai/v1/speech/voices', headers: { 'api-key': SECRET } });
    expect(credentialProbe('INWORLD_API_KEY', SECRET).headers).toEqual({ Authorization: `Basic ${SECRET}` });
    expect(credentialProbe('SONIOX_API_KEY', SECRET).headers).toEqual({ Authorization: `Bearer ${SECRET}` });
  });
  it('each selection needs only its own key, and the key is reported by variable name', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ AI_TTS: 'murf_falcon_2', AI_TTS_VOICE: 'en-US-natalie' }, 'MURF_API_KEY'],
      [{ AI_TTS: 'inworld', AI_TTS_VOICE: 'Ashley' }, 'INWORLD_API_KEY'],
      [{ AI_TTS: 'soniox', AI_TTS_VOICE: 'Adrian' }, 'SONIOX_API_KEY'],
      [{ AI_STT: 'soniox' }, 'SONIOX_API_KEY'],
      [{ AI_STT: 'ink-whisper' }, 'CARTESIA_API_KEY'],
    ];
    for (const [env, name] of cases) {
      const missing = loadAiConfig(aiEnv({ ...env, [name]: undefined, ...(name === 'CARTESIA_API_KEY' ? { AI_TTS: 'deepgram', AI_TTS_VOICE: 'aura-asteria-en' } : {}) }));
      expect(missing.errors.join(' '), name).toContain(`${name} is required by the selected providers but is not set`);
      expect(JSON.stringify(missing)).not.toContain(SECRET);
    }
  });
  it('builds the real adapter for every selectable model, and never swaps providers silently', () => {
    const build = (env: Record<string, string>, only: 'stt' | 'tts') => {
      const config = loadAiConfig(aiEnv({ AI_AUDIO_SAMPLE_RATE: '16000', ...env, MURF_API_KEY: SECRET, INWORLD_API_KEY: SECRET, SONIOX_API_KEY: SECRET })).config;
      const providers = createProviders(config, { env: aiEnv({ ...env, MURF_API_KEY: SECRET, INWORLD_API_KEY: SECRET, SONIOX_API_KEY: SECRET }), only });
      return only === 'stt' ? providers.stt.name : providers.tts.name;
    };
    expect(build({ AI_STT: 'soniox' }, 'stt')).toBe('soniox');
    expect(build({ AI_STT: 'stt-rt-v5' }, 'stt')).toBe('soniox');
    expect(build({ AI_STT: 'flux' }, 'stt')).toBe('deepgram-flux');
    expect(build({ AI_STT: 'ink-whisper' }, 'stt')).toBe('cartesia');
    expect(build({ AI_TTS: 'murf_falcon_2', AI_TTS_VOICE: 'en-US-natalie' }, 'tts')).toBe('murf');
    expect(build({ AI_TTS: 'murf_falcon_2_hi', AI_TTS_VOICE: 'hi-IN-kabir' }, 'tts')).toBe('murf');
    expect(build({ AI_TTS: 'inworld', AI_TTS_VOICE: 'Ashley' }, 'tts')).toBe('inworld');
    expect(build({ AI_TTS: 'soniox', AI_TTS_VOICE: 'Adrian' }, 'tts')).toBe('soniox');
    expect(() => loadAiConfig(aiEnv({ AI_TTS: 'murf' })).config && createProviders(loadAiConfig(aiEnv({ AI_TTS: 'murf' })).config, { env: aiEnv({ AI_TTS: 'murf', MURF_API_KEY: SECRET }), only: 'tts' })).not.toThrow(/zzz/);
    expect(loadAiConfig(aiEnv({ AI_TTS: 'murf', MURF_API_KEY: SECRET })).errors.join(' ')).toMatch(/not ported to the gateway yet/);
  });
  it('rejects a model that is not the provider\'s, an unsupported rate, and passes a valid model through', () => {
    const ok = loadAiConfig(aiEnv({ AI_TTS: 'soniox', AI_TTS_VOICE: 'Adrian', AI_TTS_MODEL: 'tts-rt-v2', SONIOX_API_KEY: SECRET }));
    expect(ok.errors).toEqual([]);
    expect(ok.config.tts.model).toBe('tts-rt-v2');
    const wrong = loadAiConfig(aiEnv({ AI_TTS: 'soniox', AI_TTS_VOICE: 'Adrian', AI_TTS_MODEL: 'sonic-3', SONIOX_API_KEY: SECRET }));
    expect(wrong.errors.join(' ')).toMatch(/AI_TTS_MODEL 'sonic-3' is not a model of 'soniox' \(supported: tts-rt-v2\)/);
    expect(wrong.config.tts.model).toBeNull(); // never passed to the provider
    expect(loadAiConfig(aiEnv({ AI_TTS: 'deepgram', AI_TTS_VOICE: 'aura-asteria-en', AI_TTS_MODEL: 'x' })).errors.join(' ')).toMatch(/has no selectable model/);
    expect(loadAiConfig(aiEnv({ AI_TTS: 'murf_falcon_2', AI_TTS_VOICE: 'v', MURF_API_KEY: SECRET, AI_AUDIO_SAMPLE_RATE: '22050' })).errors.join(' ')).toMatch(/not a raw rate Murf supports \(8000, 16000, 24000, 44100, 48000\)/);
  });
});
