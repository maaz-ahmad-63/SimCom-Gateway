/**
 * Health, alerts, network diagnostics and backups, as the gateway reports them, and the small pure helpers the alert centre and the
 * System health page share. Customer-facing text comes from the gateway (title, message, action); raw technical detail is only fetched
 * on request, for the diagnostic view.
 */

export type AlertSeverity = 'critical' | 'error' | 'warning' | 'info';
export type HealthStatus = 'ok' | 'warning' | 'error' | 'critical' | 'unknown' | 'not_applicable';

export interface OpsAlert {
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

export interface ComponentHealth {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  observedAt: string;
  facts?: Record<string, unknown>;
}

export interface OpsHealth {
  overall: Exclude<HealthStatus, 'not_applicable'>;
  generatedAt: string;
  components: ComponentHealth[];
  alerts: number;
}

export interface Registration {
  stat: number | null;
  registered: boolean;
  text: string;
  raw: string | null;
}

export interface NetworkReading {
  takenAt: string;
  source: 'hardware' | 'simulated' | 'skipped';
  skippedBecause: string | null;
  sim: { state: string; raw: string | null };
  signal: { rssi: number | null; ber: number | null; dbm: number | null; level: string; text: string; raw: string | null };
  registration: { cs: Registration; eps: Registration; ps: Registration };
  operator: string | null;
  verdict: { code: string; severity: 'ok' | 'info' | 'warning' | 'error' | 'critical'; title: string; explanation: string; action: string; uncertain: boolean };
}

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
  kind: 'automatic' | 'manual' | 'pre-restore' | 'other';
}

export const SEVERITY_LABEL: Record<AlertSeverity, string> = { critical: 'Critical', error: 'Error', warning: 'Warning', info: 'Information' };
export const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 3, error: 2, warning: 1, info: 0 };

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export const severityTone = (s: AlertSeverity): Tone => (s === 'critical' || s === 'error' ? 'bad' : s === 'warning' ? 'warn' : 'neutral');

export function statusTone(s: HealthStatus): Tone {
  if (s === 'ok') return 'good';
  if (s === 'warning') return 'warn';
  if (s === 'error' || s === 'critical') return 'bad';
  return 'neutral';
}

export const STATUS_LABEL: Record<HealthStatus, string> = { ok: 'OK', warning: 'Warning', error: 'Problem', critical: 'Critical', unknown: 'Unknown', not_applicable: 'Not applicable' };

export function sortAlerts(alerts: OpsAlert[]): OpsAlert[] {
  return [...alerts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.lastAt.localeCompare(a.lastAt));
}

/** What the banner has to say, from the active alerts. A critical alert stays in the banner until it is acknowledged or resolved. */
export function bannerAlerts(alerts: OpsAlert[]): OpsAlert[] {
  return sortAlerts(alerts).filter((a) => a.severity === 'critical' && a.acknowledgedAt === null);
}

export function alertSummary(alerts: OpsAlert[]): string {
  if (alerts.length === 0) return 'No problems';
  const count = (s: AlertSeverity) => alerts.filter((a) => a.severity === s).length;
  const parts = (['critical', 'error', 'warning', 'info'] as AlertSeverity[]).filter((s) => count(s) > 0).map((s) => `${count(s)} ${SEVERITY_LABEL[s].toLowerCase()}`);
  return parts.join(', ');
}

/** "3 minutes ago". An unknown or future time says so rather than showing a number. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.round((now - t) / 1000);
  if (s < -5) return 'in the future';
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export type LinkState = 'live' | 'reconnecting' | 'lost';

/**
 * Whether this dashboard can trust what it shows. The gateway being unreachable is one of the things a customer must notice, so it is
 * judged from how long ago the last answer arrived, not from a single failed request.
 */
export function linkState(input: { lastSuccessAt: number | null; failures: number; now?: number; staleAfterMs?: number }): { state: LinkState; stale: boolean; message: string } {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? 30_000;
  if (input.lastSuccessAt === null) {
    return input.failures >= 2
      ? { state: 'lost', stale: true, message: 'The dashboard cannot reach the gateway.' }
      : { state: 'reconnecting', stale: true, message: 'Connecting to the gateway…' };
  }
  const age = now - input.lastSuccessAt;
  if (input.failures === 0) return { state: 'live', stale: age > staleAfter, message: age > staleAfter ? `Information is ${Math.round(age / 1000)} seconds old.` : 'Connected' };
  if (age > staleAfter * 2 || input.failures >= 3) return { state: 'lost', stale: true, message: `Lost contact with the gateway ${timeAgo(new Date(input.lastSuccessAt).toISOString(), now)}. What you see may be out of date.` };
  return { state: 'reconnecting', stale: age > staleAfter, message: 'Reconnecting to the gateway…' };
}

/** Seconds to wait before the next reconnect attempt: starts quick, backs off, never longer than half a minute. */
export function reconnectDelayMs(failures: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, Math.min(failures, 6) - 1));
}

export function registrationLine(r: Registration): string {
  return r.stat === null ? 'No answer' : r.text;
}

export function signalBars(level: string): number {
  return ({ very_weak: 1, weak: 1, fair: 2, good: 3, excellent: 4 } as Record<string, number>)[level] ?? 0;
}

export const COMPONENT_HELP: Record<string, string> = {
  gateway: 'The program that talks to the modem and runs calls.',
  modem: 'The USB modem that places and receives calls.',
  network: 'The SIM card and the mobile network it is registered on.',
  providers: 'The AI services used for speech and conversation.',
  database: 'Where calls, campaigns and settings are stored.',
  storage: 'Disk space for data and call recordings.',
  background: 'Campaigns and call analysis running in the background.',
};
