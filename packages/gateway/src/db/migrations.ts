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
