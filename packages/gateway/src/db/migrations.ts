import { AUDIO_VERIFICATION_SCHEMA_SQL } from '../ai/audio-verification-store.js';
import { Database as DatabaseType } from 'better-sqlite3';
import { OPS_SCHEMA_SQL } from '../ops/schema.js';
import { RECORDING_SKIPS_SCHEMA_SQL } from '../recording/recording-settings.js';

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
  {
    version: 9,
    name: '009_campaign_config_versions_list_archive_and_cached_tokens',
    up: (db: DatabaseType) => {
      // Additive. Nothing here deletes or rewrites a call, a turn, an attempt or a contact.
      //  campaign_config_versions  the editable AI configuration of a campaign (prompt, model), one immutable row per saved version;
      //                            campaigns.config_version names the one in force, 0 meaning "none yet" (the campaign keeps its old behaviour)
      //  campaign_contacts.archived / list_version   replacing a contact list keeps the old rows (and every attempt that points at them)
      //                            as history instead of deleting them; only archived = 0 rows are the live list
      //  campaign_attempts.config_version / prompt_sha / llm_key   the exact configuration each call was created with
      //  campaign_imports          the CSV text exactly as uploaded, per import, for auditing
      //  ai_turns.llm_cached_tokens / llm_cache_write_tokens   what the provider reported as served from / written to its prompt cache
      //                            (NULL = the provider did not report it, which is different from 0)
      const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      const add = (table: string, name: string, ddl: string) => {
        if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      };
      db.exec(`
        CREATE TABLE IF NOT EXISTS campaign_config_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          prompt_sha TEXT NOT NULL DEFAULT '',
          llm_key TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ccv_campaign_version ON campaign_config_versions(campaign_id, version);

        CREATE TABLE IF NOT EXISTS campaign_imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id TEXT NOT NULL,
          list_version INTEGER NOT NULL,
          csv TEXT NOT NULL,
          mapping TEXT,
          summary TEXT,
          row_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ci_campaign ON campaign_imports(campaign_id, id);
      `);
      add('campaigns', 'config_version', 'INTEGER NOT NULL DEFAULT 0');
      add('campaigns', 'list_version', 'INTEGER NOT NULL DEFAULT 1');
      add('campaign_contacts', 'archived', 'INTEGER NOT NULL DEFAULT 0');
      add('campaign_contacts', 'list_version', 'INTEGER NOT NULL DEFAULT 1');
      add('campaign_attempts', 'config_version', 'INTEGER');
      add('campaign_attempts', 'prompt_sha', 'TEXT');
      add('campaign_attempts', 'llm_key', 'TEXT');
      add('ai_turns', 'llm_cached_tokens', 'INTEGER');
      add('ai_turns', 'llm_cache_write_tokens', 'INTEGER');
      // One live row per number per campaign: archived rows (an earlier list) no longer count against it.
      db.exec(`
        DROP INDEX IF EXISTS idx_cc_unique_phone;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_unique_phone ON campaign_contacts(campaign_id, phone_e164) WHERE phone_e164 IS NOT NULL AND archived = 0;
        CREATE INDEX IF NOT EXISTS idx_cc_live ON campaign_contacts(campaign_id, archived, status, row_number);
      `);
    },
  },
  {
    version: 10,
    name: '010_campaign_call_analysis',
    up: (db: DatabaseType) => {
      // Additive: two new tables. call_analyses is append-only (every model run is kept as it was returned); a manual correction is a
      // separate row laid over it when read, so the original AI result is never changed or deleted. Nothing here touches calls or ai_turns.
      db.exec(`
CREATE TABLE IF NOT EXISTS call_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL,
  campaign_id TEXT NOT NULL,
  call_id TEXT,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  llm_key TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES campaign_attempts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cana_attempt ON call_analyses(attempt_id, id);
CREATE INDEX IF NOT EXISTS idx_cana_campaign ON call_analyses(campaign_id, id);
CREATE TABLE IF NOT EXISTS call_analysis_overrides (
  attempt_id INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  outcome TEXT,
  interest TEXT,
  summary TEXT,
  next_action TEXT,
  note TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES campaign_attempts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canao_campaign ON call_analysis_overrides(campaign_id);
      `);
    },
  },
  {
    version: 11,
    name: '011_ops_alerts_and_call_diagnostics',
    up: (db: DatabaseType) => {
      // Additive: two new tables (alerts with their history, and one diagnosis per call). Nothing existing is changed.
      db.exec(OPS_SCHEMA_SQL);
    },
  },
  {
    version: 12,
    name: '012_call_audio_verification',
    up: (db: DatabaseType) => {
      // Additive: one new table with the automatic call-audio verification result of each call. Nothing existing is changed.
      db.exec(AUDIO_VERIFICATION_SCHEMA_SQL);
    },
  },
  {
    version: 13,
    name: '013_call_recording_skips',
    up: (db: DatabaseType) => {
      // Additive: one new table with why a call was not recorded (recording off, consent missing, failed to start). Nothing existing is changed.
      db.exec(RECORDING_SKIPS_SCHEMA_SQL);
    },
  },
];

/** The newest schema version this application knows. A database that is behind is migrated at start; one that is ahead is refused for restore. */
export const SCHEMA_VERSION = migrations[migrations.length - 1].version;

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
