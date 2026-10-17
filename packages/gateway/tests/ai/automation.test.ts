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
import { AiProviderError, ProviderSet } from '../../src/ai/providers/types.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const KEY = 'automation-test-key';
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };

describe('hands-free calling workflow', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(
    options: {
      env?: Record<string, string | undefined>;
      providers?: ProviderSet;
      playbackMs?: number;
      idleWaitsMs?: readonly [number, number, number];
      callLimitMs?: number;
      audioWaitMs?: number;
      failActivation?: boolean;
    } = {}
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      if (options.failActivation && command.startsWith('AT+CPCMREG=1')) throw new Error('AT ERROR');
      return original(command, timeoutMs);
    };
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true, options.playbackMs ?? 0);
    const providers =
      options.providers ?? createMockProviders({ stt: ['first question', 'second question', 'third question'], llm: ['First answer here.', 'Second answer here.', 'Third answer here.'] });
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', AI_PLAYBACK_GUARD_MS: '0', ...options.env }),
        providers,
        allowSimulatedHardware: true,
        transports: () => ({ source, sink }),
        idleWaitsMs: options.idleWaitsMs ?? [60_000, 60_000, 60_000],
        callLimitMs: options.callLimitMs,
        automationAudioWaitMs: options.audioWaitMs ?? 1500,
        automationPollMs: 20,
      },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const alerts: string[] = [];
    server.eventBus.on('gateway:alert', (a) => alerts.push(a.message));
    const api = (method: 'get' | 'post' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const urc = (raw: string, type: string, extra: object = {}) =>
      modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false, ...extra } as never);
    /** One ring cycle as the modem sends it: RING and +CLIP (the number is deliberately fake). */
    const ring = (withClip = true) => {
      urc('RING', 'RING');
      if (withClip) urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
    };
    /** A caller who waits for the agent to finish (half-duplex) before speaking, as a person on a call does. */
    const callerSays = async () => {
      await vi.waitFor(() => {
        const s = server.aiOrchestrator.getSessions()[0];
        expect(!s || s.conversation.phase === 'listening' || s.conversation.phase === 'stopped').toBe(true);
      });
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1300));
    };
    const endRemote = () => urc('VOICE CALL: END: 9', 'VOICE_CALL_END', { durationSeconds: 9 });
    const markers = () => events.filter((e) => e.stage === 'call').map((e) => e.detail ?? '');
    const count = (re: RegExp) => commands.filter((c) => re.test(c)).length;
    return { server, modem, source, sink, providers, events, alerts, commands, api, ring, urc, callerSays, endRemote, markers, count };
  }

  const AUTO = { AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2', AI_AUTO_ACTIVATE_USB_AUDIO: 'true', AI_AUTO_HANDLE: 'inbound' };

  // ----------------------------------------------------------------------- answering
  describe('auto-answer', () => {
    it('is off by default: any number of rings leaves the call alone', async () => {
      const h = await harness();
      for (let i = 0; i < 5; i++) h.ring();
      await sleep(50);
      expect(h.count(/^ATA$/)).toBe(0);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('INBOUND_RINGING');
    });

    it('answers exactly once, after the configured number of ring cycles', async () => {
      const h = await harness({ env: AUTO });
      h.ring();
      await sleep(30);
      expect(h.count(/^ATA$/)).toBe(0); // one ring is not enough
      h.ring();
      await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'));
      h.ring();
      h.ring(false);
      await sleep(50);
      expect(h.count(/^ATA$/)).toBe(1);
      expect(h.markers().some((m) => /Auto-answering after 2 rings/.test(m))).toBe(true);
    });

    it('counts a ring and its caller-ID line as one cycle, and works when only one of them arrives', async () => {
      const h = await harness({ env: { ...AUTO, AI_AUTO_ANSWER_RINGS: '3' } });
      h.urc('RING', 'RING');
      h.urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
      h.urc('RING', 'RING');
      await sleep(30);
      expect(h.count(/^ATA$/)).toBe(0);
      h.urc('RING', 'RING');
            await vi.waitFor(() => expect(h.count(/^ATA$/)).toBe(1));
    });

    it('does not answer, and says why, when the AI cannot handle the call', async () => {
      const off = await harness({ env: { ...AUTO, AI_AUTO_HANDLE: 'off' } });
      off.ring();
      off.ring();
      await vi.waitFor(() => expect(off.markers().join(' ')).toMatch(/Auto-answer skipped: .*not enabled for inbound calls/));
      expect(off.count(/^ATA$/)).toBe(0);

      const noRate = await harness({ env: { ...AUTO, AI_AUDIO_SAMPLE_RATE: undefined } });
      noRate.ring();
      noRate.ring();
      await vi.waitFor(() => expect(noRate.markers().join(' ')).toMatch(/sample rate is not set/));
      expect(noRate.count(/^ATA$/)).toBe(0);

      const noKey = await harness({ env: { ...AUTO, DEEPGRAM_API_KEY: undefined } });
      noKey.ring();
      noKey.ring();
      await vi.waitFor(() => expect(noKey.markers().join(' ')).toMatch(/configuration or provider keys are incomplete/));
      expect(noKey.count(/^ATA$/)).toBe(0);
      expect(noKey.alerts.join(' ')).toMatch(/Auto-answer skipped/);
    });

    it('tries once per call: a failed answer is reported and not retried', async () => {
      const h = await harness({ env: AUTO });
      const spy = vi.spyOn(h.server.callManager, 'answer').mockRejectedValue(new Error('ATA failed: NO CARRIER'));
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.markers().join(' ')).toMatch(/Auto-answer failed: ATA failed/));
      h.ring();
      h.ring();
      await sleep(50);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------------- activation + attachment
  describe('automatic USB audio and attachment', () => {
    it('answers, activates USB audio once, sees bytes, and attaches the AI without any click', async () => {
      const h = await harness({ env: AUTO });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      expect(call.state).toBe('ACTIVE');
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.count(/^AT\+CPCMREG=0$/)).toBe(0);
      const markers = h.markers();
      const order = ['Auto-answering', 'USB audio activated automatically', 'Audio bytes are flowing', 'AI attached'].map((m) => markers.findIndex((x) => x.includes(m)));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // Attached passively: it listens, it does not speak.
      expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('passive');
      expect(h.sink.playCalls).toBe(0);
    });

    it('does not touch the modem when automatic activation is off', async () => {
      const h = await harness({ env: { ...AUTO, AI_AUTO_ACTIVATE_USB_AUDIO: 'false' } });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'));
      await sleep(200);
      expect(h.count(/CPCMREG/)).toBe(0);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0); // no audio, so no attachment
    });

    it('reports a failed activation once, never retries it, and does not attach', async () => {
      const h = await harness({ env: AUTO, failActivation: true });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.markers().join(' ')).toMatch(/Automatic USB audio activation failed: AT ERROR/));
      await sleep(300);
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    });

    it('says so when activation succeeded but no audio bytes arrive', async () => {
      const h = await harness({ env: AUTO, audioWaitMs: 250 });
      const real = h.server.callManager.getUsbAudioStatus!.bind(h.server.callManager);
      vi.spyOn(h.server.callManager, 'getUsbAudioStatus').mockImplementation(() => ({ ...real(), audio: { state: 'stalled', msSinceLastFrame: 9000 } }));
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.markers().join(' ')).toMatch(/no audio bytes arrived within 0 s|no audio bytes arrived/));
      expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
      expect(h.alerts.join(' ')).toMatch(/will not attach until they do/);
    });

    it('leaves outbound calls alone unless attachment is enabled for them', async () => {
      const h = await harness({ env: AUTO }); // inbound only
      await h.server.callManager.dial({ phoneNumber: '+10000000001' });
      h.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
      await sleep(250);
      expect(h.count(/CPCMREG/)).toBe(0);

      const both = await harness({ env: { ...AUTO, AI_AUTO_HANDLE: 'all' } });
      await both.server.callManager.dial({ phoneNumber: '+10000000001' });
      both.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
      await vi.waitFor(() => expect(both.count(/^AT\+CPCMREG=1$/)).toBe(1));
    });
  });

  // ----------------------------------------------------------------------- automatic replies
  describe('automatic replies', () => {
    it('cannot be turned on until both audio paths are confirmed, and is withdrawn with a confirmation', async () => {
      const h = await harness();
      const refused = await h.api('put', '/api/ai/settings').send({ automation: { autoReplies: true } });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/both audio confirmations/);
      expect((await h.api('get', '/api/ai/settings')).body.automation.autoReplies).toBe(false);

      const confirmed = await harness({ env: VERIFIED });
      const ok = await confirmed.api('put', '/api/ai/settings').send({ automation: { autoReplies: true } });
      expect(ok.status).toBe(200);
      expect(ok.body.automation.autoReplies).toBe(true);
    });

    it('validates the automation settings strictly and persists them', async () => {
      const h = await harness();
      for (const body of [{ automation: { autoAnswerRings: 0 } }, { automation: { autoAnswerRings: 11 } }, { automation: { maxCallSeconds: 5 } }, { automation: { surprise: true } }, { autoHandle: 'sometimes' }]) {
        expect((await h.api('put', '/api/ai/settings').send(body)).status, JSON.stringify(body)).toBe(400);
      }
      const saved = await h.api('put', '/api/ai/settings').send({ autoHandle: 'inbound', automation: { autoAnswer: true, autoAnswerRings: 3, autoActivateUsbAudio: true } });
      expect(saved.body).toMatchObject({ autoHandle: 'inbound', automation: { autoAnswer: true, autoAnswerRings: 3, autoActivateUsbAudio: true, autoReplies: false } });
    });

    it('stays passive when replies were switched on but the paths are not confirmed (never half-active)', async () => {
      const h = await harness({ env: { ...AUTO, AI_AUTO_REPLIES: 'true' } }); // bypasses the settings check on purpose
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      await h.callerSays();
      await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true));
      await sleep(100);
      expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('passive');
      expect(h.providers.llm.requests).toHaveLength(0);
      expect(h.sink.playCalls).toBe(0);
    });

    it('holds a whole conversation: several turns, one reply each, listening again after every reply', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' }, playbackMs: 20 });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('active');

      for (let turn = 1; turn <= 3; turn++) {
        await h.callerSays();
        await vi.waitFor(() => expect(h.sink.played.length).toBe(turn), { timeout: 4000 });
      }
      expect(h.providers.stt.calls).toHaveLength(3);
      expect(h.providers.tts.requests).toEqual(['First answer here.', 'Second answer here.', 'Third answer here.']);
      // The model saw the growing conversation, so replies are contextual.
      const last = h.providers.llm.requests[2].messages;
      expect(last.map((m) => `${m.role}:${m.content}`)).toEqual([
        'user:first question',
        'assistant:First answer here.',
        'user:second question',
        'assistant:Second answer here.',
        'user:third question',
      ]);
      // Each stage is on record, with the honest wording for playback.
      const playback = h.events.filter((e) => e.stage === 'playback' && e.status === 'ok');
      expect(playback).toHaveLength(3);
      expect(playback[0].detail).toMatch(/not verified/);
      const session = h.server.aiOrchestrator.getSessions()[0];
      expect(session.totals).toMatchObject({ turns: 3, completed: 3, failed: 0 });
      expect(session.busy).toBe(false);
    });

    it('lets the caller interrupt: the reply in progress is cancelled and only the newest question is answered', async () => {
      const providers = createMockProviders({ stt: ['first question', 'second question'], llm: ['A long first answer that is being spoken now.', 'The answer to the second.'] });
      // Full duplex is an explicit opt-in (unverified on this hardware): only then can the caller talk over the agent.
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_HALF_DUPLEX: 'false' }, providers, playbackMs: 600 });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      await h.callerSays();
      await vi.waitFor(() => expect(h.sink.playCalls).toBe(1), { timeout: 4000 }); // the first reply is now playing
      h.source.push(speechPcm(1200)); // barge-in: talks over the agent immediately, no waiting
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
      await sleep(150);
      expect(h.sink.played).toHaveLength(1); // the interrupted reply was never completed
      expect(providers.llm.requests.at(-1)!.messages.at(-1)).toEqual({ role: 'user', content: 'first question second question' });
      expect(h.events.some((e) => e.stage === 'playback' && e.status === 'cancelled')).toBe(true);
    });

    it('survives provider failures, gives up politely, and tries again after the cool-down', async () => {
      const boom = () => new AiProviderError('groq', 'llm', 'HTTP 503: provider server error', { status: 503 });
      const providers = createMockProviders({
        stt: ['q one', 'q two', 'q three', 'q four', 'q five'],
        llm: [boom(), boom(), boom(), 'Recovered and answering again.'],
      });
      const h = await harness({
        env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_MAX_CONSECUTIVE_FAILURES: '3', AI_RECOVERY_COOLDOWN_MS: '1000', AI_MAX_RETRIES: '0' },
        providers,
      });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      for (let i = 1; i <= 3; i++) {
        await h.callerSays();
        await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()[0].totals.failed).toBe(i), { timeout: 4000 });
      }
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()[0].degraded).toBe(true));
      expect(h.alerts.join(' ')).toMatch(/stopped responding after 3 consecutive failures/);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'); // the call is untouched

      await h.callerSays(); // inside the cool-down: no provider is paid
      await sleep(250);
      expect(providers.llm.requests).toHaveLength(3);
      expect(h.sink.playCalls).toBe(0);

      await sleep(900); // past the cool-down
      await h.callerSays();
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
      expect(h.alerts.join(' ')).toMatch(/trying again after/);
      expect(h.server.aiOrchestrator.getSessions()[0].degraded).toBe(false);
    });
  });

  // ----------------------------------------------------------------------- idle silence
  describe('idle follow-ups', () => {
    it('asks twice whether the caller is there, then says goodbye and hangs up once (only when allowed)', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_ALLOW_AGENT_HANGUP: 'true' }, idleWaitsMs: [120, 120, 120] });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      await h.callerSays();
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
      // Silence from here: follow-up, follow-up, goodbye.
      await vi.waitFor(() => expect(h.sink.played.length).toBe(4), { timeout: 4000 });
      const spoken = h.providers.tts.requests.slice(1);
      expect(spoken).toHaveLength(3);
      expect(spoken[2]).toBe("I didn't get a response, so I'm disconnecting now. Goodbye.");
      await vi.waitFor(() => expect(h.count(/^AT\+CHUP$|^ATH$/)).toBe(1));
      await sleep(300);
      expect(h.count(/^AT\+CHUP$|^ATH$/)).toBe(1);
    });

    it('says goodbye but leaves the call up when hang-up is not allowed', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' }, idleWaitsMs: [100, 100, 100] });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      await vi.waitFor(() => expect(h.providers.tts.requests.length).toBe(3), { timeout: 4000 });
      await sleep(250);
      expect(h.count(/^AT\+CHUP$|^ATH$/)).toBe(0);
      expect(h.alerts.join(' ')).toMatch(/not hanging up because AI_ALLOW_AGENT_HANGUP is false/);
    });

    it('is reset by real speech, and never speaks in passive mode', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_ALLOW_AGENT_HANGUP: 'true' }, idleWaitsMs: [400, 400, 400] });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      for (let i = 0; i < 2; i++) {
        await h.callerSays();
        await vi.waitFor(() => expect(h.sink.played.length).toBe(i + 1), { timeout: 4000 });
        await sleep(150);
      }
      expect(h.providers.tts.requests).toEqual(['First answer here.', 'Second answer here.']); // no follow-up while they keep talking

      const passive = await harness({ env: AUTO, idleWaitsMs: [50, 50, 50] });
      passive.ring();
      passive.ring();
      await vi.waitFor(() => expect(passive.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      await sleep(400);
      expect(passive.providers.tts.requests).toHaveLength(0);
      expect(passive.sink.playCalls).toBe(0);
    });
  });

  // ----------------------------------------------------------------------- termination and cleanup
  describe('call termination', () => {
    it('stops everything when the remote hangs up mid-reply: playback cancelled, no more provider requests, no timers left', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true', AI_ALLOW_AGENT_HANGUP: 'true' }, playbackMs: 800, idleWaitsMs: [100, 100, 100] });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      await h.callerSays();
      await vi.waitFor(() => expect(h.sink.playCalls).toBe(1), { timeout: 4000 });
      h.endRemote();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false));
      expect(h.source.listenerCount).toBe(0); // unsubscribed from the audio stream
      expect(h.sink.played).toHaveLength(0); // the cut-off reply was not reported as played

      const requests = h.providers.llm.requests.length;
      const spoken = h.providers.tts.requests.length;
      await h.callerSays(); // audio after the end is ignored
      await sleep(500); // longer than every idle wait
      expect(h.providers.llm.requests).toHaveLength(requests);
      expect(h.providers.tts.requests).toHaveLength(spoken);
      expect(h.count(/^AT\+CHUP$|^ATH$/)).toBe(0); // nothing tried to hang up a call that was already over
      expect(h.server.aiOrchestrator.hasActiveSession).toBe(false);
    });

    it('cleans up when the operator hangs up through the API', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' }, idleWaitsMs: [100, 100, 100] });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      await h.server.callManager.hangup('operator');
      await vi.waitFor(() => expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false));
      expect(h.source.listenerCount).toBe(0);
      const spoken = h.providers.tts.requests.length;
      await sleep(400);
      expect(h.providers.tts.requests).toHaveLength(spoken);
    });

    it('lets go of a call after the AI time limit without touching the call', async () => {
      const h = await harness({ env: AUTO, callLimitMs: 250 });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      const call = h.server.callManager.getCurrentCall()!;
      await vi.waitFor(() => expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false), { timeout: 3000 });
      expect(h.alerts.join(' ')).toMatch(/reached its \d+ s limit/);
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
      expect(h.count(/^AT\+CHUP$|^ATH$/)).toBe(0);
      await sleep(200);
      expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false); // not silently re-attached
    });

    it('gives the next call a clean start', async () => {
      const h = await harness({ env: { ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' } });
      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      await h.callerSays();
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
      h.endRemote();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.hasActiveSession).toBe(false));
      await sleep(50);

      h.ring();
      h.ring();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
      expect(h.count(/^ATA$/)).toBe(2);
      expect(h.count(/^AT\+CPCMREG=1$/)).toBe(2);
      await h.callerSays();
      await vi.waitFor(() => expect(h.sink.played.length).toBe(2), { timeout: 4000 });
      expect(h.providers.llm.requests[1].messages).toEqual([{ role: 'user', content: 'second question' }]); // no memory of the previous call
    });
  });
});
