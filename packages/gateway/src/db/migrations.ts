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
  {
    version: 4,
    name: '004_sms_messages',
    up: (db: DatabaseType) => {
      // Additive: a new table only. Messages the gateway has read from the modem's storage and messages it has sent,
      // so the inbox survives restarts and a notification or a re-read never creates a second copy (dedupe_key).
      // Nothing here is ever deleted by the gateway.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sms_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dedupe_key TEXT NOT NULL UNIQUE,
          direction TEXT NOT NULL,
          source TEXT NOT NULL,
          storage TEXT,
          storage_index INTEGER,
          address TEXT,
          text TEXT NOT NULL,
          message_time TEXT,
          modem_status TEXT,
          send_status TEXT,
          message_reference INTEGER,
          error_code TEXT,
          error_message TEXT,
          on_modem INTEGER NOT NULL DEFAULT 1,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sms_messages_direction ON sms_messages(direction, id DESC);
      `);
    },
  },
  {
    version: 5,
    name: '005_call_observability',
    up: (db: DatabaseType) => {
      // Additive only. call_trace_events is written one row at a time while a call runs, so an abrupt end loses
      // nothing already recorded. Timestamps are UTC ISO strings; mono_ms is the gateway's monotonic clock (ms since the
      // process started) and is the only value durations are computed from. No audio and no credentials are stored here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS call_trace_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call_id TEXT NOT NULL,
          turn_id TEXT,
          at TEXT NOT NULL,
          mono_ms REAL NOT NULL,
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          latency_ms REAL,
          detail TEXT,
          data TEXT,
          provider TEXT,
          model TEXT,
          http_status INTEGER,
          attempt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_trace_call ON call_trace_events(call_id, id);
        CREATE INDEX IF NOT EXISTS idx_trace_at ON call_trace_events(at);
        CREATE INDEX IF NOT EXISTS idx_trace_turn ON call_trace_events(turn_id);
        CREATE INDEX IF NOT EXISTS idx_trace_status ON call_trace_events(status, stage);
        CREATE INDEX IF NOT EXISTS idx_trace_provider ON call_trace_events(provider, model);
      `);
      const existing = new Set((db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[]).map((c) => c.name));
      const columns: Array<[string, 'REAL' | 'INTEGER' | 'TEXT']> = [
        ['turn_ref', 'TEXT'],
        ['llm_total_ms', 'REAL'],
        ['tts_total_ms', 'REAL'],
        ['play_ms', 'REAL'],
        ['tft_available', 'INTEGER'],
      ];
      for (const [name, type] of columns) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ai_turns ADD COLUMN ${name} ${type}`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_turns_ref ON ai_turns(turn_ref);
        CREATE INDEX IF NOT EXISTS idx_ai_turns_status ON ai_turns(status);
        CREATE INDEX IF NOT EXISTS idx_ai_turns_keys ON ai_turns(stt_key, llm_key, tts_key);
      `);
    },
  },
  {
    version: 6,
    name: '006_observability_stt_mode_and_index',
    up: (db: DatabaseType) => {
      // Additive. stt_mode says what stt_ms measured (a batch request, a request started early, or a streaming
      // finalize wait), so the three are never averaged together unknowingly. NULL on turns recorded before this.
      const existing = new Set((db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[]).map((c) => c.name));
      if (!existing.has('stt_mode')) db.exec('ALTER TABLE ai_turns ADD COLUMN stt_mode TEXT');
      // The per-call provider lookup reads only the 'call' stage rows; retention prunes by time.
      db.exec('CREATE INDEX IF NOT EXISTS idx_trace_stage_call ON call_trace_events(stage, call_id)');
    },
  },
  {
    version: 7,
    name: '007_turn_playback_jitter_and_cancel_source',
    up: (db: DatabaseType) => {
      // Additive and nullable: NULL reads "not recorded" on turns from before this.
      //  max_late_ms      worst lateness of any audio frame written in the turn (playback jitter)
      //  loop_lag_max_ms  longest event-loop stall during the turn (tells a stalled loop from a slow network)
      //  cancel_source    who cancelled the turn (caller speech, operator, teardown, ...)
      const existing = new Set((db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[]).map((c) => c.name));
      const columns: Array<[string, 'REAL' | 'TEXT']> = [
        ['max_late_ms', 'REAL'],
        ['loop_lag_max_ms', 'REAL'],
        ['cancel_source', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE ai_turns ADD COLUMN ${name} ${type}`);
    },
  },
  {
    version: 8,
    name: '008_campaigns',
    up: (db: DatabaseType) => {
      // Additive: new tables only. Campaign progress is stored one contact at a time, so it survives a restart. Nothing here
      // changes calls, call_events or ai_turns. do_not_call is global: an opt-out applies to every campaign, present and future.
      db.exec(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          pause_reason TEXT,
          settings TEXT NOT NULL,
          mapping TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          confirmed_at TEXT,
          -- What the operator confirmed when starting (JSON: the acknowledgements, the consent mode, the time).
          acknowledgements TEXT,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

        CREATE TABLE IF NOT EXISTS campaign_contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id TEXT NOT NULL,
          row_number INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          phone_raw TEXT NOT NULL DEFAULT '',
          phone_e164 TEXT,
          designation TEXT NOT NULL DEFAULT '',
          company TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT '',
          extra TEXT,
          consent TEXT NOT NULL DEFAULT 'unknown',
          opt_out INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued',
          skip_reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          call_id TEXT,
          last_outcome TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        );
        -- One row per number per campaign: the database itself refuses a second one, whatever the code does.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unique_phone ON campaign_contacts(campaign_id, phone_e164) WHERE phone_e164 IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_cc_queue ON campaign_contacts(campaign_id, status, next_attempt_at, row_number);
        CREATE INDEX IF NOT EXISTS idx_cc_call ON campaign_contacts(call_id);
        CREATE INDEX IF NOT EXISTS idx_cc_phone ON campaign_contacts(phone_e164);

        CREATE TABLE IF NOT EXISTS campaign_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id TEXT NOT NULL,
          contact_id INTEGER NOT NULL,
          phone_e164 TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          call_id TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          outcome TEXT,
          error TEXT,
          FOREIGN KEY (contact_id) REFERENCES campaign_contacts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ca_contact ON campaign_attempts(contact_id, attempt);
        CREATE INDEX IF NOT EXISTS idx_ca_phone ON campaign_attempts(phone_e164, started_at);
        CREATE INDEX IF NOT EXISTS idx_ca_call ON campaign_attempts(call_id);

        CREATE TABLE IF NOT EXISTS do_not_call (
          phone_e164 TEXT PRIMARY KEY,
          reason TEXT,
          source TEXT NOT NULL DEFAULT 'operator',
          added_at TEXT NOT NULL
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
