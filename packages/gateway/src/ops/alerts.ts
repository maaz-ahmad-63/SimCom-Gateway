import type { Database as DatabaseType } from 'better-sqlite3';
import { redactDiagnosticText } from '../core/logger.js';

/**
 * Alerts for the customer: one record per problem, not one per occurrence.
 *
 * Raising an alert whose key is already active updates it (count, last seen, text) instead of adding another, so a problem that keeps
 * happening cannot flood the dashboard. When the problem goes away the same key is resolved, and the record stays in the history.
 * `details` are for the protected diagnostic view only; the customer-facing fields are title, message and action. A critical alert
 * stays active until it is resolved or acknowledged, and cannot be dismissed.
 */

export type AlertSeverity = 'critical' | 'error' | 'warning' | 'info';
export type AlertEventType = 'raised' | 'escalated' | 'resolved';

export interface AlertInput {
  /** Identifies the problem. The same key never has two active alerts. */
  key: string;
  component: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  action?: string;
  /** Technical detail for the diagnostic view; redacted before it is stored. Never shown in the customer-facing text. */
  details?: unknown;
  /** A safe thing the customer can ask for. Only "recheck" exists: it re-reads the state and never reconnects hardware or places a call. */
  retry?: 'recheck' | null;
}

export interface AlertRecord {
  id: number;
  key: string;
  component: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  action: string;
  retry: 'recheck' | null;
  status: 'active' | 'resolved';
  count: number;
  firstAt: string;
  lastAt: string;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  resolvedAt: string | null;
}

const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, error: 2, critical: 3 };
const HISTORY_KEEP = 1000;

export class AlertError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
  }
}

function map(r: Record<string, any>): AlertRecord {
  return {
    id: r.id,
    key: r.key,
    component: r.component,
    severity: r.severity,
    title: r.title,
    message: r.message,
    action: r.action ?? '',
    retry: r.retry ?? null,
    status: r.status,
    count: r.count,
    firstAt: r.first_at,
    lastAt: r.last_at,
    acknowledgedAt: r.acknowledged_at,
    dismissedAt: r.dismissed_at,
    resolvedAt: r.resolved_at,
  };
}

export class AlertStore {
  constructor(
    private readonly db: DatabaseType,
    private readonly now: () => Date = () => new Date(),
    private readonly onEvent?: (type: AlertEventType, alert: AlertRecord) => void
  ) {}

  private emit(type: AlertEventType, alert: AlertRecord): void {
    try {
      this.onEvent?.(type, alert);
    } catch {
      /* a listener must never break alerting */
    }
  }

  private byKey(key: string): AlertRecord | null {
    const r = this.db.prepare("SELECT * FROM ops_alerts WHERE key = ? AND status = 'active'").get(key) as Record<string, any> | undefined;
    return r ? map(r) : null;
  }

  get(id: number): AlertRecord | null {
    const r = this.db.prepare('SELECT * FROM ops_alerts WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? map(r) : null;
  }

  raise(input: AlertInput): AlertRecord {
    const at = this.now().toISOString();
    const details = input.details === undefined ? null : redactDiagnosticText(JSON.stringify(input.details)).slice(0, 8000);
    const existing = this.byKey(input.key);
    if (existing) {
      const escalated = RANK[input.severity] > RANK[existing.severity];
      this.db
        .prepare(
          `UPDATE ops_alerts SET count = count + 1, last_at = ?, severity = ?, title = ?, message = ?, action = ?, details = COALESCE(?, details), retry = ?,
             acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END, dismissed_at = CASE WHEN ? THEN NULL ELSE dismissed_at END WHERE id = ?`
        )
        .run(at, escalated ? input.severity : existing.severity, input.title, input.message, input.action ?? '', details, input.retry ?? null, escalated ? 1 : 0, escalated ? 1 : 0, existing.id);
      const updated = this.get(existing.id)!;
      if (escalated) this.emit('escalated', updated);
      return updated;
    }
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO ops_alerts (key, component, severity, title, message, action, details, retry, status, count, first_at, last_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`
        )
        .run(input.key, input.component, input.severity, input.title, input.message, input.action ?? '', details, input.retry ?? null, at, at).lastInsertRowid
    );
    this.prune();
    const created = this.get(id)!;
    this.emit('raised', created);
    return created;
  }

  /** The problem is gone. Returns the resolved record, or null if nothing was active under this key. */
  resolve(key: string): AlertRecord | null {
    const existing = this.byKey(key);
    if (!existing) return null;
    this.db.prepare("UPDATE ops_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?").run(this.now().toISOString(), existing.id);
    const resolved = this.get(existing.id)!;
    this.emit('resolved', resolved);
    return resolved;
  }

  acknowledge(id: number): AlertRecord {
    const a = this.get(id);
    if (!a) throw new AlertError('Alert not found', 'NOT_FOUND', 404);
    this.db.prepare('UPDATE ops_alerts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?').run(this.now().toISOString(), id);
    return this.get(id)!;
  }

  /** Hide a notice. A critical alert that is still active cannot be dismissed: it is acknowledged, and leaves when the problem does. */
  dismiss(id: number): AlertRecord {
    const a = this.get(id);
    if (!a) throw new AlertError('Alert not found', 'NOT_FOUND', 404);
    if (a.severity === 'critical' && a.status === 'active') throw new AlertError('A critical alert cannot be dismissed while the problem remains. Acknowledge it instead.', 'CANNOT_DISMISS', 409);
    this.db.prepare('UPDATE ops_alerts SET dismissed_at = COALESCE(dismissed_at, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?').run(this.now().toISOString(), this.now().toISOString(), id);
    return this.get(id)!;
  }

  /** What is wrong now, worst first. Dismissed notices are left out. */
  active(): AlertRecord[] {
    const rows = this.db.prepare("SELECT * FROM ops_alerts WHERE status = 'active' AND dismissed_at IS NULL").all() as Array<Record<string, any>>;
    return rows.map(map).sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.lastAt.localeCompare(a.lastAt));
  }

  history(page = 1, pageSize = 50): { page: number; pageSize: number; total: number; items: AlertRecord[] } {
    const size = Math.min(200, Math.max(1, Math.floor(pageSize)));
    const p = Math.max(1, Math.floor(page));
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM ops_alerts').get() as { n: number }).n;
    const rows = this.db.prepare('SELECT * FROM ops_alerts ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?').all(size, (p - 1) * size) as Array<Record<string, any>>;
    return { page: p, pageSize: size, total, items: rows.map(map) };
  }

  /** The technical detail of one alert, for the protected diagnostic view only. */
  details(id: number): { alert: AlertRecord; details: unknown } | null {
    const r = this.db.prepare('SELECT * FROM ops_alerts WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!r) return null;
    let details: unknown = null;
    try {
      details = r.details ? JSON.parse(r.details) : null;
    } catch {
      details = r.details;
    }
    return { alert: map(r), details };
  }

  private prune(): void {
    this.db
      .prepare(`DELETE FROM ops_alerts WHERE status = 'resolved' AND id NOT IN (SELECT id FROM ops_alerts WHERE status = 'resolved' ORDER BY id DESC LIMIT ?)`)
      .run(HISTORY_KEEP);
  }
}
