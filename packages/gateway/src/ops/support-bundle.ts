import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getRecentLogs, redactDiagnosticText } from '../core/logger.js';
import type { LogRecord } from '../core/log-file.js';
import type { AlertRecord } from './alerts.js';
import type { CallDiagnosticsStore } from './call-diagnostics.js';
import { freeBytesOf, HealthSnapshot } from './health.js';
import type { NetworkSnapshot } from './network.js';

/**
 * The file a customer sends to support. It holds health, alerts, recent logs, versions, the non-secret configuration and database
 * statistics. It never holds an API key, a password, a phone number, a transcript or a recording: the configuration is built from an
 * allow-list (so a new secret can never slip in by being added to the config), and every string is passed through the same redaction
 * the logger uses.
 */

export interface BundleInput {
  version: { app: string; schema: number; node: string };
  startedAt: string;
  db: DatabaseType;
  dbPath: string;
  health: HealthSnapshot;
  alerts: { active: AlertRecord[]; recent: AlertRecord[] };
  network: NetworkSnapshot | null;
  diagnostics: CallDiagnosticsStore;
  /** Non-secret configuration, already reduced to an allow-list by the caller. */
  config: Record<string, string | number | boolean | null>;
  keysPresent: Record<string, boolean>;
  fileLogs: () => LogRecord[];
  now?: () => Date;
}

/** Only these configuration values ever reach a bundle. */
export const CONFIG_ALLOWLIST = ['host', 'port', 'modemDriver', 'corsOrigin', 'atBaudRate', 'audioBaudRate', 'audioSampleRate', 'autoReconnect'] as const;

export function safeConfig(config: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of CONFIG_ALLOWLIST) {
    const v = config[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v as string | number | boolean | null;
  }
  return out;
}

function tableCounts(db: DatabaseType): Record<string, number> {
  const out: Record<string, number> = {};
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const name of names) {
    try {
      out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '')}"`).get() as { n: number }).n;
    } catch {
      out[name] = -1;
    }
  }
  return out;
}

export function buildSupportBundle(i: BundleInput) {
  const now = (i.now?.() ?? new Date()).toISOString();
  const dataDir = path.dirname(path.resolve(i.dbPath));
  const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  const bundle = {
    kind: 'support-bundle',
    createdAt: now,
    notice: 'This file contains no API keys, passwords, phone numbers, transcripts or recordings.',
    version: i.version,
    startedAt: i.startedAt,
    system: { platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
    configuration: i.config,
    credentialsPresent: i.keysPresent,
    health: i.health,
    network: i.network,
    alerts: { active: i.alerts.active, recent: i.alerts.recent },
    recentCallDiagnoses: i.diagnostics.recent(100),
    database: { sizeBytes: size(i.dbPath), walBytes: size(`${i.dbPath}-wal`), rowCounts: tableCounts(i.db), migrations: i.db.prepare('SELECT version, name FROM _schema_migrations ORDER BY version').all() },
    storage: { dataDir: path.basename(dataDir), freeBytes: freeBytesOf(dataDir) },
    logs: { inMemory: getRecentLogs(300, 'info').map((e) => e.line), file: i.fileLogs().slice(-1500) },
  };
  // One more pass over every STRING in the bundle (numbers such as byte counts are left alone), in case a value carried something the
  // redaction patterns know.
  return redactStrings(bundle) as typeof bundle;
}

export function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactStrings(v)]));
  return value;
}
