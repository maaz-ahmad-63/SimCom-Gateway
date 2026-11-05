import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { AlertInput, AlertSeverity, AlertStore } from './alerts.js';

/**
 * One health picture of the whole product, built from state the gateway already holds.
 *
 * A check reads state; it never sends an AT command, dials, reconnects or restarts anything. Each component reports a status and, when
 * something is wrong, the alert that explains it to the customer. The monitor raises that alert while the problem lasts and resolves it
 * the moment the check passes again, so the alert centre and the health page always agree.
 */

export type HealthStatus = 'ok' | 'warning' | 'error' | 'critical' | 'unknown' | 'not_applicable';

export interface ComponentHealth {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  observedAt: string;
  /** Present when the status is not ok. */
  alert?: Omit<AlertInput, 'component' | 'severity'> & { severity?: AlertSeverity };
  /** Technical facts for the diagnostic view. */
  facts?: Record<string, unknown>;
}

export interface HealthSnapshot {
  overall: Exclude<HealthStatus, 'not_applicable'>;
  generatedAt: string;
  components: ComponentHealth[];
}

export interface HealthCheck {
  id: string;
  label: string;
  run: () => ComponentHealth | Promise<ComponentHealth>;
}

const SEVERITY_OF: Record<Exclude<HealthStatus, 'ok' | 'unknown' | 'not_applicable'>, AlertSeverity> = { warning: 'warning', error: 'error', critical: 'critical' };
const WORST: HealthStatus[] = ['critical', 'error', 'warning', 'unknown', 'ok'];

export class HealthMonitor {
  private latest = new Map<string, ComponentHealth>();
  private raised = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: { alerts: AlertStore; checks: HealthCheck[]; now?: () => Date; logger?: { warn(message: string): void; info(message: string): void } }
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  snapshot(): HealthSnapshot {
    const components = this.deps.checks.map((c) => this.latest.get(c.id) ?? { id: c.id, label: c.label, status: 'unknown' as const, summary: 'Not checked yet', observedAt: this.now().toISOString() });
    const real = components.filter((c) => c.status !== 'not_applicable');
    const overall = (WORST.find((s) => real.some((c) => c.status === s)) ?? 'ok') as HealthSnapshot['overall'];
    return { overall, generatedAt: this.now().toISOString(), components };
  }

  /** Run one check and keep its alert in step with the result. A check that throws is reported as unknown, never as ok. */
  async run(id: string): Promise<ComponentHealth | null> {
    const check = this.deps.checks.find((c) => c.id === id);
    if (!check) return null;
    let result: ComponentHealth;
    try {
      result = await check.run();
    } catch (e) {
      result = { id: check.id, label: check.label, status: 'unknown', summary: 'This check could not be completed', observedAt: this.now().toISOString(), facts: { error: (e as Error).message } };
      this.deps.logger?.warn(`Health check ${id} failed: ${(e as Error).message}`);
    }
    this.latest.set(id, result);
    this.sync(result);
    return result;
  }

  async runAll(): Promise<HealthSnapshot> {
    if (!this.running) {
      this.running = (async () => {
        for (const c of this.deps.checks) await this.run(c.id);
      })().finally(() => (this.running = null));
    }
    await this.running;
    return this.snapshot();
  }

  private sync(result: ComponentHealth): void {
    const keys = this.raised.get(result.id) ?? new Set<string>();
    const nowKeys = new Set<string>();
    if (result.alert && (result.status === 'warning' || result.status === 'error' || result.status === 'critical')) {
      const input = { ...result.alert, component: result.id, severity: result.alert.severity ?? SEVERITY_OF[result.status] };
      this.deps.alerts.raise(input);
      nowKeys.add(input.key);
    }
    // Anything this component raised before and no longer raises is over.
    for (const key of keys) if (!nowKeys.has(key)) this.deps.alerts.resolve(key);
    this.raised.set(result.id, nowKeys);
  }

