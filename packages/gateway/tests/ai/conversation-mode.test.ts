import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationPhase, AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { AgentAudioSink, CollectingAudioSink, ManualAudioSource, PlayResult } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { AiProviderError, ProviderSet } from '../../src/ai/providers/types.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const KEY = 'conversation-mode-key';
const CONFIRM = { enabled: true, confirmBilling: true, confirmPlayToCaller: true };

/** A sink that plays for a while and, like a caller's phone speaker/microphone, lets its own sound come back as caller audio. */
class EchoingSink implements AgentAudioSink {
  readonly format = FORMAT_8K;
  readonly verified = false;
  played = 0;
  constructor(private readonly source: ManualAudioSource, private readonly playbackMs: number) {}
  async play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    const timer = setTimeout(() => {
      // 300 ms into the reply the speaker sound reaches the caller's microphone and returns on the downlink.
      this.source.push(speechPcm(900));
      this.source.push(noiseFloorPcm(1300));
    }, 100);
    const finished = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(true), this.playbackMs);
      signal.addEventListener('abort', () => (clearTimeout(t), resolve(false)), { once: true });
    });
    clearTimeout(timer);
    if (!finished) return { bytesWritten: 0, completed: false, stoppedBy: 'aborted' };
    this.played++;
    return { bytesWritten: pcm.length, completed: true, stoppedBy: null };
  }
}

