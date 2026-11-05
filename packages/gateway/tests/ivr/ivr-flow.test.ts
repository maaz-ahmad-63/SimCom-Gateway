import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { AtParser } from '../../src/adapters/modem/at-parser.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { defaultIvrConfig } from '../../src/ivr/config.js';
import { createIvrController } from '../../src/ivr/wiring.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, sleep } from '../ai/helpers.js';
import { wav } from './helpers.js';

// The IVR end to end on the real call flow: the gateway dials out, the callee answers, USB audio is activated, the IVR controller plays
// real announcements through the real GatewayAudioSink into the mock audio adapter, and keys arrive as real "+RXDTMF" lines parsed by
// the production parser. The AI side uses the fake transports the other AI tests use.

const KEY = 'ivr-flow-test-key';
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };
const AUTO = { AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2', AI_AUTO_ACTIVATE_USB_AUDIO: 'true', AI_AUTO_HANDLE: 'outbound' };
const AI_ANSWERS = { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' };
const AI_OFF = { ...VERIFIED, AI_ENABLED: 'false' }; // the AI off, but the audio paths still confirmed by the operator
const CLIP_MS = 150;
/** Bytes of one announcement at 8 kHz, 16-bit mono. */
const CLIP_BYTES = (CLIP_MS * 8000 * 2) / 1000;

describe('IVR end to end', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(options: { env?: Record<string, string | undefined>; enabled?: boolean; maxRetries?: number; timeoutMs?: number } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-flow-'));
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
        env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', AI_PLAYBACK_GUARD_MS: '0', ...options.env }),
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
    const controller = createIvrController({
      modem,
      audio: server.audio,
      manager: server.callManager,
      eventBus: server.eventBus,
      runtime: () => server.aiRuntime,
      options: { handoffSettleMs: 60, debounceMs: 100 },
    });
    server.ivrOwnership.registerHandler(controller);
    cleanup.push(async () => {
      controller.stop();
      server.ivrOwnership.stop();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const writes: Array<{ at: number; bytes: number }> = [];
    server.audio.on('audio_out', (chunk: Buffer) => writes.push({ at: performance.now(), bytes: chunk.length }));
    const armed: number[] = [];
    const arm = server.aiOrchestrator.arm.bind(server.aiOrchestrator);
    vi.spyOn(server.aiOrchestrator, 'arm').mockImplementation(async (id: string) => {
      armed.push(performance.now());
      return arm(id);
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const markers = () => events.filter((e) => e.stage === 'call').map((e) => e.detail ?? '');
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
    /** A key as the module reports it: a real "+RXDTMF: <key>" line through the production parser. */
    const press = (key: string) => modem.emit('urc', AtParser.parseUrc(`+RXDTMF: ${key}`)!);
    const count = (re: RegExp) => commands.filter((c) => re.test(c)).length;
    const bytesWritten = () => writes.reduce((n, w) => n + w.bytes, 0);

    // Publish and switch on an IVR whose announcements are all CLIP_MS long.
    const add = (name: string, tone: number) => server.ivrAssets.add(wav({ ms: CLIP_MS, tone }), name).asset.id;
    const ids = { welcome: add('welcome', 300), menu: add('menu', 400), invalid: add('invalid', 500), timeout: add('timeout', 600), info: add('info', 700), bye: add('bye', 800) };
    server.ivrStore.saveDraft({
      ...defaultIvrConfig(),
      welcome: { assetId: ids.welcome },
      menu: { assetId: ids.menu },
      invalid: { assetId: ids.invalid },
      timeout: { assetId: ids.timeout },
      options: [
        { key: '1', label: 'AI assistant', action: { type: 'connect-ai' } },
        { key: '2', label: 'Hours', action: { type: 'play-announcement', assetId: ids.info, then: 'return-to-menu' } },
        { key: '3', label: 'Menu again', action: { type: 'repeat-menu' } },
        { key: '9', label: 'Goodbye', action: { type: 'hang-up', goodbyeAssetId: ids.bye } },
      ],
      inputTimeoutMs: options.timeoutMs ?? 2000,
      maxRetries: options.maxRetries ?? 1,
      finalAction: { type: 'hang-up', goodbyeAssetId: ids.bye },
    });
    server.ivrStore.publish();
    if (options.enabled !== false) server.ivrStore.setEnabled(true);
    return { server, modem, controller, writes, armed, events, markers, callOut, ringIn, press, count, bytesWritten, ids };
  }

  /** Place an outbound call, the callee answers, and wait until the welcome and the menu prompt have both gone out. */
  const untilMenuPlayed = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.callOut();
    await vi.waitFor(() => expect(h.bytesWritten()).toBeGreaterThanOrEqual(2 * CLIP_BYTES), { timeout: 5000 });
    await sleep(30);
  };

  it('plays the welcome and the menu through the real sink, keeps the AI off, and hands the call over on key 1 with the writes stopped first', async () => {
    const h = await harness({ env: AI_ANSWERS });
    await untilMenuPlayed(h);
    const callId = h.server.callManager.getCurrentCall()!.id;
    expect(h.controller.activeCalls).toEqual([callId]);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0); // the AI waits while the IVR holds the call
    const quietBefore = h.writes.length;
    await sleep(150); // waiting for a key: nothing is being written
    expect(h.writes.length).toBe(quietBefore);

    h.press('1');
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
    expect(h.armed).toHaveLength(1);
    expect(h.server.aiOrchestrator.isAttached(callId)).toBe(true);
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    // Nothing from the IVR was written after the AI was armed, and the call was released only after the settle.
    expect(h.writes.every((w) => w.at < h.armed[0])).toBe(true);
    await sleep(150);
    expect(h.writes.every((w) => w.at < h.armed[0])).toBe(true);
    const text = h.markers().join(' | ');
    expect(text).toContain('IVR: menu started (published configuration version 1)');
    expect(text).toContain('IVR: the caller chose option 1 (connect-ai)');
    expect(text).toContain('IVR: handing the call to the AI');
    expect(text).toContain('The call was handed to the AI');
    expect(h.controller.activeCalls).toEqual([]);
  });

  it('a key during the menu stops the menu mid-playback and hands over without any overlap', async () => {
    const h = await harness({ env: AI_ANSWERS });
    await h.callOut();
    await vi.waitFor(() => expect(h.bytesWritten()).toBeGreaterThan(CLIP_BYTES + 800), { timeout: 5000 }); // the welcome is done, the menu has started
    h.press('1');
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
    expect(h.bytesWritten()).toBeLessThan(2 * CLIP_BYTES); // the menu was cut short
    expect(h.writes.every((w) => w.at < h.armed[0])).toBe(true);
    expect(h.armed[0] - h.writes.at(-1)!.at).toBeGreaterThanOrEqual(50); // the settle: the last write and the arm are not back to back
  });

  it('works with the AI off completely: the IVR plays on the outbound call, says goodbye on key 9 and ends the call', async () => {
    const h = await harness({ env: AI_OFF });
    await untilMenuPlayed(h);
    expect(h.count(/^ATA$/)).toBe(0); // an outbound call is never answered by us
    expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1); // but its USB audio is activated for the IVR, with the AI off
    h.press('9');
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 5000 });
    expect(h.bytesWritten()).toBeGreaterThanOrEqual(3 * CLIP_BYTES); // welcome, menu, goodbye
    expect(h.count(/^ATH$|^AT\+CHUP$/)).toBeGreaterThanOrEqual(1);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    expect(h.armed).toEqual([]);
  });

  it('key 2 plays the announcement and returns to the menu; the caller can then still choose', async () => {
    const h = await harness({ env: AI_ANSWERS });
    await untilMenuPlayed(h);
    const before = h.bytesWritten();
    h.press('2');
    await vi.waitFor(() => expect(h.bytesWritten()).toBeGreaterThanOrEqual(before + 2 * CLIP_BYTES), { timeout: 5000 }); // info, then the menu again
    await sleep(160); // past the debounce window
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    h.press('1');
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
  });

  it('a wrong key plays the invalid announcement; silence afterwards runs out the retries and the final action says goodbye and ends the call', async () => {
    const h = await harness({ env: AI_OFF, maxRetries: 1, timeoutMs: 2000 });
    await untilMenuPlayed(h);
    const before = h.bytesWritten();
    h.press('5');
    await vi.waitFor(() => expect(h.bytesWritten()).toBeGreaterThanOrEqual(before + 2 * CLIP_BYTES), { timeout: 5000 }); // invalid, then the menu
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 6000 }); // 2 s of silence: the second mistake
    expect(h.markers().join(' | ')).toMatch(/a key that is not one of the options \(mistake 1 of 2.*no key within 2 s \(mistake 2 of 2/);
    expect(h.markers().join(' | ')).toContain('running the final action (hang-up)');
  });

  it('the caller hanging up mid-announcement stops the writing at once and leaves nothing running', async () => {
    const h = await harness({ env: AI_ANSWERS });
    await h.callOut();
    await vi.waitFor(() => expect(h.bytesWritten()).toBeGreaterThan(600), { timeout: 5000 }); // part way through the welcome
    const hangUpAt = performance.now();
    h.server.eventBus.emit('call:ended', h.server.callManager.getCurrentCall() as never);
    h.modem.emit('urc', { raw: 'VOICE CALL: END: 4', type: 'VOICE_CALL_END', timestamp: new Date().toISOString(), isSimulated: false, durationSeconds: 4 } as never);
    await vi.waitFor(() => expect(h.controller.activeCalls).toEqual([]), { timeout: 3000 });
    await sleep(200);
    expect(h.writes.filter((w) => w.at > hangUpAt + 60)).toEqual([]); // nothing after a few frames
    expect(h.bytesWritten()).toBeLessThan(CLIP_BYTES); // the welcome never finished
    expect(h.count(/^ATH$|^AT\+CHUP$/)).toBe(0); // the IVR did not try to end a call that had already ended
    expect(h.armed).toEqual([]);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
  });

  describe('when audio is not ready or breaks', () => {
    it('manual confirmation mode: outbound audio not confirmed: nothing is played, and with an AI that cannot answer the call is ended cleanly, with the reason', async () => {
      const h = await harness({ env: { ...AUTO, AI_AUDIO_AUTO_VERIFY: 'false', AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'false' } });
      await h.callOut();
      await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 5000 });
      expect(h.bytesWritten()).toBe(0); // never wrote to an audio path nobody confirmed
      expect(h.markers().join(' | ')).toMatch(/IVR released the call: audio is not ready for the IVR: outbound-audio/);
      expect(h.markers().join(' | ')).toContain('Ending the call');
      expect(h.armed).toEqual([]);
    });

    it('the port refusing to write: the IVR stops, and an AI that can answer takes the call', async () => {
      const h = await harness({ env: AI_ANSWERS });
      vi.spyOn(h.server.audio, 'writeAudioChunk').mockRejectedValue(new Error('serial glitch'));
      await h.callOut();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
      expect(h.markers().join(' | ')).toMatch(/IVR released the call: the IVR hit an error: serial glitch/);
      expect(h.armed).toHaveLength(1);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
      expect(h.controller.activeCalls).toEqual([]);
    });

    it('the port refusing to write with no AI able to answer: the call is ended cleanly', async () => {
      const h = await harness({ env: AI_OFF });
      vi.spyOn(h.server.audio, 'writeAudioChunk').mockRejectedValue(new Error('serial glitch'));
      await h.callOut();
      await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 5000 });
      expect(h.markers().join(' | ')).toMatch(/Ending the call: the IVR hit an error: serial glitch, and the AI cannot take it/);
    });
  });

  describe('an IVR that is switched off', () => {
    it('leaves the AI-only flow exactly as it was: the AI attaches, the IVR writes nothing and never runs', async () => {
      const h = await harness({ env: AUTO, enabled: false });
      await h.callOut();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
      expect(h.bytesWritten()).toBe(0);
      expect(h.controller.activeCalls).toEqual([]);
      expect(h.markers().filter((m) => /^IVR/.test(m))).toEqual([]);
      h.press('1'); // a key on an AI call reaches nothing
      await sleep(150);
      expect(h.armed).toEqual([]);
    });
  });

  describe('an incoming call is never run by the IVR, even with the IVR published and switched on', () => {
    it('the AI answers and attaches exactly as without an IVR: nothing is played, no key is listened for, the controller never runs', async () => {
      const h = await harness({ env: { ...AI_ANSWERS, AI_AUTO_HANDLE: 'inbound' } }); // IVR enabled and registered by the harness
      h.ringIn();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 });
      expect(h.count(/^ATA$/)).toBe(1); // answered by the AI automation, as before
      expect(h.bytesWritten()).toBe(0); // the IVR played nothing
      expect(h.controller.activeCalls).toEqual([]);
      expect(h.server.ivrOwnership.isHeld(h.server.callManager.getCurrentCall()!.id)).toBe(false);
      expect(h.markers().filter((m) => /IVR/.test(m))).toEqual([]);
      h.press('1'); // a key on the AI's call reaches nothing
      await sleep(150);
      expect(h.armed).toEqual([]);
    });

    it('the IVR no longer forces an unanswered call to be answered: with the AI auto-answer off the call just rings', async () => {
      const h = await harness({ env: { AI_AUTO_ANSWER: 'false', AI_AUTO_HANDLE: 'inbound' } });
      h.ringIn();
      await sleep(250);
      expect(h.count(/^ATA$/)).toBe(0);
      expect(h.count(/CPCMREG/)).toBe(0);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('INBOUND_RINGING');
      expect(h.bytesWritten()).toBe(0);
    });
  });
});
