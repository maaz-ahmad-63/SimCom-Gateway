import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { AtParser } from '../../src/adapters/modem/at-parser.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { defaultIvrConfig, IvrConfig } from '../../src/ivr/config.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, sleep } from '../ai/helpers.js';
import { wav } from './helpers.js';

// The whole chain, exactly as the Dashboard drives it: configuration goes in through /api/ivr (upload, draft, publish, enable), then real
// OUTBOUND calls are placed and answered on a mock modem. Nothing here registers a handler by hand: the controller is the one the gateway registers itself.

const KEY = 'ivr-chain-test-key';
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };
const AUTO = { AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2', AI_AUTO_ACTIVATE_USB_AUDIO: 'true', AI_AUTO_HANDLE: 'outbound' };
const AI_ANSWERS = { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' };
const AI_OFF = { ...VERIFIED, AI_ENABLED: 'false' };
const CLIP_MS = 150;
const CLIP_BYTES = (CLIP_MS * 8000 * 2) / 1000;

describe('the IVR from the Dashboard\'s API to a real call', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(env: Record<string, string | undefined>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-chain-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return original(command, timeoutMs);
    };
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', AI_PLAYBACK_GUARD_MS: '0', ...env }),
        providers: createMockProviders({ stt: ['hello'], llm: ['Hi there.'] }),
        allowSimulatedHardware: true,
        transports: () => ({ source: new ManualAudioSource(FORMAT_8K, true), sink: new CollectingAudioSink(FORMAT_8K, true, 0) }),
        idleWaitsMs: [60_000, 60_000, 60_000],
        automationAudioWaitMs: 1500,
        automationPollMs: 20,
        automationActivation: { settleMs: 0, retryMs: 20, attempts: 2 },
      },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const writes: Array<{ at: number; bytes: number }> = [];
    server.audio.on('audio_out', (chunk: Buffer) => writes.push({ at: performance.now(), bytes: chunk.length }));
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const api = (method: 'get' | 'post' | 'put' | 'delete', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const urc = (raw: string, type: string, extra: object = {}) => modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false, ...extra } as never);
    /** An outbound call the callee answers: dial, then the module's "VOICE CALL: BEGIN". The IVR runs on outbound calls only. */
    const callOut = async () => {
      await server.callManager.dial({ phoneNumber: '+10000000001' });
      urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
    };
    /** A call coming IN (rings twice): never the IVR's. */
    const ringIn = () => {
      for (let i = 0; i < 2; i++) {
        urc('RING', 'RING');
        urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
      }
    };
    const press = (key: string) => modem.emit('urc', AtParser.parseUrc(`+RXDTMF: ${key}`)!);
    const bytes = () => writes.reduce((n, w) => n + w.bytes, 0);
    const markers = () => events.filter((e) => e.stage === 'call').map((e) => e.detail ?? '');
    const callEnds = () => urc('VOICE CALL: END: 3', 'VOICE_CALL_END', { durationSeconds: 3 });

    /** What the Dashboard does: upload the WAV files, save a draft that uses them, publish it. Returns the asset ids. */
    const upload = async (name: string, tone: number) => (await api('post', `/api/ivr/assets?name=${name}`).set('Content-Type', 'audio/wav').send(wav({ ms: CLIP_MS, tone }))).body.asset.id as string;
    const library = {
      welcome: await upload('welcome', 300),
      menu: await upload('menu', 400),
      invalid: await upload('invalid', 500),
      timeout: await upload('timeout', 600),
      info: await upload('info', 700),
      bye: await upload('bye', 800),
    };
    const menu = (over: Partial<IvrConfig> = {}): IvrConfig => ({
      ...defaultIvrConfig(),
      welcome: { assetId: library.welcome },
      menu: { assetId: library.menu },
      invalid: { assetId: library.invalid },
      timeout: { assetId: library.timeout },
      options: [
        { key: '1', label: 'AI assistant', action: { type: 'connect-ai' } },
        { key: '2', label: 'Hours', action: { type: 'play-announcement', assetId: library.info, then: 'return-to-menu' } },
        { key: '9', label: 'Goodbye', action: { type: 'hang-up', goodbyeAssetId: library.bye } },
      ],
      inputTimeoutMs: 2000,
      maxRetries: 1,
      finalAction: { type: 'hang-up', goodbyeAssetId: library.bye },
      ...over,
    });
    const publish = async (config: IvrConfig) => {
      expect((await api('put', '/api/ivr/draft').send(config)).status).toBe(200);
      const res = await api('post', '/api/ivr/publish');
      expect(res.status).toBe(200);
      return res.body.published.version as number;
    };
    const enable = async (on = true) => expect((await api('put', '/api/ivr/enabled').send({ enabled: on })).status).toBe(200);
    const untilMenu = async (callsBefore = 0) => {
      await callOut();
      await vi.waitFor(() => expect(bytes()).toBeGreaterThanOrEqual(callsBefore + 2 * CLIP_BYTES), { timeout: 5000 });
      await sleep(30);
    };
    return { server, modem, api, callOut, ringIn, press, bytes, markers, callEnds, commands, library, menu, publish, enable, untilMenu, urc };
  }

  it('the gateway registers its own controller, and the API reports it, along with whether the AI could take over a failed call', async () => {
    const answers = await harness(AI_ANSWERS);
    expect(answers.server.ivrOwnership.hasHandler).toBe(true);
    const overview = (await answers.api('get', '/api/ivr')).body;
    expect(overview.runtime).toEqual({ controllerRegistered: true, activeCalls: [], aiCanAnswer: true });
    expect(overview.status.enabled).toBe(false); // off until someone turns it on

    const off = await harness(AI_OFF);
    expect((await off.api('get', '/api/ivr')).body.runtime).toEqual({ controllerRegistered: true, activeCalls: [], aiCanAnswer: false });
  });

  it('publish, enable, call: the menu the Dashboard published is the one callers hear, key 1 hands the call to the AI, and the IVR reports the call while it runs', async () => {
    const h = await harness(AI_ANSWERS);
    expect(await h.publish(h.menu())).toBe(1);
    await h.enable();
    await h.untilMenu();
    const callId = h.server.callManager.getCurrentCall()!.id;
    expect((await h.api('get', '/api/ivr')).body.runtime.activeCalls).toEqual([callId]);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    h.press('1');
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
    expect(h.server.aiOrchestrator.isAttached(callId)).toBe(true);
    expect((await h.api('get', '/api/ivr')).body.runtime.activeCalls).toEqual([]);
    expect(h.markers().join(' | ')).toContain('IVR: menu started (published configuration version 1)');
  });

  it('a draft changes nothing for calls until it is published; a call in progress keeps its own version; the next call gets the new one', async () => {
    const h = await harness(AI_ANSWERS);
    await h.publish(h.menu()); // version 1: key 1 connects the AI
    await h.enable();

    await h.untilMenu();
    // The operator edits and publishes version 2 (key 1 hangs up) WHILE this call is in the menu.
    const v2 = h.menu({ options: [{ key: '1', label: 'Hang up now', action: { type: 'hang-up', goodbyeAssetId: null } }] });
    expect((await h.api('put', '/api/ivr/draft').send(v2)).status).toBe(200); // saved, not published
    h.press('1'); // the call in progress still has version 1: the AI, not a hang-up
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    h.callEnds();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0), { timeout: 3000 });

    // Still only a draft: the next call is version 1 too.
    const before = h.bytes();
    await h.untilMenu(before);
    expect(h.markers().filter((m) => m.includes('menu started (published configuration version 1)'))).toHaveLength(2);
    h.callEnds();
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 3000 });

    // Publish it: the next call runs version 2, where key 1 ends the call.
    expect((await h.api('post', '/api/ivr/publish')).body.published.version).toBe(2);
    await h.untilMenu(h.bytes());
    h.press('1');
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 5000 });
    expect(h.markers().join(' | ')).toContain('menu started (published configuration version 2)');
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
  }, 25_000);

  it('turning the IVR off restores the AI-only flow: the AI attaches at once and the IVR plays nothing', async () => {
    const h = await harness(AI_ANSWERS);
    await h.publish(h.menu());
    await h.enable();
    await h.enable(false);
    const before = h.bytes();
    await h.callOut();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
    expect(h.bytes()).toBe(before);
    expect(h.markers().filter((m) => m.startsWith('IVR'))).toEqual([]);
  });

  it('IVR-only with the AI off: announced to the callee, key 9 says goodbye and ends the call, and silence runs out the retries', async () => {
    const h = await harness(AI_OFF);
    await h.publish(h.menu());
    await h.enable();
    await h.untilMenu();
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    h.press('9');
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 5000 });
    expect(h.bytes()).toBeGreaterThanOrEqual(3 * CLIP_BYTES);

    const before = h.bytes();
    await h.untilMenu(before);
    // No key at all: two silences (maxRetries 1) and then the final action, a goodbye and a hang-up.
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 8000 });
    expect(h.markers().join(' | ')).toMatch(/no key within 2 s \(mistake 1 of 2.*no key within 2 s \(mistake 2 of 2.*running the final action \(hang-up\)/);
  }, 25_000);

  it('a menu that cannot be published is never used: the API refuses it and calls keep the previous version', async () => {
    const h = await harness(AI_ANSWERS);
    await h.publish(h.menu());
    await h.enable();
    const broken = h.menu({ options: [...h.menu().options, { key: '1', label: 'dup', action: { type: 'repeat-menu' } }] });
    expect((await h.api('put', '/api/ivr/draft').send(broken)).status).toBe(200);
    const refused = await h.api('post', '/api/ivr/publish');
    expect(refused.status).toBe(422);
    expect(refused.body.details[0]).toMatchObject({ path: 'options[3].key' });
    await h.untilMenu();
    expect(h.markers().join(' | ')).toContain('version 1');
    expect((await h.api('get', '/api/ivr')).body.status.publishedVersion).toBe(1);
  });
  it('an incoming call is untouched by an enabled, published IVR: the AI answers it, the IVR plays nothing', async () => {
    const h = await harness({ ...AI_ANSWERS, AI_AUTO_HANDLE: 'inbound', AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2' });
    await h.publish(h.menu());
    await h.enable();
    const before = h.bytes();
    h.ringIn();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
    expect(h.bytes()).toBe(before);
    expect(h.markers().filter((m) => m.startsWith('IVR'))).toEqual([]);
    expect((await h.api('get', '/api/ivr')).body.runtime.activeCalls).toEqual([]);
  });
});
