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

/**
 * The live-call scenarios behind the 0.1.5 fix ("the AI sometimes never answers"), through the real endpointer, orchestrator and session
 * with only the phone line and the providers simulated. The original fault: any sound while the agent was transcribing or thinking
 * cancelled the turn at its first moment, and the sound was then rejected as non-speech, so the caller's question was never answered.
 * Simulated audio only: this is not a test of a real cellular call.
 */
const KEY = 'live-call-scenarios-key';
const CONFIRM = { enabled: true, confirmBilling: true, confirmPlayToCaller: true };

describe('live-call scenarios (real turn-taking, simulated line and providers)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function harness(o: { stt?: string[]; sttDelayMs?: number; llm?: string[]; llmDelayMs?: number; playbackMs?: number; env?: Record<string, string | undefined> } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scen-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true, o.playbackMs ?? 0);
    const providers: ProviderSet & { stt: ScriptedStt; llm: ScriptedLlm; tts: ToneTts } = {
      stt: new ScriptedStt(o.stt ?? ['what are your opening hours', 'and on sunday', 'thank you'], o.sttDelayMs ?? 0),
      llm: new ScriptedLlm(o.llm ?? ['We open at nine.', 'We are closed on Sunday.', 'You are welcome.'], { delayMs: o.llmDelayMs ?? 0 }),
      tts: new ToneTts(0),
    };
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', AI_PLAYBACK_GUARD_MS: '0', ...o.env }), providers, allowSimulatedHardware: true, transports: () => ({ source, sink }), idleWaitsMs: [60_000, 60_000, 60_000] },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const api = (m: 'post', url: string) => request(server.app)[m](url).set('x-api-key', KEY);
    const startCall = async () => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60);
      await api('post', `/api/ai/calls/${call.id}/arm`);
      expect((await api('post', `/api/ai/calls/${call.id}/conversation`).send(CONFIRM)).status).toBe(200);
      return call;
    };
    const ask = () => {
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1300)); // the endpoint (1 s of silence) closes the question
    };
    const view = () => server.aiOrchestrator.getSessions()[0]?.conversation;
    const cancelled = () => events.filter((e) => e.status === 'cancelled');
    const stage = (s: string) => events.filter((e) => e.stage === s);
    return { source, sink, providers, events, startCall, ask, view, cancelled, stage };
  }

  it('1. the caller asks a question: the AI completes its reply', async () => {
    const h = await harness();
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
    expect(h.providers.llm.requests).toHaveLength(1);
    expect(h.providers.llm.requests[0].messages.at(-1)?.content).toBe('what are your opening hours');
    expect(h.cancelled()).toEqual([]);
  });

  it('2. a short voiced sound while the AI is thinking (LLM): the caller is still answered, exactly once, and no reply audio is cut', async () => {
    const h = await harness({ llmDelayMs: 900, stt: ['what are your opening hours', '', 'what are your opening hours'] }); // the sound's pause transcription: no words; then question + sound: the question
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.stage('llm-request').length).toBe(1), { timeout: 5000 }); // thinking now
    h.source.push(speechPcm(250)); // a click / cough: long enough to trigger speech detection (200 ms), too short to be words (300 ms)
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 6000 });
    await sleep(300);
    expect(h.sink.played).toHaveLength(1); // one reply
    expect(h.providers.llm.requests.at(-1)?.messages.at(-1)?.content).toBe('what are your opening hours'); // to the question
    // Loudness cannot tell this sound from a word, so the reply being prepared was replaced (before any of it played) and the question
    // was transcribed again with the sound: one extra transcription and model request, never a lost answer, never cut audio.
    expect(h.providers.llm.requests).toHaveLength(2);
    expect(h.events.some((e) => e.stage === 'playback' && e.status === 'cancelled')).toBe(false);
  });

  it('2b. background noise while the AI is thinking: the caller still gets the answer to their question', async () => {
    const h = await harness({ llmDelayMs: 900, stt: ['what are your opening hours', '', 'what are your opening hours'] }); // noise has no words; question + noise gives the question
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.stage('llm-request').length).toBe(1), { timeout: 5000 });
    h.source.push(loudNoisePcm(700)); // line noise, long enough to be an "utterance"
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 8000 });
    await sleep(300);
    expect(h.sink.played).toHaveLength(1); // answered once, not twice and not never
    expect(h.providers.llm.requests.at(-1)?.messages.at(-1)?.content).toBe('what are your opening hours');
  });

  it('3. a short voiced sound while the caller is being transcribed (STT): the caller is answered exactly once', async () => {
    const h = await harness({ sttDelayMs: 900, stt: ['what are your opening hours', '', 'what are your opening hours'] });
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.stage('stt-submit').length).toBe(1), { timeout: 5000 }); // transcribing now
    h.source.push(speechPcm(250));
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 6000 });
    await sleep(300);
    expect(h.sink.played).toHaveLength(1);
    expect(h.providers.llm.requests).toHaveLength(1); // replaced during transcription, before any model request: no extra request
    expect(h.providers.llm.requests[0].messages.at(-1)?.content).toBe('what are your opening hours');
  });

  it('4. genuine caller speech while the AI is speaking: barge-in stops the reply and the caller is answered', async () => {
    const h = await harness({ playbackMs: 4000, stt: ['hello there', 'actually I have a different question'], llm: ['Hi, how can I help you today?', 'Of course, go ahead.'] });
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.view()?.phase).toBe('speaking'), { timeout: 4000 });
    h.source.push(noiseFloorPcm(800));
    h.source.push(speechPcm(900));
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.events.some((e) => e.stage === 'playback' && e.status === 'cancelled')).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(h.providers.llm.requests).toHaveLength(2), { timeout: 5000 });
    expect(h.providers.llm.requests[1].messages.at(-1)?.content).toMatch(/different question/);
  });

  it('5. the caller keeps talking while the AI is thinking: the new speech replaces the turn and both parts are answered together', async () => {
    const h = await harness({ llmDelayMs: 700, stt: ['what are your opening hours', 'on sunday', 'what are your opening hours on sunday'], llm: ['We open at nine.', 'We are closed on Sunday.'] });
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.stage('llm-request').length).toBe(1), { timeout: 5000 });
    h.source.push(speechPcm(900)); // real speech: "...on Sunday"
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 6000 });
    await sleep(300);
    expect(h.sink.played).toHaveLength(1); // one reply, to the whole thing
    expect(h.providers.llm.requests.at(-1)?.messages.at(-1)?.content).toBe('what are your opening hours on sunday');
    expect(h.cancelled().length).toBeGreaterThan(0); // the first, incomplete turn was (intentionally) replaced
  });

  it('6. several turns in a row: one reply per question, in order, none lost or overlapping', async () => {
    const h = await harness({ playbackMs: 200 });
    await h.startCall();
    for (let n = 1; n <= 3; n++) {
      h.ask();
      await vi.waitFor(() => expect(h.sink.played.length).toBe(n), { timeout: 6000 });
      await vi.waitFor(() => expect(h.view()?.phase).toBe('listening'), { timeout: 4000 });
    }
    expect(h.providers.llm.requests.map((r) => r.messages.at(-1)?.content)).toEqual(['what are your opening hours', 'and on sunday', 'thank you']);
    expect(h.cancelled()).toEqual([]);
  });

  it('7. a noise mid-answer never cuts reply audio or loses an answer, and the next question is still heard and answered', async () => {
    const h = await harness({ llmDelayMs: 600, stt: ['what are your opening hours', '', 'what are your opening hours', 'and on sunday'] });
    await h.startCall();
    h.ask();
    await vi.waitFor(() => expect(h.stage('llm-request').length).toBe(1), { timeout: 5000 });
    h.source.push(speechPcm(250)); // a short noise
    h.source.push(noiseFloorPcm(1300));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 6000 });
    expect(h.events.some((e) => e.stage === 'playback' && e.status === 'cancelled')).toBe(false); // no reply audio was cut
    await vi.waitFor(() => expect(h.view()?.phase).toBe('listening'), { timeout: 4000 });
    h.ask(); // the caller audio stream is still being received and transcribed
    await vi.waitFor(() => expect(h.sink.played.length).toBe(2), { timeout: 6000 });
    // Two replies, one per question; the requests that produced them answered the question and then the next one.
    expect(h.providers.llm.requests.slice(-2).map((r) => r.messages.at(-1)?.content)).toEqual(['what are your opening hours', 'and on sunday']);
  });
});