  start(everyMs = 15_000): void {
    if (this.timer) return;
    void this.runAll().catch(() => undefined);
    this.timer = setInterval(() => void this.runAll().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ---- disk and storage ------------------------------------------------------------------------------------------------------------------

export const DISK_THRESHOLDS = { warningBytes: 2 * 1024 ** 3, errorBytes: 500 * 1024 ** 2, criticalBytes: 100 * 1024 ** 2 };

export function diskStatus(freeBytes: number): { status: 'ok' | 'warning' | 'error' | 'critical' } {
  if (freeBytes < DISK_THRESHOLDS.criticalBytes) return { status: 'critical' };
  if (freeBytes < DISK_THRESHOLDS.errorBytes) return { status: 'error' };
  if (freeBytes < DISK_THRESHOLDS.warningBytes) return { status: 'warning' };
  return { status: 'ok' };
}

export const formatBytes = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.round(n / 1024)} KB`);

export function freeBytesOf(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Whether a small file can be written and removed in the folder. */
export function isWritable(dir: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- the checks ------------------------------------------------------------------------------------------------------------------------

type Clock = () => Date;
const iso = (now: Clock) => now().toISOString();

export function gatewayCheck(deps: { version: string; startedAt: Date; now?: Clock }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  return {
    id: 'gateway',
    label: 'Gateway',
    run: () => ({ id: 'gateway', label: 'Gateway', status: 'ok', summary: `Running (version ${deps.version})`, observedAt: iso(now), facts: { pid: process.pid, uptimeSeconds: Math.round((now().getTime() - deps.startedAt.getTime()) / 1000), version: deps.version } }),
  };
}

export function modemCheck(deps: { state: () => string; simulated: boolean; now?: Clock; graceMs?: number }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  let since: { state: string; at: number } | null = null;
  return {
    id: 'modem',
    label: 'Modem',
    run: () => {
      const state = deps.state();
      if (deps.simulated) return { id: 'modem', label: 'Modem', status: 'not_applicable', summary: 'A simulated modem is in use (no hardware).', observedAt: iso(now), facts: { state } };
      if (!since || since.state !== state) since = { state, at: now().getTime() };
      const held = now().getTime() - since.at;
      const base = { id: 'modem', label: 'Modem', observedAt: iso(now), facts: { state, sinceSeconds: Math.round(held / 1000) } };
      if (state === 'READY') return { ...base, status: 'ok', summary: 'Connected and ready' };
      if (state === 'CONNECTING' || state === 'INITIALIZING') {
        return held < (deps.graceMs ?? 45_000)
          ? { ...base, status: 'warning', summary: 'Connecting to the modem…' }
          : { ...base, status: 'error', summary: 'The modem is taking too long to start', alert: { key: 'modem:stuck', title: 'Modem is not starting', message: 'The modem has been starting for more than a minute without becoming ready.', action: 'Unplug the modem USB cable, wait ten seconds and plug it in again.', retry: 'recheck' } };
      }
      if (state === 'ERROR') return { ...base, status: 'error', summary: 'The modem reported an error', alert: { key: 'modem:error', title: 'Modem error', message: 'The modem connection is in an error state. The gateway keeps trying to reconnect by itself.', action: 'If this does not clear in a minute, unplug the modem USB cable and plug it in again.', retry: 'recheck' } };
      return { ...base, status: 'critical', summary: 'The modem is disconnected', alert: { key: 'modem:disconnected', title: 'Modem disconnected', message: 'The gateway cannot reach the modem, so calls cannot be placed or received.', action: 'Check that the modem is plugged in and powered. The gateway reconnects automatically when it reappears.', retry: 'recheck' } };
    },
  };
}

export function networkCheck(deps: { snapshot: () => import('./network.js').NetworkSnapshot | null; modemReady: () => boolean; simulated: boolean; now?: Clock; staleMs?: number }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  return {
    id: 'network',
    label: 'SIM and mobile network',
    run: () => {
      const base = { id: 'network', label: 'SIM and mobile network', observedAt: iso(now) };
      if (deps.simulated) return { ...base, status: 'not_applicable', summary: 'A simulated modem has no SIM or network.' };
      const s = deps.snapshot();
      if (!deps.modemReady()) return { ...base, status: 'unknown', summary: 'Waiting for the modem' };
      if (!s || s.source !== 'hardware') return { ...base, status: 'unknown', summary: s?.skippedBecause ?? 'Not read yet', facts: { reading: s } };
      const age = now().getTime() - new Date(s.takenAt).getTime();
      const facts = { reading: s, ageSeconds: Math.round(age / 1000) };
      const v = s.verdict;
      if (v.severity === 'ok') return age > (deps.staleMs ?? 10 * 60_000) ? { ...base, status: 'warning', summary: 'The network reading is out of date', facts } : { ...base, status: 'ok', summary: v.explanation, facts };
      if (v.severity === 'info') return { ...base, status: 'ok', summary: v.explanation, facts };
      const status = v.severity === 'critical' ? 'critical' : v.severity === 'error' ? 'error' : 'warning';
      return { ...base, status, summary: v.title, facts, alert: { key: `network:${v.code}`, title: v.title, message: v.explanation, action: v.action, retry: 'recheck', details: { rawReplies: { sim: s.sim.raw, signal: s.signal.raw, cs: s.registration.cs.raw, eps: s.registration.eps.raw, ps: s.registration.ps.raw }, uncertain: v.uncertain } } };
    },
  };
}

interface ProviderFailure {
  provider: string | null;
  http_status: number | null;
  detail: string | null;
  n: number;
}

/** Why a language-model, speech-to-text or text-to-speech provider has been failing, from the call trace of the last 15 minutes. */
export function classifyProviderFailure(f: Pick<ProviderFailure, 'http_status' | 'detail'>): { kind: 'auth' | 'quota' | 'rate_limit' | 'unavailable' | 'timeout' | 'other'; title: string; message: string; action: string; severity: AlertSeverity } {
  const text = (f.detail ?? '').toLowerCase();
  if (f.http_status === 401 || f.http_status === 403 || /invalid api key|unauthori[sz]ed|incorrect api key|authentication/.test(text)) {
    return { kind: 'auth', title: 'AI provider rejected the API key', message: 'The AI provider did not accept the saved API key, so the agent cannot use that service.', action: 'Open Settings, enter a valid key for this provider and save it.', severity: 'error' };
  }
  if (f.http_status === 402 || /quota|insufficient|credit|billing|balance/.test(text)) {
    return { kind: 'quota', title: 'AI provider credit or quota used up', message: 'The AI provider reports that the account has no credit or has reached its quota.', action: 'Add credit or raise the quota in the provider account, or choose another provider.', severity: 'error' };
  }
  if (f.http_status === 429 || /rate.?limit|too many requests/.test(text)) {
    return { kind: 'rate_limit', title: 'AI provider is rate limiting requests', message: 'The AI provider is refusing some requests because too many were sent.', action: 'Wait a few minutes, or choose a plan or provider with a higher limit.', severity: 'warning' };
  }
  if (f.http_status !== null && f.http_status >= 500) {
    return { kind: 'unavailable', title: 'AI provider is having problems', message: 'The AI provider returned a server error. This is usually temporary.', action: 'Wait and try again, or choose another provider if it continues.', severity: 'warning' };
  }
  if (/timeout|timed out|etimedout|econnreset|enotfound|network/.test(text)) {
    return { kind: 'timeout', title: 'AI provider is not responding', message: 'Requests to the AI provider are timing out or failing to connect.', action: 'Check the internet connection. If it is working, the provider may be slow or down.', severity: 'warning' };
  }
  return { kind: 'other', title: 'AI provider errors', message: 'Requests to an AI provider are failing.', action: 'Open Call logs for a failing call to see which step failed.', severity: 'warning' };
}

export function providersCheck(deps: { db: DatabaseType; now?: Clock; windowMinutes?: number; minFailures?: number }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  return {
    id: 'providers',
    label: 'AI providers',
    run: () => {
      const since = new Date(now().getTime() - (deps.windowMinutes ?? 15) * 60_000).toISOString();
      const base = { id: 'providers', label: 'AI providers', observedAt: iso(now) };
      // Per provider: the failures in the window, and whether the newest event from that provider was a success (then it has recovered).
      const rows = deps.db
        .prepare(
          `SELECT provider, http_status, detail, COUNT(*) AS n, MAX(id) AS last_failure_id FROM call_trace_events
           WHERE stage = 'provider-attempt' AND status = 'failed' AND at >= ? AND provider IS NOT NULL GROUP BY provider, http_status ORDER BY n DESC`
        )
        .all(since) as Array<ProviderFailure & { last_failure_id: number }>;
      const problems = rows.filter((r) => {
        const okAfter = deps.db.prepare("SELECT 1 FROM call_trace_events WHERE stage = 'provider-attempt' AND status = 'ok' AND provider = ? AND id > ? LIMIT 1").get(r.provider, r.last_failure_id);
        return !okAfter && r.n >= (deps.minFailures ?? 2);
      });
      if (problems.length === 0) return { ...base, status: 'ok', summary: 'No recent provider errors' };
      const top = problems[0];
      const c = classifyProviderFailure(top);
      const name = top.provider ?? 'an AI provider';
      return {
        ...base,
        status: c.severity === 'error' ? 'error' : 'warning',
        summary: `${c.title} (${name})`,
        facts: { problems },
        alert: { key: `provider:${name}:${c.kind}`, severity: c.severity, title: c.title, message: `${c.message} Provider: ${name}.`, action: c.action, retry: 'recheck', details: { providers: problems } },
      };
    },
  };
}

export function databaseCheck(deps: { db: DatabaseType; expectedSchema: number; now?: Clock; deepEveryMs?: number }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  let deepAt = 0;
  let deepResult: string | null = null;
  return {
    id: 'database',
    label: 'Database',
    run: () => {
      const base = { id: 'database', label: 'Database', observedAt: iso(now) };
      try {
        deps.db.prepare('SELECT 1').get();
        const applied = (deps.db.prepare('SELECT MAX(version) AS v FROM _schema_migrations').get() as { v: number | null }).v ?? 0;
        if (now().getTime() - deepAt > (deps.deepEveryMs ?? 3_600_000)) {
          deepAt = now().getTime();
          deepResult = (deps.db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>).map((r) => r.quick_check).join('; ');
        }
        if (deepResult !== null && deepResult !== 'ok') {
          return { ...base, status: 'critical', summary: 'The database failed its integrity check', facts: { quickCheck: deepResult.slice(0, 500), applied }, alert: { key: 'database:corrupt', title: 'Database problem detected', message: 'The database reported damage. Calls and records may be affected.', action: 'Stop making calls, create a support bundle, and restore the most recent backup from the Backups page.', details: { quickCheck: deepResult.slice(0, 2000) } } };
        }
        if (applied < deps.expectedSchema) {
          return { ...base, status: 'error', summary: 'The database is behind this version', facts: { applied, expected: deps.expectedSchema }, alert: { key: 'database:migration', title: 'Database update did not finish', message: 'The database has not been brought up to date for this version of the application.', action: 'Restart the application. If this stays, contact support with a support bundle.', details: { applied, expected: deps.expectedSchema } } };
        }
        return { ...base, status: 'ok', summary: 'Available and up to date', facts: { schemaVersion: applied, lastIntegrityCheck: deepAt ? new Date(deepAt).toISOString() : null } };
      } catch (e) {
        return { ...base, status: 'critical', summary: 'The database cannot be read', facts: { error: (e as Error).message }, alert: { key: 'database:unavailable', title: 'Database unavailable', message: 'The application cannot read its database, so calls and records cannot be saved.', action: 'Restart the application. If it continues, restore a backup or contact support.', details: { error: (e as Error).message } } };
      }
    },
  };
}

export function storageCheck(deps: { dataDir: string; recordingsDir?: string | null; recorderError: () => string | null; now?: Clock; free?: (dir: string) => number | null; writable?: (dir: string) => { ok: boolean; error?: string } }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  const free = deps.free ?? freeBytesOf;
  const writable = deps.writable ?? isWritable;
  return {
    id: 'storage',
    label: 'Storage and recordings',
    run: () => {
      const base = { id: 'storage', label: 'Storage and recordings', observedAt: iso(now) };
      const w = writable(deps.dataDir);
      if (!w.ok) {
        return { ...base, status: 'critical', summary: 'The data folder cannot be written', facts: { dataDir: deps.dataDir, error: w.error }, alert: { key: 'storage:not-writable', title: 'Cannot save data', message: 'The application cannot write to its data folder, so recordings and records cannot be saved.', action: 'Check that the folder exists, the disk is not full or read-only, and the application may write to it.', details: { dataDir: deps.dataDir, error: w.error } } };
      }
      const bytes = free(deps.dataDir);
      const recErr = deps.recorderError();
      if (bytes !== null) {
        const d = diskStatus(bytes);
        if (d.status !== 'ok') {
          return {
            ...base,
            status: d.status,
            summary: `${formatBytes(bytes)} free`,
            facts: { freeBytes: bytes, dataDir: deps.dataDir },
            alert: { key: 'storage:disk-low', severity: d.status === 'critical' ? 'critical' : d.status === 'error' ? 'error' : 'warning', title: d.status === 'critical' ? 'Disk space critically low' : 'Disk space is low', message: `Only ${formatBytes(bytes)} is free where the data is kept. Recordings and the database need space to keep working.`, action: 'Free up disk space, or lower the recording retention days in Settings.', retry: 'recheck', details: { freeBytes: bytes } },
          };
        }
      }
      if (recErr) {
        return { ...base, status: 'error', summary: 'The last recording could not be saved', facts: { freeBytes: bytes, recorderError: recErr }, alert: { key: 'storage:recording-failed', title: 'A recording could not be saved', message: 'The last call recording failed to save. Calls continue normally.', action: 'Check free disk space and that the recordings folder can be written.', retry: 'recheck', details: { error: recErr } } };
      }
      return { ...base, status: 'ok', summary: bytes === null ? 'Writable' : `Writable, ${formatBytes(bytes)} free`, facts: { freeBytes: bytes, dataDir: deps.dataDir } };
    },
  };
}

export function backgroundCheck(deps: { db: DatabaseType; campaignPaused: () => string | null; now?: Clock }): HealthCheck {
  const now = deps.now ?? (() => new Date());
  return {
    id: 'background',
    label: 'Background processing',
    run: () => {
      const base = { id: 'background', label: 'Background processing', observedAt: iso(now) };
      const hourAgo = new Date(now().getTime() - 3_600_000).toISOString();
      const failed = (deps.db.prepare("SELECT COUNT(*) AS n FROM call_analyses WHERE status = 'failed' AND created_at >= ?").get(hourAgo) as { n: number }).n;
      const paused = deps.campaignPaused();
      if (paused) return { ...base, status: 'warning', summary: 'A campaign is paused', facts: { reason: paused }, alert: { key: 'background:campaign-paused', title: 'A campaign paused itself', message: `A campaign stopped placing calls: ${paused}`, action: 'Fix the cause shown, then resume the campaign from its page.', details: { reason: paused } } };
      if (failed >= 3) return { ...base, status: 'warning', summary: `${failed} call analyses failed in the last hour`, facts: { failedAnalyses: failed }, alert: { key: 'background:analysis-failing', title: 'Call analysis is failing', message: `${failed} call analyses failed in the last hour. Calls and recordings are not affected.`, action: 'Check the AI provider status. Failed calls can be analysed again from their details.', retry: 'recheck', details: { failedLastHour: failed } } };
      return { ...base, status: 'ok', summary: 'Working normally', facts: { failedAnalyses: failed } };
    },
  };
}
