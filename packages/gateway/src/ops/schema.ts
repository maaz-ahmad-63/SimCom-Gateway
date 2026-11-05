/**
 * Tables for alerts and per-call diagnoses. Used by migration 011, and by the tests, so the migration and the tests cannot drift.
 * Additive only: nothing here changes an existing table.
 */
export const OPS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ops_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    component TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    details TEXT,
    retry TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    count INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    acknowledged_at TEXT,
    dismissed_at TEXT,
    resolved_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_alerts_active_key ON ops_alerts(key) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_ops_alerts_last ON ops_alerts(last_at DESC);

  CREATE TABLE IF NOT EXISTS call_diagnostics (
    call_id TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    final_status TEXT NOT NULL,
    modem_result TEXT,
    cause_code INTEGER,
    cause_text TEXT,
    signal_rssi INTEGER,
    signal_dbm INTEGER,
    signal_level TEXT,
    signal_at TEXT,
    sim_state TEXT,
    registration TEXT,
    network_verdict TEXT,
    failure_stage TEXT NOT NULL,
    explanation TEXT NOT NULL,
    certainty TEXT NOT NULL,
    retry_hint TEXT NOT NULL,
    raw TEXT
  );
`;
