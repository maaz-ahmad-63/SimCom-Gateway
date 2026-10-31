import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { playPcmPaced } from '../../src/adapters/audio/paced-playback.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { AudioFormat, CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { CartesiaTts, DeepgramTts } from '../../src/ai/providers/tts.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, fakeFetch, FORMAT_8K, SECRET, sleep } from './helpers.js';

/**
 * Changing the TTS voice and the gateway sample rate from the dashboard stopped the agent from greeting callers and made
 * its speech choppy. Three separate things were behind it, and each has a test here:
 *   1. the settings save clears the audio confirmations and switches automatic replies off (so calls attach passively and
 *      nobody is greeted), and said nothing about it;
 *   2. nothing on the attach path compared the gateway rate with the rate the module is actually using, so 16 kHz audio
 *      was written to a module still running at 8 kHz;
 *   3. an attach that could not happen because the configuration was invalid was skipped without a word.
 */
const KEY = 'tts-rate-test-key';
const FORMAT_16K: AudioFormat = { ...FORMAT_8K, sampleRate: 16000 };
const AUTO = { AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2', AI_AUTO_ACTIVATE_USB_AUDIO: 'true', AI_AUTO_HANDLE: 'inbound' };
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };
const signal = () => new AbortController().signal;
const base = { apiKey: SECRET, timeoutMs: 2000, maxRetries: 0 };

describe('TTS rate and voice: configuration', () => {
  it('rejects 160000 Hz (a typo for 16000) instead of using it, and never calls it "not set"', () => {
    const result = loadAiConfig(aiEnv({ AI_AUDIO_SAMPLE_RATE: '160000' }));
    expect(result.errors).toContain('AI_AUDIO_SAMPLE_RATE must be an integer between 8000 and 48000 (got 160000)');
    expect(result.usable).toBe(false);
    expect(result.passiveUsable).toBe(false);
    expect(result.config.audio.format).toBeNull();
  });

  it('accepts the rates the module and Cartesia both support, and refuses a rate Cartesia cannot make', () => {
    for (const rate of ['8000', '16000']) expect(loadAiConfig(aiEnv({ AI_AUDIO_SAMPLE_RATE: rate })).errors, rate).toEqual([]);
    expect(loadAiConfig(aiEnv({ AI_AUDIO_SAMPLE_RATE: '11025' })).errors.join(' ')).toMatch(/not a raw rate Cartesia supports/);
    const kyle = loadAiConfig(aiEnv({ AI_AUDIO_SAMPLE_RATE: '16000', AI_TTS_VOICE: 'kyle' }));
    expect(kyle.errors).toEqual([]);
    expect(kyle.config.tts).toEqual({ key: 'cartesia', voice: 'kyle', model: null });
  });

  it('refuses to store a bad rate through the settings API and keeps the saved one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-rate-'));
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only' }), providers: createMockProviders(), allowSimulatedHardware: true },
    });
    try {
      const put = (body: object) => request(server.app).put('/api/ai/settings').set('x-api-key', KEY).send(body);
      expect((await put({ audioSampleRate: 16000 })).body.audioSampleRate).toBe(16000);
      for (const bad of [160000, 7999, 16000.5, '16000', -1]) {
        const res = await put({ audioSampleRate: bad });
        expect(res.status, String(bad)).toBe(400);
      }
      const state = await request(server.app).get('/api/ai/settings').set('x-api-key', KEY);
      expect(state.body.audioSampleRate).toBe(16000);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TTS provider output format', () => {
  it('asks Cartesia for raw signed 16-bit PCM at exactly the gateway rate, with the chosen voice', async () => {
    const audio = Buffer.alloc(3200, 5);
    const { impl, requests } = fakeFetch([new Response(audio, { status: 200 })]);
    const pcm = await new CartesiaTts({ ...base, fetchImpl: impl, voice: 'kyle', language: 'en' }).synthesize('Hello.', FORMAT_16K, signal());
    expect(pcm.equals(audio)).toBe(true); // returned untouched: no resampling is needed or done
    expect(JSON.parse(requests[0].body as string)).toMatchObject({
      voice: { id: 'c961b81c-a935-4c17-bfb3-ba2239de8c2f' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
    });
  });

  it('never sends a request for a rate outside what the engine can play', async () => {
    const { impl, requests } = fakeFetch([new Response(Buffer.alloc(100), { status: 200 })]);
    const tts = new CartesiaTts({ ...base, fetchImpl: impl, voice: 'kyle', language: 'en' });
    await expect(tts.synthesize('x', { ...FORMAT_8K, sampleRate: 160000 }, signal())).rejects.toThrow(/Unsupported sample rate 160000/);
    expect(requests).toHaveLength(0);
  });

  it('asks Deepgram for linear16 at the gateway rate and rejects a WAV that says another rate', async () => {
    const raw = fakeFetch([new Response(Buffer.alloc(640, 1), { status: 200 })]);
    await new DeepgramTts({ ...base, fetchImpl: raw.impl, voice: 'aura-asteria-en' }).synthesize('Hi.', FORMAT_16K, signal());
    const url = new URL(raw.requests[0].url);
    expect([url.searchParams.get('encoding'), url.searchParams.get('sample_rate'), url.searchParams.get('container')]).toEqual(['linear16', '16000', 'none']);

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + 640, 4);
    header.write('WAVEfmt ', 8, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24); // the provider answered at 8 kHz although 16 kHz was asked for
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(640, 40);
    const wrong = fakeFetch([new Response(Buffer.concat([header, Buffer.alloc(640)]), { status: 200 })]);
    await expect(new DeepgramTts({ ...base, fetchImpl: wrong.impl, voice: 'aura-asteria-en' }).synthesize('Hi.', FORMAT_16K, signal())).rejects.toThrow(/WAV is 8000 Hz.*expected 16000 Hz/);
  });

  it('paces playback in 20 ms frames of the configured rate, not of another one', async () => {
    const sizes: number[] = [];
    const pcm = Buffer.alloc(16000 * 2 * 0.2, 1); // 200 ms at 16 kHz
    const result = await playPcmPaced(async (chunk) => void sizes.push(chunk.length), pcm, { sampleRate: 16000, leadFrames: 2, shouldStop: () => null });
    expect(result.stoppedBy).toBeNull();
    expect(new Set(sizes)).toEqual(new Set([640])); // 16000 * 0.02 * 2 bytes
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(pcm.length);
  });
});

