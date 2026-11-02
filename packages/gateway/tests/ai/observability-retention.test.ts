import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ConversationSession } from '../../src/ai/conversation.js';
import { ObservabilityStore } from '../../src/ai/observability-store.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { AiUsageStore } from '../../src/ai/usage-store.js';
import { migrations, runMigrations } from '../../src/db/migrations.js';
import { FORMAT_8K, makeConfig, speechPcm } from './helpers.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((d) => d.close()));
const mem = () => {
  const d = new Database(':memory:');
  open.push(d);
  return d;
};

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const turn = { status: 'completed', sttMs: 12, llmFirstTokenMs: 3, ttsFirstMs: 4, totalMs: 50, utteranceMs: 9, sttSeconds: 1, llmPromptTokens: 1, llmCompletionTokens: 2, ttsChars: 3, selection: { stt: 'a', llm: 'b', tts: 'c' }, mock: false };

function seed(db: Database.Database) {
  const store = new ObservabilityStore(db, { now: () => new Date(NOW) });
  const call = (id: string, outcome: string | null, state: string) =>
    db.prepare('INSERT INTO calls (id, direction, remote_number, state, started_at, outcome) VALUES (?,?,?,?,?,?)').run(id, 'inbound', '+1', state, new Date(NOW - 90 * DAY).toISOString(), outcome);
  call('old-done', 'completed', 'IDLE');
  call('old-live', null, 'ACTIVE');
  const at = (days: number) => new Date(NOW - days * DAY).toISOString();
  const ev = db.prepare('INSERT INTO call_trace_events (call_id, turn_id, at, mono_ms, stage, status) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 10; i++) ev.run('old-done', null, at(60), i, 'stt-result', 'ok'); // expired
  for (let i = 0; i < 5; i++) ev.run('old-done', null, at(5), i, 'stt-result', 'ok'); // recent
  for (let i = 0; i < 3; i++) ev.run('old-live', null, at(60), i, 'stt-result', 'ok'); // expired, but the call is still live
  db.prepare("INSERT INTO call_events (call_id, event_type, timestamp) VALUES ('old-done','state', ?)").run(at(60));
  new AiUsageStore(db).record({ callId: 'old-done', ...turn });
  return store;
}
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const oldEvent = (db: Database.Database) =>
  db.prepare("INSERT INTO call_trace_events (call_id, turn_id, at, mono_ms, stage, status) VALUES ('old-done', NULL, ?, 0, 'x', 'ok')").run(new Date(NOW - 100 * DAY).toISOString());

describe('trace event retention', () => {
  it('removes only expired trace events, never calls, turns or call-state events, and keeps a live call', async () => {
    const db = mem();
    runMigrations(db);
    const store = seed(db);
    expect(await store.prune({ retentionDays: 30, maxEvents: 0, chunk: 100 })).toEqual({ deleted: 10, stoppedEarly: false });
    expect(count(db, 'call_trace_events')).toBe(8); // 5 recent + 3 of the live call
    expect(count(db, 'calls')).toBe(2);
    expect(count(db, 'call_events')).toBe(1);
    expect(count(db, 'ai_turns')).toBe(1);
    expect(await store.prune({ retentionDays: 30, maxEvents: 0 })).toEqual({ deleted: 0, stoppedEarly: false }); // repeatable
  });

  it('works in chunks and yields between them, so a large backlog does not block the loop', async () => {
    const db = mem();
    runMigrations(db);
    const store = seed(db);
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) oldEvent(db);
    })();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const r = await store.prune({ retentionDays: 30, maxEvents: 0, chunk: 100 });
    clearInterval(timer);
    expect(r.deleted).toBe(1010);
    expect(ticks).toBeGreaterThan(0); // other work ran while it was pruning
  });

  it('stops immediately when a call goes live', async () => {
    const db = mem();
    runMigrations(db);
    const store = seed(db);
    await store.prune({ retentionDays: 30, maxEvents: 0 });
    oldEvent(db);
    expect(await store.prune({ retentionDays: 30, maxEvents: 0, busy: () => true })).toEqual({ deleted: 0, stoppedEarly: true });
    expect(count(db, 'call_trace_events')).toBe(9);
  });

  it('caps the table size by dropping the oldest events, and 0 means keep everything', async () => {
    const db = mem();
    runMigrations(db);
    const store = seed(db);
    expect((await store.prune({ retentionDays: 0, maxEvents: 0 })).deleted).toBe(0);
    expect(count(db, 'call_trace_events')).toBe(18);
    expect((await store.prune({ retentionDays: 0, maxEvents: 10, chunk: 100 })).deleted).toBe(8);
    expect(count(db, 'call_trace_events')).toBe(10);
    expect(store.stats()).toMatchObject({ events: 10, failedWrites: 0 });
  });

  it('reports a failing database instead of throwing', async () => {
    const db = mem();
    runMigrations(db);
    const errors: Error[] = [];
    const store = new ObservabilityStore(db, { onError: (e) => errors.push(e) });
    db.exec('DROP TABLE call_trace_events');
    await expect(store.prune({ retentionDays: 30, maxEvents: 0 })).resolves.toEqual({ deleted: 0, stoppedEarly: false });
    expect(errors).toHaveLength(1);
  });
});

