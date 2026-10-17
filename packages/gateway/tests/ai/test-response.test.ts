import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { AgentAudioSink, CollectingAudioSink, ManualAudioSource, PlayResult } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { AiProviderError, ProviderSet } from '../../src/ai/providers/types.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, loudNoisePcm, noiseFloorPcm, SECRET, sleep, speechPcm } from './helpers.js';

const KEY = 'test-response-key';
const CONFIRM = { confirmBilling: true, confirmPlayToCaller: true };

class ScriptedSink implements AgentAudioSink {
  readonly format = FORMAT_8K;
  readonly verified = false;
  calls = 0;
  constructor(private readonly result: (pcm: Buffer) => PlayResult | Promise<PlayResult>) {}
  async play(pcm: Buffer): Promise<PlayResult> {
    this.calls++;
    return this.result(pcm);
  }
}

describe('one-shot test response', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(
    options: {
      providers?: ProviderSet;
      sink?: AgentAudioSink;
      env?: Record<string, string | undefined>;
      mode?: 'passive' | 'active';
    } = {}
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-response-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return original(command, timeoutMs);
    };
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = options.sink ?? new CollectingAudioSink(FORMAT_8K, true);
    const providers = options.providers ?? createMockProviders({ stt: ['What time do you open tomorrow?'], llm: ['We open at nine in the morning.'] });
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { env: aiEnv(options.env), providers, allowSimulatedHardware: true, mode: options.mode ?? 'passive', transports: () => ({ source, sink }) },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const api = (method: 'get' | 'post', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const startCall = async () => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60);
      return call;
    };
    /** Attach in passive mode and let the caller say something that yields a voiced transcript. */
    const attachAndHear = async () => {
      const call = await startCall();
      expect((await api('post', `/api/ai/calls/${call.id}/arm`)).status).toBe(200);
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1200));
      await vi.waitFor(() => expect(events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true));
      return call;
    };
    const post = (callId: string, body: object = CONFIRM) => api('post', `/api/ai/calls/${callId}/test-response`).send(body);
    const endCall = () =>
      modem.emit('urc', { raw: 'VOICE CALL: END: 4', type: 'VOICE_CALL_END', durationSeconds: 4, timestamp: new Date().toISOString(), isSimulated: false });
    return { server, modem, source, sink, providers, events, commands, api, startCall, attachAndHear, post, endCall };
  }

  it('answers the latest transcript once, with every stage reported, and verifies nothing', async () => {
    const h = await harness();
    const call = await h.attachAndHear();
    const state = (await h.api('get', '/api/ai/state')).body;
    expect(state.testResponse).toMatchObject({ allowed: true, blockers: [], format: expect.stringMatching(/8000 Hz/) });
    expect(state.testResponse.transcriptAgeSeconds).toBeLessThan(5);
    expect(JSON.stringify(state.testResponse)).not.toContain('open tomorrow'); // the words are never in the readiness

    const before = h.commands.length;
    const res = await h.post(call.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      callId: call.id,
      mock: true,
      heardByRemote: 'unknown',
      llm: { status: 'ok', chars: 'We open at nine in the morning.'.length },
      tts: { status: 'ok' },
      playbackSubmission: { status: 'ok' },
      playbackCompletion: { status: 'ok', stoppedBy: null },
    });
    expect(res.body.playbackSubmission.bytesWritten).toBe(res.body.playbackSubmission.bytesTotal);

    // The model got exactly the heard words, once; the voice got exactly the reply; the sink got that audio.
    expect(h.providers.llm.requests).toHaveLength(1);
    expect(h.providers.llm.requests[0].messages).toEqual([{ role: 'user', content: 'What time do you open tomorrow?' }]);
    expect(h.providers.tts.requests).toEqual(['We open at nine in the morning.']);
    expect((h.sink as CollectingAudioSink).played).toHaveLength(1);

    // It stays passive, never confirms the outbound path, never touches call control or the modem.
    expect(h.server.aiRuntime.mode).toBe('passive');
    const settings = (await h.api('get', '/api/ai/settings')).body;
    expect(settings.attestations.outbound.confirmed).toBe(false);
    expect((await h.api('get', '/api/ai/readiness')).body.ok).toBe(false);
    expect(h.commands.slice(before)).toEqual([]);

    // One action, one reply: nothing follows by itself.
    await sleep(250);
    expect(h.providers.llm.requests).toHaveLength(1);
    expect((h.sink as CollectingAudioSink).played).toHaveLength(1);

    // The inspector shows the test under its own turn, text hidden unless transcripts are on.
    const test = h.events.filter((e) => e.turnId?.endsWith(':test1'));
    expect(test.map((e) => e.stage)).toEqual(['llm-request', 'llm-response', 'tts-generated', 'playback']);
    expect(test.every((e) => e.status === 'ok')).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain('nine in the morning');
    expect(test.find((e) => e.stage === 'playback')?.detail).toMatch(/audibility is not verified/);
  });

  it('needs an explicit operator action each time and never runs twice from one', async () => {
    const h = await harness();
    const call = await h.attachAndHear();
    const refused = await h.post(call.id, { confirmBilling: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/confirmPlayToCaller/);
    expect((await h.post(call.id, {})).status).toBe(400);
    expect(h.providers.llm.requests).toHaveLength(0);

    expect((await h.post(call.id)).status).toBe(200);
    expect((await h.post(call.id)).status).toBe(200); // a second, separate action is a second reply
    expect(h.providers.llm.requests).toHaveLength(2);
  });

  it('refuses concurrent runs', async () => {
    const providers = createMockProviders({ stt: ['hello there'], llm: ['Sure thing, happy to help.'], delays: { llm: 300 } });
    const h = await harness({ providers });
    const call = await h.attachAndHear();
    const first = h.post(call.id).then((r) => r);
    await sleep(80);
    const second = await h.post(call.id);
    expect(second.status).toBe(409);
    expect(second.body.blockers.join(' ')).toMatch(/already running/);
    expect((await first).status).toBe(200);
    expect(providers.llm.requests).toHaveLength(1);
  });

  describe('rejections', () => {
    it('with no call', async () => {
      const h = await harness();
      expect((await h.post('no-such-call')).status).toBe(404);
      expect((await h.api('get', '/api/ai/state')).body.testResponse.allowed).toBe(false);
    });

    it('with no attached session', async () => {
      const h = await harness();
      const call = await h.startCall();
      const res = await h.post(call.id);
      expect(res.status).toBe(409);
      expect(res.body.blockers.join(' ')).toMatch(/not attached to this call/);
      expect(h.providers.llm.requests).toHaveLength(0);
    });

    it('with no transcript yet, and with a transcript from noise', async () => {
      const h = await harness();
      const call = await h.startCall();
      await h.api('post', `/api/ai/calls/${call.id}/arm`);
      let res = await h.post(call.id);
      expect(res.status).toBe(409);
      expect(res.body.blockers.join(' ')).toMatch(/no voiced transcript/);

      h.source.push(loudNoisePcm(1200)); // transcribed by the scripted STT, but not voiced audio
      h.source.push(noiseFloorPcm(1200));
      await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true));
      res = await h.post(call.id);
      expect(res.status).toBe(409);
      expect(res.body.blockers.join(' ')).toMatch(/no voiced transcript/);
      expect(h.providers.llm.requests).toHaveLength(0);
    });

    it('with a stale transcript', async () => {
      const h = await harness();
      const call = await h.attachAndHear();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
      const res = await h.post(call.id);
      expect(res.status).toBe(409);
      expect(res.body.blockers.join(' ')).toMatch(/s old \(limit 60 s\)/);
    });

    it('when the output path is not ready: audio not flowing, module format disagrees, PCM test running, keys missing', async () => {
      const h = await harness();
      const call = await h.attachAndHear();

      const usb = h.server.callManager.getUsbAudioStatus!.bind(h.server.callManager);
      const spy = vi.spyOn(h.server.callManager, 'getUsbAudioStatus');
      spy.mockImplementation(() => ({ ...usb(), moduleAudioFormat: { cpcmfrm: 1, cpcmbandwidth: null } }));
      let res = await h.post(call.id);
      expect(res.status).toBe(409);
      expect(res.body.blockers.join(' ')).toMatch(/module reports 16000 Hz \(AT\+CPCMFRM=1\) but the gateway is set to 8000 Hz/);

      spy.mockImplementation(() => ({ ...usb(), audio: { state: 'stalled', msSinceLastFrame: 9000 } }));
      res = await h.post(call.id);
      expect(res.body.blockers.join(' ')).toMatch(/inbound-wire/);

      spy.mockRestore();
      expect(h.providers.llm.requests).toHaveLength(0);
      expect((h.sink as CollectingAudioSink).played).toHaveLength(0);

      const noKey = await harness({ env: { CARTESIA_API_KEY: undefined } });
      const call2 = await noKey.attachAndHear();
      const blocked = await noKey.post(call2.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.blockers.join(' ')).toMatch(/CARTESIA_API_KEY is required/);
    });

    it('when replies are already enabled for the call', async () => {
      const h = await harness({ mode: 'active', env: { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' } });
      const call = await h.startCall();
      await h.api('post', `/api/ai/calls/${call.id}/arm`);
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1200));
      await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'playback')).toBe(true));
      const res = await h.post(call.id);
      expect(res.status).toBe(409);
      expect(res.body.blockers.join(' ')).toMatch(/replies are already enabled/);
    });

    it('never lets mock hardware pass without the test seam', async () => {
      const h = await harness();
      const call = await h.attachAndHear();
      // The production check: a simulated modem fails the hardware readiness that the test response also requires.
      const strict = createGatewayServer({
        config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(os.tmpdir(), `strict-${Date.now()}.sqlite`) },
        modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
        audio: new MockAudioAdapter(),
        ai: { env: aiEnv(), providers: createMockProviders() },
      });
      expect(strict.aiRuntime.testResponseReadiness().blockers.join(' ')).toMatch(/hardware: .*simulated/);
      await strict.close();
      expect(call.id).toBeTruthy();
    });
  });

  describe('stage failures are reported separately and never faked', () => {
    it('LLM failure: later stages do not run and nothing is played', async () => {
      const providers = createMockProviders({ stt: ['hello there friend'], llm: [new AiProviderError('groq', 'llm', 'HTTP 429: rate limited or out of quota', { status: 429 })] });
      const h = await harness({ providers });
      const call = await h.attachAndHear();
      const res = await h.post(call.id);
      expect(res.status).toBe(200);
      expect(res.body.llm).toMatchObject({ status: 'failed' });
      expect(res.body.llm.error).toMatch(/rate limited/);
      expect(res.body.tts.status).toBe('not-run');
      expect(res.body.playbackSubmission.status).toBe('not-run');
      expect(res.body.playbackCompletion.status).toBe('not-run');
      expect((h.sink as CollectingAudioSink).played).toHaveLength(0);
      expect(JSON.stringify(res.body) + JSON.stringify(h.events)).not.toContain(SECRET);
    });

    it('an empty model reply is a failure, not silence played to the caller', async () => {
      const providers = createMockProviders({ stt: ['hello there friend'], llm: ['END_CALL'] });
      const h = await harness({ providers });
      const call = await h.attachAndHear();
      const res = await h.post(call.id);
      expect(res.body.llm).toMatchObject({ status: 'failed', error: expect.stringMatching(/no speakable text/) });
      expect(res.body.tts.status).toBe('not-run');
      expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'); // a sign-off token never ends the call
    });

    it('TTS failure: the LLM result is kept, playback does not run', async () => {
      const providers = createMockProviders({ stt: ['hello there friend'], llm: ['Of course, one moment please.'] });
      (providers.tts as unknown as { failOn: () => boolean }).failOn = () => true;
      const h = await harness({ providers });
      const call = await h.attachAndHear();
      const res = await h.post(call.id);
      expect(res.body.llm.status).toBe('ok');
      expect(res.body.tts).toMatchObject({ status: 'failed', error: expect.stringMatching(/scripted failure/) });
      expect(res.body.playbackSubmission.status).toBe('not-run');
      expect((h.sink as CollectingAudioSink).played).toHaveLength(0);
    });

    it('playback accepted nothing: submission and completion both fail', async () => {
      const sink = new ScriptedSink(() => ({ bytesWritten: 0, completed: false, stoppedBy: 'not-written' }));
      const h = await harness({ sink });
      const call = await h.attachAndHear();
      const res = await h.post(call.id);
      expect(res.body.llm.status).toBe('ok');
      expect(res.body.tts.status).toBe('ok');
      expect(res.body.playbackSubmission).toMatchObject({ status: 'failed', bytesWritten: 0 });
      expect(res.body.playbackSubmission.error).toMatch(/not-written/);
      expect(res.body.playbackCompletion.status).toBe('failed');
      expect(res.body.heardByRemote).toBe('unknown');
    });

    it('playback cut short: submitted but not completed', async () => {
      const sink = new ScriptedSink((pcm) => ({ bytesWritten: Math.floor(pcm.length / 3), completed: false, stoppedBy: 'call-ended' }));
      const h = await harness({ sink });
      const call = await h.attachAndHear();
      const res = await h.post(call.id);
      expect(res.body.playbackSubmission).toMatchObject({ status: 'ok' });
      expect(res.body.playbackSubmission.bytesWritten).toBeLessThan(res.body.playbackSubmission.bytesTotal);
      expect(res.body.playbackCompletion).toMatchObject({ status: 'cancelled', stoppedBy: 'call-ended' });
    });

    it('a sink that throws is reported as a submission failure', async () => {
      const sink = new ScriptedSink(() => {
        throw new Error('Audio port is not streaming; refusing to write playback');
      });
      const h = await harness({ sink });
      const call = await h.attachAndHear();
      const res = await h.post(call.id);
      expect(res.body.playbackSubmission).toMatchObject({ status: 'failed', error: expect.stringMatching(/not streaming/) });
      expect(res.body.playbackCompletion.status).toBe('not-run');
    });

    it('the call ending mid-generation cancels the run and plays nothing', async () => {
      const providers = createMockProviders({ stt: ['hello there friend'], llm: ['This reply arrives too late.'], delays: { llm: 400 } });
      const h = await harness({ providers });
      const call = await h.attachAndHear();
      const pending = h.post(call.id).then((r) => r); // supertest only sends once awaited or chained
      await sleep(100);
      h.endCall();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.llm.status).toBe('cancelled');
      expect(res.body.tts.status).toBe('not-run');
      expect((h.sink as CollectingAudioSink).played).toHaveLength(0);
      // The slot is released: a later call can use the feature.
      expect(h.server.aiRuntime.testResponseReadiness().blockers.join(' ')).not.toMatch(/already running/);
    });
  });
});
