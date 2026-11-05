import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { AiProviderError, TtsProvider } from '../../src/ai/providers/types.js';
import { resetActiveRegistry, setActiveRegistry } from '../../src/ai/registry/active.js';
import { defaultRegistry } from '../../src/ai/registry/defaults.js';
import { buildRegistry } from '../../src/ai/registry/registry.js';
import { checkWav, IvrAssetStore } from '../../src/ivr/assets.js';
import { IvrError } from '../../src/ivr/errors.js';
import { chooseSourceRate, resamplePcm16, TTS_GENERATE_LIMITS, TtsGenerator } from '../../src/ivr/tts-generate.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv, FORMAT_8K, makeConfig, SECRET } from '../ai/helpers.js';
import { sha256 } from './helpers.js';

// Generating an announcement from text: the provider is reached through the same registry and protocol clients the AI agent uses, the
// audio is converted to the IVR's format, validated like an upload, returned (never stored), and then added by the ordinary upload.

const KEY = 'ivr-tts-test-key';

/** 16-bit mono PCM of a sine wave. */
function sine(rate: number, hz: number, ms: number, amp = 12000): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp), i * 2);
  return b;
}
function rms(pcm: Buffer, from = 0, to = pcm.length / 2): number {
  let s = 0;
  for (let i = from; i < to; i++) s += pcm.readInt16LE(i * 2) ** 2;
  return Math.sqrt(s / (to - from));
}

