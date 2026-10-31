import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { playPcmPaced } from '../../src/adapters/audio/paced-playback.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, PlayResult } from '../../src/ai/audio.js';
import { ConversationSession } from '../../src/ai/conversation.js';
import { createLoopLag, LoopLag } from '../../src/ai/loop-lag.js';
import { ObservabilityStore } from '../../src/ai/observability-store.js';
import { createMockProviders, ScriptedLlm, ToneTts } from '../../src/ai/providers/mock.js';
import { LlmChunk, LlmProvider } from '../../src/ai/providers/types.js';
import { SecretCipher } from '../../src/ai/secrets.js';
import { SentenceSplitter } from '../../src/ai/text.js';
import { AiUsageStore } from '../../src/ai/usage-store.js';
import { runMigrations } from '../../src/db/migrations.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv, FORMAT_8K, makeConfig, sleep, speechPcm } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const feed = (splitter: SentenceSplitter, text: string, size = 7): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  out.push(...splitter.flush());
  return out;
};

describe('phrase-level speech start', () => {
  const reply = 'Thanks for calling Sizh Voicely, how can I help you with your order today? We are open until five.';

  it('lets the first chunk end at a clause once it is long enough, and never cuts later chunks that way', () => {
    expect(feed(new SentenceSplitter(24, 24, 32), reply)).toEqual(['Thanks for calling Sizh Voicely,', 'how can I help you with your order today?', 'We are open until five.']);
    // Switched off: the first chunk waits for the sentence end, exactly as before.
    expect(feed(new SentenceSplitter(24, 24, 0), reply)).toEqual(['Thanks for calling Sizh Voicely, how can I help you with your order today?', 'We are open until five.']);
    // The default constructor is unchanged for every existing caller.
    expect(feed(new SentenceSplitter(24, 24), reply)).toHaveLength(2);
  });

  it('does not cut a short opener, a number, or a clause that is too short', () => {
    expect(feed(new SentenceSplitter(24, 24, 32), 'Sure, I can help with that for you today. Anything else?')).toEqual(['Sure, I can help with that for you today.', 'Anything else?']);
    expect(feed(new SentenceSplitter(24, 24, 32), 'The total comes to 1,000 dollars including all of the fees. Done.')).toEqual(['The total comes to 1,000 dollars including all of the fees.', 'Done.']);
  });

  it('starts synthesis before the model has finished the first sentence', async () => {
    const run = async (env: Record<string, string>) => {
      let chunksEmitted = 0;
      const text = 'Thanks for calling Sizh Voicely, how can I help you with your order today? We open at nine.';
      const llm: LlmProvider = {
        name: 'slow-llm',
        async *stream(): AsyncIterable<LlmChunk> {
          for (let i = 0; i < text.length; i += 8) {
            await sleep(3);
            chunksEmitted++;
            yield { delta: text.slice(i, i + 8) };
          }
        },
      };
      const tts = new ToneTts(0);
      let chunksAtFirstSynth = -1;
      const synth = tts.synthesize.bind(tts);
      tts.synthesize = async (t, f, s) => {
        if (chunksAtFirstSynth < 0) chunksAtFirstSynth = chunksEmitted;
        return synth(t, f, s);
      };
      const session = new ConversationSession({ callId: 'c-phrase', config: makeConfig(env), providers: { ...createMockProviders(), llm, tts }, sink: new CollectingAudioSink(FORMAT_8K) });
      expect((await session.handleUtterance(speechPcm(1200), 'u1')).status).toBe('completed');
      return { chunksAtFirstSynth, total: Math.ceil(text.length / 8) };
    };
    const off = await run({ AI_FIRST_CLAUSE_MIN_CHARS: '0' });
    const on = await run({});
    // Chunks the model had produced when speech synthesis began: fewer means speech started earlier.
    expect(on.chunksAtFirstSynth).toBeLessThan(off.chunksAtFirstSynth);
    console.log(`first synthesis began after ${on.chunksAtFirstSynth} of ${on.total} model chunks (was ${off.chunksAtFirstSynth} before)`);
  });

  it('is configurable and validated', () => {
    expect(makeConfig().limits.firstClauseMinChars).toBe(32);
    expect(makeConfig({ AI_FIRST_CLAUSE_MIN_CHARS: '0' }).limits.firstClauseMinChars).toBe(0);
    expect(() => makeConfig({ AI_FIRST_CLAUSE_MIN_CHARS: '500' })).toThrow();
  });
});

