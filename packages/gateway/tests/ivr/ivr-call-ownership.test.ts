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
import { defaultIvrConfig } from '../../src/ivr/config.js';
import type { IvrCallOwner } from '../../src/ivr/ownership.js';
import type { IvrSnapshot } from '../../src/ivr/store.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, sleep } from '../ai/helpers.js';
import { wav } from './helpers.js';

// Through the real server, with a mock modem: an OUTBOUND call is placed and answered by the callee, gets its USB audio, and is owned by the
// IVR or the AI. A FAKE handler stands in for the IVR controller: it only records that it was started and what it was given. Incoming calls
// are never the IVR's, and the last describe block proves it.

const KEY = 'ivr-ownership-test-key';
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };
const AUTO = { AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2', AI_AUTO_ACTIVATE_USB_AUDIO: 'true', AI_AUTO_HANDLE: 'outbound' };
/** An AI that answers: replies switched on and both audio paths confirmed. */
const AI_ANSWERS = { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' };
/** A silent, listening-only AI (the default once attached): it cannot answer a caller. */
const AI_PASSIVE = AUTO;
/** The AI switched off completely, and none of the AI's own automation settings on. */
const AI_OFF = { AI_ENABLED: 'false' };

describe('IVR call ownership through the real call flow', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(options: { env?: Record<string, string | undefined>; failActivation?: boolean; audioWaitMs?: number } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-own-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      if (options.failActivation && command.startsWith('AT+CPCMREG=1')) throw new Error('AT ERROR');
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
        automationAudioWaitMs: options.audioWaitMs ?? 1500,
        automationPollMs: 20,
        automationActivation: { settleMs: 0, retryMs: 20, attempts: 2 },
      },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      server.ivrOwnership.stop();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const alerts: string[] = [];
    server.eventBus.on('gateway:alert', (a) => alerts.push(a.message));
    const urc = (raw: string, type: string, extra: object = {}) => modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false, ...extra } as never);
    /** An outbound call that exists but has not been answered yet. */
    const dial = async () => {
      await server.callManager.dial({ phoneNumber: '+10000000001' });
    };
    /** The callee picks up. */
    const answered = () => urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
    /** An outbound call the callee answers. */
    const callOut = async () => {
      await dial();
      answered();
    };
    /** One ring of a call coming IN (RING and +CLIP, as the module reports it). */
    const ring = () => {
      urc('RING', 'RING');
      urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
    };
    const api = (method: 'get' | 'post' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const markers = () => events.filter((e) => e.stage === 'call').map((e) => e.detail ?? '');
    const count = (re: RegExp) => commands.filter((c) => re.test(c)).length;
    const ended = () => expect(server.callManager.getCurrentCall()).toBeNull();

    /** Publish and switch on an IVR (two announcements, key 1 = the AI), and register a fake handler that records what it is given. */
    const startedWith: Array<{ callId: string; snapshot: IvrSnapshot; owner: IvrCallOwner }> = [];
    let onStart: (s: { callId: string; snapshot: IvrSnapshot; owner: IvrCallOwner }) => void | Promise<void> = () => {};
    const enableIvr = (opts: { switchOn?: boolean } = {}) => {
      const welcome = server.ivrAssets.add(wav({ ms: 500, tone: 300 }), 'welcome').asset.id;
      const menu = server.ivrAssets.add(wav({ ms: 500, tone: 400 }), 'menu').asset.id;
      server.ivrStore.saveDraft({ ...defaultIvrConfig(), welcome: { assetId: welcome }, menu: { assetId: menu }, options: [{ key: '1', label: 'AI', action: { type: 'connect-ai' } }] });
      server.ivrStore.publish();
      if (opts.switchOn !== false) server.ivrStore.setEnabled(true);
      server.ivrOwnership.registerHandler({
        start: (call, snapshot, owner) => {
          const entry = { callId: call.id, snapshot, owner };
          startedWith.push(entry);
          return onStart(entry);
        },
      });
    };
    return { server, modem, events, alerts, commands, api, ring, dial, answered, callOut, urc, markers, count, ended, enableIvr, startedWith, setOnStart: (fn: typeof onStart) => void (onStart = fn) };
  }

  describe('an IVR that is switched off leaves every call exactly as it was', () => {
    it('published but not switched on, with a handler registered: the AI automation activates the audio and attaches, the handler never starts', async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.enableIvr({ switchOn: false });
      await h.callOut();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.server.ivrOwnership.isHeld(call.id)).toBe(false);
      expect(h.startedWith).toEqual([]);
      expect(h.markers().filter((m) => /IVR/.test(m))).toEqual([]);
    });

    it("with no IVR at all and the AI's USB activation off, an outbound call is left alone (the IVR is the only thing that changes that)", async () => {
      const h = await harness({ env: { AI_AUTO_ACTIVATE_USB_AUDIO: 'false', AI_AUTO_HANDLE: 'outbound' } });
      await h.callOut();
      await sleep(120);
      expect(h.count(/CPCMREG/)).toBe(0);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    });
  });

  describe('an enabled, published IVR owns an outbound call', () => {
    it("activates USB audio, starts the handler with this call's snapshot, and keeps the AI off the call; nothing is answered", async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      expect(call.direction).toBe('outbound');
      expect(call.state).toBe('ACTIVE');
      expect(h.count(/^ATA$/)).toBe(0); // an outbound call is never answered by us
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.startedWith[0].callId).toBe(call.id);
      expect(h.startedWith[0].snapshot.version).toBe(1);
      await sleep(300); // long enough for any attach retry to have happened
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
      expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false);
      expect(h.alerts.filter((a) => /AI agent/.test(a))).toEqual([]); // no "waiting to attach" or "not attached" noise either
      const order = ['IVR took ownership', 'USB audio activated automatically', 'Audio bytes are flowing', 'the IVR is starting'].map((m) => h.markers().findIndex((x) => x.includes(m)));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order); // in that order
      expect(h.markers().join(' ')).not.toMatch(/Auto-answering/);
    });

    it('the AI is not attached even though it is fully ready and set to attach to every outbound call', async () => {
      const h = await harness({ env: AI_ANSWERS });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      await sleep(400);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    });

    it('works with the AI switched off completely: the audio is activated for the IVR, which the same gateway never does without it', async () => {
      const h = await harness({ env: AI_OFF });
      await h.callOut(); // the IVR is not enabled yet: AI off, so nothing is activated
      await sleep(120);
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(0);
      h.enableIvr();
      // A new call: the first one was decided without the IVR and stays that way.
      h.urc('VOICE CALL: END: 0', 'VOICE_CALL_END', { durationSeconds: 0 });
      await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull());
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    });

    it("gets its audio whatever the AI's own auto-activation and attach settings say: switching the IVR on is the opt-in", async () => {
      const h = await harness({ env: { AI_AUTO_ACTIVATE_USB_AUDIO: 'false', AI_AUTO_HANDLE: 'off' } });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
    });

    it('the decision is made when the call is created, not when it is answered: switching the IVR on while it rings does not take that call', async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.enableIvr({ switchOn: false });
      await h.dial(); // the call exists; the IVR is off
      h.server.ivrStore.setEnabled(true);
      h.answered();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      expect(h.startedWith).toEqual([]);
      h.urc('VOICE CALL: END: 3', 'VOICE_CALL_END', { durationSeconds: 3 });
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0));
      await h.callOut(); // the next call is taken
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
    });

    it('and the other way: switching the IVR off while the call rings does not release it, the call keeps the IVR it was created with', async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.enableIvr();
      await h.dial(); // created while the IVR is on
      h.server.ivrStore.setEnabled(false);
      h.answered();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      expect(h.startedWith[0].snapshot.version).toBe(1);
      await sleep(250);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    });

    it('the callee hanging up ends the hold: nothing is left behind', async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      const id = h.startedWith[0].callId;
      expect(h.server.ivrOwnership.isHeld(id)).toBe(true);
      h.urc('VOICE CALL: END: 5', 'VOICE_CALL_END', { durationSeconds: 5 });
      await vi.waitFor(() => expect(h.server.ivrOwnership.isHeld(id)).toBe(false));
      h.ended();
    });

    it('an operator cannot arm the AI on a call the IVR holds (that would put two writers on the audio port): 409 with the reason', async () => {
      const h = await harness({ env: AI_ANSWERS });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      const res = await h.api('post', `/api/ai/calls/${h.startedWith[0].callId}/arm`);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/IVR is handling this call/);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    });
  });

  describe('handing over to the AI', () => {
    it('the handler hands the call over: the AI attaches and the IVR lets go', async () => {
      const h = await harness({ env: AI_ANSWERS });
      h.setOnStart(async ({ callId, owner }) => void (await owner.handOffToAi(callId)));
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const id = h.startedWith[0].callId;
      expect(h.server.aiOrchestrator.isAttached(id)).toBe(true);
      expect(h.server.ivrOwnership.isHeld(id)).toBe(false);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
      expect(h.markers().join(' ')).toMatch(/IVR is handing the call to the AI.*The call was handed to the AI|The call was handed to the AI/s);
    });
  });

  describe('when the IVR cannot continue', () => {
    it('a handler that fails to start: the AI takes the call when it can answer', async () => {
      const h = await harness({ env: AI_ANSWERS });
      h.setOnStart(() => {
        throw new Error('menu could not be played');
      });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      expect(h.markers().join(' ')).toMatch(/IVR released the call: the IVR failed to start: menu could not be played/);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    });

    it('a handler that fails to start while the AI cannot answer: the call is ended cleanly, with the reason', async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.setOnStart(() => {
        throw new Error('menu could not be played');
      });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => h.ended(), { timeout: 4000 });
      expect(h.markers().join(' ')).toMatch(/Ending the call: the IVR failed to start: menu could not be played, and the AI cannot take it \(the AI is not set to answer calls\)/);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
      expect(h.count(/^ATH$|^AT\+CHUP$/)).toBeGreaterThanOrEqual(1);
    });

    it('USB audio that cannot be activated: released, and since the AI needs the same audio, the call is ended cleanly', async () => {
      const h = await harness({ env: AI_ANSWERS, failActivation: true });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.markers().join(' ')).toMatch(/IVR released the call: USB audio could not be activated/), { timeout: 4000 });
      await vi.waitFor(() => h.ended(), { timeout: 4000 });
      expect(h.startedWith).toEqual([]);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
      expect(h.markers().join(' ')).toMatch(/Ending the call: USB audio could not be activated/);
    });

    it('audio that never flows: released and ended cleanly, never left in silence', async () => {
      const h = await harness({ env: AI_ANSWERS, audioWaitMs: 250 });
      const real = h.server.callManager.getUsbAudioStatus!.bind(h.server.callManager);
      vi.spyOn(h.server.callManager, 'getUsbAudioStatus').mockImplementation(() => ({ ...real(), audio: { state: 'stalled', msSinceLastFrame: 9000 } }));
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.markers().join(' ')).toMatch(/IVR released the call: no audio bytes arrived/), { timeout: 4000 });
      await vi.waitFor(() => h.ended(), { timeout: 4000 });
      expect(h.startedWith).toEqual([]);
    });

    it('with the AI off as well, a failure ends the call cleanly', async () => {
      const h = await harness({ env: AI_OFF, failActivation: true });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => h.ended(), { timeout: 4000 });
      expect(h.markers().join(' ')).toMatch(/Ending the call: USB audio could not be activated, and the AI cannot take it/);
    });

    it('a published IVR whose audio went missing is not taken: the call follows the normal AI path, and the trace says why', async () => {
      const h = await harness({ env: AI_PASSIVE });
      h.enableIvr();
      const menuId = h.server.ivrStore.getPublished()!.config.menu.assetId!;
      h.server.ivrAssets.remove(menuId); // deleted behind the store's back
      await h.callOut();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      expect(h.startedWith).toEqual([]);
      expect(h.markers().join(' ')).toMatch(/IVR could not take ownership of this call.*normal AI path/);
    });
  });

  describe('the gates in the orchestrator and automation, one by one', () => {
    it('an IVR call raises no "AI agent not attached" error even when the AI\'s own configuration is broken (a provider key missing)', async () => {
      const h = await harness({ env: { ...AI_PASSIVE, DEEPGRAM_API_KEY: undefined } });
      h.enableIvr();
      await h.callOut();
      await vi.waitFor(() => expect(h.startedWith).toHaveLength(1), { timeout: 4000 });
      await sleep(300);
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.alerts.filter((a) => /AI agent/.test(a))).toEqual([]);
      // Without the IVR the same broken AI activates nothing for the call.
      const plain = await harness({ env: { ...AI_PASSIVE, DEEPGRAM_API_KEY: undefined } });
      await plain.callOut();
      await sleep(250);
      expect(plain.count(/CPCMREG/)).toBe(0);
      expect(plain.startedWith).toEqual([]);
    });

    it('control: a call the AI is waiting to attach to (audio not up yet) DOES attach once audio flows', async () => {
      const h = await harness({ env: { ...AI_PASSIVE, AI_AUTO_ACTIVATE_USB_AUDIO: 'false' } });
      await h.callOut();
      await vi.waitFor(() => expect(h.alerts.join(' ')).toMatch(/AI agent waiting to attach to the call/), { timeout: 4000 });
      await h.server.callManager.activateUsbAudioDiagnostic!();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    });

    it('a retry loop that is already waiting stops the moment the IVR holds the call: audio coming up later does not attach the AI', async () => {
      const h = await harness({ env: { ...AI_PASSIVE, AI_AUTO_ACTIVATE_USB_AUDIO: 'false' } });
      await h.callOut();
      await vi.waitFor(() => expect(h.alerts.join(' ')).toMatch(/AI agent waiting to attach to the call/), { timeout: 4000 });
      vi.spyOn(h.server.ivrOwnership, 'decide').mockReturnValue('ivr'); // the IVR takes the call while the AI is mid-wait
      await h.server.callManager.activateUsbAudioDiagnostic!(); // everything the AI was waiting for is now true
      await sleep(1300); // two polls of the retry loop
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    });
  });

  describe("an incoming call is never the IVR's, with the IVR published, switched on and its handler registered", () => {
    it("it is not answered because of the IVR: with the AI's auto-answer off the call just rings, and nothing is activated", async () => {
      const h = await harness({ env: { AI_AUTO_ANSWER: 'false', AI_AUTO_ANSWER_RINGS: '1', AI_AUTO_HANDLE: 'inbound' } });
      h.enableIvr();
      h.ring();
      h.ring();
      await sleep(250);
      expect(h.count(/^ATA$/)).toBe(0);
      expect(h.count(/CPCMREG/)).toBe(0);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('INBOUND_RINGING');
      expect(h.server.ivrOwnership.isHeld(h.server.callManager.getCurrentCall()!.id)).toBe(false);
      expect(h.startedWith).toEqual([]);
      expect(h.markers().filter((m) => /IVR/.test(m))).toEqual([]);
    });

    it("with the AI's auto-answer on it is answered by the AI automation exactly as without an IVR, and the AI attaches", async () => {
      const h = await harness({ env: { ...AI_PASSIVE, AI_AUTO_HANDLE: 'inbound' } });
      h.enableIvr();
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      expect(call.direction).toBe('inbound');
      expect(h.count(/^ATA$/)).toBe(1);
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.server.ivrOwnership.isHeld(call.id)).toBe(false);
      expect(h.startedWith).toEqual([]);
      const text = h.markers().join(' | ');
      expect(text).toContain('Auto-answering after 2 rings');
      expect(text).not.toMatch(/IVR/);
    });

    it('asked about directly, in every way the IVR can be asked, it is still the AI\'s', async () => {
      const h = await harness({ env: { ...AI_ANSWERS, AI_AUTO_HANDLE: 'inbound' } });
      h.enableIvr();
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      expect(h.server.ivrOwnership.decide(call)).toBe('ai');
      h.server.ivrOwnership.audioReady(call); // even a direct "audio is ready" cannot start the IVR on it
      await sleep(100);
      expect(h.startedWith).toEqual([]);
    });
  });

  it('no handler registered: switching the IVR on changes nothing about any call', async () => {
    const h = await harness({ env: AI_PASSIVE });
    h.enableIvr();
    h.server.ivrOwnership.registerHandler(null);
    await h.callOut();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    expect(h.startedWith).toEqual([]);
    expect(h.markers().filter((m) => /IVR/.test(m))).toEqual([]);
  });
});
