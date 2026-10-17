import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { GatewayAudioSink, GatewayAudioSource } from '../../src/ai/gateway-adapters.js';
import { createMockProviders, ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { ProviderSet } from '../../src/ai/providers/types.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const API_KEY = 'ai-orchestrator-test-key';
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };

describe('AI agent inside the gateway', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(
    options: {
      env?: Record<string, string | undefined>;
      providers?: ProviderSet;
      config?: Record<string, unknown>;
      withAi?: boolean;
    } = {}
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const audio = new MockAudioAdapter();
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true);
    const providers = options.providers ?? createMockProviders();
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return original(command, timeoutMs);
    };
    const server: GatewayServerInstance = createGatewayServer({
      config: {
        modemDriver: 'mock',
        gatewayApiKey: API_KEY,
        sqliteDbPath: path.join(dir, 'gateway.sqlite'),
        enableUsbAudioDiagnostic: true,
        ...(options.config as object),
      },
      modem,
      audio,
      instanceLockDir: dir,
      ai: {
        env: options.withAi === false ? {} : aiEnv({ ...VERIFIED, ...options.env }),
        providers,
        allowSimulatedHardware: true,
        mode: 'active',
        transports: () => ({ source, sink }),
      },
    });
    await modem.initialize();
    server.aiOrchestrator?.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const alerts: string[] = [];
    server.eventBus.on('gateway:alert', (alert) => alerts.push(alert.message));
    const api = (method: 'get' | 'post', url: string) => request(server.app)[method](url).set('x-api-key', API_KEY);

    /** Bring up an ACTIVE call the way a real one reaches the gateway: URC-driven, no answering by the AI. */
    const startCall = async (activateUsbAudio = true) => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      if (activateUsbAudio) await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60); // let the mock audio produce frames so the wire reads as flowing
      return call;
    };
    const endCallRemotely = () =>
      modem.emit('urc', { raw: 'VOICE CALL: END: 5', type: 'VOICE_CALL_END', durationSeconds: 5, timestamp: new Date().toISOString(), isSimulated: false });
    /** A caller sentence followed by the pause that ends the turn. */
    const callerSpeaks = () => {
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1200));
    };

    return { server, modem, audio, source, sink, providers, commands, alerts, api, startCall, endCallRemotely, callerSpeaks };
  }

  const callControl = (commands: string[]) =>
    commands.filter((c) => c === 'ATH' || c === 'ATA' || c === 'AT+CHUP' || c.startsWith('ATD'));

  it('is completely inert unless enabled, and the gateway works as before', async () => {
    const h = await harness({ withAi: false });
    expect(h.server.aiRuntime.mode).toBe('off');

    const status = await h.api('get', '/api/ai/status');
    expect(status.body).toMatchObject({ enabled: false, usable: false, sessions: [] });
    expect((await h.api('get', '/api/ai/readiness')).body.ok).toBe(false);
    expect((await h.api('post', '/api/ai/calls/whatever/arm')).status).toBe(409);

    // Existing behaviour is untouched.
    expect((await h.api('get', '/api/gateway/health')).status).toBe(200);
    await h.startCall();
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
  });

  it('requires the gateway\'s API key like every other route', async () => {
    const h = await harness();
    expect((await request(h.server.app).get('/api/ai/status')).status).toBe(401);
    expect((await request(h.server.app).post('/api/ai/calls/x/arm')).status).toBe(401);
  });

  it('does not touch a call nobody armed, even if a caller starts talking', async () => {
    const h = await harness();
    const call = await h.startCall();
    h.callerSpeaks();
    await sleep(80);

    expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(false);
    expect(h.providers.stt.calls).toHaveLength(0);
    expect(h.source.listenerCount).toBe(0);
    expect(h.sink.playCalls).toBe(0);
  });

  it('refuses to arm until incoming and outgoing audio have been verified, and says why', async () => {
    const h = await harness({ env: { AI_AUDIO_INBOUND_VERIFIED: undefined, AI_AUDIO_OUTBOUND_VERIFIED: undefined } });
    const call = await h.startCall();

    const readiness = (await h.api('get', '/api/ai/readiness')).body;
    expect(readiness.ok).toBe(false);
    expect(readiness.blockers.join(' ')).toMatch(/inbound-audio.*not been confirmed/);
    expect(readiness.blockers.join(' ')).toMatch(/outbound-audio.*not been confirmed/);

    const arm = await h.api('post', `/api/ai/calls/${call.id}/arm`);
    expect(arm.status).toBe(409);
    expect(arm.body.blockers.length).toBeGreaterThan(0);
    expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(false);
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
  });

  it('refuses when the verified flag is set but the wire shows no audio', async () => {
    const h = await harness();
    const call = await h.startCall(false); // USB audio never activated -> not flowing
    const arm = await h.api('post', `/api/ai/calls/${call.id}/arm`);
    expect(arm.status).toBe(409);
    expect(arm.body.error).toMatch(/inbound-audio/);
  });

  it('arms only the current call', async () => {
    const h = await harness();
    await h.startCall();
    expect((await h.api('post', '/api/ai/calls/not-the-current-call/arm')).status).toBe(404);
  });

  it('runs a whole spoken turn on an armed, ready call without sending any call-control command', async () => {
    const providers = createMockProviders({ stt: ['What time do you close?'], llm: ['We close at five. Anything else I can do for you?'] });
    const h = await harness({ providers });
    const call = await h.startCall();
    const before = h.commands.length;

    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).body).toMatchObject({ success: true });
    expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(true);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1));

    expect(providers.stt.calls).toHaveLength(1);
    // A very short first sentence is joined to the next so TTS is not called for a few words.
    expect(providers.tts.requests).toEqual(['We close at five. Anything else I can do for you?']);
    const status = (await h.api('get', '/api/ai/status')).body;
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({ callId: call.id, busy: false, degraded: false });
    expect(status.sessions[0].totals).toMatchObject({ turns: 1, completed: 1 });
    expect(status.sessions[0].lastTurn).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(status)).not.toContain('What time do you close'); // no transcripts in status
    expect(JSON.stringify(status)).not.toContain('sk-test');

    // The AI never answered, dialled, hung up or touched the audio registration.
    expect(h.commands.slice(before)).toEqual([]);
    expect(callControl(h.commands).filter((c) => c !== 'ATD+919876543210;')).toEqual([]);
    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
  });

  it('can be switched on for a direction with AI_AUTO_HANDLE, and only that direction', async () => {
    const inboundOnly = await harness({ env: { AI_AUTO_HANDLE: 'inbound' } });
    await inboundOnly.startCall(); // outbound call
    expect(inboundOnly.server.aiOrchestrator!.getStatus().sessions).toEqual([]);

    // USB audio is activated after the call connects, so the agent attaches once the wire is ready.
    const outbound = await harness({ env: { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUTO_HANDLE: 'outbound' } });
    const call = await outbound.startCall();
    await vi.waitFor(() => expect(outbound.server.aiOrchestrator!.isAttached(call.id)).toBe(true), { timeout: 3000 });
  });

  it('does not auto-attach while readiness fails, reports it only when the reason changes, and stops when the call ends', async () => {
    const h = await harness({ env: { AI_AUTO_HANDLE: 'all', AI_AUDIO_INBOUND_VERIFIED: 'false' } });
    const call = await h.startCall();
    await sleep(600);
    const waiting = () => h.alerts.filter((a) => /AI agent waiting to attach/.test(a)).length;
    const settled = waiting();
    expect(settled).toBeGreaterThan(0);
    expect(h.alerts.join(' ')).toMatch(/inbound-audio/);

    await sleep(1300); // more than two further polls with nothing changed
    expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(false);
    expect(waiting()).toBe(settled);

    h.endCallRemotely();
    await sleep(700);
    expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(false);
    expect(waiting()).toBe(settled);
  });

  it('cancels outstanding work and detaches when the call ends mid-request', async () => {
    const providers = {
      stt: new ScriptedStt(['hello']),
      llm: new ScriptedLlm(['A long answer that will never be spoken.'], { delayMs: 500 }),
      tts: new ToneTts(),
    };
    const h = await harness({ providers });
    const call = await h.startCall();
    await h.server.aiOrchestrator!.arm(call.id);
    h.callerSpeaks();
    await vi.waitFor(() => expect(providers.llm.requests).toHaveLength(1));

    const started = Date.now();
    h.endCallRemotely();
    await vi.waitFor(() => expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(false));

    expect(Date.now() - started).toBeLessThan(300); // not waited out
    expect(h.server.callManager.getCurrentCall()).toBeNull();
    expect(h.sink.played).toHaveLength(0);
    expect(h.source.listenerCount).toBe(0);
    expect(h.server.aiOrchestrator!.getStatus().sessions).toEqual([]);
    expect(h.server.aiOrchestrator!.isArmed(call.id)).toBe(false);
    // audio arriving after the call is gone goes nowhere
    h.callerSpeaks();
    await sleep(60);
    expect(providers.stt.calls).toHaveLength(1);
  });

  it('gives the next call a clean session', async () => {
    const providers = createMockProviders({ stt: ['first call words'], llm: ['Reply for the first call only.'] });
    const h = await harness({ providers });
    const first = await h.startCall();
    await h.server.aiOrchestrator!.arm(first.id);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1));
    h.endCallRemotely();
    await vi.waitFor(() => expect(h.server.aiOrchestrator!.isAttached(first.id)).toBe(false));

    const second = await h.startCall();
    expect(second.id).not.toBe(first.id);
    expect(h.server.aiOrchestrator!.isAttached(second.id)).toBe(false); // not armed: nothing carries over
    await h.server.aiOrchestrator!.arm(second.id);
    const session = (h.server.aiOrchestrator!.getStatus().sessions as Array<{ callId: string; totals: { turns: number } }>)[0];
    expect(session).toMatchObject({ callId: second.id, totals: { turns: 0 } });
  });

  describe('agent hang-up', () => {
    const goodbye = () => createMockProviders({ stt: ['no that is all'], llm: ['Thank you for calling, goodbye! END_CALL'] });

    it('is reported, not performed, by default', async () => {
      const h = await harness({ providers: goodbye() });
      const hangup = vi.spyOn(h.server.callManager, 'hangup');
      const call = await h.startCall();
      await h.server.aiOrchestrator!.arm(call.id);
      h.callerSpeaks();
      await vi.waitFor(() => expect(h.alerts.some((a) => /said END_CALL; not hanging up/.test(a))).toBe(true));

      expect(hangup).not.toHaveBeenCalled();
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
      expect(callControl(h.commands).filter((c) => !c.startsWith('ATD'))).toEqual([]);
    });

    it('hangs up exactly once, with no retry, when explicitly allowed', async () => {
      const h = await harness({ providers: goodbye(), env: { AI_ALLOW_AGENT_HANGUP: 'true' } });
      const hangup = vi.spyOn(h.server.callManager, 'hangup').mockRejectedValue(new Error('modem busy'));
      const call = await h.startCall();
      await h.server.aiOrchestrator!.arm(call.id);
      h.callerSpeaks();
      await vi.waitFor(() => expect(h.alerts.some((a) => /could not hang up: modem busy/.test(a))).toBe(true));
      await sleep(50);

      expect(hangup).toHaveBeenCalledTimes(1);
      expect(hangup).toHaveBeenCalledWith('AI agent ended the call');
    });
  });

  it('leaves the call alone when the AI gives up after repeated failures', async () => {
    const providers = createMockProviders({ stt: [new Error('provider down')] });
    const h = await harness({ providers, env: { AI_MAX_CONSECUTIVE_FAILURES: '2' } });
    const call = await h.startCall();
    await h.server.aiOrchestrator!.arm(call.id);
    const failures = () =>
      (h.server.aiOrchestrator!.getStatus().sessions as Array<{ totals: { failed: number } }>)[0].totals.failed;
    h.callerSpeaks();
    await vi.waitFor(() => expect(failures()).toBe(1)); // let the first turn finish failing before the next one
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.alerts.some((a) => /stopped responding after 2 consecutive failures/.test(a))).toBe(true));

    expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(callControl(h.commands).filter((c) => !c.startsWith('ATD'))).toEqual([]);
  });

  it('stops a PCM verification test from writing the audio port while the AI agent owns it', async () => {
    const h = await harness({ config: { enableUsbPcmCaptureTest: true } });
    const call = await h.startCall();
    await h.server.aiOrchestrator!.arm(call.id);

    const capture = await h.api('post', '/api/gateway/audio/usb-pcm/capture');
    expect(capture.status).toBe(409);
    expect(capture.body.error).toMatch(/AI agent is using the audio port/);
  });

  it('shuts the AI down with the gateway', async () => {
    const h = await harness();
    const call = await h.startCall();
    await h.server.aiOrchestrator!.arm(call.id);
    await h.server.aiOrchestrator!.stop();
    expect(h.server.aiOrchestrator!.isAttached(call.id)).toBe(false);
    expect(h.source.listenerCount).toBe(0);
  });
});

