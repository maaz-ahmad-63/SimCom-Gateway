import { performance } from 'node:perf_hooks';
import { Database as DatabaseType } from 'better-sqlite3';
import { timeSyncIo } from '../core/sync-io-watch.js';
import { redactSecrets } from './providers/http.js';

/**
 * Persistent call telemetry. Every pipeline event is written the moment it happens (one small INSERT), so a crash or an
 * abrupt disconnect keeps everything recorded up to that point. Recording never throws: a full disk or a locked
 * database costs a telemetry row, never audio or a call. Nothing here stores audio, API keys or authorization headers,
 * and text (what was said) is stored only when the operator turned that on explicitly.
 */

export interface TraceEventInput {
  callId: string;
  turnId: string | null;
  stage: string;
  status: string;
  latencyMs?: number | null;
  detail?: string | null;
  data?: Record<string, unknown> | null;
  provider?: string | null;
  model?: string | null;
  httpStatus?: number | null;
  attempt?: number | null;
  text?: string | null;
  role?: string | null;
}

export interface StoredTraceEvent {
  id: number;
  callId: string;
  turnId: string | null;
  at: string;
  monoMs: number;
  stage: string;
  status: string;
  latencyMs: number | null;
  detail: string | null;
  data: Record<string, unknown> | null;
  provider: string | null;
  model: string | null;
  httpStatus: number | null;
  attempt: number | null;
}

export interface CallFilters {
  /** Inclusive ISO bounds on the call's start time. */
  from?: string;
  to?: string;
  /** A call outcome (completed, failed, missed, ...), `in_progress`, or `ai_error` (at least one failed AI turn). */
  status?: string;
  direction?: 'inbound' | 'outbound';
  provider?: string;
  model?: string;
  /** Call/session id, exact or prefix. */
  q?: string;
  /** `only` or `exclude` simulated (mock modem) calls; absent shows both. */
  simulated?: 'only' | 'exclude';
}

export interface Page {
  page?: number;
  pageSize?: number;
}

export interface Stat {
  /** How many turns the figure is based on. Everything else is null when this is 0. */
  n: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

/** Nearest-rank percentile of an ascending-sorted list; null for an empty one. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function stat(values: Array<number | null | undefined>): Stat {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, avg: null, p50: null, p95: null };
  const round = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return { n: v.length, avg: round(v.reduce((a, b) => a + b, 0) / v.length), p50: round(percentile(v, 50)), p95: round(percentile(v, 95)) };
}

const SECRET_KEY = /(api[-_]?key|secret|authorization|password|bearer|credential)/i;
const MAX_DETAIL = 500;
const MAX_DATA_JSON = 4000;

function cleanData(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = typeof v === 'string' ? redactSecrets(v).slice(0, 300) : v;
  }
  const json = JSON.stringify(out);
  return json.length > MAX_DATA_JSON ? JSON.stringify({ truncated: true }) : json;
}

export interface ObservabilityOptions {
  /** Store what was said (caller text and agent reply). Off unless the operator turned it on. */
  storeText?: boolean;
  /** UTC wall clock for the `at` column (a test seam). */
  now?: () => Date;
  /** Monotonic milliseconds (a test seam); defaults to performance.now(). */
  mono?: () => number;
  onError?: (error: Error) => void;
}

interface CallRow {
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
  sel: string | null;
  metadata: string | null;
  turns: number | null;
  failed_turns: number | null;
  cancelled_turns: number | null;
  e2e_avg: number | null;
  stt_avg: number | null;
  tft_avg: number | null;
  llm_avg: number | null;
  tts_avg: number | null;
}

export interface CallSelection {
  stt: { key: string; provider: string; model: string | null } | null;
  llm: { key: string; provider: string; model: string | null } | null;
  tts: { key: string; provider: string; model: string | null } | null;
}

function parseCampaign(metadata: string | null): { campaignId: string; contactId: number; attempt: number | null } | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>;
    return typeof m.campaignId === 'string' && typeof m.campaignContactId === 'number'
      ? { campaignId: m.campaignId, contactId: m.campaignContactId, attempt: typeof m.campaignAttempt === 'number' ? m.campaignAttempt : null }
      : null;
  } catch {
    return null;
  }
}