describe('playback jitter and loop stalls are recorded per turn', () => {
  const lateSink = (result: Partial<PlayResult>) =>
    new (class extends CollectingAudioSink {
      override async play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
        const base = await super.play(pcm, signal);
        return { ...base, ...result };
      }
    })(FORMAT_8K);

  it('sums frames past the write-ahead (they were never counted) and keeps the worst lateness', async () => {
    const providers = createMockProviders({ llm: ['One sentence only, long enough to be spoken.'] });
    const session = new ConversationSession({ callId: 'c-jitter', config: makeConfig(), providers, sink: lateSink({ lateFrames: 3, riskFrames: 2, maxLateMs: 67 }) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(result.metrics.lateFrames).toBe(3);
    expect(result.metrics.riskFrames).toBe(2); // was always 0: nothing added it up
    expect(result.metrics.maxLateMs).toBe(67);
  });

  it('records the longest event-loop stall of the turn, reset at its start', async () => {
    let value: number | null = 999; // a stall left over from before the turn must not be blamed on it
    const loopLag: LoopLag = { reset: () => (value = 12), maxMs: () => value, stop: () => {} };
    const session = new ConversationSession({ callId: 'c-lag', config: makeConfig(), providers: createMockProviders(), sink: new CollectingAudioSink(FORMAT_8K), loopLag });
    expect((await session.handleUtterance(speechPcm(1200), 'u1')).metrics.loopLagMaxMs).toBe(12);
  });

  it('measures a real stall of this event loop', async () => {
    const lag = createLoopLag();
    lag.reset();
    await sleep(30);
    const end = Date.now() + 80;
    while (Date.now() < end); // a synchronous block, like the key decryption was
    await sleep(30);
    const stall = lag.maxMs();
    lag.stop();
    expect(stall).not.toBeNull();
    expect(stall as number).toBeGreaterThanOrEqual(50);
  });
});

describe('what stalled the loop during calls: stored-key decryption on every dashboard poll', () => {
  it('no longer blocks the loop on repeat polls (before/after, measured)', async () => {
    const master = 'a-long-master-key-for-tests-only';
    const writer = new SecretCipher(master);
    const blobs = Array.from({ length: 6 }, (_, i) => writer.encrypt(`provider-key-number-${i}-abcdefgh`));

    // Before: every poll decrypted every stored key from scratch (a fresh cipher models "no memory").
    const before = createLoopLag();
    before.reset();
    await sleep(10);
    for (const b of blobs) new SecretCipher(master).decrypt(b);
    await sleep(10);
    const stallBefore = before.maxMs() as number;
    before.stop();

    // After: the same six keys through one cipher that has already seen them (the state of a running gateway).
    const warm = new SecretCipher(master);
    for (const b of blobs) warm.decrypt(b);
    const after = createLoopLag();
    after.reset();
    await sleep(10);
    for (let poll = 0; poll < 10; poll++) for (const b of blobs) warm.decrypt(b);
    await sleep(10);
    const stallAfter = after.maxMs() as number;
    after.stop();

    console.log(`event-loop stall per dashboard poll: ${stallBefore} ms before, ${stallAfter} ms after (6 stored keys)`);
    expect(stallBefore).toBeGreaterThan(150); // six synchronous scrypt derivations
    expect(stallAfter).toBeLessThan(40);
  });

  it('keeps paced playback on time while the dashboard polls the AI state through the real server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lat-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    const key = 'latency-test-key-123456';
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: master(), DEEPGRAM_API_KEY: undefined, GROQ_API_KEY: undefined, CARTESIA_API_KEY: undefined, OPENAI_API_KEY: undefined, TELNYX_API_KEY: undefined }), providers: createMockProviders(), allowSimulatedHardware: true },
    });
    cleanups.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const api = (m: 'get' | 'put', url: string) => request(server.app)[m](url).set('x-api-key', key);
    for (const name of ['DEEPGRAM_API_KEY', 'GROQ_API_KEY', 'CARTESIA_API_KEY', 'MURF_API_KEY', 'SONIOX_API_KEY', 'INWORLD_API_KEY']) {
      expect((await api('put', `/api/ai/credentials/${name}`).send({ value: `${name.toLowerCase()}-value-0123456789` })).status).toBe(200);
    }
    await api('get', '/api/ai/state'); // the gateway has warmed its keys long before a call starts
    const polls = (async () => {
      for (let i = 0; i < 8; i++) {
        await api('get', '/api/ai/state');
        await sleep(120);
      }
    })();
    const result = await playPcmPaced(async () => {}, speechPcm(1500), { sampleRate: 8000 });
    await polls;
    console.log(`paced playback during 8 state polls: ${result.lateFrames} late frames, worst ${Math.round(result.maxLateMs)} ms`);
    expect(result.riskFrames).toBe(0);
    expect(result.maxLateMs).toBeLessThan(60);
  });
});
const master = () => 'a-long-master-key-for-tests-only';