describe('gateway audio adapters', () => {
  const makeAudio = async () => {
    const audio = new MockAudioAdapter({ generateTone: false });
    await audio.startSession('call-1');
    return audio;
  };

  it('source forwards frames only while the call it belongs to is live', async () => {
    const audio = await makeAudio();
    let live = false;
    const source = new GatewayAudioSource(audio, FORMAT_8K, true, () => live);
    const received: number[] = [];
    const off = source.onAudio((pcm) => received.push(pcm.length));

    await sleep(70);
    expect(received).toHaveLength(0);
    live = true;
    await sleep(70);
    expect(received.length).toBeGreaterThan(0);
    off();
    const after = received.length;
    await sleep(60);
    expect(received).toHaveLength(after);
    await audio.stopSession();
  });

  it('sink writes through the existing audio adapter, paced, and counts what the adapter accepted', async () => {
    const audio = await makeAudio();
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    const pcm = speechPcm(200); // 10 frames of 20 ms

    const result = await sink.play(pcm, new AbortController().signal);

    expect(result).toMatchObject({ bytesWritten: pcm.length, completed: true, stoppedBy: null });
    expect(audio.getStats().bytesSent).toBe(pcm.length);
    await audio.stopSession();
  });

  it('sink stops when aborted or when the call is no longer active, and says so', async () => {
    const audio = await makeAudio();
    const controller = new AbortController();
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    const running = sink.play(speechPcm(2000), controller.signal);
    await sleep(60);
    controller.abort();
    const aborted = await running;
    expect(aborted).toMatchObject({ completed: false, stoppedBy: 'aborted' });
    expect(aborted.bytesWritten).toBeLessThan(speechPcm(2000).length);

    let live = true;
    const endingSink = new GatewayAudioSink(audio, FORMAT_8K, true, () => live);
    const playing = endingSink.play(speechPcm(2000), new AbortController().signal);
    await sleep(60);
    live = false;
    expect(await playing).toMatchObject({ completed: false, stoppedBy: 'call-ended' });
    await audio.stopSession();
  });

  it('sink refuses to write when the audio port is not streaming', async () => {
    const audio = new MockAudioAdapter(); // no session started
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    await expect(sink.play(speechPcm(100), new AbortController().signal)).rejects.toThrow(/not streaming/);
    expect(audio.getStats().bytesSent).toBe(0);
  });

  it('sink never interleaves two plays on the port', async () => {
    const audio = await makeAudio();
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    const order: string[] = [];
    const original = audio.writeAudioChunk.bind(audio);
    let tag = '';
    audio.writeAudioChunk = async (chunk) => {
      order.push(tag);
      return original(chunk);
    };
    const first = (async () => {
      tag = 'a';
      return sink.play(speechPcm(100), new AbortController().signal);
    })();
    const second = sink.play(speechPcm(100), new AbortController().signal);
    await Promise.all([first, second]);
    // every chunk of the first play was written before any chunk of the second started
    const firstDone = order.lastIndexOf('a');
    expect(order.slice(0, firstDone + 1).every((t) => t === 'a')).toBe(true);
    await audio.stopSession();
  });
});
