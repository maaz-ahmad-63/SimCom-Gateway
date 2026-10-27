import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { ConversationSession } from '../../src/ai/conversation.js';
import { KnowledgeProvider } from '../../src/ai/knowledge.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { TurnRecord, AiUsageStore } from '../../src/ai/usage-store.js';
import { migrations, runMigrations } from '../../src/db/migrations.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, makeConfig, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const NEW_COLUMNS = [
  'first_audio_ms',
  'perceived_first_audio_ms',
  'endpoint_ms',
  'stt_waited_ms',
  'speculative_stt',
  'late_frames',
  'risk_frames',
  'knowledge_hits',
];

const tmpDirs: string[] = [];
const openDbs: DatabaseType[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.open) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDb(): DatabaseType {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-metrics-'));
  tmpDirs.push(dir);
  const db = new Database(path.join(dir, 'gateway.sqlite'));
  openDbs.push(db);
  return db;
}

/** The database as it was before this change: migrations 1 and 2 applied and recorded, nothing else. */
function oldSchemaDb(): DatabaseType {
  const db = tempDb();
  db.exec('CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  for (const m of migrations.filter((x) => x.version <= 2)) {
    m.up(db);
    db.prepare('INSERT INTO _schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
  }
  return db;
}

const columnNames = (db: DatabaseType) => (db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[]).map((c) => c.name);
const lastRow = (db: DatabaseType) => db.prepare('SELECT * FROM ai_turns ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;

const baseTurn: TurnRecord = {
  callId: 'c1',
  status: 'completed',
  sttMs: 300,
  llmFirstTokenMs: 150,
  ttsFirstMs: 200,
  totalMs: 2000,
  utteranceMs: 1200,
  sttSeconds: 1.2,
  llmPromptTokens: 10,
  llmCompletionTokens: 5,
  ttsChars: 40,
  selection: { stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'cartesia' },
  mock: false,
};

describe('ai_turns migration 003 (latency metrics)', () => {
  it('adds the eight nullable columns to a database at the old schema', () => {
    const db = oldSchemaDb();
    for (const c of NEW_COLUMNS) expect(columnNames(db)).not.toContain(c);

    runMigrations(db);

    for (const c of NEW_COLUMNS) expect(columnNames(db)).toContain(c);
    const info = db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string; notnull: number; dflt_value: unknown }[];
    for (const c of info.filter((x) => NEW_COLUMNS.includes(x.name))) {
      expect(c.notnull, c.name).toBe(0);
      expect(c.dflt_value, c.name).toBeNull();
    }
    expect(db.prepare('SELECT version, name FROM _schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: '001_initial_schema' },
      { version: 2, name: '002_ai_turn_log' },
      { version: 3, name: '003_ai_turn_latency_metrics' },
    ]);
  });

  it('keeps every existing row unchanged, with the new columns reading NULL', () => {
    const db = oldSchemaDb();
    const insert = db.prepare(
      `INSERT INTO ai_turns (call_id, at, status, reason, stt_ms, llm_first_token_ms, tts_first_ms, total_ms, utterance_ms,
         stt_seconds, llm_prompt_tokens, llm_completion_tokens, tts_chars, stt_key, llm_key, tts_key, mock, transcript, reply)
       VALUES (?, ?, 'completed', NULL, 301.5, 120, 210, 1800, 1100, 1.1, 12, 7, 33, 'nova-3', 'groq_qwen_3_8_27b', 'cartesia', 0, NULL, NULL)`
    );
    insert.run('old-1', '2026-10-01T00:00:00.000Z');
    insert.run('old-2', '2026-10-02T00:00:00.000Z');
    const before = db.prepare('SELECT * FROM ai_turns ORDER BY id').all() as Record<string, unknown>[];

    runMigrations(db);

    const after = db.prepare('SELECT * FROM ai_turns ORDER BY id').all() as Record<string, unknown>[];
    expect(after).toHaveLength(2);
    for (let i = 0; i < before.length; i++) {
      for (const [key, value] of Object.entries(before[i])) expect(after[i][key], key).toEqual(value);
      for (const c of NEW_COLUMNS) expect(after[i][c], c).toBeNull();
    }
    // The existing readers still work on those rows.
    const store = new AiUsageStore(db);
    expect(store.recent(10).map((r) => r.callId)).toEqual(['old-2', 'old-1']);
    expect(store.totals().turns).toBe(2);
  });

  it('is safe to run again, and tolerates a column that already exists', () => {
    const db = oldSchemaDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const partial = oldSchemaDb();
    partial.exec('ALTER TABLE ai_turns ADD COLUMN late_frames INTEGER');
    expect(() => runMigrations(partial)).not.toThrow();
    for (const c of NEW_COLUMNS) expect(columnNames(partial).filter((n) => n === c)).toHaveLength(1);
  });

  it('creates a fresh database with all columns in one run', () => {
    const db = tempDb();
    runMigrations(db);
    for (const c of NEW_COLUMNS) expect(columnNames(db)).toContain(c);
  });
});

describe('AiUsageStore.record with the new metrics', () => {
  function store(): { db: DatabaseType; store: AiUsageStore } {
    const db = tempDb();
    runMigrations(db);
    return { db, store: new AiUsageStore(db) };
  }

  it('stores every supplied metric', () => {
    const s = store();
    s.store.record({
      ...baseTurn,
      firstAudioMs: 812.5,
      perceivedFirstAudioMs: 1290,
      endpointMs: 650,
      sttWaitedMs: 40,
      speculativeStt: true,
      lateFrames: 3,
      riskFrames: 1,
      knowledgeHits: 2,
    });
    expect(lastRow(s.db)).toMatchObject({
      first_audio_ms: 812.5,
      perceived_first_audio_ms: 1290,
      endpoint_ms: 650,
      stt_waited_ms: 40,
      speculative_stt: 1,
      late_frames: 3,
      risk_frames: 1,
      knowledge_hits: 2,
    });
  });

  it('keeps legitimate zero and false values instead of turning them into NULL', () => {
    const s = store();
    s.store.record({
      ...baseTurn,
      firstAudioMs: 0,
      perceivedFirstAudioMs: 0,
      endpointMs: 0,
      sttWaitedMs: 0,
      speculativeStt: false,
      lateFrames: 0,
      riskFrames: 0,
      knowledgeHits: 0,
    });
    const row = lastRow(s.db);
    for (const c of NEW_COLUMNS) expect(row[c], c).toBe(0);
  });

  it('stores NULL when a metric is omitted or null, and still accepts callers that know nothing about them', () => {
    const s = store();
    s.store.record(baseTurn); // an existing-style caller
    for (const c of NEW_COLUMNS) expect(lastRow(s.db)[c], c).toBeNull();

    s.store.record({
      ...baseTurn,
      firstAudioMs: null,
      perceivedFirstAudioMs: null,
      endpointMs: null,
      sttWaitedMs: null,
      speculativeStt: null,
      lateFrames: null,
      riskFrames: null,
      knowledgeHits: null,
    });
    for (const c of NEW_COLUMNS) expect(lastRow(s.db)[c], c).toBeNull();
    // The columns that existed before are written exactly as before.
    expect(lastRow(s.db)).toMatchObject({ stt_ms: 300, llm_first_token_ms: 150, tts_first_ms: 200, total_ms: 2000, tts_chars: 40 });
  });

  it('leaves the API-facing log entry and the totals unchanged', () => {
    const s = store();
    s.store.record({ ...baseTurn, firstAudioMs: 500, lateFrames: 2 });
    const entry = s.store.recent(1)[0];
    expect(Object.keys(entry).sort()).toEqual(
      ['id', 'callId', 'at', 'status', 'reason', 'sttMs', 'llmFirstTokenMs', 'ttsFirstMs', 'totalMs', 'utteranceMs', 'sttSeconds', 'llmPromptTokens', 'llmCompletionTokens', 'ttsChars', 'transcript', 'reply'].sort()
    );
    expect(s.store.totals().turns).toBe(1);
  });
});

describe('knowledgeHits on the turn metrics', () => {
  const session = (knowledge: KnowledgeProvider | null) =>
    new ConversationSession({
      callId: 'k1',
      config: makeConfig(),
      providers: createMockProviders({ stt: ['What are your opening hours?'], llm: ['We open at nine every weekday. Anything else?'] }),
      sink: new CollectingAudioSink(FORMAT_8K),
      knowledge,
    });

  it('is null when no knowledge base is configured (RAG inactive)', async () => {
    const result = await session(null).handleUtterance(speechPcm(1200), 'u1');
    expect(result.metrics.knowledgeHits).toBeNull();
  });

  it('is the number of passages retrieved when one is configured, including zero', async () => {
    const hit = { source: 'a.md', text: 'We open at nine.', score: 1 };
    const withHits: KnowledgeProvider = { name: 'stub', retrieve: async () => [hit, { ...hit, source: 'b.md' }] };
    const empty: KnowledgeProvider = { name: 'stub', retrieve: async () => [] };
    expect((await session(withHits).handleUtterance(speechPcm(1200), 'u1')).metrics.knowledgeHits).toBe(2);
    expect((await session(empty).handleUtterance(speechPcm(1200), 'u1')).metrics.knowledgeHits).toBe(0);
  });
});

describe('gateway persists the metrics of a real turn, and the test-call path still works', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });
  const API_KEY = 'turn-metrics-test-key';

  async function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-metrics-gw-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true);
    const providers = createMockProviders({ stt: ['What time do you close?'], llm: ['We close at five. Anything else I can do for you?'] });
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: API_KEY, sqliteDbPath: path.join(dir, 'gateway.sqlite'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' }),
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
    const api = (method: 'get' | 'post', url: string) => request(server.app)[method](url).set('x-api-key', API_KEY);
    return { server, modem, source, sink, api };
  }

  it('records first audio, endpointing, STT wait and playback quality for a spoken turn', async () => {
    const h = await harness();
    const call = await h.server.callManager.dial({ phoneNumber: '+919876543210' });
    h.modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
    await h.server.callManager.activateUsbAudioDiagnostic!();
    await sleep(60);
    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).body).toMatchObject({ success: true });

    h.source.push(speechPcm(1200));
    h.source.push(noiseFloorPcm(1200));
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1));
    await vi.waitFor(() => expect(h.server.db.prepare('SELECT COUNT(*) c FROM ai_turns WHERE call_id = ?').get(call.id)).toMatchObject({ c: 1 }));

    const row = h.server.db.prepare('SELECT * FROM ai_turns WHERE call_id = ?').get(call.id) as Record<string, number | null>;
    expect(row.status).toBe('completed');
    expect(row.first_audio_ms).toBeGreaterThan(0);
    expect(row.perceived_first_audio_ms).toBeGreaterThan(0);
    expect(row.endpoint_ms).toBeGreaterThanOrEqual(0);
    expect(row.stt_waited_ms).not.toBeNull();
    expect(row.speculative_stt === 0 || row.speculative_stt === 1).toBe(true);
    expect(row.late_frames).not.toBeNull(); // audio played, so frame counts exist (0 is a real answer)
    expect(row.risk_frames).not.toBeNull();
    expect(row.knowledge_hits).toBeNull(); // no knowledge base: RAG is inactive
    // The pre-existing columns are still filled.
    expect(row.stt_ms).not.toBeNull();
    expect(row.llm_first_token_ms).not.toBeNull();
  });

  it('logs an operator test call with NULL for every new metric', async () => {
    const h = await harness();
    const res = await h.api('post', '/api/ai/test/llm').send({ prompt: 'hello', confirmBilling: true });
    expect(res.status).toBe(200);
    const row = h.server.db.prepare("SELECT * FROM ai_turns WHERE call_id = 'test:llm'").get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    for (const c of NEW_COLUMNS) expect(row[c], c).toBeNull();
    expect((await h.api('get', '/api/ai/turns')).body.turns.length).toBe(1);
  });
});