describe('operator-enabled conversation mode (per call, no per-turn clicks)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(
    options: {
      providers?: ProviderSet;
      env?: Record<string, string | undefined>;
      playbackMs?: number;
      echo?: boolean;
    } = {}
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return original(command, timeoutMs);
    };
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink: AgentAudioSink & { played?: Buffer[] | number } = options.echo
      ? new EchoingSink(source, options.playbackMs ?? 500)
      : new CollectingAudioSink(FORMAT_8K, true, options.playbackMs ?? 0);
    const providers =
      options.providers ?? createMockProviders({ stt: ['hello', 'what are your opening hours', 'thanks bye'], llm: ['Hi there, how can I help?', 'We open at nine every morning.', 'You are welcome, goodbye.'] });
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
        idleWaitsMs: [60_000, 60_000, 60_000],
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
    const api = (method: 'get' | 'post' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const startCall = async () => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60);
      return call;
    };
    const view = () => server.aiOrchestrator.getSessions()[0]?.conversation;
    const enable = (callId: string, body: object = CONFIRM) => api('post', `/api/ai/calls/${callId}/conversation`).send(body);
    const caller = async () => {
      await vi.waitFor(() => expect(['listening', 'stopped']).toContain(view()?.phase ?? 'listening'));
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1300));
    };
    const endRemote = () => modem.emit('urc', { raw: 'VOICE CALL: END: 9', type: 'VOICE_CALL_END', durationSeconds: 9, timestamp: new Date().toISOString(), isSimulated: false });
    const played = () => (sink instanceof CollectingAudioSink ? sink.played.length : (sink as EchoingSink).played);
    return { server, modem, source, sink, providers, events, commands, api, startCall, view, enable, caller, endRemote, played };
  }

  it('is off by default: a call is only transcribed, and the state says stopped', async () => {
    const h = await harness();
    const call = await h.startCall();
    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).status).toBe(200);
    await h.caller();
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true));
    await sleep(100);
    expect(h.view()).toMatchObject({ enabled: false, phase: 'stopped', halfDuplex: true });
    expect(h.providers.llm.requests).toHaveLength(0);
    expect(h.providers.tts.requests).toHaveLength(0);
    expect(h.played()).toBe(0);
  });

  it('refuses without the two confirmations, for other calls, and when the output path is not ready', async () => {
    const h = await harness();
    const call = await h.startCall();
    expect((await h.enable(call.id, { enabled: true })).status).toBe(400);
    expect((await h.enable(call.id, { enabled: true, confirmBilling: true })).body.error).toMatch(/confirmPlayToCaller/);
    expect((await h.enable(call.id, { confirmBilling: true, confirmPlayToCaller: true })).status).toBe(400); // enabled missing
    expect((await h.enable('some-other-call')).status).toBe(404);

    const real = h.server.callManager.getUsbAudioStatus!.bind(h.server.callManager);
    vi.spyOn(h.server.callManager, 'getUsbAudioStatus').mockImplementation(() => ({ ...real(), audio: { state: 'stalled', msSinceLastFrame: 9000 }, moduleAudioFormat: { cpcmfrm: 1, cpcmbandwidth: null } }));
    const blocked = await h.enable(call.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers.join(' ')).toMatch(/inbound-wire/);
    expect(blocked.body.blockers.join(' ')).toMatch(/module reports 16000 Hz/);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0); // nothing was attached by a refused request
    expect(h.providers.llm.requests).toHaveLength(0);

    const noKey = await harness({ env: { CARTESIA_API_KEY: undefined } });
    const call2 = await noKey.startCall();
    const res = await noKey.enable(call2.id);
    expect(res.status).toBe(409);
    expect(res.body.blockers.join(' ')).toMatch(/CARTESIA_API_KEY is required/);
  });

  it('holds the acceptance conversation with no clicks between turns: Hello, then a follow-up, each answered once', async () => {
    const slow = createMockProviders({
      stt: ['hello', 'what are your opening hours'],
      llm: ['Hi there, how can I help?', 'We open at nine every morning.'],
      delays: { stt: 25, llm: 25, tts: 25 },
    });
    const h = await harness({ playbackMs: 60, providers: slow });
    const call = await h.startCall();
    const state0 = (await h.api('get', '/api/ai/state')).body;
    expect(state0.conversation).toMatchObject({ allowed: true, active: false });

    const on = await h.enable(call.id); // the single operator action: attaches and enables
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ success: true, enabled: true, conversation: { active: true } });
    expect(h.view()).toMatchObject({ enabled: true, phase: 'listening' });
    expect(h.server.aiRuntime.mode).toBe('passive'); // the persistent setting is untouched
    expect((await h.api('get', '/api/ai/settings')).body.attestations.outbound.confirmed).toBe(false); // nothing was "verified"

    const phases: AiConversationPhase[] = [];
    const sampler = setInterval(() => {
      const p = h.view()?.phase;
      if (p && phases.at(-1) !== p) phases.push(p);
    }, 2);

    await h.caller(); // "Hello"
    await vi.waitFor(() => expect(h.played()).toBe(1), { timeout: 4000 });
    await h.caller(); // the follow-up question
    await vi.waitFor(() => expect(h.played()).toBe(2), { timeout: 4000 });
    await vi.waitFor(() => expect(h.view()?.phase).toBe('listening'));
    clearInterval(sampler);

    // Exactly once per caller turn.
    expect(h.providers.stt.calls).toHaveLength(2);
    expect(h.providers.llm.requests).toHaveLength(2);
    expect(h.providers.tts.requests).toEqual(['Hi there, how can I help?', 'We open at nine every morning.']);
    // Contextual: the second request carries the first exchange.
    expect(h.providers.llm.requests[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:hello',
      'assistant:Hi there, how can I help?',
      'user:what are your opening hours',
    ]);
    // The stages were visited in order and it went back to listening.
    const order = ['transcribing', 'generating', 'speaking', 'listening'];
    const firstTurn = phases.slice(phases.indexOf('transcribing'));
    expect(firstTurn.slice(0, 4)).toEqual(order);
    expect(new Set(phases)).toEqual(new Set(['listening', 'transcribing', 'generating', 'speaking']));
    // Per-stage latency and no error on record.
    expect(h.view()!.lastTurn).toMatchObject({ status: 'completed', reason: null });
    expect(h.view()!.lastTurn!.sttMs).not.toBeNull();
    expect(h.view()!.lastTurn!.ttsFirstMs).not.toBeNull();
    expect(h.view()!.lastError).toBeNull();
    // It does not keep going by itself.
    await sleep(250);
    expect(h.providers.llm.requests).toHaveLength(2);
    expect(h.played()).toBe(2);
    // And the call control was never touched by the AI.
    expect(h.commands.filter((c) => /^ATA$|^ATH$|CHUP|^ATD/.test(c)).filter((c) => !c.startsWith('ATD'))).toEqual([]);
  });

  it('does not process the same event twice, and merges a caller who speaks again while the answer is being generated', async () => {
    const providers = createMockProviders({ stt: ['first part', 'first part second part'], llm: ['Sure, here is the answer.'], delays: { llm: 250 } });
    const h = await harness({ providers });
    const call = await h.startCall();
    await h.enable(call.id);
    await h.caller();
    await vi.waitFor(() => expect(providers.llm.requests).toHaveLength(1)); // the first turn is generating
    h.source.push(speechPcm(1200)); // the caller keeps talking: newest utterance wins; the first turn is cancelled, not answered
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.played()).toBe(1), { timeout: 4000 });
    await sleep(200);
    expect(h.played()).toBe(1); // one reply for what was, to the caller, one turn
    expect(providers.llm.requests.at(-1)!.messages.at(-1)).toEqual({ role: 'user', content: 'first part second part' });
    expect(h.view()!.phase).toBe('listening');
  });

  describe('half-duplex turn-taking', () => {
    it('ignores caller audio while the agent speaks, so it never answers its own voice coming back', async () => {
      const h = await harness({ echo: true, playbackMs: 600, env: { AI_PLAYBACK_GUARD_MS: '150' } });
      const call = await h.startCall();
      await h.enable(call.id);
      await h.caller();
      await vi.waitFor(() => expect(h.played()).toBe(1), { timeout: 4000 });
      await sleep(400); // the echo would have been transcribed by now if it had been heard
      expect(h.providers.stt.calls).toHaveLength(1);
      expect(h.providers.llm.requests).toHaveLength(1);
      expect(h.view()!.ignoredWhileSpeakingSeconds).toBeGreaterThan(0.5);
      expect(h.view()!.phase).toBe('listening');
    });

    it('would answer itself without it (the reason it is the default)', async () => {
      const h = await harness({ echo: true, playbackMs: 600, env: { AI_HALF_DUPLEX: 'false' } });
      const call = await h.startCall();
      await h.enable(call.id);
      await h.caller();
      await vi.waitFor(() => expect(h.providers.stt.calls.length).toBeGreaterThan(1), { timeout: 4000 });
    });

    it('keeps ignoring audio for the guard period after playback, then listens again', async () => {
      const h = await harness({ playbackMs: 40, env: { AI_PLAYBACK_GUARD_MS: '400' } });
      const call = await h.startCall();
      await h.enable(call.id);
      await h.caller();
      await vi.waitFor(() => expect(h.played()).toBe(1), { timeout: 4000 });
      await vi.waitFor(() => expect(h.view()!.phase).toBe('listening'));
      h.source.push(speechPcm(1200)); // right after the agent finished: inside the guard
      h.source.push(noiseFloorPcm(1300));
      await sleep(150);
      expect(h.providers.stt.calls).toHaveLength(1);
      await sleep(450); // guard over
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.providers.stt.calls).toHaveLength(2));
    });
  });

  describe('stopping and failing safely', () => {
    it('switching it off cuts off speech in progress and returns to transcription only', async () => {
      const h = await harness({ playbackMs: 2000 });
      const call = await h.startCall();
      await h.enable(call.id);
      await h.caller();
      await vi.waitFor(() => expect(h.view()!.phase).toBe('speaking'), { timeout: 4000 });
      const off = await h.enable(call.id, { enabled: false });
      expect(off.status).toBe(200);
      await vi.waitFor(() => expect(h.view()!.phase).toBe('stopped'));
      await sleep(100);
      expect(h.played()).toBe(0); // the cut-off reply was never reported as played
      expect(h.events.some((e) => e.stage === 'playback' && e.status === 'cancelled')).toBe(true);

      await h.caller(); // still transcribed, no longer answered
      await vi.waitFor(() => expect(h.providers.stt.calls).toHaveLength(2));
      await sleep(150);
      expect(h.providers.llm.requests).toHaveLength(1);
    });

    it('reports each stage failure, stays alive, and answers the next turn', async () => {
      const boom = (stage: 'llm' | 'stt') => new AiProviderError('groq', stage, 'HTTP 503: provider server error', { status: 503 });
      const providers = createMockProviders({ stt: [boom('stt'), '   ', 'hello again', 'one more'], llm: [boom('llm'), 'Recovered and answering.'] });
      // This test scripts one STT outcome per request, so it runs without the speculative request made during the pause.
      const h = await harness({ providers, env: { AI_MAX_RETRIES: '0', AI_SPECULATIVE_STT: 'false' } });
      const call = await h.startCall();
      await h.enable(call.id);

      await h.caller(); // STT fails
      await vi.waitFor(() => expect(h.view()!.lastError?.stage).toBe('stt'));
      expect(h.view()!.lastTurn).toMatchObject({ status: 'failed', reason: 'stt-failed' });
      expect(providers.llm.requests).toHaveLength(0);

      await h.caller(); // empty transcript: skipped, nothing generated
      await vi.waitFor(() => expect(h.view()!.lastTurn?.reason).toBe('empty-transcript'));
      expect(providers.llm.requests).toHaveLength(0);

      await h.caller(); // LLM fails
      await vi.waitFor(() => expect(h.view()!.lastError?.stage).toBe('llm'));
      expect(h.view()!.lastError!.message).toMatch(/503/);
      expect(h.played()).toBe(0);

      await h.caller(); // and then it works again
      await vi.waitFor(() => expect(h.played()).toBe(1), { timeout: 4000 });
      expect(h.view()).toMatchObject({ phase: 'listening', enabled: true });
    });

    it('a TTS failure is reported on its own stage and playback never starts', async () => {
      const providers = createMockProviders({ stt: ['hello'], llm: ['Hi there.'] });
      (providers.tts as unknown as { failOn: () => boolean }).failOn = () => true;
      const h = await harness({ providers });
      const call = await h.startCall();
      await h.enable(call.id);
      await h.caller();
      await vi.waitFor(() => expect(h.view()!.lastError?.stage).toBe('tts'));
      expect(h.played()).toBe(0);
      expect(h.view()!.phase).toBe('listening');
    });

    it('stops everything on hang-up and the next call starts with conversation off', async () => {
      const h = await harness({ playbackMs: 1500 });
      const call = await h.startCall();
      await h.enable(call.id);
      await h.caller();
      await vi.waitFor(() => expect(h.view()!.phase).toBe('speaking'), { timeout: 4000 });
      h.endRemote();
      await vi.waitFor(() => expect(h.server.aiOrchestrator.isAttached(call.id)).toBe(false));
      expect(h.source.listenerCount).toBe(0);
      expect(h.played()).toBe(0);
      const requests = h.providers.llm.requests.length;
      await h.caller();
      await sleep(300);
      expect(h.providers.llm.requests).toHaveLength(requests);

      const next = await h.startCall();
      await h.api('post', `/api/ai/calls/${next.id}/arm`);
      expect(h.view()).toMatchObject({ enabled: false, phase: 'stopped' });
    });

    it('survives a settings save during the call: the operator\'s choice for this call stays', async () => {
      const h = await harness();
      const call = await h.startCall();
      await h.enable(call.id);
      expect((await h.api('put', '/api/ai/settings').send({ language: 'en-US' })).status).toBe(200);
      expect(h.view()).toMatchObject({ enabled: true });
      await h.caller();
      await vi.waitFor(() => expect(h.played()).toBe(1), { timeout: 4000 });
    });
  });

  it('shows the live pipeline in the session list', async () => {
    const h = await harness();
    const call = await h.startCall();
    await h.enable(call.id);
    const sessions = (await h.api('get', '/api/ai/sessions')).body.sessions;
    expect(sessions[0].conversation).toMatchObject({ enabled: true, phase: 'listening', halfDuplex: true, ignoredWhileSpeakingSeconds: 0, lastTurn: null, lastError: null });
    expect(typeof sessions[0].conversation.phaseSince).toBe('string');
  });
});
