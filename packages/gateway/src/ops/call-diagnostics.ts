import type { Database as DatabaseType } from 'better-sqlite3';
import { redactDiagnosticText } from '../core/logger.js';
import type { NetworkSnapshot } from './network.js';

/**
 * Why a call ended the way it did, saved with the call.
 *
 * A modem reports a handful of call results, and several different causes look the same: BUSY can be a genuinely busy line, a decline, a
 * carrier rejection or congestion. This module records what was actually reported (the modem result, the network cause from AT+CEER when
 * the modem gave one, the last signal and registration reading) and explains it in plain words WITHOUT claiming more than that evidence
 * supports. When the evidence is not enough, the explanation says so and `certainty` is "uncertain".
 */

export type Certainty = 'certain' | 'likely' | 'uncertain';
export type RetryHint = 'not_applicable' | 'reasonable' | 'not_recommended' | 'unknown';

export interface CeerReading {
  raw: string | null;
  code: number | null;
  text: string | null;
}

export interface CallFacts {
  callId: string;
  /** The call's final status as the gateway records it: completed, busy, no_answer, failed, rejected, missed. */
  finalStatus: string;
  /** What ended the call, as the call manager recorded it (the modem's own wording where there is one). */
  terminationReason: string | null;
  answered: boolean;
  ceer: CeerReading | null;
  network: NetworkSnapshot | null;
  /** How old the network reading was when the call ended. */
  networkAgeMs: number | null;
}

export interface CallDiagnostic {
  callId: string;
  recordedAt: string;
  finalStatus: string;
  modemResult: string | null;
  causeCode: number | null;
  causeText: string | null;
  signal: { rssi: number | null; dbm: number | null; level: string; takenAt: string } | null;
  sim: string | null;
  registration: string | null;
  networkVerdict: string | null;
  failureStage: 'none' | 'setup' | 'ringing' | 'during_call' | 'unknown';
  explanation: string;
  certainty: Certainty;
  retryHint: RetryHint;
}

/** Common 3GPP/GSM call-clearing causes (3GPP TS 24.008 annex H). Only the ones a person can act on or understand. */
const CAUSES: Record<number, string> = {
  1: 'the number does not exist (unallocated)',
  3: 'no route to the destination',
  16: 'the call ended normally',
  17: 'the destination was busy',
  18: 'the destination did not respond',
  19: 'the destination rang but nobody answered',
  21: 'the call was rejected',
  22: 'the number has changed',
  27: 'the destination is out of service',
  28: 'the number is not valid',
  31: 'the call ended (no specific reason given)',
  34: 'the network had no free circuit (congestion)',
  38: 'the network is out of order',
  41: 'a temporary network failure',
  42: 'the network is congested',
  50: 'the SIM is not subscribed to this service',
  88: 'the destination is not compatible with this call',
  102: 'the network timed out',
};