function parseSelection(json: string | null): CallSelection {
  const empty: CallSelection = { stt: null, llm: null, tts: null };
  if (!json) return empty;
  try {
    const d = JSON.parse(json) as Record<string, string>;
    const part = (p: 'stt' | 'llm' | 'tts') => (d[`${p}Key`] ? { key: d[`${p}Key`], provider: d[`${p}Provider`] ?? d[`${p}Key`], model: d[`${p}Model`] || null } : null);
    return { stt: part('stt'), llm: part('llm'), tts: part('tts') };
  } catch {
    return empty;
  }
}

/** Selection of the provider/model for a call is the first attach event that carried one. */
const SEL_CTE = `sel AS MATERIALIZED (
  SELECT call_id, data FROM call_trace_events
  WHERE id IN (SELECT MIN(id) FROM call_trace_events WHERE stage = 'call' AND json_extract(data, '$.sttKey') IS NOT NULL GROUP BY call_id)
)`;
const TURN_CTE = `tt AS MATERIALIZED (
  SELECT call_id, COUNT(*) AS turns, SUM(status = 'failed') AS failed_turns, SUM(status = 'cancelled') AS cancelled_turns,
         AVG(CASE WHEN status = 'completed' THEN perceived_first_audio_ms END) AS e2e_avg, AVG(stt_ms) AS stt_avg,
         AVG(CASE WHEN tft_available IS NOT 0 THEN llm_first_token_ms END) AS tft_avg,
         AVG(llm_total_ms) AS llm_avg, AVG(tts_first_ms) AS tts_avg
  FROM ai_turns GROUP BY call_id
)`;