describe('migrations 005 to 007', () => {
  const upTo = (db: Database.Database, version: number) => {
    db.exec("CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const m of migrations.filter((x) => x.version <= version)) {
      m.up(db);
      db.prepare('INSERT INTO _schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    }
  };

  it('upgrades a version-4 database without touching existing rows, and is safe to run twice', () => {
    const db = mem();
    upTo(db, 4);
    db.prepare("INSERT INTO calls (id, direction, remote_number, state, started_at, outcome) VALUES ('c1','inbound','+1','IDLE','2026-01-01T00:00:00Z','completed')").run();
    // A row written by the version-4 code, which knows nothing of the new columns.
    db.prepare("INSERT INTO ai_turns (call_id, at, status, stt_ms, llm_first_token_ms, tts_first_ms, total_ms, utterance_ms, stt_key, llm_key, tts_key) VALUES ('c1','2026-01-01T00:00:01Z','completed',12,3,4,50,9,'a','b','c')").run();
    const before = db.prepare('SELECT * FROM ai_turns').all() as Array<Record<string, unknown>>;
    runMigrations(db);
    runMigrations(db);
    expect((db.prepare('SELECT version FROM _schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version)).toEqual(migrations.map((x) => x.version));
    const after = db.prepare('SELECT * FROM ai_turns').all() as Array<Record<string, unknown>>;
    for (const [k, v] of Object.entries(before[0])) expect(after[0][k], k).toEqual(v);
    for (const col of ['turn_ref', 'llm_total_ms', 'tts_total_ms', 'play_ms', 'tft_available', 'stt_mode', 'max_late_ms', 'loop_lag_max_ms', 'cancel_source']) expect(after[0][col], col).toBeNull(); // "not recorded", not zero
    expect(count(db, 'calls')).toBe(1);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='call_trace_events'").all() as Array<{ name: string }>).map((i) => i.name);
    for (const name of ['idx_trace_call', 'idx_trace_at', 'idx_trace_turn', 'idx_trace_status', 'idx_trace_provider', 'idx_trace_stage_call']) expect(idx).toContain(name);
  });
});

describe('telemetry can never break or stall a call', () => {
  it('a persistence hook that throws, or a store on a dead database, leaves the turn untouched', async () => {
    const { TraceHub } = await import('../../src/ai/trace.js');
    const hub = new TraceHub(() => {}, () => false, () => {
      throw new Error('disk full');
    });
    const session = new ConversationSession({ callId: 'c-throw', config: makeConfig(), providers: createMockProviders(), sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => hub.publish('c-throw', e) });
    expect((await session.handleUtterance(speechPcm(1200), 'u1')).status).toBe('completed');

    const db = new Database(':memory:'); // no tables at all: every insert fails
    const dead = new ObservabilityStore(db, { onError: () => { throw new Error('even the error handler is broken'); } });
    expect(() => dead.record({ callId: 'x', turnId: null, stage: 'call', status: 'ok' })).not.toThrow();
    expect(dead.failedWrites).toBe(1);
    db.close();
  });
});

describe('what stt_ms measured', () => {
  it('is recorded per turn so batch, early and streaming times are never silently mixed', async () => {
    const session = new ConversationSession({ callId: 'c-mode', config: makeConfig(), providers: createMockProviders(), sink: new CollectingAudioSink(FORMAT_8K) });
    expect((await session.handleUtterance(speechPcm(1200), 'u1')).metrics.sttMode).toBe('batch');
    const quiet = new ConversationSession({ callId: 'c-none', config: makeConfig(), providers: createMockProviders(), sink: new CollectingAudioSink(FORMAT_8K), passive: true });
    expect((await quiet.handleUtterance(Buffer.alloc(0), 'u0')).metrics.sttMode).toBeNull(); // no transcript, no mode
  });
});
