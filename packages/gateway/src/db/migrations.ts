import { Database as DatabaseType } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db: DatabaseType) => {
      // Calls table
      db.exec(`
        CREATE TABLE IF NOT EXISTS calls (
          id TEXT PRIMARY KEY,
          direction TEXT NOT NULL,
          remote_number TEXT NOT NULL,
          state TEXT NOT NULL,
          started_at TEXT NOT NULL,
          answered_at TEXT,
          ended_at TEXT,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          outcome TEXT,
          termination_reason TEXT,
          is_simulated INTEGER NOT NULL DEFAULT 0,
          audio_dump_path TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_calls_state ON calls(state);
        CREATE INDEX IF NOT EXISTS idx_calls_remote_number ON calls(remote_number);
        CREATE INDEX IF NOT EXISTS idx_calls_outcome ON calls(outcome);

        -- Call events timeline table
        CREATE TABLE IF NOT EXISTS call_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          previous_state TEXT,
          current_state TEXT,
          payload TEXT,
          timestamp TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_call_events_call_id ON call_events(call_id, timestamp);

        -- Gateway persistent configuration table
        CREATE TABLE IF NOT EXISTS gateway_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 2,
    name: '002_ai_turn_log',
    up: (db: DatabaseType) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call_id TEXT NOT NULL,
          at TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          stt_ms REAL,
          llm_first_token_ms REAL,
          tts_first_ms REAL,
          total_ms REAL,
          utterance_ms REAL,
          stt_seconds REAL NOT NULL DEFAULT 0,
          llm_prompt_tokens INTEGER,
          llm_completion_tokens INTEGER,
          tts_chars INTEGER NOT NULL DEFAULT 0,
          stt_key TEXT,
          llm_key TEXT,
          tts_key TEXT,
          mock INTEGER NOT NULL DEFAULT 0,
          transcript TEXT,
          reply TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_turns_at ON ai_turns(at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_turns_call ON ai_turns(call_id, at);
      `);
    },
  },
  {
    version: 3,
    name: '003_ai_turn_latency_metrics',
    up: (db: DatabaseType) => {
      // Additive only: every column is nullable, so existing rows read NULL ("not recorded") and old writers keep working.
      // ADD COLUMN is not idempotent in SQLite, so a column that is already there is skipped.
      const existing = new Set((db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[]).map((c) => c.name));
      const columns: Array<[string, 'REAL' | 'INTEGER']> = [
        ['first_audio_ms', 'REAL'],
        ['perceived_first_audio_ms', 'REAL'],
        ['endpoint_ms', 'REAL'],
        ['stt_waited_ms', 'REAL'],
        ['speculative_stt', 'INTEGER'],
        ['late_frames', 'INTEGER'],
        ['risk_frames', 'INTEGER'],
        ['knowledge_hits', 'INTEGER'],
      ];
      for (const [name, type] of columns) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ai_turns ADD COLUMN ${name} ${type}`);
      }
    },
  },
];

export function runMigrations(db: DatabaseType): void {
  // Ensure schema migrations tracker table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const appliedRows = db
    .prepare('SELECT version FROM _schema_migrations ORDER BY version ASC')
    .all() as { version: number }[];

  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const runMigrationTx = db.transaction((migration: Migration) => {
    migration.up(db);
    db.prepare('INSERT INTO _schema_migrations (version, name) VALUES (?, ?)').run(
      migration.version,
      migration.name
    );
  });

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      runMigrationTx(migration);
    }
  }
}
