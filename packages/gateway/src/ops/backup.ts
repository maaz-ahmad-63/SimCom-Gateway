import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { formatBytes, freeBytesOf } from './health.js';

/**
 * Database backup and restore.
 *
 * A backup is a consistent copy made with SQLite's own online backup, checked before it is kept. Restoring never replaces the database
 * of a running gateway: a restore is STAGED, and applied at the next start before the database is opened, after the current database
 * has been set aside as a "pre-restore" backup. Nothing is ever deleted by restoring, and no backup is deleted automatically except
 * the oldest automatic ones beyond the number to keep.
 */

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
  kind: 'automatic' | 'manual' | 'pre-restore' | 'other';
}

const NAME = /^[A-Za-z0-9._-]{1,120}\.sqlite$/;
const PENDING = 'restore-pending.sqlite';

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function checkBackupFile(file: string, expectedSchema: number): { ok: true; schemaVersion: number } | { ok: false; reason: string } {
  let db: DatabaseType | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = (db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>).map((r) => r.quick_check).join('; ');
    if (check !== 'ok') return { ok: false, reason: 'The backup file failed its integrity check.' };
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_schema_migrations'").get();
    if (!has) return { ok: false, reason: 'This file is not a backup of this application (no schema table).' };
    const v = (db.prepare('SELECT MAX(version) AS v FROM _schema_migrations').get() as { v: number | null }).v ?? 0;
    if (v > expectedSchema) return { ok: false, reason: `This backup comes from a newer version of the application (database version ${v}, this application supports ${expectedSchema}).` };
    return { ok: true, schemaVersion: v };
  } catch {
    return { ok: false, reason: 'The file could not be opened as a database.' };
  } finally {
    db?.close();
  }
}

