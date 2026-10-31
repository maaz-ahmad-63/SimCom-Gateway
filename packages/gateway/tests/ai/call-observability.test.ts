import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ConversationSession } from '../../src/ai/conversation.js';
import { currentObsContext, setProviderAttemptSink } from '../../src/ai/obs-context.js';
import { ObservabilityStore, percentile, stat } from '../../src/ai/observability-store.js';
import { requestWithRetry } from '../../src/ai/providers/http.js';
import { createMockProviders, ToneTts } from '../../src/ai/providers/mock.js';
import { AiProviderError, LlmChunk, LlmProvider, SttProvider } from '../../src/ai/providers/types.js';
import { TraceHub } from '../../src/ai/trace.js';
import { AiUsageStore } from '../../src/ai/usage-store.js';
import { createObservabilityRouter } from '../../src/api/routes/observability.js';
import { runMigrations } from '../../src/db/migrations.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv, FORMAT_8K, fakeFetch, json, makeConfig, speechPcm } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function memory() {
  const db = new Database(':memory:');
  runMigrations(db);
  cleanups.push(() => void db.close());
  return db;
}

const SEL = { sttKey: 'nova-3', sttProvider: 'deepgram', sttModel: 'nova-3', llmKey: 'groq_qwen_3_8_27b', llmProvider: 'groq-qwen', llmModel: 'qwen3', ttsKey: 'cartesia', ttsProvider: 'cartesia', ttsModel: 'sonic-3' };

function addCall(db: Database.Database, id: string, over: Record<string, unknown> = {}) {
  const row = { direction: 'inbound', state: 'IDLE', started_at: '2026-10-28T10:00:00.000Z', answered_at: '2026-10-28T10:00:05.000Z', ended_at: '2026-10-28T10:01:00.000Z', duration_seconds: 55, outcome: 'completed', termination_reason: 'remote hangup', is_simulated: 0, ...over };
  db.prepare('INSERT INTO calls (id, direction, remote_number, state, started_at, answered_at, ended_at, duration_seconds, outcome, termination_reason, is_simulated) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    id, row.direction, '+10000000000', row.state, row.started_at, row.answered_at, row.ended_at, row.duration_seconds, row.outcome, row.termination_reason, row.is_simulated
  );
}

const turnBase = { status: 'completed', sttMs: null, llmFirstTokenMs: null, ttsFirstMs: null, totalMs: null, utteranceMs: null, sttSeconds: 0, llmPromptTokens: null, llmCompletionTokens: null, ttsChars: 0, selection: { stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'cartesia' }, mock: false };