function whereFor(f: CallFilters): { sql: string; params: unknown[] } {
  const w: string[] = [];
  const p: unknown[] = [];
  if (f.from) { w.push('c.started_at >= ?'); p.push(f.from); }
  if (f.to) { w.push('c.started_at <= ?'); p.push(f.to); }
  if (f.direction) { w.push('c.direction = ?'); p.push(f.direction); }
  if (f.simulated === 'only') w.push('c.is_simulated = 1');
  if (f.simulated === 'exclude') w.push('c.is_simulated = 0');
  if (f.status === 'in_progress') w.push('c.outcome IS NULL');
  else if (f.status === 'ai_error') w.push('COALESCE(tt.failed_turns, 0) > 0');
  else if (f.status) { w.push('c.outcome = ?'); p.push(f.status); }
  if (f.provider) {
    w.push(`(json_extract(sel.data, '$.sttProvider') = ? OR json_extract(sel.data, '$.llmProvider') = ? OR json_extract(sel.data, '$.ttsProvider') = ?)`);
    p.push(f.provider, f.provider, f.provider);
  }
  if (f.model) {
    w.push(`(json_extract(sel.data, '$.sttModel') = ? OR json_extract(sel.data, '$.llmModel') = ? OR json_extract(sel.data, '$.ttsModel') = ?)`);
    p.push(f.model, f.model, f.model);
  }
  if (f.q) {
    w.push(`c.id LIKE ? ESCAPE '\\'`);
    p.push(`${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

/** Only the CTEs a query needs: materialising the turn aggregate for a query that never reads it is the slow part. */
function scopeFor(f: CallFilters, opts: { turns?: boolean; sel?: boolean; base?: string } = {}): { with: string; from: string } {
  const sel = opts.sel === true || !!(f.provider || f.model);
  const tt = opts.turns === true || f.status === 'ai_error';
  const ctes = [sel ? SEL_CTE : null, tt ? TURN_CTE : null].filter(Boolean).join(', ');
  return {
    with: ctes ? `WITH ${ctes}` : '',
    from: `${opts.base ?? 'FROM calls c'}${sel ? ' LEFT JOIN sel ON sel.call_id = c.id' : ''}${tt ? ' LEFT JOIN tt ON tt.call_id = c.id' : ''}`,
  };
}

const clampPage = (page: Page): { limit: number; offset: number; page: number; pageSize: number } => {
  const pageSize = Math.min(100, Math.max(1, Math.floor(page.pageSize ?? 25)));
  const n = Math.max(1, Math.floor(page.page ?? 1));
  return { limit: pageSize, offset: (n - 1) * pageSize, page: n, pageSize };
};

export class ObservabilityStore {
  private failures = 0;
  private readonly now: () => Date;
  private readonly mono: () => number;

  constructor(
    private readonly db: DatabaseType,
    private readonly options: ObservabilityOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.mono = options.mono ?? (() => performance.now());
  }

  /** How many telemetry writes failed since start (they were dropped, never retried into the call path). */
  get failedWrites(): number {
    return this.failures;
  }

  /** Record one event. Never throws and never blocks on anything but a single local INSERT. */
  record(event: TraceEventInput): void {
    try {
      const data: Record<string, unknown> = { ...(event.data ?? {}) };
      if (this.options.storeText && event.text) {
        data.text = redactSecrets(event.text).slice(0, 1000);
        if (event.role) data.role = event.role;
      }
      timeSyncIo('telemetry database write', () =>
        this.db
          .prepare(
            `INSERT INTO call_trace_events (call_id, turn_id, at, mono_ms, stage, status, latency_ms, detail, data, provider, model, http_status, attempt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            event.callId,
            event.turnId,
            this.now().toISOString(),
            this.mono(),
            event.stage,
            event.status,
            event.latencyMs ?? null,
            event.detail ? redactSecrets(event.detail).slice(0, MAX_DETAIL) : null,
            cleanData(data),
            event.provider ?? null,
            event.model ?? null,
            event.httpStatus ?? null,
            event.attempt ?? null
          )
      );
    } catch (error) {
      this.failures++;
      try {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // ignore
      }
    }
  }

  // ---- retention ---------------------------------------------------------------------------------------

  /**
   * Remove old trace events, and only trace events: never a call, a turn-log row or a call-state event. Events of a call
   * that is still in progress are kept. Work is done in small chunks with a yield between them, and stops at once when
   * `busy()` says a call is live, so pruning can never hold up the call pipeline. Safe to run repeatedly.
   */
  async prune(options: { retentionDays: number; maxEvents: number; busy?: () => boolean; chunk?: number }): Promise<{ deleted: number; stoppedEarly: boolean }> {
    const chunk = Math.max(100, Math.floor(options.chunk ?? 2000));
    let deleted = 0;
    const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      if (options.retentionDays > 0) {
        const cutoff = new Date(this.now().getTime() - options.retentionDays * 86_400_000).toISOString();
        const del = this.db.prepare(
          `DELETE FROM call_trace_events WHERE id IN (
             SELECT id FROM call_trace_events WHERE at < ?
               AND call_id NOT IN (SELECT id FROM calls WHERE outcome IS NULL AND state != 'IDLE')
             ORDER BY id LIMIT ?)`
        );
        for (;;) {
          if (options.busy?.()) return { deleted, stoppedEarly: true };
          const n = del.run(cutoff, chunk).changes;
          deleted += n;
          if (n < chunk) break;
          await yieldNow();
        }
      }
      if (options.maxEvents > 0) {
        const trim = this.db.prepare('DELETE FROM call_trace_events WHERE id IN (SELECT id FROM call_trace_events ORDER BY id LIMIT ?)');
        for (;;) {
          const total = (this.db.prepare('SELECT COUNT(*) AS n FROM call_trace_events').get() as { n: number }).n;
          const excess = total - options.maxEvents;
          if (excess <= 0) break;
          if (options.busy?.()) return { deleted, stoppedEarly: true };
          deleted += trim.run(Math.min(chunk, excess)).changes;
          await yieldNow();
        }
      }
    } catch (error) {
      this.failures++;
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    return { deleted, stoppedEarly: false };
  }

  stats(): { events: number; oldestAt: string | null; failedWrites: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM call_trace_events').get() as { n: number; oldest: string | null };
    return { events: r.n, oldestAt: r.oldest, failedWrites: this.failures };
  }

  // ---- reads -------------------------------------------------------------------------------------------

  listCalls(filters: CallFilters, page: Page = {}) {
    const { limit, offset, page: n, pageSize } = clampPage(page);
    const { sql, params } = whereFor(filters);
    const count = scopeFor(filters);
    const full = scopeFor(filters, { turns: true, sel: true });
    const total = (this.db.prepare(`${count.with} SELECT COUNT(*) AS n ${count.from} ${sql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(
        `${full.with}
         SELECT c.id, c.direction, c.remote_number, c.state, c.started_at, c.answered_at, c.ended_at, c.duration_seconds, c.outcome,
                c.termination_reason, c.is_simulated, c.metadata, sel.data AS sel, tt.turns, tt.failed_turns, tt.cancelled_turns,
                tt.e2e_avg, tt.stt_avg, tt.tft_avg, tt.llm_avg, tt.tts_avg
         ${full.from} ${sql} ORDER BY c.started_at DESC, c.id LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as CallRow[];
    const r1 = (x: number | null) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
    return {
      page: n,
      pageSize,
      total,
      items: rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        startedAt: r.started_at,
        answeredAt: r.answered_at,
        endedAt: r.ended_at,
        durationSeconds: r.duration_seconds,
        status: r.outcome ?? (r.state === 'IDLE' ? 'unknown' : 'in_progress'),
        terminationReason: r.termination_reason,
        simulated: r.is_simulated === 1,
        campaign: parseCampaign(r.metadata),
        selection: parseSelection(r.sel),
        turns: r.turns ?? 0,
        failedTurns: r.failed_turns ?? 0,
        cancelledTurns: r.cancelled_turns ?? 0,
        // Averages over the turns that have the measurement; null when none do.
        latency: { endToEndMs: r1(r.e2e_avg), sttMs: r1(r.stt_avg), tftMs: r1(r.tft_avg), llmTotalMs: r1(r.llm_avg), ttsFirstMs: r1(r.tts_avg) },
      })),
    };
  }

  /** One call with its turns (each carrying its events) and the call-level events. Null when the call is unknown. */
  callDetail(callId: string) {
    const call = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(callId) as
      | { id: string; direction: string; state: string; started_at: string; answered_at: string | null; ended_at: string | null; duration_seconds: number; outcome: string | null; termination_reason: string | null; is_simulated: number; metadata: string | null }
      | undefined;
    if (!call) return null;
    const events = this.eventsFor(callId);
    const sel = events.find((e) => e.stage === 'call' && e.data && typeof e.data.sttKey === 'string');
    const turns = this.db.prepare('SELECT * FROM ai_turns WHERE call_id = ? ORDER BY id').all(callId) as Array<Record<string, any>>;
    const byTurn = new Map<string, StoredTraceEvent[]>();
    const callLevel: StoredTraceEvent[] = [];
    for (const e of events) {
      if (e.turnId === null) callLevel.push(e);
      else (byTurn.get(e.turnId) ?? byTurn.set(e.turnId, []).get(e.turnId)!).push(e);
    }
    const lifecycle = (
      this.db.prepare('SELECT event_type, previous_state, current_state, timestamp FROM call_events WHERE call_id = ? ORDER BY timestamp, id').all(callId) as Array<{
        event_type: string;
        previous_state: string | null;
        current_state: string | null;
        timestamp: string;
      }>
    ).map((l) => ({ type: l.event_type, from: l.previous_state, to: l.current_state, at: l.timestamp }));

    const seenRefs = new Set<string>();
    const turnItems = turns.map((t, i) => {
      const ref: string = t.turn_ref ?? `${callId}:t${i + 1}`;
      seenRefs.add(ref);
      const evs = byTurn.get(ref) ?? [];
      const failing = evs.find((e) => e.status === 'failed' && e.stage !== 'provider-attempt') ?? null;
      return {
        turnId: ref,
        index: i + 1,
        at: t.at as string,
        status: t.status as string,
        reason: (t.reason ?? null) as string | null,
        cancelSource: (t.cancel_source ?? null) as string | null,
        // Stored only while the operator has transcripts switched on; null otherwise (never reconstructed or guessed).
        transcript: (t.transcript ?? null) as string | null,
        reply: (t.reply ?? null) as string | null,
        failingStage: failing?.stage ?? (t.status === 'failed' ? (t.reason as string | null) : null),
        failureDetail: failing?.detail ?? null,
        latency: {
          utteranceMs: t.utterance_ms ?? null,
          endpointMs: t.endpoint_ms ?? null,
          sttMs: t.stt_ms ?? null,
          sttWaitedMs: t.stt_waited_ms ?? null,
          tftMs: t.tft_available === 0 ? null : (t.llm_first_token_ms ?? null),
          tftAvailable: t.tft_available === null || t.tft_available === undefined ? null : t.tft_available === 1,
          sttMode: (t.stt_mode ?? null) as string | null,
          llmTotalMs: t.llm_total_ms ?? null,
          ttsFirstMs: t.tts_first_ms ?? null,
          ttsTotalMs: t.tts_total_ms ?? null,
          firstAudioMs: t.first_audio_ms ?? null,
          // A cancelled or failed turn has no end-to-end figure to quote as a response time.
          endToEndMs: t.status === 'completed' ? (t.perceived_first_audio_ms ?? null) : null,
          playMs: t.play_ms ?? null,
          maxLateMs: t.max_late_ms ?? null,
          lateFrames: t.late_frames ?? null,
          riskFrames: t.risk_frames ?? null,
          loopLagMaxMs: t.loop_lag_max_ms ?? null,
          turnMs: t.total_ms ?? null,
        },
        retries: evs.filter((e) => e.stage === 'provider-attempt' && e.data?.willRetry === true).length,
        events: evs,
      };
    });
    // Events of a turn that never reached the turn log (a crash mid-turn) are still shown, as an unfinished turn.
    for (const [ref, evs] of byTurn) {
      if (seenRefs.has(ref)) continue;
      const failing = evs.find((e) => e.status === 'failed' && e.stage !== 'provider-attempt') ?? null;
      turnItems.push({
        turnId: ref,
        index: turnItems.length + 1,
        at: evs[0].at,
        status: 'unfinished',
        reason: null,
        cancelSource: null,
        transcript: null,
        reply: null,
        failingStage: failing?.stage ?? null,
        failureDetail: failing?.detail ?? null,
        latency: { utteranceMs: null, endpointMs: null, sttMs: null, sttWaitedMs: null, tftMs: null, tftAvailable: null, sttMode: null, llmTotalMs: null, ttsFirstMs: null, ttsTotalMs: null, firstAudioMs: null, endToEndMs: null, playMs: null, maxLateMs: null, lateFrames: null, riskFrames: null, loopLagMaxMs: null, turnMs: null },
        retries: evs.filter((e) => e.stage === 'provider-attempt' && e.data?.willRetry === true).length,
        events: evs,
      } as (typeof turnItems)[number]);
    }
    const firstCapture = events.find((e) => e.stage === 'pcm-capture' && e.status === 'ok') ?? null;
    return {
      call: {
        id: call.id,
        direction: call.direction,
        startedAt: call.started_at,
        answeredAt: call.answered_at,
        endedAt: call.ended_at,
        durationSeconds: call.duration_seconds,
        status: call.outcome ?? (call.state === 'IDLE' ? 'unknown' : 'in_progress'),
        terminationReason: call.termination_reason,
        simulated: call.is_simulated === 1,
        campaign: parseCampaign(call.metadata),
      },
      // Every failed stage and failed provider request of the call in one list, oldest first.
      errors: events
        .filter((e) => e.status === 'failed')
        .slice(0, 100)
        .map((e) => ({ at: e.at, turnId: e.turnId, stage: e.stage, detail: e.detail, provider: e.provider, httpStatus: e.httpStatus, attempt: e.attempt })),
      totals: {
        turns: turnItems.length,
        failedTurns: turnItems.filter((t) => t.status === 'failed').length,
        cancelledTurns: turnItems.filter((t) => t.status === 'cancelled').length,
        events: events.length,
      },
      selection: sel ? parseSelection(JSON.stringify(sel.data)) : ({ stt: null, llm: null, tts: null } as CallSelection),
      // Null when the call never delivered audio to the AI (or the AI was not attached).
      firstAudioReceivedAt: firstCapture?.at ?? null,
      turns: turnItems,
      callEvents: callLevel,
      lifecycle,
    };
  }

  eventsFor(callId: string, turnId?: string): StoredTraceEvent[] {
    const rows = (turnId
      ? this.db.prepare('SELECT * FROM call_trace_events WHERE call_id = ? AND turn_id = ? ORDER BY id').all(callId, turnId)
      : this.db.prepare('SELECT * FROM call_trace_events WHERE call_id = ? ORDER BY id').all(callId)) as Array<Record<string, any>>;
    return rows.map(mapEvent);
  }

  /** Aggregate latency, outcome and error figures over the calls the filters select. */
  overview(filters: CallFilters) {
    const { sql, params } = whereFor(filters);
    const scope = scopeFor(filters);
    const withTurns = scopeFor(filters, { turns: true });
    const outcomes = this.db
      .prepare(`${scope.with} SELECT COALESCE(c.outcome, 'in_progress') AS o, COUNT(*) AS n ${scope.from} ${sql} GROUP BY o`)
      .all(...params) as Array<{ o: string; n: number }>;
    const aiErrorCalls = (
      this.db.prepare(`${withTurns.with} SELECT COUNT(*) AS n ${withTurns.from} ${sql ? `${sql} AND` : 'WHERE'} COALESCE(tt.failed_turns, 0) > 0`).get(...params) as { n: number }
    ).n;
    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const r of outcomes) {
      byOutcome[r.o] = r.n;
      total += r.n;
    }
    // Only the columns the figures use (never the text columns), and no call filter at all when none was given.
    const cols = 'status, mock, stt_key, llm_key, tts_key, stt_ms, stt_mode, llm_first_token_ms, tft_available, llm_total_ms, tts_first_ms, tts_total_ms, total_ms, perceived_first_audio_ms, first_audio_ms, max_late_ms, loop_lag_max_ms, late_frames, risk_frames, cancel_source';
    const turns = (sql
      ? this.db.prepare(`${scope.with} SELECT ${cols} FROM ai_turns WHERE call_id IN (SELECT c.id ${scope.from} ${sql}) ORDER BY id LIMIT 50000`).all(...params)
      : this.db.prepare(`SELECT ${cols} FROM ai_turns ORDER BY id LIMIT 50000`).all()) as Array<Record<string, any>>;
    const completed = turns.filter((t) => t.status === 'completed').length;
    const failed = turns.filter((t) => t.status === 'failed').length;
    const cancelled = turns.filter((t) => t.status === 'cancelled').length;
    const answered = completed + failed + cancelled;
    const group = (col: 'stt_key' | 'llm_key' | 'tts_key', ms: string) => {
      const m = new Map<string, Array<Record<string, any>>>();
      for (const t of turns) if (t[col]) (m.get(t[col]) ?? m.set(t[col], []).get(t[col])!).push(t);
      return [...m.entries()]
        .map(([key, list]) => ({
          key,
          turns: list.length,
          failedTurns: list.filter((t) => t.status === 'failed').length,
          latencyMs: stat(list.map((t) => t[ms])),
        }))
        .sort((a, b) => b.turns - a.turns);
    };
    return {
      calls: {
        total,
        successful: byOutcome.completed ?? 0,
        failed: byOutcome.failed ?? 0,
        withAiErrors: aiErrorCalls,
        byOutcome,
        failureRate: total === 0 ? null : Math.round(((byOutcome.failed ?? 0) / total) * 1000) / 10,
      },
      turns: { total: turns.length, completed, failed, cancelled, errorRatePercent: answered === 0 ? null : Math.round((failed / answered) * 1000) / 10 },
      latencyMs: {
        // What the caller waits: end of their speech to the first reply audio written to the audio port (not heard).
        // Completed turns only: a turn that was cancelled or failed is never counted as a fast response.
        endToEnd: stat(turns.map((t) => (t.status === 'completed' ? t.perceived_first_audio_ms : null))),
        // Time to first token only counts turns whose model streams; others are null, not a made-up number.
        tft: stat(turns.map((t) => (t.tft_available === 0 ? null : t.llm_first_token_ms))),
        stt: stat(turns.map((t) => t.stt_ms)),
        llmTotal: stat(turns.map((t) => t.llm_total_ms)),
        ttsFirstAudio: stat(turns.map((t) => t.tts_first_ms)),
        ttsTotal: stat(turns.map((t) => t.tts_total_ms)),
        turn: stat(turns.map((t) => t.total_ms)),
      },
      providers: { stt: group('stt_key', 'stt_ms'), llm: group('llm_key', 'llm_first_token_ms'), tts: group('tts_key', 'tts_first_ms') },
      cancellations: {
        total: cancelled,
        // Cancelled after the first audio was already written (the caller heard part of a reply).
        afterAudioStarted: turns.filter((t) => t.status === 'cancelled' && t.first_audio_ms !== null).length,
        bySource: turns.reduce<Record<string, number>>((acc, t) => {
          if (t.status === 'cancelled') acc[t.cancel_source ?? 'unknown'] = (acc[t.cancel_source ?? 'unknown'] ?? 0) + 1;
          return acc;
        }, {}),
      },
      playback: {
        // Per turn that played audio: worst frame lateness, and how many frames went out past the write-ahead.
        maxLateMs: stat(turns.map((t) => t.max_late_ms)),
        loopLagMs: stat(turns.map((t) => t.loop_lag_max_ms)),
        turnsWithLateFrames: turns.filter((t) => (t.late_frames ?? 0) > 0).length,
        turnsWithGapRisk: turns.filter((t) => (t.risk_frames ?? 0) > 0).length,
      },
      // STT time means different things per mode; counts let the reader see how mixed the average is.
      sttModes: turns.reduce<Record<string, number>>((acc, t) => {
        if (t.stt_ms !== null) acc[t.stt_mode ?? 'unknown'] = (acc[t.stt_mode ?? 'unknown'] ?? 0) + 1;
        return acc;
      }, {}),
      simulatedTurns: turns.filter((t) => t.mock === 1).length,
    };
  }

  /** Failed stages and failed/retried provider attempts, newest first. */
  errors(filters: CallFilters, page: Page = {}) {
    const { limit, offset, page: n, pageSize } = clampPage(page);
    const { sql, params } = whereFor(filters);
    const scope = scopeFor(filters, { base: 'FROM call_trace_events e JOIN calls c ON c.id = e.call_id' });
    const cond = `(e.status = 'failed' OR (e.stage = 'provider-attempt' AND e.status != 'ok'))`;
    const where = sql ? `${sql} AND ${cond}` : `WHERE ${cond}`;
    const total = (this.db.prepare(`${scope.with} SELECT COUNT(*) AS n ${scope.from} ${where}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`${scope.with} SELECT e.* ${scope.from} ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, any>>;
    return { page: n, pageSize, total, items: rows.map(mapEvent) };
  }
}

function mapEvent(r: Record<string, any>): StoredTraceEvent {
  let data: Record<string, unknown> | null = null;
  if (r.data) {
    try {
      data = JSON.parse(r.data) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  return {
    id: r.id,
    callId: r.call_id,
    turnId: r.turn_id,
    at: r.at,
    monoMs: r.mono_ms,
    stage: r.stage,
    status: r.status,
    latencyMs: r.latency_ms,
    detail: r.detail,
    data,
    provider: r.provider,
    model: r.model,
    httpStatus: r.http_status,
    attempt: r.attempt,
  };
}
