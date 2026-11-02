import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { ProviderSet } from '../../src/ai/providers/types.js';
import { buildWav } from '../../src/diagnostics/pcm-tools.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, fakeFetch, json, loudNoisePcm, noiseFloorPcm, SECRET, sleep, speechPcm } from './helpers.js';

const API_KEY = 'ai-control-test-key';
const MASTER = 'a-long-master-key-for-tests-only';
const NEW_KEY = 'dg-live-ABCDEFGH1234567890WXYZ';

describe('AI control center (settings, credentials, passive mode, tests, usage)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  interface HarnessOptions {
    env?: Record<string, string | undefined>;
    providers?: ProviderSet;
    fetchImpl?: ReturnType<typeof fakeFetch>['impl'];
    mode?: 'off' | 'passive' | 'active';
    allowSimulatedHardware?: boolean;
    dir?: string;
  }

  async function harness(options: HarnessOptions = {}) {
    const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ai-control-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const audio = new MockAudioAdapter();
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true);
    const written: number[] = [];
    const originalWrite = audio.writeAudioChunk.bind(audio);
    audio.writeAudioChunk = async (chunk: Buffer) => {
      written.push(chunk.length);
      return originalWrite(chunk);
    };
    const commands: string[] = [];
    const originalCommand = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return originalCommand(command, timeoutMs);
    };
    const server: GatewayServerInstance = createGatewayServer({
      config: {
        modemDriver: 'mock',
        gatewayApiKey: API_KEY,
        sqliteDbPath: path.join(dir, 'gateway.sqlite'),
        audioDumpDir: path.join(dir, 'recordings'),
        enableUsbAudioDiagnostic: true,
      },
      modem,
      audio,
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_SECRETS_MASTER_KEY: MASTER, ...options.env }),
        providers: options.providers,
        fetchImpl: options.fetchImpl,
        allowSimulatedHardware: options.allowSimulatedHardware ?? true,
        mode: options.mode,
        transports: () => ({ source, sink }),
      },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      if (!options.dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (event) => events.push(event));
    const api = (method: 'get' | 'post' | 'put' | 'delete', url: string) => request(server.app)[method](url).set('x-api-key', API_KEY);
    const startCall = async () => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60);
      return call;
    };
    const callerSpeaks = () => {
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1200));
    };
    return { server, modem, audio, source, sink, api, events, commands, written, startCall, callerSpeaks, dir };
  }

  // -------------------------------------------------------------------------------- permissions
  it('protects every new endpoint with the gateway API key', async () => {
    const h = await harness();
    const calls: Array<['get' | 'post' | 'put' | 'delete', string]> = [
      ['get', '/api/ai/state'],
      ['get', '/api/ai/settings'],
      ['put', '/api/ai/settings'],
      ['put', '/api/ai/agent'],
      ['get', '/api/ai/credentials'],
      ['put', '/api/ai/credentials/DEEPGRAM_API_KEY'],
      ['delete', '/api/ai/credentials/DEEPGRAM_API_KEY'],
      ['post', '/api/ai/credentials/DEEPGRAM_API_KEY/validate'],
      ['post', '/api/ai/mode'],
      ['post', '/api/ai/attestations/inbound'],
      ['post', '/api/ai/test/llm'],
      ['post', '/api/ai/test/tts'],
      ['post', '/api/ai/test/stt'],
      ['get', '/api/ai/recordings'],
      ['get', '/api/ai/usage'],
      ['get', '/api/ai/turns'],
      ['delete', '/api/ai/turns'],
      ['get', '/api/ai/events'],
    ];
    for (const [method, url] of calls) {
      expect((await request(h.server.app)[method](url)).status, `${method} ${url}`).toBe(401);
    }
  });

  // -------------------------------------------------------------------------------- settings
  it('validates and persists provider selections across a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-persist-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const first = await harness({ dir });
    const saved = await first.api('put', '/api/ai/settings').send({ stt: 'groq_whisper', llm: 'openai_gpt_5_4_mini', tts: 'deepgram', ttsVoice: 'aura-luna-en', language: 'en-US' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ stt: 'groq_whisper', llm: 'openai_gpt_5_4_mini', tts: 'deepgram', ttsVoice: 'aura-luna-en' });
    await first.server.close();
    cleanup.pop();

    const second = await harness({ dir });
    const view = (await second.api('get', '/api/ai/settings')).body;
    expect(view).toMatchObject({ stt: 'groq_whisper', llm: 'openai_gpt_5_4_mini', tts: 'deepgram', ttsVoice: 'aura-luna-en' });
  });

  it('rejects unknown, not-ported or malformed settings and changes nothing', async () => {
    const h = await harness();
    const before = (await h.api('get', '/api/ai/settings')).body;
    const bad: Array<Record<string, unknown>> = [
      { stt: 'no-such-model' },
      { stt: 'assemblyai' }, // listed but not ported
      { tts: 'murf' }, // listed but not ported
      { tts: 'deepgram', ttsVoice: 'flux-alexis-en' }, // v2 streaming voice, not ported
      { language: 'English please' },
      { audioSampleRate: 123 },
      { params: { maxTokens: 999999 } },
      { surprise: true }, // strict: unknown fields are errors
    ];
    for (const body of bad) {
      const res = await h.api('put', '/api/ai/settings').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.api('get', '/api/ai/settings')).body).toEqual(before);
  });

  it('does not keep a TTS voice that belongs to a different provider', async () => {
    const h = await harness();
    await h.api('put', '/api/ai/settings').send({ tts: 'deepgram', ttsVoice: 'aura-luna-en' });
    const view = (await h.api('put', '/api/ai/settings').send({ tts: 'cartesia' })).body;
    expect(view.tts).toBe('cartesia');
    expect(view.ttsVoice).toBe('katie');
  });

  it('offers only what the gateway can run, and labels STT as batch (no partial transcripts)', async () => {
    const h = await harness();
    const catalog = (await h.api('get', '/api/ai/catalog')).body;
    const stt = Object.fromEntries(catalog.stt.map((o: any) => [o.key, o]));
    expect(stt['nova-3']).toMatchObject({ implemented: true, streaming: false });
    expect(stt.assemblyai).toMatchObject({ implemented: false });
    expect(stt.assemblyai.unavailableReason).toMatch(/Not ported/);
    const llm = Object.fromEntries(catalog.llm.map((o: any) => [o.key, o]));
    expect(llm.gemini_3_flash.implemented).toBe(true);
    expect(llm.groq_qwen_3_8_27b.supportedParams).toEqual(['maxTokens']);
    expect(llm.groq_qwen_3_8_27b.fixedParams).toMatchObject({ temperature: 0.4 });
  });

  // -------------------------------------------------------------------------------- agent
  it('keeps one editable agent profile, applied to the next conversation, with each call isolated', async () => {
    const providers = createMockProviders({ stt: ['hello', 'second caller'], llm: ['Hi there, how can I help you today?'] });
    const h = await harness({ providers, mode: 'active', env: { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' } });
    const saved = await h.api('put', '/api/ai/agent').send({ name: 'Front desk', instructions: 'You answer for Acme Dental.', greeting: '', allowHangup: false });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'Front desk', instructions: 'You answer for Acme Dental.' });
    expect((await h.api('get', '/api/ai/agent')).body.instructions).toBe('You answer for Acme Dental.');

    const first = await h.startCall();
    expect((await h.api('post', `/api/ai/calls/${first.id}/arm`)).status).toBe(200);
    h.callerSpeaks();
    await vi.waitFor(() => expect(providers.llm.requests).toHaveLength(1));
    expect(providers.llm.requests[0].system).toContain('You answer for Acme Dental.');
    expect(providers.llm.requests[0].messages).toEqual([{ role: 'user', content: 'hello' }]);
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1));

    h.modem.emit('urc', { raw: 'VOICE CALL: END: 3', type: 'VOICE_CALL_END', durationSeconds: 3, timestamp: new Date().toISOString(), isSimulated: false });
    await vi.waitFor(() => expect(h.server.aiOrchestrator.isAttached(first.id)).toBe(false));

    // A new call gets a fresh history: nothing from the first call is in its prompt.
    await h.api('put', '/api/ai/agent').send({ instructions: 'You answer for Beta Optical.' });
    const second = await h.startCall();
    expect((await h.api('post', `/api/ai/calls/${second.id}/arm`)).status).toBe(200);
    h.callerSpeaks();
    await vi.waitFor(() => expect(providers.llm.requests).toHaveLength(2));
    expect(providers.llm.requests[1].system).toContain('Beta Optical');
    expect(providers.llm.requests[1].system).not.toContain('Acme Dental');
    expect(providers.llm.requests[1].messages).toEqual([{ role: 'user', content: 'second caller' }]);
  });

  it('can be disabled from the dashboard, which makes the whole AI path inert', async () => {
    const providers = createMockProviders();
    const h = await harness({ providers });
    expect((await h.api('put', '/api/ai/agent').send({ enabled: false })).body.enabled).toBe(false);
    const state = (await h.api('get', '/api/ai/state')).body;
    expect(state.readiness.mode).toBe('off');
    const call = await h.startCall();
    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).status).toBe(409);
    expect(providers.stt.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------- credentials
  it('stores API keys encrypted, never returns them, and reports only a mask', async () => {
    const h = await harness({ env: { DEEPGRAM_API_KEY: undefined } });
    const put = await h.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: NEW_KEY });
    expect(put.status).toBe(200);
    const status = put.body.credentials.find((c: any) => c.name === 'DEEPGRAM_API_KEY');
    expect(status).toMatchObject({ source: 'stored', masked: '••••WXYZ', requiredBySelection: true });

    // Nothing the API can say contains the key, and the database never holds it in the clear.
    for (const url of ['/api/ai/state', '/api/ai/credentials', '/api/ai/settings', '/api/ai/readiness', '/api/ai/status']) {
      expect(JSON.stringify((await h.api('get', url)).body), url).not.toContain(NEW_KEY);
    }
    const rows = h.server.db.prepare('SELECT key, value FROM gateway_settings').all() as Array<{ key: string; value: string }>;
    expect(JSON.stringify(rows)).not.toContain(NEW_KEY);
    expect(rows.find((r) => r.key === 'ai.secret.DEEPGRAM_API_KEY')?.value.startsWith('v1:')).toBe(true);

    expect((await h.api('delete', '/api/ai/credentials/DEEPGRAM_API_KEY')).body.credentials.find((c: any) => c.name === 'DEEPGRAM_API_KEY').source).toBe('missing');
    expect(h.server.db.prepare("SELECT COUNT(*) AS n FROM gateway_settings WHERE key LIKE 'ai.secret.%'").get()).toEqual({ n: 0 });
  });

  it('reports a key from .env by source only and never echoes it', async () => {
    const h = await harness();
    const list = (await h.api('get', '/api/ai/credentials')).body.credentials;
    expect(list.find((c: any) => c.name === 'GROQ_API_KEY')).toMatchObject({ source: 'env', masked: null });
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it('refuses to store keys without a master key, and rejects unknown names and junk values', async () => {
    const h = await harness({ env: { AI_SECRETS_MASTER_KEY: '' } });
    const refused = await h.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: NEW_KEY });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/AI_SECRETS_MASTER_KEY/);
    expect((await h.api('get', '/api/ai/settings')).body.secretStorageAvailable).toBe(false);

    const withKey = await harness();
    expect((await withKey.api('put', '/api/ai/credentials/NOT_A_KEY').send({ value: NEW_KEY })).status).toBe(404);
    expect((await withKey.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: 'short' })).status).toBe(400);
    expect((await withKey.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: 'has spaces in the key' })).status).toBe(400);
  });

  it('keeps missing, invalid and unreachable apart when validating a key', async () => {
    const results = [json({ projects: [] }), json({ error: 'nope' }, 401), new Error('getaddrinfo ENOTFOUND')];
    const fetched = fakeFetch(results);
    const h = await harness({ fetchImpl: fetched.impl });

    const ok = await h.api('post', '/api/ai/credentials/DEEPGRAM_API_KEY/validate');
    expect(ok.body).toMatchObject({ check: 'ok' });
    const bad = await h.api('post', '/api/ai/credentials/DEEPGRAM_API_KEY/validate');
    expect(bad.body).toMatchObject({ check: 'invalid' });
    const down = await h.api('post', '/api/ai/credentials/DEEPGRAM_API_KEY/validate');
    expect(down.body).toMatchObject({ check: 'unreachable' });
    expect(down.body.detail).not.toContain('ENOTFOUND'); // raw network error text is not forwarded

    // The key was sent to the provider's listing endpoint only, as an auth header, never in the URL.
    expect(fetched.requests[0].url).toBe('https://api.deepgram.com/v1/projects');
    expect(fetched.requests[0].headers.authorization).toBe(`Token ${SECRET}`);
    expect(JSON.stringify(down.body)).not.toContain(SECRET);

    // A key that is absent is reported as such, not as invalid.
    const none = await harness({ env: { CARTESIA_API_KEY: undefined } });
    const missing = await none.api('post', '/api/ai/credentials/CARTESIA_API_KEY/validate');
    expect(missing.status).toBe(409);
    expect(missing.body.error).toMatch(/not set/);
  });

  // -------------------------------------------------------------------------------- readiness & mock mode
  it('never lets mock hardware make the agent ready', async () => {
    const h = await harness({ allowSimulatedHardware: false });
    const call = await h.startCall();
    const readiness = (await h.api('get', '/api/ai/readiness')).body;
    expect(readiness.simulatedHardware).toBe(true);
    expect(readiness.ok).toBe(false);
    expect(readiness.passiveOk).toBe(false);
    expect(readiness.checks.find((c: any) => c.name === 'hardware').status).toBe('fail');
    const arm = await h.api('post', `/api/ai/calls/${call.id}/arm`);
    expect(arm.status).toBe(409);
    expect(arm.body.blockers.join(' ')).toMatch(/hardware/);
    const attest = await h.api('post', '/api/ai/attestations/inbound').send({ note: 'I listened to the capture and it was clear' });
    expect(attest.status).toBe(409);
    expect(attest.body.error).toMatch(/Simulated hardware/);
    expect((await h.api('post', '/api/ai/mode').send({ mode: 'active' })).status).toBe(409);
  });

  it('starts passive: transcribes, never generates or sends a reply, and says so stage by stage', async () => {
    const providers = createMockProviders({ stt: ['Is the clinic open on Saturday?'], llm: ['Yes we are.'] });
    const h = await harness({ providers });
    const call = await h.startCall();
    expect((await h.api('get', '/api/ai/state')).body.settings.mode).toBe('passive');
    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).status).toBe(200);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true));
    await sleep(40);

    expect(providers.stt.calls).toHaveLength(1);
    expect(providers.llm.requests).toHaveLength(0);
    expect(providers.tts.requests).toHaveLength(0);
    expect(h.sink.playCalls).toBe(0);
    expect(h.written).toEqual([]); // nothing reached the audio port
    const turnEvents = h.events.filter((e) => e.turnId);
    const stages = new Map(turnEvents.map((e) => [e.stage, e.status]));
    expect(stages.get('pcm-capture')).toBe('ok');
    expect(stages.get('pcm-validation')).toBe('ok');
    expect(stages.get('stt-submit')).toBe('ok');
    expect(stages.get('stt-result')).toBe('ok');
    for (const stage of ['llm-request', 'llm-response', 'tts-generated', 'playback'] as const) {
      expect(stages.get(stage), stage).toBe('not-run');
    }
    expect(turnEvents.find((e) => e.stage === 'llm-request')?.detail).toMatch(/passive/);
    // The caller's words are not exposed unless the operator opted in.
    expect(JSON.stringify(h.events)).not.toContain('clinic open');
    expect(turnEvents.find((e) => e.stage === 'stt-result')?.data).toMatchObject({ textHidden: true });
    // And no call control or PCM command came from any of this.
    expect(h.commands.filter((c) => /CPCMREG|ATH|ATA|CHUP/.test(c))).toEqual(h.commands.filter((c) => /CPCMREG/.test(c)));
  });

  it('shows recognized text only after the operator turns transcripts on, and mock transcripts are never evidence', async () => {
    const providers = createMockProviders({ stt: ['Is the clinic open on Saturday?'] });
    const h = await harness({ providers });
    await h.api('put', '/api/ai/settings').send({ showTranscripts: true });
    const call = await h.startCall();
    await h.api('post', `/api/ai/calls/${call.id}/arm`);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.text)).toBe(true));
    expect(h.events.find((e) => e.stage === 'stt-result')?.text).toBe('Is the clinic open on Saturday?');

    // A scripted transcript says nothing about the real audio path.
    const attest = await h.api('post', '/api/ai/attestations/inbound').send({ note: 'The transcript matched what I said' });
    expect(attest.status).toBe(409);
    expect(attest.body.error).toMatch(/No live transcript from real caller audio/);
  });

  it('records evidence from a real provider transcript, then lets the operator confirm, and active still needs everything', async () => {
    const transcript = json({ results: { channels: [{ alternatives: [{ transcript: 'hello this is a test', confidence: 0.9 }] }] } });
    const fetched = fakeFetch([transcript]);
    const h = await harness({ fetchImpl: fetched.impl });
    const call = await h.startCall();
    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).status).toBe(200);
    h.callerSpeaks();
    await vi.waitFor(() => expect(fetched.requests.length).toBeGreaterThan(0), { timeout: 3000 });
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true));
    expect(fetched.requests[0].url).toMatch(/deepgram/);
    expect(fetched.requests[0].headers.authorization).toBe(`Token ${SECRET}`);

    const tooShort = await h.api('post', '/api/ai/attestations/inbound').send({ note: 'ok' });
    expect(tooShort.status).toBe(400);
    const inbound = await h.api('post', '/api/ai/attestations/inbound').send({ note: 'Transcript matched what I said on the test call' });
    expect(inbound.status).toBe(200);
    expect(inbound.body.settings.attestations.inbound).toMatchObject({ confirmed: true, source: 'stored' });

    // Outbound is still unconfirmed, so replies stay blocked.
    const active = await h.api('post', '/api/ai/mode').send({ mode: 'active' });
    expect(active.status).toBe(409);
    expect(active.body.blockers.join(' ')).toMatch(/outbound-audio/);
    expect((await h.api('post', '/api/ai/attestations/outbound').send({ note: 'Remote party heard both blind test tones clearly' })).status).toBe(200);
    const enabled = await h.api('post', '/api/ai/mode').send({ mode: 'active' });
    expect(enabled.status).toBe(200);
    expect(enabled.body.mode).toBe('active');

    // Active lasts for this call only.
    h.modem.emit('urc', { raw: 'VOICE CALL: END: 3', type: 'VOICE_CALL_END', durationSeconds: 3, timestamp: new Date().toISOString(), isSimulated: false });
    await vi.waitFor(() => expect(h.server.aiRuntime.mode).toBe('passive'));
  });

  it('does not take a transcript of unvoiced noise as evidence that caller speech is intelligible', async () => {
    // Speech models can invent words from noise; that must not unlock the confirmation.
    const fetched = fakeFetch([json({ results: { channels: [{ alternatives: [{ transcript: 'Thank you.' }] }] } })]);
    const h = await harness({ fetchImpl: fetched.impl });
    const call = await h.startCall();
    await h.api('post', `/api/ai/calls/${call.id}/arm`);
    h.source.push(loudNoisePcm(1200));
    h.source.push(noiseFloorPcm(1200));
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true), { timeout: 3000 });
    const attest = await h.api('post', '/api/ai/attestations/inbound').send({ note: 'The transcript matched what I said' });
    expect(attest.status).toBe(409);
    expect(attest.body.error).toMatch(/No live transcript from real caller audio/);
  });

  // -------------------------------------------------------------------------------- failure paths
  it('reports a failed STT request on its own stage with the later stages not run, and never leaks the key', async () => {
    const fetched = fakeFetch([json({ err_msg: 'bad key' }, 401)]);
    const h = await harness({ fetchImpl: fetched.impl });
    const call = await h.startCall();
    await h.api('post', `/api/ai/calls/${call.id}/arm`);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'failed')).toBe(true), { timeout: 3000 });
    const failed = h.events.find((e) => e.stage === 'stt-result' && e.status === 'failed')!;
    expect(failed.detail).toMatch(/authentication failed/);
    expect(h.events.filter((e) => e.turnId === failed.turnId && e.stage === 'llm-request').every((e) => e.status === 'not-run')).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    const turns = (await h.api('get', '/api/ai/turns')).body.turns;
    expect(turns[0]).toMatchObject({ status: 'failed', reason: 'stt-failed' });
  });

  it('ends cleanly when the call ends mid-request, and active mode never outlives the call', async () => {
    const providers = createMockProviders({ stt: ['hello'], delays: { stt: 400 } });
    const h = await harness({ providers });
    const call = await h.startCall();
    await h.api('post', `/api/ai/calls/${call.id}/arm`);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-submit')).toBe(true));
    h.modem.emit('urc', { raw: 'VOICE CALL: END: 3', type: 'VOICE_CALL_END', durationSeconds: 3, timestamp: new Date().toISOString(), isSimulated: false });
    await vi.waitFor(() => expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false));
    expect(h.server.aiRuntime.mode).toBe('passive');
    expect(h.server.aiOrchestrator.hasActiveSession).toBe(false);
  });

  // -------------------------------------------------------------------------------- tests
  it('runs the LLM test as text only and only with explicit billing consent', async () => {
    const providers = createMockProviders({ llm: ['We are open nine to five.'] });
    const h = await harness({ providers });
    const refused = await h.api('post', '/api/ai/test/llm').send({ prompt: 'When are you open?' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/confirmBilling/);
    const ok = await h.api('post', '/api/ai/test/llm').send({ prompt: 'When are you open?', confirmBilling: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ reply: 'We are open nine to five.', mock: true, model: 'groq_qwen_3_8_27b' });
    expect(h.written).toEqual([]);
    expect(h.sink.playCalls).toBe(0);
    expect((await h.api('post', '/api/ai/test/llm').send({ prompt: '', confirmBilling: true })).status).toBe(400);
  });

  it('previews TTS to the browser only: generated, not transmitted, and never written to the audio port', async () => {
    const providers = createMockProviders();
    const h = await harness({ providers });
    const call = await h.startCall();
    expect(call.id).toBeTruthy();
    const res = await h.api('post', '/api/ai/test/tts').send({ text: 'Hello from the clinic.', confirmBilling: true });
    expect(res.status).toBe(200);
    expect(res.body.transmittedToCaller).toBe(false);
    const wav = Buffer.from(res.body.audioWavBase64, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(res.body.format).toMatch(/8000 Hz 16-bit mono LE PCM/);
    expect(h.written).toEqual([]);
    expect(h.sink.playCalls).toBe(0);
    const compat = (await h.api('get', '/api/ai/test/tts/compatibility')).body;
    expect(compat).toMatchObject({ providerSupportsGatewayRate: true, outboundPathVerified: false });
    expect(compat.statements.join(' ')).toMatch(/Not established/);
  });

  it('transcribes a saved recording on request, kept apart from live evidence, and refuses paths outside the folder', async () => {
    const providers = createMockProviders({ stt: ['recorded words'] });
    const h = await harness({ providers });
    const recordings = path.join(h.dir, 'recordings');
    fs.mkdirSync(recordings, { recursive: true });
    fs.writeFileSync(path.join(recordings, 'sample.wav'), buildWav(speechPcm(1500), { ...FORMAT_8K, verified: true }));
    fs.writeFileSync(path.join(recordings, 'raw.bin'), speechPcm(1500));
    fs.writeFileSync(path.join(h.dir, 'outside.wav'), buildWav(speechPcm(1500), { ...FORMAT_8K, verified: true }));

    const list = (await h.api('get', '/api/ai/recordings')).body.recordings;
    expect(list.map((r: any) => r.name).sort()).toEqual(['raw.bin', 'sample.wav']);

    expect((await h.api('post', '/api/ai/test/stt').send({ file: 'sample.wav' })).status).toBe(400); // no consent
    const ok = await h.api('post', '/api/ai/test/stt').send({ file: 'sample.wav', confirmBilling: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ source: 'recording', transcript: 'recorded words', mock: true });
    const raw = await h.api('post', '/api/ai/test/stt').send({ file: 'raw.bin', confirmBilling: true });
    expect(raw.body.format).toMatch(/8000 Hz/);

    for (const file of ['../outside.wav', '..\\outside.wav', path.join(h.dir, 'outside.wav'), 'sub/x.wav', 'notes.txt', 'missing.wav']) {
      const res = await h.api('post', '/api/ai/test/stt').send({ file, confirmBilling: true });
      expect([400, 404], file).toContain(res.status);
    }
    // A recording test is not live evidence.
    expect(h.server.aiRuntime.readiness().checks.find((c) => c.name === 'inbound-audio')?.status).toBe('unverified');
  });

  // -------------------------------------------------------------------------------- usage & logs
  it('keeps a per-turn log, excludes mock providers from usage, and clears on request', async () => {
    const providers = createMockProviders({ stt: ['hi'] });
    const h = await harness({ providers });
    await h.api('post', '/api/ai/test/llm').send({ prompt: 'hello', confirmBilling: true });
    const usage = (await h.api('get', '/api/ai/usage?range=today')).body.totals;
    expect(usage).toMatchObject({ calls: 0, turns: 0, estimatedCostUsd: 0 }); // mock usage is never counted
    expect((await h.api('get', '/api/ai/turns')).body.turns.length).toBe(1);
    expect((await h.api('delete', '/api/ai/turns')).body.removed).toBe(1);
    expect((await h.api('get', '/api/ai/turns')).body.turns).toEqual([]);
  });

  it('estimates cost only where every used model has a known price', async () => {
    const h = await harness();
    const store = h.server.aiRuntime as unknown as { options: { usage: { record: (t: any) => void; totals: () => any } } };
    const usage = store.options.usage;
    const base = { callId: 'c1', status: 'completed', sttMs: 1, llmFirstTokenMs: 1, ttsFirstMs: 1, totalMs: 1, utteranceMs: 1000, sttSeconds: 60, llmPromptTokens: 1_000_000, llmCompletionTokens: 1_000_000, ttsChars: 1_000_000, mock: false };
    usage.record({ ...base, selection: { stt: 'groq_whisper', llm: 'groq_qwen_3_8_27b', tts: 'deepgram' } });
    expect(usage.totals().estimatedCostUsd).toBeCloseTo(0.00185 + 0.8 + 4 + 30, 5);
    usage.record({ ...base, callId: 'c2', selection: { stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'deepgram' } }); // nova-3 has no price in the catalog
    expect(usage.totals().estimatedCostUsd).toBeNull();
    expect(usage.totals().costNote).toMatch(/no total is shown/);
  });

  // -------------------------------------------------------------------------------- inspector feed
  it('delivers ordered inspector events live and from the catch-up endpoint', async () => {
    const providers = createMockProviders({ stt: ['one'] });
    const h = await harness({ providers });
    const call = await h.startCall();
    await h.api('post', `/api/ai/calls/${call.id}/arm`);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result')).toBe(true));
    const seqs = h.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const caught = (await h.api('get', `/api/ai/events?callId=${call.id}`)).body.events as AiInspectorEvent[];
    expect(caught.map((e) => e.seq)).toEqual(seqs);
    const session = (await h.api('get', '/api/ai/sessions')).body.sessions[0];
    expect(session.audio.receivedBytes).toBeGreaterThan(0);
    expect(session.audio.utterances).toBeGreaterThanOrEqual(1);
    expect(session.isSimulated).toBe(true);
  });
});
