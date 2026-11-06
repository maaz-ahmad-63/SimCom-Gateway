import type { Database as DatabaseType } from 'better-sqlite3';
import { RecordingConfig } from './config.js';

/**
 * Call-recording settings the operator changes in the dashboard (Settings > Call Recording), stored with the gateway's other settings.
 * The CALL_RECORDING_* environment variables are only the starting values: once settings are saved they win, and the recordings folder
 * stays where the environment puts it. Recording can only be switched on together with the consent acknowledgement, and withdrawing the
 * acknowledgement switches it off.
 */
export interface SavedRecordingSettings {
  enabled: boolean;
  consentAcknowledged: boolean;
  /** When the acknowledgement was given (null when it is not given). */
  consentAcknowledgedAt: string | null;
  retentionDays: number;
  maxSeconds: number;
  updatedAt: string;
}

export interface SettingsBackendLike {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export class RecordingSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'RecordingSettingsError';
  }
}

const KEY = 'recording.settings';
const FIELD_ENV: Record<string, string> = {
  enabled: 'CALL_RECORDING_ENABLED',
  consentAcknowledged: 'CALL_RECORDING_CONSENT_ACKNOWLEDGED',
  retentionDays: 'CALL_RECORDING_RETENTION_DAYS',
  maxSeconds: 'CALL_RECORDING_MAX_SECONDS',
};

/** The effective configuration: the environment's, with the saved settings over it. */
export function effectiveRecordingConfig(base: RecordingConfig, saved: SavedRecordingSettings | null): RecordingConfig {
  if (!saved) return base;
  // A saved value replaces the environment's, so an invalid environment value for that field no longer matters.
  const overridden = Object.values(FIELD_ENV);
  return {
    ...base,
    enabled: saved.enabled && saved.consentAcknowledged,
    consentAcknowledged: saved.consentAcknowledged,
    retentionDays: saved.retentionDays,
    maxSeconds: saved.maxSeconds,
    errors: base.errors.filter((e) => !overridden.some((name) => e.startsWith(name))),
  };
}

export interface RecordingSettingsView {
  settings: { enabled: boolean; consentAcknowledged: boolean; consentAcknowledgedAt: string | null; retentionDays: number; maxSeconds: number };
  /** 'saved': changed in the dashboard. 'environment': still the CALL_RECORDING_* starting values. */
  source: 'saved' | 'environment';
  dir: string;
  updatedAt: string | null;
}

export class RecordingSettingsService {
  constructor(
    private readonly backend: SettingsBackendLike,
    private readonly base: RecordingConfig,
    /** Applies a new effective configuration to the recorder (live, from the next call). */
    private readonly apply: (config: RecordingConfig) => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  saved(): SavedRecordingSettings | null {
    const raw = this.backend.getSetting(KEY);
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as SavedRecordingSettings;
      if (typeof s.enabled !== 'boolean' || typeof s.consentAcknowledged !== 'boolean' || !Number.isInteger(s.retentionDays) || !Number.isInteger(s.maxSeconds)) return null;
      return s;
    } catch {
      return null; // a damaged record falls back to the environment's values rather than guessing
    }
  }

  effective(): RecordingConfig {
    return effectiveRecordingConfig(this.base, this.saved());
  }

  view(): RecordingSettingsView {
    const saved = this.saved();
    const c = this.effective();
    return {
      settings: {
        enabled: c.enabled,
        consentAcknowledged: c.consentAcknowledged,
        consentAcknowledgedAt: saved?.consentAcknowledgedAt ?? null,
        retentionDays: c.retentionDays,
        maxSeconds: c.maxSeconds,
      },
      source: saved ? 'saved' : 'environment',
      dir: c.dir,
      updatedAt: saved?.updatedAt ?? null,
    };
  }

  update(body: unknown): RecordingSettingsView {
    if (!body || typeof body !== 'object') throw new RecordingSettingsError('Send the recording settings as an object');
    const b = body as Record<string, unknown>;
    const current = this.effective();
    const bool = (name: string, fallback: boolean): boolean => {
      if (b[name] === undefined) return fallback;
      if (typeof b[name] !== 'boolean') throw new RecordingSettingsError(`${name} must be true or false`);
      return b[name] as boolean;
    };
    const int = (name: string, fallback: number, min: number, max: number): number => {
      if (b[name] === undefined) return fallback;
      const n = b[name];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new RecordingSettingsError(`${name} must be a whole number from ${min} to ${max}`);
      return n;
    };
    const consentAcknowledged = bool('consentAcknowledged', current.consentAcknowledged);
    let enabled = bool('enabled', current.enabled);
    if (enabled && !consentAcknowledged) {
      if (b.enabled === true) throw new RecordingSettingsError('Recording cannot be switched on until the consent acknowledgement is confirmed', 409);
      enabled = false; // withdrawing the acknowledgement switches recording off
    }
    const previous = this.saved();
    const next: SavedRecordingSettings = {
      enabled,
      consentAcknowledged,
      consentAcknowledgedAt: consentAcknowledged ? (current.consentAcknowledged ? (previous?.consentAcknowledgedAt ?? null) : this.now().toISOString()) : null,
      retentionDays: int('retentionDays', current.retentionDays, 0, 3650),
      maxSeconds: int('maxSeconds', current.maxSeconds, 10, 86400),
      updatedAt: this.now().toISOString(),
    };
    this.backend.setSetting(KEY, JSON.stringify(next));
    this.apply(this.effective());
    return this.view();
  }
}

// ---- why a call was not recorded -------------------------------------------------------------------

export type NotRecordedStatus = 'off' | 'no-consent' | 'config-error' | 'start-failed';

export const RECORDING_SKIPS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS call_recording_skips (
  call_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_recording_skips_created ON call_recording_skips(created_at);
`;

const KEEP_SKIPS = 5000;

/** One row per call that became ACTIVE but was not recorded, with the reason as it was at that moment. */
export class RecordingSkipStore {
  private writes = 0;
  constructor(private readonly db: DatabaseType) {}

  record(callId: string, status: NotRecordedStatus, reason: string): void {
    this.db.prepare('INSERT OR REPLACE INTO call_recording_skips (call_id, status, reason, created_at) VALUES (?, ?, ?, ?)').run(callId, status, reason, new Date().toISOString());
    if (++this.writes % 100 === 0) {
      this.db.prepare('DELETE FROM call_recording_skips WHERE call_id NOT IN (SELECT call_id FROM call_recording_skips ORDER BY created_at DESC LIMIT ?)').run(KEEP_SKIPS);
    }
  }

  get(callIds: string[]): Array<{ callId: string; status: NotRecordedStatus; reason: string; at: string }> {
    if (callIds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT call_id, status, reason, created_at FROM call_recording_skips WHERE call_id IN (${callIds.map(() => '?').join(',')})`)
      .all(...callIds) as Array<{ call_id: string; status: NotRecordedStatus; reason: string; created_at: string }>;
    return rows.map((r) => ({ callId: r.call_id, status: r.status, reason: r.reason, at: r.created_at }));
  }
}
