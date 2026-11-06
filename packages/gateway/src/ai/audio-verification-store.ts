import type { Database as DatabaseType } from 'better-sqlite3';
import type { CallAudioVerification, VerificationStatus } from './call-audio-verifier.js';

/**
 * One row per call: the three verification results and their evidence, exactly as the verifier produced them. The evidence holds
 * counts, flags and short sentences only; transcript text never reaches it (the verifier is never given any), so nothing here
 * depends on the transcript-logging setting.
 */
export const AUDIO_VERIFICATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS call_audio_verifications (
    call_id TEXT PRIMARY KEY,
    direction TEXT,
    started_at TEXT NOT NULL,
    active_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    final INTEGER NOT NULL DEFAULT 0,
    simulated INTEGER NOT NULL DEFAULT 0,
    inbound_status TEXT NOT NULL,
    transport_status TEXT NOT NULL,
    audibility_status TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_call_audio_verifications_updated ON call_audio_verifications(updated_at DESC);
`;

const STATUSES: VerificationStatus[] = ['pending', 'verifying', 'verified', 'failed', 'unable'];

export interface AudioVerificationSummary {
  callId: string;
  direction: string | null;
  startedAt: string;
  endedAt: string | null;
  final: boolean;
  inbound: VerificationStatus;
  transport: VerificationStatus;
  audibility: VerificationStatus;
  updatedAt: string;
}

export class AudioVerificationStore {
  constructor(
    private readonly db: DatabaseType,
    private readonly now: () => Date = () => new Date()
  ) {}

  save(v: CallAudioVerification): void {
    const updated = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO call_audio_verifications (call_id, direction, started_at, active_at, ended_at, updated_at, final, simulated, inbound_status, transport_status, audibility_status, result_json)
         VALUES (@callId, @direction, @startedAt, @activeAt, @endedAt, @updatedAt, @final, @simulated, @inbound, @transport, @audibility, @json)
         ON CONFLICT(call_id) DO UPDATE SET direction = excluded.direction, active_at = excluded.active_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at,
           final = excluded.final, simulated = excluded.simulated, inbound_status = excluded.inbound_status, transport_status = excluded.transport_status,
           audibility_status = excluded.audibility_status, result_json = excluded.result_json
         WHERE call_audio_verifications.final = 0`
      )
      .run({
        callId: v.callId,
        direction: v.direction,
        startedAt: v.startedAt,
        activeAt: v.activeAt,
        endedAt: v.endedAt,
        updatedAt: updated,
        final: v.final ? 1 : 0,
        simulated: v.simulated ? 1 : 0,
        inbound: v.inbound.status,
        transport: v.transport.status,
        audibility: v.audibility.status,
        json: JSON.stringify(v),
      });
  }

  /**
   * At startup: rows a previous run never finished (the gateway stopped during the call) become final, with every aspect that was still
   * pending or verifying set to 'unable' and the reason given. Decided aspects are kept. Returns how many rows were finished.
   */
  finishUnfinished(reason: string): number {
    const rows = this.db.prepare('SELECT call_id, result_json FROM call_audio_verifications WHERE final = 0').all() as Array<{ call_id: string; result_json: string }>;
    const at = this.now().toISOString();
    let n = 0;
    for (const r of rows) {
      let v: CallAudioVerification;
      try {
        v = JSON.parse(r.result_json) as CallAudioVerification;
      } catch {
        // unreadable: mark the row final without inventing a result (get() already reports it as missing)
        this.db.prepare('UPDATE call_audio_verifications SET final = 1, updated_at = ? WHERE call_id = ?').run(at, r.call_id);
        n++;
        continue;
      }
      for (const a of [v.inbound, v.transport, v.audibility]) {
        if (a && (a.status === 'pending' || a.status === 'verifying')) {
          a.status = 'unable';
          a.reason = reason;
          a.source = 'call-lifecycle';
          a.updatedAt = at;
        }
      }
      v.final = true;
      v.endedAt = v.endedAt ?? at;
      this.save(v);
      n++;
    }
    return n;
  }

  /** The full result for one call, or null. A row that cannot be read is reported as missing, never guessed. */
  get(callId: string): CallAudioVerification | null {
    const r = this.db.prepare('SELECT result_json FROM call_audio_verifications WHERE call_id = ?').get(callId) as { result_json: string } | undefined;
    if (!r) return null;
    try {
      const v = JSON.parse(r.result_json) as CallAudioVerification;
      for (const a of [v.inbound, v.transport, v.audibility]) if (!a || !STATUSES.includes(a.status)) return null;
      return v;
    } catch {
      return null;
    }
  }

  recent(limit = 20): AudioVerificationSummary[] {
    const rows = this.db
      .prepare('SELECT call_id, direction, started_at, ended_at, final, inbound_status, transport_status, audibility_status, updated_at FROM call_audio_verifications ORDER BY started_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Math.floor(limit)))) as Array<Record<string, any>>;
    return rows.map((r) => ({
      callId: r.call_id,
      direction: r.direction,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      final: r.final === 1,
      inbound: r.inbound_status,
      transport: r.transport_status,
      audibility: r.audibility_status,
      updatedAt: r.updated_at,
    }));
  }
}