describe('automatic attachment, greeting and the module rate', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  /** `module`: what AT+CPCMFRM? answers (0 = 8 kHz, 1 = 16 kHz), or null for a module that does not say. */
  async function harness(options: { env?: Record<string, string | undefined>; module?: 0 | 1 | null; format?: AudioFormat } = {}) {
    const format = options.format ?? FORMAT_8K;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-rate-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      if (command === 'AT+CPCMFRM?' && options.module !== null && options.module !== undefined) return `+CPCMFRM: ${options.module}\r\n\r\nOK`;
      return original(command, timeoutMs);
    };
    const source = new ManualAudioSource(format, true);
    const sink = new CollectingAudioSink(format, true);
    const providers = createMockProviders({ stt: ['first question'], llm: ['First answer here.'] });
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', AI_PLAYBACK_GUARD_MS: '0', AI_GREETING: 'Hi there.', ...options.env }),
        providers,
        allowSimulatedHardware: true,
        transports: () => ({ source, sink }),
        idleWaitsMs: [60_000, 60_000, 60_000],
        automationAudioWaitMs: 1500,
        automationPollMs: 20,
        automationActivation: { settleMs: 0, retryMs: 20, attempts: 3 },
      },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const alerts: Array<{ level: string; message: string }> = [];
    server.eventBus.on('gateway:alert', (a) => alerts.push({ level: a.level, message: a.message }));
    const urc = (raw: string, type: string, extra: object = {}) =>
      modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false, ...extra } as never);
    const ring = () => {
      urc('RING', 'RING');
      urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
    };
    const api = (method: 'get' | 'post' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const said = (re: RegExp) => alerts.some((a) => re.test(a.message));
    return { server, modem, source, sink, providers, alerts, commands, ring, api, said };
  }

  it('attaches and greets at 8 kHz when the module is at 8 kHz (the known-good setup)', async () => {
    const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' }, module: 0 });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
    expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('active');
    expect(h.providers.tts.requests).toEqual(['Hi there.']);
    expect(h.sink.played[0].length).toBe(6080); // 380 ms of 8 kHz 16-bit mono
  });

  it('greets in the format it was configured for: 16 kHz audio when the module is at 16 kHz', async () => {
    const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_AUDIO_SAMPLE_RATE: '16000', AI_TTS_VOICE: 'kyle' }, module: 1, format: FORMAT_16K });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
    expect(h.sink.played[0].length).toBe(12160); // the same 380 ms, at twice the byte rate
    expect(h.sink.played[0].length % 2).toBe(0);
  });

  it('attaches when the module does not report a rate (nothing to compare, so nothing is blocked)', async () => {
    const h = await harness({ env: AUTO, module: null });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
  });

  it('does not attach, and says why, when the gateway is set to 16 kHz but the module is still at 8 kHz', async () => {
    const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_AUDIO_SAMPLE_RATE: '16000' }, module: 0, format: FORMAT_16K });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'), { timeout: 4000 });
    await vi.waitFor(() => expect(h.said(/waiting to attach.*module reports 8000 Hz \(AT\+CPCMFRM=0\) but the gateway is set to 16000 Hz/)).toBe(true), { timeout: 4000 });
    await sleep(100);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    expect(h.sink.playCalls).toBe(0); // nothing was written at the wrong rate
    expect(h.providers.tts.requests).toHaveLength(0);
  });

  it('blocks the other way round too (gateway 8 kHz, module 16 kHz), for passive listening as well', async () => {
    const h = await harness({ env: AUTO, module: 1 });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.said(/module reports 16000 Hz \(AT\+CPCMFRM=1\) but the gateway is set to 8000 Hz/)).toBe(true), { timeout: 4000 });
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
  });

  it('refuses a manual attach with the same reason instead of attaching and breaking up', async () => {
    const h = await harness({ env: { ...VERIFIED, AI_AUDIO_SAMPLE_RATE: '16000' }, module: 0, format: FORMAT_16K });
    const call = await h.server.callManager.dial({ phoneNumber: '+919876543210' });
    h.modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
    await h.server.callManager.activateUsbAudioDiagnostic!();
    await sleep(60);
    const res = await h.api('post', `/api/ai/calls/${call.id}/arm`).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/module reports 8000 Hz.*gateway is set to 16000 Hz/);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
  });

  it('says that the AI could not attach when the configuration is invalid (160000 Hz), and leaves the call alone', async () => {
    const h = await harness({ env: { ...AUTO, AI_AUDIO_SAMPLE_RATE: '160000' }, module: 0 });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.said(/AI_AUDIO_SAMPLE_RATE must be an integer between 8000 and 48000/)).toBe(true), { timeout: 4000 });
    expect(h.alerts.find((a) => /AI_AUDIO_SAMPLE_RATE must be/.test(a.message))!.message).not.toMatch(/is not set/);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    expect(h.commands.filter((c) => /^AT\+CPCMREG=1$/.test(c))).toHaveLength(0); // no USB audio is registered for nobody
  });

  it('tells the operator, once, why a call they answered by hand got no AI when the configuration is invalid', async () => {
    const h = await harness({ env: { AI_AUTO_HANDLE: 'inbound', AI_AUDIO_SAMPLE_RATE: '160000' }, module: 0 });
    h.ring();
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()?.state).toBe('INBOUND_RINGING'));
    await h.server.callManager.answer();
    await vi.waitFor(() => expect(h.said(/AI agent not attached: .*\(got 160000\)/)).toBe(true), { timeout: 4000 });
    await sleep(100);
    expect(h.alerts.filter((a) => /AI agent not attached/.test(a.message))).toHaveLength(1);
    expect(h.alerts.find((a) => /AI agent not attached/.test(a.message))!.level).toBe('error');
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'); // the call itself is untouched
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
  });

  it('stays silent when the AI is switched off on purpose', async () => {
    const h = await harness({ env: { AI_ENABLED: 'false', AI_AUTO_HANDLE: 'inbound' }, module: 0 });
    h.ring();
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()?.state).toBe('INBOUND_RINGING'));
    await h.server.callManager.answer();
    await sleep(150);
    expect(h.alerts.filter((a) => /AI agent not attached/.test(a.message))).toEqual([]);
  });
});