describe('a cancelled turn is never a fast response', () => {
  it('keeps cancelled turns out of end-to-end figures and records who cancelled them', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    cleanups.push(() => void db.close());
    const usage = new AiUsageStore(db);
    const store = new ObservabilityStore(db);
    db.prepare("INSERT INTO calls (id, direction, remote_number, state, started_at, outcome) VALUES ('c1','inbound','+1','IDLE','2026-10-28T10:00:00Z','completed')").run();
    const base = { callId: 'c1', sttMs: 300, llmFirstTokenMs: 200, ttsFirstMs: 100, totalMs: 4000, utteranceMs: 1000, sttSeconds: 1, llmPromptTokens: 10, llmCompletionTokens: 10, ttsChars: 20, selection: { stt: 'nova-3', llm: 'x', tts: 'cartesia' }, mock: false };
    usage.record({ ...base, status: 'completed', perceivedFirstAudioMs: 2000, firstAudioMs: 1300, turnRef: 'c1:t1', maxLateMs: 12, lateFrames: 0, riskFrames: 0 });
    // Cancelled after audio had started: its 300 ms must not drag the success average down.
    usage.record({ ...base, status: 'cancelled', reason: 'interrupted', cancelSource: 'caller-speech', perceivedFirstAudioMs: 300, firstAudioMs: 250, turnRef: 'c1:t2', maxLateMs: 67, lateFrames: 4, riskFrames: 2, loopLagMaxMs: 58 });
    usage.record({ ...base, status: 'failed', reason: 'tts-failed', perceivedFirstAudioMs: 100, turnRef: 'c1:t3' });

    const o = store.overview({});
    expect(o.latencyMs.endToEnd).toEqual({ n: 1, avg: 2000, p50: 2000, p95: 2000 });
    expect(o.cancellations).toEqual({ total: 1, afterAudioStarted: 1, bySource: { 'caller-speech': 1 } });
    expect(o.playback).toMatchObject({ turnsWithLateFrames: 1, turnsWithGapRisk: 1 });
    expect(o.playback.maxLateMs).toMatchObject({ n: 2, p95: 67 });
    expect(o.playback.loopLagMs).toMatchObject({ n: 1, avg: 58 });

    const row = store.listCalls({}).items[0];
    expect(row.latency.endToEndMs).toBe(2000);
    const detail = store.callDetail('c1')!;
    const [t1, t2, t3] = detail.turns;
    expect(t1.latency.endToEndMs).toBe(2000);
    expect(t2).toMatchObject({ status: 'cancelled', cancelSource: 'caller-speech' });
    expect(t2.latency).toMatchObject({ endToEndMs: null, maxLateMs: 67, lateFrames: 4, riskFrames: 2, loopLagMaxMs: 58 });
    expect(t3.latency.endToEndMs).toBeNull();
  });
});

describe('barge-in discards stale audio and cancels at once', () => {
  it('stops synthesising and playing the rest of a reply the moment the caller interrupts', async () => {
    const llm = new ScriptedLlm(['First sentence of the long reply goes here. Second sentence of the long reply goes here. Third sentence of the long reply goes here.'], { chunkChars: 10 });
    const providers = { ...createMockProviders(), llm, tts: new ToneTts(15) };
    const sink = new CollectingAudioSink(FORMAT_8K, true, 60);
    const session = new ConversationSession({ callId: 'c-barge', config: makeConfig(), providers, sink });
    const turn = session.handleUtterance(speechPcm(1200), 'u1');
    while (sink.playCalls < 1) await sleep(5); // the first sentence is playing
    session.interrupt('caller-speech');
    const result = await turn;
    const spoken = sink.played.length;
    const requested = providers.tts.requests.length;
    await sleep(150); // anything stale would play or be requested now
    expect(result.status).toBe('cancelled');
    expect(result.cancelSource).toBe('caller-speech');
    expect(sink.played.length).toBe(spoken);
    expect(providers.tts.requests.length).toBe(requested);
    expect(spoken).toBeLessThan(3);
  });
});