describe('latency maths on a deterministic clock', () => {
  it('measures every stage from the monotonic clock, not the wall clock', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const stt: SttProvider = { name: 'fake-stt', transcribe: async () => { clock += 120; return { text: 'what time do you open' }; } };
    const llm: LlmProvider = {
      name: 'fake-llm',
      async *stream(): AsyncIterable<LlmChunk> {
        clock += 200; // request start to first token
        yield { delta: 'We open at nine. ' };
        clock += 300; // rest of the reply
        yield { delta: 'Anything else?' };
        yield { usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
      },
    };
    const tts = new ToneTts(0);
    const origSynth = tts.synthesize.bind(tts);
    tts.synthesize = async (text, format, signal) => { clock += 150; return origSynth(text, format, signal); };
    const session = new ConversationSession({ callId: 'c-clock', config: makeConfig(), providers: { stt, llm, tts }, sink: new CollectingAudioSink(FORMAT_8K) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('completed');
    expect(result.metrics.sttMs).toBe(120);
    expect(result.metrics.llmFirstTokenMs).toBe(200);
    // 200 + 300 of model time, plus the 150 the fake clock ticks while sentence one is synthesized: the stages overlap on purpose.
    expect(result.metrics.llmTotalMs).toBe(650);
    expect(result.metrics.ttsFirstMs).toBe(150);
    expect(result.metrics.tftAvailable).toBe(true);
  });

  it('marks time-to-first-token unavailable for a model that does not stream', async () => {
    const llm: LlmProvider = { name: 'batch-llm', streaming: false, async *stream() { yield { delta: 'One whole reply, sent at once.' }; } };
    const providers = { ...createMockProviders(), llm };
    const session = new ConversationSession({ callId: 'c-batch', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(result.metrics.tftAvailable).toBe(false);
  });

  it('computes nearest-rank percentiles and leaves missing values null', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(stat([10, 20, 30, null, undefined])).toEqual({ n: 3, avg: 20, p50: 20, p95: 30 });
    expect(stat([null, undefined])).toEqual({ n: 0, avg: null, p50: null, p95: null });
  });
});

describe('persisting the pipeline as it runs', () => {
  function wire(db: Database.Database, store = new ObservabilityStore(db)) {
    const hub = new TraceHub(() => {}, () => false, (callId, e) => store.record({ callId, turnId: e.turnId, stage: e.stage, status: e.status, latencyMs: e.latencyMs, detail: e.detail, data: e.data, text: e.text, role: e.role }));
    const session = (callId: string, providers = createMockProviders({ stt: ['first question here', 'second question here'], llm: ['First answer is long enough.', 'Second answer is long enough.'] })) =>
      new ConversationSession({ callId, config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => hub.publish(callId, e) });
    return { store, session };
  }

  it('links every stage of several turns to its call and turn, and keeps concurrent calls apart', async () => {
    const db = memory();
    const { store, session } = wire(db);
    const a = session('call-A');
    const b = session('call-B');
    await Promise.all([
      (async () => { await a.handleUtterance(speechPcm(1200), 'a1'); await a.handleUtterance(speechPcm(1200), 'a2'); })(),
      (async () => { await b.handleUtterance(speechPcm(1200), 'b1'); await b.handleUtterance(speechPcm(1200), 'b2'); })(),
    ]);
    for (const id of ['call-A', 'call-B']) {
      const events = store.eventsFor(id);
      expect(events.length).toBeGreaterThan(8);
      expect(events.every((e) => e.callId === id)).toBe(true);
      const turnIds = new Set(events.map((e) => e.turnId).filter(Boolean));
      expect([...turnIds].sort()).toEqual([`${id}:t1`, `${id}:t2`]);
      for (const t of turnIds) {
        const stages = store.eventsFor(id, t as string).map((e) => e.stage);
        for (const s of ['pcm-capture', 'stt-result', 'llm-request', 'llm-response', 'tts-generated', 'playback']) expect(stages, `${id} ${t}`).toContain(s);
        expect(stages.indexOf('stt-result')).toBeLessThan(stages.indexOf('llm-response'));
      }
      const mono = events.map((e) => e.monoMs);
      expect(mono).toEqual([...mono].sort((x, y) => x - y)); // the monotonic column never goes backwards
      expect(events.every((e) => /Z$/.test(e.at))).toBe(true); // wall clock is UTC
    }
  });

  it('records a provider failure with its stage and a safe message, and the turn survives', async () => {
    const db = memory();
    const { store, session } = wire(db);
    const s = session('call-F', createMockProviders({ stt: [new AiProviderError('deepgram', 'stt', `HTTP 401: authentication failed Bearer ${'x'.repeat(20)}`, { status: 401 })] }));
    const result = await s.handleUtterance(speechPcm(1200), 'f1');
    expect(result).toMatchObject({ status: 'failed', reason: 'stt-failed' });
    const failed = store.eventsFor('call-F').filter((e) => e.status === 'failed');
    expect(failed.map((e) => e.stage)).toContain('stt-result');
    expect(JSON.stringify(failed)).not.toContain('x'.repeat(20));
    expect(failed.every((e) => e.turnId === 'call-F:t1')).toBe(true);
  });

  it('records an interruption as a cancelled stage on that turn', async () => {
    const db = memory();
    const { store, session } = wire(db);
    const s = session('call-I', createMockProviders({ stt: ['tell me a long story please'], llm: ['A long story begins here and goes on. And on it goes.'], delays: { llm: 60 } }));
    const turn = s.handleUtterance(speechPcm(1200), 'i1');
    await new Promise((r) => setTimeout(r, 20));
    s.interrupt('caller-speech');
    const result = await turn;
    expect(result.status).toBe('cancelled');
    const events = store.eventsFor('call-I', 'call-I:t1');
    expect(events.some((e) => e.status === 'cancelled' || (e.stage === 'call' && /cancelled/i.test(e.detail ?? '')))).toBe(true);
  });

  it('keeps what was recorded before an abrupt end, and a dead database never reaches the call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
    const file = path.join(dir, 'g.sqlite');
    const db = new Database(file);
    runMigrations(db);
    const errors: Error[] = [];
    const store = new ObservabilityStore(db, { onError: (e) => errors.push(e) });
    store.record({ callId: 'c1', turnId: 'c1:t1', stage: 'stt-result', status: 'ok' });
    db.close(); // the process "crashes": nothing is flushed on shutdown
    expect(() => store.record({ callId: 'c1', turnId: 'c1:t1', stage: 'llm-response', status: 'ok' })).not.toThrow();
    expect(store.failedWrites).toBe(1);
    expect(errors).toHaveLength(1);
    const reopened = new Database(file);
    expect(reopened.prepare('SELECT stage FROM call_trace_events').all()).toEqual([{ stage: 'stt-result' }]);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never stores keys, authorization headers or the spoken text unless text capture is on', () => {
    const db = memory();
    const off = new ObservabilityStore(db);
    off.record({ callId: 'c', turnId: null, stage: 'call', status: 'ok', detail: 'Authorization: Bearer sk-abcdefghijklmnop failed', data: { apiKey: 'sk-secret-value-12345', authorization: 'Bearer abc', chars: 5, note: 'token=abc123456789' }, text: 'my card number is 4111', role: 'caller' });
    const dump = JSON.stringify(db.prepare('SELECT * FROM call_trace_events').all());
    expect(dump).not.toMatch(/sk-secret|sk-abcdef|abc123456789|4111|Bearer abc/);
    expect(off.eventsFor('c')[0].data).toEqual({ chars: 5, note: 'token=[REDACTED]' });
    const on = new ObservabilityStore(db, { storeText: true });
    on.record({ callId: 'c2', turnId: null, stage: 'stt-result', status: 'ok', text: 'hello there', role: 'caller' });
    expect(on.eventsFor('c2')[0].data).toMatchObject({ text: 'hello there', role: 'caller' });
  });
});

describe('provider attempts, retries and timeouts', () => {
  it('attributes each HTTP attempt to the turn it ran in, with status and retry flags', async () => {
    const db = memory();
    const store = new ObservabilityStore(db);
    cleanups.push(setProviderAttemptSink((a, ctx) => {
      if (!ctx) return;
      store.record({ callId: ctx.callId, turnId: ctx.turnId, stage: 'provider-attempt', status: a.outcome === 'ok' ? 'ok' : 'failed', latencyMs: a.durationMs, provider: a.provider, httpStatus: a.httpStatus, attempt: a.attempt, data: { outcome: a.outcome, willRetry: a.willRetry } });
    }));
    const { impl } = fakeFetch([json({}, 503), json({}, 429), json({ ok: true })]);
    const stt: SttProvider = {
      name: 'http-stt',
      transcribe: async (_p, _f, signal) => {
        expect(currentObsContext()?.turnId).toMatch(/^call-R:t1$/);
        await requestWithRetry('https://stt.example/v1', { method: 'POST' }, { provider: 'deepgram', stage: 'stt', fetchImpl: impl, timeoutMs: 1000, maxRetries: 2, signal, sleep: async () => {} });
        return { text: 'hello from a retried request' };
      },
    };
    const session = new ConversationSession({ callId: 'call-R', config: makeConfig(), providers: { ...createMockProviders(), stt }, sink: new CollectingAudioSink(FORMAT_8K) });
    const result = await session.handleUtterance(speechPcm(1200), 'r1');
    expect(result.status).toBe('completed');
    const attempts = store.eventsFor('call-R').filter((e) => e.stage === 'provider-attempt');
    expect(attempts.map((a) => [a.attempt, a.httpStatus, a.data?.willRetry])).toEqual([[1, 503, true], [2, 429, true], [3, 200, false]]);
    expect(attempts.every((a) => a.turnId === 'call-R:t1' && a.provider === 'deepgram')).toBe(true);
  });

  it('records a timeout as its own outcome with no status code', async () => {
    const seen: Array<{ outcome: string; httpStatus: number | null; willRetry: boolean }> = [];
    cleanups.push(setProviderAttemptSink((a) => void seen.push({ outcome: a.outcome, httpStatus: a.httpStatus, willRetry: a.willRetry })));
    const hanging = (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(requestWithRetry('https://x.example', {}, { provider: 'p', stage: 'llm', fetchImpl: hanging, timeoutMs: 15, maxRetries: 1, signal: new AbortController().signal, sleep: async () => {} })).rejects.toThrow(/timed out/);
    expect(seen).toEqual([{ outcome: 'timeout', httpStatus: null, willRetry: true }, { outcome: 'timeout', httpStatus: null, willRetry: false }]);
  });
});

describe('the query API', () => {
  function populated() {
    const db = memory();
    const store = new ObservabilityStore(db);
    const usage = new AiUsageStore(db);
    addCall(db, 'call-1');
    addCall(db, 'call-2', { direction: 'outbound', started_at: '2026-10-27T09:00:00.000Z', outcome: 'failed', termination_reason: 'no carrier' });
    addCall(db, 'call-3', { started_at: '2026-10-26T09:00:00.000Z', outcome: 'missed', answered_at: null, duration_seconds: 0 });
    store.record({ callId: 'call-1', turnId: null, stage: 'call', status: 'ok', detail: 'AI attached', data: { ...SEL } });
    store.record({ callId: 'call-2', turnId: null, stage: 'call', status: 'ok', data: { ...SEL, sttKey: 'ink-whisper', sttProvider: 'cartesia', sttModel: 'ink-whisper' } });
    store.record({ callId: 'call-1', turnId: 'call-1:t1', stage: 'stt-result', status: 'ok', latencyMs: 100 });
    store.record({ callId: 'call-2', turnId: 'call-2:t1', stage: 'stt-result', status: 'failed', detail: 'HTTP 503', provider: 'cartesia' });
    store.record({ callId: 'call-2', turnId: 'call-2:t1', stage: 'provider-attempt', status: 'failed', httpStatus: 503, attempt: 1, provider: 'cartesia', data: { willRetry: true } });
    const e2e = [400, 500, 600, 700];
    e2e.forEach((ms, i) =>
      usage.record({ ...turnBase, callId: 'call-1', sttMs: 100 + i, llmFirstTokenMs: 200, ttsFirstMs: 50, totalMs: 3000, perceivedFirstAudioMs: ms, llmTotalMs: 400, tftAvailable: true, turnRef: `call-1:t${i + 1}` })
    );
    usage.record({ ...turnBase, callId: 'call-2', status: 'failed', reason: 'stt-failed', selection: { stt: 'ink-whisper', llm: 'groq_qwen_3_8_27b', tts: 'cartesia' }, turnRef: 'call-2:t1' });
    usage.record({ ...turnBase, callId: 'call-1', sttMs: 100, llmFirstTokenMs: 999, perceivedFirstAudioMs: null, tftAvailable: false, turnRef: 'call-1:t5' });
    const app = express();
    app.use('/api/observability', createObservabilityRouter({ store }));
    return { db, app, store };
  }

  it('summarises calls, errors and latency with percentiles from the stored turns', async () => {
    const { app } = populated();
    const o = (await request(app).get('/api/observability/overview')).body;
    expect(o.calls).toMatchObject({ total: 3, successful: 1, failed: 1, withAiErrors: 1, failureRate: 33.3 });
    expect(o.turns).toMatchObject({ total: 6, failed: 1, completed: 5 });
    expect(o.turns.errorRatePercent).toBe(16.7);
    expect(o.latencyMs.endToEnd).toEqual({ n: 4, avg: 550, p50: 500, p95: 700 });
    expect(o.latencyMs.tft).toMatchObject({ n: 4, avg: 200 }); // the non-streaming turn's 999 is not a TFT
    expect(o.latencyMs.stt.n).toBe(5);
    expect(o.latencyMs.ttsTotal).toEqual({ n: 0, avg: null, p50: null, p95: null }); // never recorded: null, not zero
    expect(o.providers.stt.find((p: any) => p.key === 'ink-whisper')).toMatchObject({ turns: 1, failedTurns: 1 });
  });

  it('pages and filters the call history', async () => {
    const { app } = populated();
    const page1 = (await request(app).get('/api/observability/calls?pageSize=2')).body;
    expect(page1).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(page1.items.map((c: any) => c.id)).toEqual(['call-1', 'call-2']);
    expect((await request(app).get('/api/observability/calls?pageSize=2&page=2')).body.items.map((c: any) => c.id)).toEqual(['call-3']);
    const q = async (s: string) => (await request(app).get(`/api/observability/calls?${s}`)).body.items.map((c: any) => c.id);
    expect(await q('direction=outbound')).toEqual(['call-2']);
    expect(await q('status=missed')).toEqual(['call-3']);
    expect(await q('status=ai_error')).toEqual(['call-2']);
    expect(await q('provider=cartesia')).toEqual(['call-1', 'call-2']); // call-1 uses cartesia TTS, call-2 cartesia STT and TTS
    expect(await q('model=ink-whisper')).toEqual(['call-2']);
    expect(await q('from=2026-10-27T00:00:00Z&to=2026-10-28T23:59:59Z')).toEqual(['call-1', 'call-2']);
    expect(await q('q=call-3')).toEqual(['call-3']);
    const row = (await request(app).get('/api/observability/calls')).body.items[0];
    expect(row).toMatchObject({ turns: 5, selection: { stt: { provider: 'deepgram', model: 'nova-3' }, tts: { provider: 'cartesia' } } });
    expect(row.latency.endToEndMs).toBe(550);
    const unmeasured = (await request(app).get('/api/observability/calls?q=call-3')).body.items[0];
    expect(unmeasured).toMatchObject({ turns: 0, selection: { stt: null }, latency: { endToEndMs: null, tftMs: null } });
  });

  it('returns a call with its turns, events, failing stage and retries', async () => {
    const { app } = populated();
    const d = (await request(app).get('/api/observability/calls/call-2')).body;
    expect(d.call).toMatchObject({ id: 'call-2', status: 'failed', direction: 'outbound' });
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]).toMatchObject({ turnId: 'call-2:t1', status: 'failed', failingStage: 'stt-result', failureDetail: 'HTTP 503', retries: 1 });
    expect(d.turns[0].events.map((e: any) => e.stage)).toEqual(['stt-result', 'provider-attempt']);
    expect(d.turns[0].latency.endToEndMs).toBeNull();
    expect(d.callEvents[0].stage).toBe('call');
    const turn = (await request(app).get(`/api/observability/calls/call-2/turns/${encodeURIComponent('call-2:t1')}`)).body;
    expect(turn.events).toHaveLength(2);
    const errors = (await request(app).get('/api/observability/errors')).body;
    expect(errors.total).toBe(2);
    expect(errors.items[0]).toMatchObject({ stage: 'provider-attempt', httpStatus: 503, provider: 'cartesia' });
    expect((await request(app).get('/api/observability/calls/nope')).status).toBe(404);
    expect((await request(app).get('/api/observability/calls?from=garbage')).status).toBe(400);
    expect((await request(app).get('/api/observability/calls?pageSize=1000')).status).toBe(400);
  });

  it('shows empty states as zeros and nulls, not invented numbers', async () => {
    const db = memory();
    const app = express();
    app.use('/api/observability', createObservabilityRouter({ store: new ObservabilityStore(db) }));
    const o = (await request(app).get('/api/observability/overview')).body;
    expect(o.calls).toMatchObject({ total: 0, failureRate: null });
    expect(o.latencyMs.endToEnd).toEqual({ n: 0, avg: null, p50: null, p95: null });
    expect((await request(app).get('/api/observability/calls')).body).toMatchObject({ total: 0, items: [] });
  });

  it('is behind the gateway API key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-api-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: 'obs-test-key-123456', sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only' }), providers: createMockProviders(), allowSimulatedHardware: true },
    });
    cleanups.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    expect((await request(server.app).get('/api/observability/overview')).status).toBe(401);
    const ok = await request(server.app).get('/api/observability/overview').set('x-api-key', 'obs-test-key-123456');
    expect(ok.status).toBe(200);
    expect(ok.body.calls.total).toBe(0);
  });
});