describe('what a sample-rate change resets', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  /**
   * A gateway whose saved settings are what the dashboard stored after the audio was confirmed: both confirmations and automatic
   * replies on, 8 kHz. (The attestation endpoints refuse simulated hardware, so the saved settings are written into the scratch
   * database before the gateway starts, the way an earlier session would have left them.)
   */
  async function confirmedSetup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-rate-'));
    const dbPath = path.join(dir, 'g.sqlite');
    const build = () =>
      createGatewayServer({
        config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: dbPath, audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
        modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
        audio: new MockAudioAdapter(),
        instanceLockDir: dir,
        ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only' }), providers: createMockProviders(), allowSimulatedHardware: true },
      });
    await build().close(); // creates the schema
    const db = new Database(dbPath);
    const at = new Date().toISOString();
    db.prepare('INSERT INTO gateway_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'ai.settings',
      JSON.stringify({
        mode: 'passive',
        audioSampleRate: 8000,
        ttsVoice: 'katie',
        tts: 'cartesia',
        automation: { autoAnswer: true, autoReplies: true, maxCallSeconds: 900 },
        attestations: {
          inbound: { confirmedAt: at, note: 'The transcript matched what I said on the test call' },
          outbound: { confirmedAt: at, note: 'Remote party heard both blind test tones clearly' },
        },
        updatedAt: at,
      }),
      at
    );
    db.close();
    const server = build();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const api = (method: 'get' | 'post' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const alerts: Array<{ level: string; message: string }> = [];
    server.eventBus.on('gateway:alert', (a) => alerts.push({ level: a.level, message: a.message }));
    const before = (await api('get', '/api/ai/settings')).body;
    expect(before.automation.autoReplies).toBe(true);
    expect(before.attestations.inbound.confirmed).toBe(true);
    return { api, alerts };
  }

  it('keeps the confirmations with their notes, makes them not count at the new rate, says so, and they count again when switched back', async () => {
    const { api, alerts } = await confirmedSetup();
    const res = await api('put', '/api/ai/settings').send({ audioSampleRate: 16000, ttsVoice: 'kyle' });
    expect(res.status).toBe(200);
    for (const kind of ['inbound', 'outbound'] as const) {
      expect(res.body.attestations[kind]).toMatchObject({ confirmed: false, stale: true, source: 'stored', sampleRate: 8000 });
      expect(res.body.attestations[kind].note).toMatch(/.{10,}/); // the note is kept, not erased
      expect(res.body.attestations[kind].confirmedAt).toEqual(expect.any(String));
      expect(res.body.attestations[kind].staleReason).toMatch(/Confirmed at 8000 Hz; the gateway is now set to 16000 Hz/);
    }
    expect(res.body.automation.autoReplies).toBe(true); // the operator's choice is kept; readiness keeps replies off meanwhile
    const notice = alerts.find((a) => /sample rate/i.test(a.message));
    expect(notice?.level).toBe('warn');
    expect(notice?.message).toMatch(/16000 Hz/);
    expect(notice?.message).toMatch(/confirmations are kept/);
    expect(notice?.message).toMatch(/re-verify/);
    expect(notice?.message).toMatch(/passive/);
    expect(notice?.message).toMatch(/AT\+CPCMFRM/); // the module has to use the same rate

    const back = await api('put', '/api/ai/settings').send({ audioSampleRate: 8000 });
    expect(back.body.attestations.inbound).toMatchObject({ confirmed: true, stale: false, sampleRate: 8000 });
    expect(back.body.attestations.outbound).toMatchObject({ confirmed: true, stale: false });
    expect(alerts.some((a) => /made at this rate and count again/.test(a.message))).toBe(true);
  });

  it('stays quiet when nothing was reset (a voice change alone, or the same rate again)', async () => {
    const { api, alerts } = await confirmedSetup();
    await api('put', '/api/ai/settings').send({ ttsVoice: 'kyle' });
    await api('put', '/api/ai/settings').send({ audioSampleRate: 8000 });
    expect(alerts.filter((a) => /sample rate/i.test(a.message))).toEqual([]);
    expect((await api('get', '/api/ai/settings')).body.automation.autoReplies).toBe(true);
  });
});
