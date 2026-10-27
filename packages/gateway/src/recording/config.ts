export interface RecordingConfig {
  /** CALL_RECORDING_ENABLED. Off by default. */
  enabled: boolean;
  /**
   * CALL_RECORDING_CONSENT_ACKNOWLEDGED. Recording people's calls can require notice or consent where you and
   * the caller are. Enabling the feature is not enough: the operator must also state they have handled that.
   */
  consentAcknowledged: boolean;
  /** CALL_RECORDING_DIR. Kept apart from the diagnostic capture directory (AUDIO_DUMP_DIRECTORY). */
  dir: string;
  /** CALL_RECORDING_RETENTION_DAYS. 0 keeps recordings until you delete them. */
  retentionDays: number;
  /** CALL_RECORDING_MAX_SECONDS. A call longer than this stops being recorded (the file stays valid). */
  maxSeconds: number;
  errors: string[];
}

type Env = Record<string, string | undefined>;

function bool(env: Env, name: string, errors: string[]): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  errors.push(`${name} must be true or false`);
  return false;
}

function int(env: Env, name: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

export function loadRecordingConfig(env: Env = process.env): RecordingConfig {
  const errors: string[] = [];
  return {
    enabled: bool(env, 'CALL_RECORDING_ENABLED', errors),
    consentAcknowledged: bool(env, 'CALL_RECORDING_CONSENT_ACKNOWLEDGED', errors),
    dir: env.CALL_RECORDING_DIR?.trim() || './call-recordings',
    retentionDays: int(env, 'CALL_RECORDING_RETENTION_DAYS', 0, 0, 3650, errors),
    maxSeconds: int(env, 'CALL_RECORDING_MAX_SECONDS', 3600, 10, 86400, errors),
    errors,
  };
}
