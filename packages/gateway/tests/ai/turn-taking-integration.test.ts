import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { ProviderSet } from '../../src/ai/providers/types.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, loudNoisePcm, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const KEY = 'turn-taking-key';
const CONFIRM = { enabled: true, confirmBilling: true, confirmPlayToCaller: true };

/**
 * The real endpointer, orchestrator and session wired together, with only the telephone line and the providers faked.
 * Audio is pushed instantly, so these tests prove ordering and decisions, not wall-clock latency.
 */
describe('turn-taking inside the gateway (real endpointer, orchestrator and session)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(options: { stt?: Array<string>; sttDelayMs?: number; llm?: string[]; playbackMs?: number; env?: Record<string, string | undefined> } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-taking-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true, options.playbackMs ?? 0);
    const providers: ProviderSet & { stt: ScriptedStt; llm: ScriptedLlm; tts: ToneTts } = {
      stt: new ScriptedStt(options.stt ?? ['hello there', 'what are your opening hours', 'thanks bye'], options.sttDelayMs ?? 0),
      llm: new ScriptedLlm(options.llm ?? ['Hi there, how can I help you today?', 'We open at nine every morning.', 'You are welcome, goodbye now.']),
      tts: new ToneTts(0),
    };
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
    const alerts: string[] = [];
    server.eventBus.on('gateway:alert', (a) => alerts.push(a.message));
    const api = (method: 'get' | 'post', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const startCall = async () => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60);
      await api('post', `/api/ai/calls/${call.id}/arm`);
      expect((await api('post', `/api/ai/calls/${call.id}/conversation`).send(CONFIRM)).status).toBe(200);
      return call;
    };
    const view = () => server.aiOrchestrator.getSessions()[0]?.conversation;
    const submitted = () => events.filter((e) => e.stage === 'stt-submit');
    const heard = (re: RegExp) => events.some((e) => e.stage === 'call' && re.test(e.detail ?? ''));
    return { server, source, sink, providers, events, alerts, startCall, view, submitted, heard };
  }

  describe('speculative transcription during the pause', () => {
    it('transcribes once and reuses it at the real end of the turn', async () => {
      const h = await harness({ sttDelayMs: 60 });
      await h.startCall();
      h.source.push(speechPcm(1500));
      h.source.push(noiseFloorPcm(1300)); // the soft end is at 350 ms of this silence, the real end at 1000 ms
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
      expect(h.providers.stt.calls).toHaveLength(1); // not two: the pause request WAS the transcription
      expect(h.submitted()[0].data).toMatchObject({ speculative: true });
      expect(h.providers.llm.requests).toHaveLength(1);
      expect(h.events.find((e) => e.stage === 'stt-result')?.data).toMatchObject({ speculative: true });
    });

    it('does nothing speculative when switched off, and still answers once', async () => {
      const h = await harness({ env: { AI_SPECULATIVE_STT: 'false' } });
      await h.startCall();
      h.source.push(speechPcm(1500));
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
      expect(h.providers.stt.calls).toHaveLength(1);
      expect(h.submitted()[0].data).toMatchObject({ speculative: false });
    });

    it('answers a caller who paused mid-sentence once, from the whole sentence', async () => {
      const h = await harness({ stt: ['I need a voice agent', 'I need a voice agent for my start-up'] });
      await h.startCall();
      h.source.push(speechPcm(900));
      h.source.push(noiseFloorPcm(500)); // long enough for a soft end, not for the real end
      h.source.push(speechPcm(900)); // ...they were only thinking
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
      await sleep(200);
      expect(h.providers.llm.requests).toHaveLength(1); // one reply, not one per half
      expect(h.providers.llm.requests[0].messages.at(-1)?.content).toBe('I need a voice agent for my start-up');
      expect(h.sink.played).toHaveLength(1);
    });
  });

  describe('early commit', () => {
    it('answers before the silence wait is over when the transcript is a finished sentence', async () => {
      const h = await harness({ stt: ['What time do you open?'], env: { AI_EARLY_COMMIT: 'true' } });
      await h.startCall();
      h.source.push(speechPcm(1500));
      h.source.push(noiseFloorPcm(420)); // past the soft end (350 ms), well short of the real end (1000 ms)
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
      expect(h.providers.stt.calls).toHaveLength(1);
      expect(h.providers.llm.requests).toHaveLength(1);
    });

    it('waits for the full silence when the sentence is not finished, and never answers twice', async () => {
      const h = await harness({ stt: ['I need a chatbot for'], env: { AI_EARLY_COMMIT: 'true' } });
      await h.startCall();
      h.source.push(speechPcm(1500));
      h.source.push(noiseFloorPcm(420));
      await sleep(350);
      expect(h.providers.llm.requests).toHaveLength(0); // no terminal punctuation: not committed early
      h.source.push(noiseFloorPcm(900)); // the rest of the silence
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
      await sleep(200);
      expect(h.providers.llm.requests).toHaveLength(1);
    });

    it('is off by default', async () => {
      const h = await harness({ stt: ['What time do you open?'] });
      await h.startCall();
      h.source.push(speechPcm(1500));
      h.source.push(noiseFloorPcm(420));
      await sleep(350);
      expect(h.providers.llm.requests).toHaveLength(0);
    });
  });

  describe('barge-in while the agent is speaking', () => {
    it('stops the reply, listens to the interruption, and answers it', async () => {
      const h = await harness({ playbackMs: 4000, stt: ['hello there', 'actually I have a different question'] });
      await h.startCall();
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.view()?.phase).toBe('speaking'), { timeout: 4000 });
      // Line quiet while the agent talks (the detector calibrates on it), then the caller starts talking over it.
      h.source.push(noiseFloorPcm(800));
      h.source.push(speechPcm(900));
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'playback' && e.status === 'cancelled')).toBe(true), { timeout: 5000 });
      expect(h.heard(/interrupted the agent/)).toBe(true);
      // The first reply was cut off, not finished: it was never counted as played in full.
      expect(h.sink.played.length).toBeLessThanOrEqual(1);
      await vi.waitFor(() => expect(h.providers.llm.requests).toHaveLength(2), { timeout: 5000 });
      expect(h.providers.llm.requests[1].messages.at(-1)?.content).toMatch(/different question/);
    });

    it('does not mistake a steady echo of the agent for the caller', async () => {
      const h = await harness({ playbackMs: 1500 });
      await h.startCall();
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.view()?.phase).toBe('speaking'), { timeout: 4000 });
      h.source.push(speechPcm(2500)); // constant loud audio from the first moment: echo
      await sleep(300);
      expect(h.heard(/interrupted the agent/)).toBe(false);
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
      expect(h.providers.stt.calls).toHaveLength(1); // the echo was never transcribed
    });

    it('can be switched off, leaving strict half-duplex', async () => {
      const h = await harness({ playbackMs: 1200, env: { AI_BARGE_IN_WHILE_SPEAKING: 'false' } });
      await h.startCall();
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1300));
      await vi.waitFor(() => expect(h.view()?.phase).toBe('speaking'), { timeout: 4000 });
      h.source.push(noiseFloorPcm(800));
      h.source.push(speechPcm(900));
      await sleep(250);
      expect(h.heard(/interrupted the agent/)).toBe(false);
      await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
    });

    it('switches itself off for the call after interruptions that contained no speech', async () => {
      const h = await harness({ playbackMs: 2500, env: { AI_SKIP_UNLIKELY_SPEECH: 'true', AI_BARGE_IN_MAX_FALSE: '2' }, stt: ['hello', 'hello again', 'and again'] });
      await h.startCall();
      const noiseWhileAgentTalks = async () => {
        await vi.waitFor(() => expect(h.view()?.phase).toBe('speaking'), { timeout: 5000 });
        h.source.push(noiseFloorPcm(800));
        h.source.push(loudNoisePcm(700)); // loud, sustained, and not speech
        h.source.push(noiseFloorPcm(1300));
      };
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1300));
      await noiseWhileAgentTalks(); // false interruption 1
      await vi.waitFor(() => expect(h.view()?.phase).toBe('listening'), { timeout: 5000 });
      h.source.push(speechPcm(1200));
      h.source.push(noiseFloorPcm(1300));
      await noiseWhileAgentTalks(); // false interruption 2
      await vi.waitFor(() => expect(h.alerts.some((a) => /Interruption detection switched off/.test(a))).toBe(true), { timeout: 8000 });
    });
  });

  it('puts a speech-end based first-audio time in the log line of every spoken turn', async () => {
    const h = await harness();
    await h.startCall();
    h.source.push(speechPcm(1500));
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
    const line = h.events.find((e) => e.stage === 'call' && /First audio written/.test(e.detail ?? ''));
    expect(line?.detail).toMatch(/after the caller stopped talking/);
    expect(line?.data).toMatchObject({ speculativeStt: true });
    expect(Number(line?.data?.perceivedFirstAudioMs)).toBeGreaterThanOrEqual(0);
  });
});
