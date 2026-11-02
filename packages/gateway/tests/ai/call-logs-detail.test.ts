import express from 'express';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ObservabilityStore } from '../../src/ai/observability-store.js';
import { AiUsageStore } from '../../src/ai/usage-store.js';
import { createObservabilityRouter } from '../../src/api/routes/observability.js';
import { runMigrations } from '../../src/db/migrations.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((d) => d.close()));

/** Six calls: three with AI turns (distinct content), one unanswered, one outbound campaign call, one with errors. */
function seed() {
  const db = new Database(':memory:');
  open.push(db);
  runMigrations(db);
  const store = new ObservabilityStore(db);
  const usage = new AiUsageStore(db);
  const call = (id: string, startedAt: string, outcome: string | null, extra: Record<string, unknown> = {}) =>
    db
      .prepare('INSERT INTO calls (id, direction, remote_number, state, started_at, outcome, duration_seconds, termination_reason, metadata) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, extra.direction ?? 'inbound', '+10000000000', 'IDLE', startedAt, outcome, extra.duration ?? 30, 'Remote party disconnected', extra.metadata ? JSON.stringify(extra.metadata) : null);
  call('call-A', '2026-10-28T10:00:00.000Z', 'completed', { duration: 41 });
  call('call-B', '2026-10-28T11:00:00.000Z', 'completed', { duration: 62 });
  call('call-C', '2026-10-28T12:00:00.000Z', 'completed', { duration: 18 });
  call('call-D', '2026-10-28T13:00:00.000Z', 'missed', { duration: 0 }); // unanswered: no AI turns at all
  call('call-E', '2026-10-28T14:00:00.000Z', 'completed', { direction: 'outbound', metadata: { campaignId: 'camp-1', campaignContactId: 7, campaignAttempt: 2 } });
  call('call-F', '2026-10-28T15:00:00.000Z', 'failed');

  const base = { sttMs: 300, llmFirstTokenMs: 200, ttsFirstMs: 100, totalMs: 4000, utteranceMs: 1000, sttSeconds: 1, llmPromptTokens: 5, llmCompletionTokens: 5, ttsChars: 20, mock: false };
  const turn = (callId: string, n: number, over: Record<string, unknown>) =>
    usage.record({ ...base, callId, status: 'completed', selection: { stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'cartesia' }, perceivedFirstAudioMs: 1500 + n, firstAudioMs: 1000, turnRef: `${callId}:t${n}`, ...over });
  turn('call-A', 1, { transcript: 'A asks about opening hours', reply: 'A reply: we open at nine.' });
  turn('call-A', 2, { transcript: 'A asks about parking', reply: 'A reply: parking is free.' });
  turn('call-B', 1, { transcript: 'B wants a quote', reply: 'B reply: sure, what size?' });
  turn('call-C', 1, { status: 'cancelled', reason: 'interrupted', cancelSource: 'caller-speech', transcript: null, reply: null });
  turn('call-E', 1, { transcript: 'E says call me later', reply: 'E reply: of course.' });
  turn('call-F', 1, { status: 'failed', reason: 'stt-failed', transcript: null, reply: null, perceivedFirstAudioMs: null, firstAudioMs: null });

  const ev = (callId: string, turnId: string | null, stage: string, status: string, over: Record<string, unknown> = {}) => store.record({ callId, turnId, stage, status, ...over });
  for (const id of ['call-A', 'call-B', 'call-C', 'call-E', 'call-F']) {
    ev(id, null, 'call', 'ok', { detail: 'AI attached', data: { sttKey: 'nova-3', sttProvider: 'deepgram', sttModel: 'nova-3', llmKey: 'groq_qwen_3_8_27b', llmProvider: 'groq-qwen', llmModel: 'qwen3', ttsKey: 'cartesia', ttsProvider: 'cartesia', ttsModel: 'sonic-3' } });
  }
  ev('call-A', 'call-A:t1', 'stt-result', 'ok', { latencyMs: 300 });
  ev('call-A', 'call-A:t1', 'llm-response', 'ok', { latencyMs: 200 });
  ev('call-A', 'call-A:t2', 'stt-result', 'ok', { latencyMs: 310 });
  ev('call-B', 'call-B:t1', 'stt-result', 'ok', { latencyMs: 290 });
  ev('call-C', 'call-C:t1', 'call', 'ok', { detail: 'Turn cancelled by caller speech' });
  ev('call-F', 'call-F:t1', 'stt-result', 'failed', { detail: 'HTTP 503: provider server error', provider: 'deepgram' });
  ev('call-F', 'call-F:t1', 'provider-attempt', 'failed', { provider: 'deepgram', httpStatus: 503, attempt: 1, data: { willRetry: true } });

  const app = express();
  app.use('/api/observability', createObservabilityRouter({ store }));
  return { app, db };
}

describe('Call Logs: every call is listed and every call opens its own detail', () => {
  it('lists all calls, answered or not, newest first, across pages with no repeats or gaps', async () => {
    const { app } = seed();
    const all = (await request(app).get('/api/observability/calls?pageSize=100')).body;
    expect(all.total).toBe(6);
    expect(all.items.map((c: any) => c.id)).toEqual(['call-F', 'call-E', 'call-D', 'call-C', 'call-B', 'call-A']);
    const seen: string[] = [];
    for (const page of [1, 2, 3]) seen.push(...(await request(app).get(`/api/observability/calls?pageSize=2&page=${page}`)).body.items.map((c: any) => c.id));
    expect(seen).toEqual(['call-F', 'call-E', 'call-D', 'call-C', 'call-B', 'call-A']);
    const d = all.items.find((c: any) => c.id === 'call-D');
    expect(d).toMatchObject({ status: 'missed', direction: 'inbound', turns: 0, durationSeconds: 0, selection: { stt: null } });
    expect(all.items.find((c: any) => c.id === 'call-E')).toMatchObject({ direction: 'outbound', campaign: { campaignId: 'camp-1', contactId: 7, attempt: 2 } });
    expect(all.items.find((c: any) => c.id === 'call-A')).toMatchObject({ durationSeconds: 41, turns: 2, selection: { stt: { provider: 'deepgram', model: 'nova-3' } } });
  });

  it('returns each call\'s own turns, transcripts, replies and timeline: switching calls never shows another call\'s data', async () => {
    const { app } = seed();
    const get = async (id: string) => (await request(app).get(`/api/observability/calls/${id}`)).body;
    const a = await get('call-A');
    const b = await get('call-B');
    const e = await get('call-E');
    expect(a.call.id).toBe('call-A');
    expect(a.turns.map((t: any) => [t.turnId, t.transcript, t.reply])).toEqual([
      ['call-A:t1', 'A asks about opening hours', 'A reply: we open at nine.'],
      ['call-A:t2', 'A asks about parking', 'A reply: parking is free.'],
    ]);
    expect(b.turns.map((t: any) => [t.turnId, t.transcript])).toEqual([['call-B:t1', 'B wants a quote']]);
    expect(JSON.stringify(a)).not.toContain('B wants a quote');
    expect(JSON.stringify(b)).not.toContain('parking');
    expect(a.turns[0].events.every((ev: any) => ev.callId === 'call-A')).toBe(true);
    expect(a.callEvents.every((ev: any) => ev.callId === 'call-A')).toBe(true);
    expect(a.totals).toMatchObject({ turns: 2, failedTurns: 0 });
    expect(e.call.campaign).toEqual({ campaignId: 'camp-1', contactId: 7, attempt: 2 });
    // Asking for A again after B gives the same A.
    expect(await get('call-A')).toEqual(a);
  });

  it('shows cancellations, errors and missing text honestly', async () => {
    const { app } = seed();
    const c = (await request(app).get('/api/observability/calls/call-C')).body;
    expect(c.turns[0]).toMatchObject({ status: 'cancelled', cancelSource: 'caller-speech', transcript: null, reply: null });
    expect(c.turns[0].latency.endToEndMs).toBeNull(); // a cancelled turn is not a response time
    const f = (await request(app).get('/api/observability/calls/call-F')).body;
    expect(f.call.status).toBe('failed');
    expect(f.turns[0]).toMatchObject({ status: 'failed', failingStage: 'stt-result', failureDetail: 'HTTP 503: provider server error', retries: 1 });
    expect(f.errors).toEqual([
      expect.objectContaining({ stage: 'stt-result', detail: 'HTTP 503: provider server error', turnId: 'call-F:t1' }),
      expect.objectContaining({ stage: 'provider-attempt', httpStatus: 503, attempt: 1 }),
    ]);
    expect(f.totals).toMatchObject({ failedTurns: 1 });
    const d = (await request(app).get('/api/observability/calls/call-D')).body; // unanswered: a valid, empty detail
    expect(d).toMatchObject({ call: { status: 'missed' }, turns: [], errors: [], totals: { turns: 0 } });
  });

  it('answers an unknown call with 404 and a malformed id safely', async () => {
    const { app } = seed();
    expect((await request(app).get('/api/observability/calls/nope')).status).toBe(404);
    expect((await request(app).get(`/api/observability/calls/${encodeURIComponent("x' OR '1'='1")}`)).status).toBe(404);
  });
});
