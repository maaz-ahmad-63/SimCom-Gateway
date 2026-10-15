import { Database as DatabaseType } from 'better-sqlite3';
import { CallDirection, CallOutcome, CallSession, CallState } from '@sim-gateway/shared';

export interface CallEventRecord {
  id: number;
  callId: string;
  eventType: string;
  previousState: CallState | null;
  currentState: CallState | null;
  payload: Record<string, unknown> | null;
  timestamp: string;
  createdAt: string;
}

interface CallDbRow {
  id: string;
  direction: string;
  remote_number: string;
  state: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  outcome: string | null;
  termination_reason: string | null;
  is_simulated: number;
  audio_dump_path: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface CallEventDbRow {
  id: number;
  call_id: string;
  event_type: string;
  previous_state: string | null;
  current_state: string | null;
  payload: string | null;
  timestamp: string;
  created_at: string;
}

export class GatewayRepository {
  constructor(private readonly db: DatabaseType) {}

  upsertCall(session: CallSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO calls (
        id, direction, remote_number, state, started_at, answered_at,
        ended_at, duration_seconds, outcome, termination_reason,
        is_simulated, audio_dump_path, metadata, updated_at
      ) VALUES (
        @id, @direction, @remoteNumber, @state, @startedAt, @answeredAt,
        @endedAt, @durationSeconds, @outcome, @terminationReason,
        @isSimulated, @audioDumpPath, @metadata, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        answered_at = excluded.answered_at,
        ended_at = excluded.ended_at,
        duration_seconds = excluded.duration_seconds,
        outcome = excluded.outcome,
        termination_reason = excluded.termination_reason,
        audio_dump_path = excluded.audio_dump_path,
        metadata = excluded.metadata,
        updated_at = datetime('now')
    `);

    stmt.run({
      id: session.id,
      direction: session.direction,
      remoteNumber: session.remoteNumber,
      state: session.state,
      startedAt: session.startedAt,
      answeredAt: session.answeredAt,
      endedAt: session.endedAt,
      durationSeconds: session.durationSeconds,
      outcome: session.outcome,
      terminationReason: session.terminationReason ?? null,
      isSimulated: session.isSimulated ? 1 : 0,
      audioDumpPath: session.audioDumpPath ?? null,
      metadata: session.metadata ? JSON.stringify(session.metadata) : null,
    });
  }

  getCallById(id: string): { session: CallSession; events: CallEventRecord[] } | null {
    const callRow = this.db
      .prepare('SELECT * FROM calls WHERE id = ?')
      .get(id) as CallDbRow | undefined;

    if (!callRow) {
      return null;
    }

    const eventRows = this.db
      .prepare('SELECT * FROM call_events WHERE call_id = ? ORDER BY timestamp ASC, id ASC')
      .all(id) as CallEventDbRow[];

    const session = this.mapRowToSession(callRow);
    const events = eventRows.map((e) => this.mapRowToEvent(e));

    return { session, events };
  }

  listCalls(options: { limit?: number; offset?: number } = {}): {
    calls: CallSession[];
    total: number;
  } {
    const limit = Math.min(Math.max(1, options.limit ?? 20), 100);
    const offset = Math.max(0, options.offset ?? 0);

    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM calls').get() as {
      count: number;
    };

    const rows = this.db
      .prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as CallDbRow[];

    return {
      calls: rows.map((r) => this.mapRowToSession(r)),
      total: countRow.count,
    };
  }

  recordCallEvent(
    callId: string,
    eventType: string,
    payload?: Record<string, unknown>,
    previousState?: CallState,
    currentState?: CallState,
    timestamp?: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO call_events (
        call_id, event_type, previous_state, current_state, payload, timestamp
      ) VALUES (
        ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      callId,
      eventType,
      previousState ?? null,
      currentState ?? null,
      payload ? JSON.stringify(payload) : null,
      timestamp ?? new Date().toISOString()
    );
  }

  getSetting(key: string, defaultValue?: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM gateway_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;

    return row ? row.value : defaultValue ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO gateway_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')
      `)
      .run(key, value);
  }

  private mapRowToSession(row: CallDbRow): CallSession {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        // ignore parse error
      }
    }

    return {
      id: row.id,
      direction: row.direction as CallDirection,
      remoteNumber: row.remote_number,
      state: row.state as CallState,
      startedAt: row.started_at,
      answeredAt: row.answered_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds,
      outcome: row.outcome as CallOutcome | null,
      terminationReason: row.termination_reason ?? undefined,
      isSimulated: Boolean(row.is_simulated),
      audioDumpPath: row.audio_dump_path ?? undefined,
      metadata,
    };
  }

  private mapRowToEvent(row: CallEventDbRow): CallEventRecord {
    let payload: Record<string, unknown> | null = null;
    if (row.payload) {
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // ignore parse error
      }
    }

    return {
      id: row.id,
      callId: row.call_id,
      eventType: row.event_type,
      previousState: row.previous_state as CallState | null,
      currentState: row.current_state as CallState | null,
      payload,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }
}