export function parseCeer(raw: string | null): CeerReading {
  if (!raw) return { raw, code: null, text: null };
  const line = /\+CEER:\s*(.+)/i.exec(raw)?.[1]?.trim() ?? null;
  if (!line) return { raw, code: null, text: null };
  const num = /(?:cause|#)?\s*(\d{1,3})\b/i.exec(line);
  const code = num ? Number(num[1]) : null;
  return { raw, code, text: line.slice(0, 200) };
}

const BUSY_TEXT = /user busy|busy/i;
const REJECT_TEXT = /reject|declin|not allowed|barred/i;

export function explainCall(f: CallFacts): Pick<CallDiagnostic, 'failureStage' | 'explanation' | 'certainty' | 'retryHint'> {
  const reason = f.terminationReason ?? '';
  if (f.finalStatus === 'completed') {
    return { failureStage: 'none', explanation: 'The call connected and ended normally.', certainty: 'certain', retryHint: 'not_applicable' };
  }
  // The registration and signal readings are only evidence if they are recent.
  const fresh = f.network && f.networkAgeMs !== null && f.networkAgeMs <= 5 * 60_000 ? f.network : null;
  const v = fresh?.verdict.code;
  const notRegistered = v === 'sim_not_ready' || v === 'no_network' || v === 'registration_denied' || v === 'searching';
  const cause = f.ceer?.code !== null && f.ceer?.code !== undefined ? CAUSES[f.ceer.code] : undefined;
  const ceerText = f.ceer?.text ?? '';

  if (/disconnect|port (closed|not open)|serial|modem (is )?(not|unavailable)/i.test(reason) && f.finalStatus === 'failed') {
    return { failureStage: 'setup', explanation: 'The modem disconnected while the call was being set up.', certainty: 'likely', retryHint: 'reasonable' };
  }

  if (f.finalStatus === 'failed') {
    if (notRegistered) {
      return { failureStage: 'setup', explanation: `The call could not be placed because the modem was not registered on the mobile network (${fresh!.verdict.title.toLowerCase()}).`, certainty: 'likely', retryHint: 'not_recommended' };
    }
    if (/timeout|timed out/i.test(reason)) return { failureStage: 'setup', explanation: 'The call attempt timed out before the modem reported a result.', certainty: 'likely', retryHint: 'reasonable' };
    return { failureStage: 'setup', explanation: `The call could not be placed${reason ? ` (${redactDiagnosticText(reason).slice(0, 120)})` : ''}. The modem did not report a more specific cause.`, certainty: 'uncertain', retryHint: 'unknown' };
  }

  if (f.finalStatus === 'busy' || BUSY_TEXT.test(reason) || f.ceer?.code === 17 || BUSY_TEXT.test(ceerText)) {
    if (notRegistered) {
      return { failureStage: 'setup', explanation: `The modem returned a busy result, but it was not registered on the mobile network at the time (${fresh!.verdict.title.toLowerCase()}). The line may not have been busy at all.`, certainty: 'uncertain', retryHint: 'not_recommended' };
    }
    if (f.ceer?.code === 17 || BUSY_TEXT.test(ceerText)) {
      return { failureStage: 'ringing', explanation: 'The network reported that the destination was busy.', certainty: 'certain', retryHint: 'reasonable' };
    }
    if (f.ceer?.code !== null && f.ceer?.code !== undefined && cause) {
      return { failureStage: 'ringing', explanation: `The modem returned a busy result, but the network said: ${cause}.`, certainty: 'likely', retryHint: f.ceer.code === 21 || f.ceer.code === 1 || f.ceer.code === 28 ? 'not_recommended' : 'unknown' };
    }
    const weak = fresh && (fresh.signal.level === 'weak' || fresh.signal.level === 'very_weak');
    return {
      failureStage: 'ringing',
      explanation: `The destination rejected the call or returned a busy response. The modem and network did not say which: a busy line, a declined call and a carrier rejection all look the same here${weak ? '. The signal was also weak, which can make calls fail' : ''}.`,
      certainty: 'uncertain',
      retryHint: 'unknown',
    };
  }

  if (f.finalStatus === 'no_answer' || f.finalStatus === 'missed') {
    if (/dial timeout|did not answer|no answer/i.test(reason) || f.ceer?.code === 19 || f.ceer?.code === 18) {
      return { failureStage: 'ringing', explanation: 'The call rang but nobody answered before it timed out.', certainty: 'likely', retryHint: 'reasonable' };
    }
    return { failureStage: 'ringing', explanation: 'The call ended before it was answered. The modem cannot tell a declined call from an unreachable number or a network drop.', certainty: 'uncertain', retryHint: 'unknown' };
  }

  if (f.finalStatus === 'rejected' || f.finalStatus === 'busy_rejected' || REJECT_TEXT.test(reason) || f.ceer?.code === 21) {
    return { failureStage: 'ringing', explanation: cause && f.ceer?.code === 21 ? 'The call was rejected by the destination or the network.' : 'The destination rejected the call.', certainty: f.ceer?.code === 21 ? 'certain' : 'likely', retryHint: 'not_recommended' };
  }

  if (cause) return { failureStage: f.answered ? 'during_call' : 'ringing', explanation: `The call ended: ${cause}.`, certainty: 'likely', retryHint: 'unknown' };
  return { failureStage: 'unknown', explanation: 'The call did not complete and the modem did not report why.', certainty: 'uncertain', retryHint: 'unknown' };
}

export class CallDiagnosticsStore {
  constructor(
    private readonly db: DatabaseType,
    private readonly now: () => Date = () => new Date()
  ) {}

  save(f: CallFacts): CallDiagnostic {
    const e = explainCall(f);
    const net = f.network;
    const row: CallDiagnostic = {
      callId: f.callId,
      recordedAt: this.now().toISOString(),
      finalStatus: f.finalStatus,
      modemResult: f.terminationReason ? redactDiagnosticText(f.terminationReason).slice(0, 200) : null,
      causeCode: f.ceer?.code ?? null,
      causeText: f.ceer?.text ?? null,
      signal: net && net.source === 'hardware' ? { rssi: net.signal.rssi, dbm: net.signal.dbm, level: net.signal.level, takenAt: net.takenAt } : null,
      sim: net && net.source === 'hardware' ? net.sim.state : null,
      registration: net && net.source === 'hardware' ? `cs:${net.registration.cs.stat ?? '?'} eps:${net.registration.eps.stat ?? '?'} ps:${net.registration.ps.stat ?? '?'}` : null,
      networkVerdict: net && net.source === 'hardware' ? net.verdict.code : null,
      ...e,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO call_diagnostics (call_id, recorded_at, final_status, modem_result, cause_code, cause_text, signal_rssi, signal_dbm, signal_level, signal_at, sim_state, registration, network_verdict, failure_stage, explanation, certainty, retry_hint, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.callId, row.recordedAt, row.finalStatus, row.modemResult, row.causeCode, row.causeText, row.signal?.rssi ?? null, row.signal?.dbm ?? null, row.signal?.level ?? null, row.signal?.takenAt ?? null, row.sim, row.registration, row.networkVerdict, row.failureStage, row.explanation, row.certainty, row.retryHint, f.ceer?.raw ? redactDiagnosticText(f.ceer.raw).slice(0, 500) : null);
    return row;
  }

  get(callId: string): (CallDiagnostic & { rawCeer: string | null }) | null {
    const r = this.db.prepare('SELECT * FROM call_diagnostics WHERE call_id = ?').get(callId) as Record<string, any> | undefined;
    if (!r) return null;
    return {
      callId: r.call_id,
      recordedAt: r.recorded_at,
      finalStatus: r.final_status,
      modemResult: r.modem_result,
      causeCode: r.cause_code,
      causeText: r.cause_text,
      signal: r.signal_level ? { rssi: r.signal_rssi, dbm: r.signal_dbm, level: r.signal_level, takenAt: r.signal_at } : null,
      sim: r.sim_state,
      registration: r.registration,
      networkVerdict: r.network_verdict,
      failureStage: r.failure_stage,
      explanation: r.explanation,
      certainty: r.certainty,
      retryHint: r.retry_hint,
      rawCeer: r.raw,
    };
  }

  recent(limit = 50): Array<Pick<CallDiagnostic, 'callId' | 'recordedAt' | 'finalStatus' | 'explanation' | 'certainty' | 'networkVerdict'>> {
    const rows = this.db.prepare('SELECT call_id, recorded_at, final_status, explanation, certainty, network_verdict FROM call_diagnostics ORDER BY recorded_at DESC LIMIT ?').all(Math.min(200, limit)) as Array<Record<string, any>>;
    return rows.map((r) => ({ callId: r.call_id, recordedAt: r.recorded_at, finalStatus: r.final_status, explanation: r.explanation, certainty: r.certainty, networkVerdict: r.network_verdict }));
  }
}

export interface RecorderDeps {
  store: CallDiagnosticsStore;
  /** The latest network reading, and the modem adapter's queued command runner. Both are the existing ones. */
  network: () => NetworkSnapshot | null;
  /** Runs AT+CEER through the modem's own queue, or returns null when it must not (a call exists, modem not ready, simulated). */
  readCeer: () => Promise<string | null>;
  now?: () => Date;
  logger?: { warn(message: string): void };
}

/** Called when a call has ended. Saves the diagnosis. Failure to diagnose must never affect call cleanup, so it never throws. */
export async function recordCallEnd(deps: RecorderDeps, session: { id: string; outcome?: string | null; terminationReason?: string | null; answeredAt?: string | null }): Promise<CallDiagnostic | null> {
  try {
    const finalStatus = session.outcome ?? 'unknown';
    let ceer: CeerReading | null = null;
    if (finalStatus !== 'completed') {
      const raw = await deps.readCeer().catch(() => null);
      ceer = raw ? parseCeer(raw) : null;
    }
    const net = deps.network();
    const age = net ? (deps.now?.() ?? new Date()).getTime() - new Date(net.takenAt).getTime() : null;
    return deps.store.save({ callId: session.id, finalStatus, terminationReason: session.terminationReason ?? null, answered: Boolean(session.answeredAt), ceer, network: net, networkAgeMs: age });
  } catch (e) {
    deps.logger?.warn(`Could not save the call diagnosis: ${(e as Error).message}`);
    return null;
  }
}