/** A fake provider that records what it was asked for and returns `audio` (a function of the requested rate). */
function fakeProvider(audio: (rate: number, text: string) => Buffer | Error) {
  const calls: Array<{ text: string; rate: number; channels: number; bitDepth: number; endianness: string }> = [];
  const provider: TtsProvider = {
    name: 'fake',
    async synthesize(text, format) {
      calls.push({ text, rate: format.sampleRate, channels: format.channels, bitDepth: format.bitDepth, endianness: format.endianness });
      const out = audio(format.sampleRate, text);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { provider, calls };
}

function generator(audio: Parameters<typeof fakeProvider>[0], env: Record<string, string | undefined> = aiEnv()) {
  const fake = fakeProvider(audio);
  const selections: Array<{ key: string; voice: string; model: string | null }> = [];
  const gen = new TtsGenerator({
    config: () => makeConfig(),
    env: () => env,
    sampleRate: () => 8000,
    createProvider: (s) => (selections.push(s), fake.provider),
  });
  return { gen, fake, selections };
}

const ask = (over: Record<string, unknown> = {}) => ({ text: 'Welcome to our company.', model: 'cartesia', confirmBilling: true, ...over });
async function rejection(p: Promise<unknown>): Promise<IvrError> {
  try {
    await p;
  } catch (e) {
    return e as IvrError;
  }
  throw new Error('expected a rejection');
}

describe('converting to the IVR format', () => {
  it('keeps a tone in band at the same frequency and level when going 24 kHz to 8 kHz', () => {
    const out = resamplePcm16(sine(24000, 1000, 1000), 24000, 8000);
    expect(out.length / 2).toBe(8000);
    const mid = out.subarray(2000, 14000); // away from the filter's edges
    expect(rms(mid) / 12000).toBeGreaterThan(0.68); // a 12000-peak sine has RMS 8485 (0.707 of peak)
    expect(rms(mid) / 12000).toBeLessThan(0.74);
    // Zero crossings: 1 kHz over the 6000 samples (0.75 s) of `mid` is 750 cycles, 1500 crossings.
    let crossings = 0;
    for (let i = 1; i < mid.length / 2; i++) if (mid.readInt16LE((i - 1) * 2) < 0 !== mid.readInt16LE(i * 2) < 0) crossings++;
    expect(crossings).toBeGreaterThan(1480);
    expect(crossings).toBeLessThan(1520);
  });

  it('removes what is above the new Nyquist instead of folding it back (16 kHz to 8 kHz)', () => {
    const out = resamplePcm16(sine(16000, 6000, 1000), 16000, 8000); // 6 kHz cannot exist at 8 kHz; a bad conversion aliases it to 2 kHz
    expect(rms(out, 1000, 7000)).toBeLessThan(400);
  });

  it('handles a non-integer ratio (44.1 kHz) and gives a whole number of samples', () => {
    const out = resamplePcm16(sine(44100, 500, 1000), 44100, 8000);
    expect(out.length % 2).toBe(0);
    expect(out.length / 2).toBe(Math.floor(44100 / (44100 / 8000)));
    expect(rms(out, 500, 7500) / 12000).toBeGreaterThan(0.68);
  });

  it('copies at the same rate and refuses to raise the rate', () => {
    const pcm = sine(8000, 440, 100);
    expect(resamplePcm16(pcm, 8000, 8000).equals(pcm)).toBe(true);
    expect(() => resamplePcm16(pcm, 8000, 16000)).toThrow(/cannot raise/);
  });

  it('asks the provider for 8 kHz when it documents it, else the nearest whole multiple above', () => {
    expect(chooseSourceRate([16000, 8000, 24000], 8000)).toBe(8000);
    expect(chooseSourceRate([22050, 24000, 44100], 8000)).toBe(24000);
    expect(chooseSourceRate([22050, 44100], 8000)).toBe(22050);
    expect(chooseSourceRate([], 8000)).toBeNull();
    expect(chooseSourceRate([4000], 8000)).toBeNull();
  });
});

describe('TtsGenerator', () => {
  afterEach(() => resetActiveRegistry());

  it('returns a WAV in exactly the IVR format that the upload check accepts', async () => {
    const { gen, fake } = generator((rate) => sine(rate, 440, 1200));
    const { wav, info } = await gen.generate(ask());
    // The header, field by field: PCM, mono, 8000 Hz, 16-bit, little-endian, sizes consistent.
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt32LE(28)).toBe(16000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(checkWav(wav, 8000).issues).toEqual([]);
    expect(info).toMatchObject({ sampleRate: 8000, channels: 1, bitsPerSample: 16, converted: false, sourceSampleRate: 8000, bytes: wav.length, chars: 23 });
    expect(info.durationMs).toBe(1200);
    // The provider was asked for the same format directly: mono, 16-bit, little-endian, 8 kHz.
    expect(fake.calls).toEqual([{ text: 'Welcome to our company.', rate: 8000, channels: 1, bitDepth: 16, endianness: 'little-endian' }]);
  });

  it('is deterministic, so adding the same generated audio twice is one library entry (content hash preserved)', async () => {
    const { gen } = generator((rate) => sine(rate, 440, 800));
    const a = (await gen.generate(ask())).wav;
    const b = (await gen.generate(ask())).wav;
    expect(sha256(a)).toBe(sha256(b));
    const assets = new IvrAssetStore({ dir: null, sampleRate: () => 8000 });
    const first = assets.add(a, 'Welcome');
    const second = assets.add(b, 'Welcome again');
    expect(first.duplicate).toBe(false);
    expect(first.asset.id).toBe(sha256(a)); // the id is the hash of the generated bytes, exactly as for an upload
    expect(second.duplicate).toBe(true);
    expect(assets.readWav(first.asset.id)!.equals(a)).toBe(true); // stored untouched
  });

  it('converts when the provider cannot return 8 kHz, and says so', async () => {
    const file = defaultRegistry();
    const entry = file.models.find((m) => m.stage === 'tts' && m.id === 'cartesia')!;
    (entry.options as { sampleRates: number[] }).sampleRates = [16000, 24000];
    const built = buildRegistry(file);
    expect(built.issues).toEqual([]);
    setActiveRegistry(built.registry!);
    const { gen, fake } = generator((rate) => sine(rate, 800, 1000));
    const { wav, info } = await gen.generate(ask());
    expect(fake.calls[0].rate).toBe(16000);
    expect(info).toMatchObject({ converted: true, sourceSampleRate: 16000, sampleRate: 8000 });
    expect(checkWav(wav, 8000).issues).toEqual([]);
    expect(info.durationMs).toBe(1000);
    expect(rms(wav.subarray(44), 1000, 7000) / 12000).toBeGreaterThan(0.68);
  });

  it('passes the chosen voice and provider model through to the client, and defaults the voice', async () => {
    const { gen, selections } = generator((rate) => sine(rate, 440, 500));
    await gen.generate(ask({ voice: 'Some Voice', providerModel: undefined }));
    await gen.generate(ask());
    expect(selections[0]).toEqual({ key: 'cartesia', voice: 'Some Voice', model: null });
    expect(selections[1].voice.length).toBeGreaterThan(0); // the registry's default voice
  });

  describe('what is refused, and why', () => {
    it('needs the billing confirmation', async () => {
      const { gen, fake } = generator((r) => sine(r, 440, 500));
      const e = await rejection(gen.generate(ask({ confirmBilling: undefined })));
      expect(e).toMatchObject({ code: 'invalid_tts_request', status: 400 });
      expect(fake.calls).toHaveLength(0);
    });

    it('rejects empty and too-long text before calling the provider', async () => {
      const { gen, fake } = generator((r) => sine(r, 440, 500));
      expect((await rejection(gen.generate(ask({ text: '   ' })))).message).toMatch(/Enter the announcement text/);
      const long = await rejection(gen.generate(ask({ text: 'x'.repeat(TTS_GENERATE_LIMITS.maxChars + 1) })));
      expect(long.message).toMatch(/limit is 1000/);
      expect(fake.calls).toHaveLength(0);
    });

    it('rejects an unknown voice model and a provider model the entry does not offer', async () => {
      const { gen } = generator((r) => sine(r, 440, 500));
      expect((await rejection(gen.generate(ask({ model: 'nope' })))).message).toMatch(/not a voice model/);
      expect((await rejection(gen.generate(ask({ providerModel: 'not-a-model' })))).message).toMatch(/not a model of/);
      expect((await rejection(gen.generate(ask({ model: '' })))).message).toMatch(/Choose a voice model/);
    });

    it('says the key is missing, naming the variable and never a value', async () => {
      const { gen, fake } = generator((r) => sine(r, 440, 500), aiEnv({ CARTESIA_API_KEY: undefined }));
      const e = await rejection(gen.generate(ask()));
      expect(e).toMatchObject({ code: 'tts_unavailable', status: 409 });
      expect(e.message).toMatch(/CARTESIA_API_KEY/);
      expect(e.message).not.toContain(SECRET);
      expect(fake.calls).toHaveLength(0);
    });

    it('says a switched-off model is switched off', async () => {
      const file = defaultRegistry();
      file.models.find((m) => m.stage === 'tts' && m.id === 'cartesia')!.enabled = false;
      setActiveRegistry(buildRegistry(file).registry!);
      const { gen } = generator((r) => sine(r, 440, 500));
      expect((await rejection(gen.generate(ask()))).message).toMatch(/switched off in the Model Hub/);
    });

    it('turns a provider failure into a readable error with no key in it', async () => {
      const { gen } = generator(() => new AiProviderError('cartesia', 'tts', `HTTP 401 for key ${SECRET}`, { status: 401 }));
      const e = await rejection(gen.generate(ask()));
      expect(e).toMatchObject({ code: 'tts_failed', status: 502 });
      expect(e.message).toMatch(/Cartesia|could not generate/i);
      expect(JSON.stringify([e.message, e.issues])).not.toContain(SECRET);
    });

    it('rejects silent, empty and odd-length audio from the provider', async () => {
      for (const [audio, words] of [
        [Buffer.alloc(16000), /silent/],
        [Buffer.alloc(0), /empty/],
        [Buffer.from([1, 2, 3]), /whole 16-bit samples/],
      ] as const) {
        const { gen } = generator(() => audio);
        const e = await rejection(gen.generate(ask()));
        expect(e).toMatchObject({ code: 'invalid_asset', status: 502 });
        expect(e.message).toMatch(words);
      }
    });

    it('rejects audio shorter than the library minimum or longer than its limit', async () => {
      expect((await rejection(generator((r) => sine(r, 440, 20)).gen.generate(ask()))).message).toMatch(/too short/);
      const long = await rejection(generator((r) => sine(r, 440, 125_000)).gen.generate(ask()));
      expect(long.message).toMatch(/MB|long/);
    });

    it('allows one generation at a time', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fake = fakeProvider((r) => sine(r, 440, 500));
      const slow: TtsProvider = { name: 'slow', synthesize: async (t, f, s) => (await gate, fake.provider.synthesize(t, f, s)) };
      const gen = new TtsGenerator({ config: () => makeConfig(), env: () => aiEnv(), sampleRate: () => 8000, createProvider: () => slow });
      const first = gen.generate(ask());
      const second = await rejection(gen.generate(ask()));
      expect(second).toMatchObject({ code: 'tts_busy', status: 429 });
      release();
      await first;
      await expect(gen.generate(ask())).resolves.toBeTruthy(); // free again
    });
  });

  it('lists every voice model with whether it can be used, and never a key', () => {
    const { gen } = generator((r) => sine(r, 440, 500), aiEnv({ DEEPGRAM_API_KEY: undefined }));
    const view = gen.options();
    expect(view.sampleRate).toBe(8000);
    expect(view.models.length).toBeGreaterThan(3);
    const cartesia = view.models.find((m) => m.key === 'cartesia')!;
    expect(cartesia).toMatchObject({ available: true, unavailableReason: null, current: true });
    expect(cartesia.voices.length + (cartesia.defaultVoice ? 1 : 0)).toBeGreaterThan(0);
    const deepgram = view.models.find((m) => m.protocol === 'deepgram-tts')!;
    expect(deepgram.available).toBe(false);
    expect(deepgram.unavailableReason).toMatch(/DEEPGRAM_API_KEY/);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

describe('the API, with the real provider client and a fake provider server', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function harness(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, env: Record<string, string | undefined> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-tts-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', ...env }),
        providers: createMockProviders({ stt: ['hello'], llm: ['Hi there.'] }),
        fetchImpl: fetchImpl as never,
        allowSimulatedHardware: true,
        transports: () => ({ source: new ManualAudioSource(FORMAT_8K, true), sink: new CollectingAudioSink(FORMAT_8K, true, 0) }),
      },
    });
    await modem.initialize();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const api = (method: 'get' | 'post', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    return { server, api };
  }

  it('generates through the Cartesia client at 8 kHz, then the result uploads to the library like any WAV', async () => {
    const seen: Array<{ url: string; auth: string | null; body: any }> = [];
    const { api, server } = await harness(async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return new Response(sine(8000, 500, 1500), { status: 200 });
    });

    const options = await api('get', '/api/ivr/generate/options');
    expect(options.status).toBe(200);
    expect(options.body.models.find((m: any) => m.key === 'cartesia')).toMatchObject({ available: true });
    expect(JSON.stringify(options.body)).not.toContain(SECRET);

    const res = await api('post', '/api/ivr/generate').send({ text: 'Press 1 for sales.', model: 'cartesia', voice: 'Test Voice', confirmBilling: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // The provider call: the IVR rate, raw 16-bit PCM, the text and the voice, with the key from the credential store (not from the request).
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${SECRET}`);
    expect(seen[0].body).toMatchObject({ transcript: 'Press 1 for sales.', output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 8000 } });
    expect(seen[0].body.voice.id).toBe('Test Voice');

    const wav = Buffer.from(res.body.audioWavBase64, 'base64');
    expect(checkWav(wav, 8000).issues).toEqual([]);
    expect(res.body.info).toMatchObject({ sampleRate: 8000, channels: 1, bitsPerSample: 16, durationMs: 1500, converted: false });
    // Generating stored nothing.
    expect((await api('get', '/api/ivr/assets')).body.assets).toEqual([]);

    // Adding it is the ordinary upload: same route, same checks, same content hash.
    const up = await api('post', '/api/ivr/assets?name=Sales').set('Content-Type', 'audio/wav').send(wav);
    expect(up.status).toBe(201);
    expect(up.body.asset.id).toBe(sha256(wav));
    const again = await api('post', '/api/ivr/assets?name=Sales%20again').set('Content-Type', 'audio/wav').send(wav);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const stored = await api('get', `/api/ivr/assets/${up.body.asset.id}/audio`);
    expect(Buffer.from(stored.body).equals(wav)).toBe(true);
    expect(server.ivrAssets.list()).toHaveLength(1);
  });

  it('answers with readable errors for a missing key, a provider failure and invalid audio', async () => {
    const noKey = await harness(async () => new Response('', { status: 200 }), { CARTESIA_API_KEY: undefined, GROQ_API_KEY: SECRET });
    const missing = await noKey.api('post', '/api/ivr/generate').send({ text: 'Hi', model: 'cartesia', confirmBilling: true });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ success: false, code: 'IVR_TTS_UNAVAILABLE' });
    expect(missing.body.error).toMatch(/CARTESIA_API_KEY/);

    const failing = await harness(async () => new Response(`denied for ${SECRET}`, { status: 401 }));
    const failed = await failing.api('post', '/api/ivr/generate').send({ text: 'Hi', model: 'cartesia', confirmBilling: true });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('IVR_TTS_FAILED');
    expect(JSON.stringify(failed.body)).not.toContain(SECRET);

    const silent = await harness(async () => new Response(Buffer.alloc(16000), { status: 200 }));
    const invalid = await silent.api('post', '/api/ivr/generate').send({ text: 'Hi', model: 'cartesia', confirmBilling: true });
    expect(invalid.status).toBe(502);
    expect(invalid.body.code).toBe('IVR_INVALID_ASSET');
    expect(invalid.body.error).toMatch(/silent/);

    const noConfirm = await silent.api('post', '/api/ivr/generate').send({ text: 'Hi', model: 'cartesia' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.code).toBe('IVR_INVALID_TTS_REQUEST');
  });

  it('needs the gateway API key like every other IVR route', async () => {
    const { server } = await harness(async () => new Response(sine(8000, 500, 500), { status: 200 }));
    expect((await request(server.app).post('/api/ivr/generate').send({})).status).toBe(401);
    expect((await request(server.app).get('/api/ivr/generate/options')).status).toBe(401);
  });
});