export class BackupService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      db: DatabaseType;
      dbPath: string;
      expectedSchema: number;
      /** The most recent automatic backups to keep. Manual and pre-restore backups are never removed by the application. */
      keepAutomatic?: number;
      now?: () => Date;
      free?: (dir: string) => number | null;
      logger?: { info(message: string): void; warn(message: string): void };
    }
  ) {}

  private get dir(): string {
    return path.join(path.dirname(path.resolve(this.deps.dbPath)), 'backups');
  }

  private get dataDir(): string {
    return path.dirname(path.resolve(this.deps.dbPath));
  }

  list(): BackupInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((n) => NAME.test(n))
      .map((name) => {
        const s = fs.statSync(path.join(this.dir, name));
        const kind: BackupInfo['kind'] = name.startsWith('auto-') ? 'automatic' : name.startsWith('manual-') ? 'manual' : name.startsWith('pre-restore-') ? 'pre-restore' : 'other';
        return { name, bytes: s.size, createdAt: s.mtime.toISOString(), kind };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pending(): { name: string; stagedAt: string } | null {
    const p = path.join(this.dataDir, PENDING);
    if (!fs.existsSync(p)) return null;
    const meta = path.join(this.dataDir, `${PENDING}.json`);
    let name = 'unknown';
    try {
      name = (JSON.parse(fs.readFileSync(meta, 'utf8')) as { name: string }).name;
    } catch {
      /* the marker is informational */
    }
    return { name, stagedAt: fs.statSync(p).mtime.toISOString() };
  }

  /** Make a backup now. Refuses when the disk does not have room for a second copy of the database. */
  async create(kind: 'manual' | 'automatic' = 'manual'): Promise<BackupInfo> {
    const size = fs.existsSync(this.deps.dbPath) ? fs.statSync(this.deps.dbPath).size : 0;
    fs.mkdirSync(this.dir, { recursive: true });
    const free = (this.deps.free ?? freeBytesOf)(this.dir);
    if (free !== null && free < size * 2 + 50 * 1024 ** 2) {
      throw new BackupError(`There is not enough free disk space for a backup (${formatBytes(free)} free, about ${formatBytes(size * 2)} needed).`, 'DISK_FULL', 507);
    }
    const name = `${kind === 'automatic' ? 'auto' : 'manual'}-${stamp(this.deps.now?.() ?? new Date())}.sqlite`;
    const target = path.join(this.dir, name);
    if (fs.existsSync(target)) throw new BackupError('A backup was already made in this second. Try again.', 'EXISTS', 409);
    await this.deps.db.backup(target);
    const check = checkBackupFile(target, this.deps.expectedSchema);
    if (!check.ok) {
      fs.rmSync(target, { force: true });
      throw new BackupError(`The backup was made but did not pass its check, so it was discarded: ${check.reason}`, 'BACKUP_INVALID', 500);
    }
    this.deps.logger?.info(`Database backup created: ${name} (${formatBytes(fs.statSync(target).size)})`);
    if (kind === 'automatic') this.pruneAutomatic();
    const s = fs.statSync(target);
    return { name, bytes: s.size, createdAt: s.mtime.toISOString(), kind: kind === 'automatic' ? 'automatic' : 'manual' };
  }

  private pruneAutomatic(): void {
    const keep = this.deps.keepAutomatic ?? 14;
    for (const b of this.list().filter((x) => x.kind === 'automatic').slice(keep)) fs.rmSync(path.join(this.dir, b.name), { force: true });
  }

  /** Stage a restore of a named backup for the next start. The running database is not touched. */
  stageRestore(name: string): { staged: string; requiresRestart: true } {
    if (!NAME.test(name)) throw new BackupError('That is not a valid backup name.', 'INVALID_NAME');
    const source = path.join(this.dir, name);
    if (path.dirname(path.resolve(source)) !== path.resolve(this.dir) || !fs.existsSync(source)) throw new BackupError('Backup not found.', 'NOT_FOUND', 404);
    const check = checkBackupFile(source, this.deps.expectedSchema);
    if (!check.ok) throw new BackupError(check.reason, 'BACKUP_INVALID');
    const free = (this.deps.free ?? freeBytesOf)(this.dataDir);
    const size = fs.statSync(source).size;
    if (free !== null && free < size * 2) throw new BackupError(`There is not enough free disk space to stage this restore (${formatBytes(free)} free).`, 'DISK_FULL', 507);
    fs.copyFileSync(source, path.join(this.dataDir, PENDING));
    fs.writeFileSync(path.join(this.dataDir, `${PENDING}.json`), JSON.stringify({ name, stagedAt: (this.deps.now?.() ?? new Date()).toISOString() }));
    this.deps.logger?.warn(`Restore of ${name} is staged. It is applied the next time the application starts; the current database is kept as a pre-restore backup.`);
    return { staged: name, requiresRestart: true };
  }

  cancelRestore(): boolean {
    const p = path.join(this.dataDir, PENDING);
    const had = fs.existsSync(p);
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}.json`, { force: true });
    return had;
  }

  /** Make a daily backup while idle. The first runs a few minutes after start. */
  start(isIdle: () => boolean, everyMs = 6 * 3_600_000): void {
    if (this.timer) return;
    const tick = () => {
      const newest = this.list().find((b) => b.kind === 'automatic');
      const due = !newest || (this.deps.now?.() ?? new Date()).getTime() - new Date(newest.createdAt).getTime() > 23 * 3_600_000;
      if (due && isIdle()) void this.create('automatic').catch((e) => this.deps.logger?.warn(`Automatic backup failed: ${(e as Error).message}`));
    };
    setTimeout(tick, 5 * 60_000).unref?.();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Applied at start, BEFORE the database is opened. The database in use is moved aside as a pre-restore backup (never deleted), then the
 * staged file takes its place. If the staged file does not pass its check it is discarded and the database is left exactly as it was.
 */
export function applyPendingRestore(dbPath: string, expectedSchema: number, logger?: { info(m: string): void; warn(m: string): void }): { applied: boolean; reason?: string } {
  const dir = path.dirname(path.resolve(dbPath));
  const pending = path.join(dir, PENDING);
  if (!fs.existsSync(pending)) return { applied: false };
  const discard = () => {
    fs.rmSync(pending, { force: true });
    fs.rmSync(`${pending}.json`, { force: true });
  };
  const check = checkBackupFile(pending, expectedSchema);
  if (!check.ok) {
    discard();
    logger?.warn(`A staged restore was discarded: ${check.reason}`);
    return { applied: false, reason: check.reason };
  }
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  if (fs.existsSync(dbPath)) {
    const aside = path.join(backups, `pre-restore-${stamp(new Date())}.sqlite`);
    fs.renameSync(dbPath, aside);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.rmSync(dbPath + ext, { force: true });
    logger?.info(`The database in use was kept as ${path.basename(aside)}`);
  }
  fs.renameSync(pending, dbPath);
  fs.rmSync(`${pending}.json`, { force: true });
  logger?.info('The staged backup was restored.');
  return { applied: true };
}
