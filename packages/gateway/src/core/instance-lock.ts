import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cross-process ownership marker for serial ports.
 *
 * Windows already refuses a second open of a COM port, but the failure is a generic
 * "Access denied" that gives no hint which process holds it, and the per-call audio port is
 * released between calls so a second gateway could take it then. Each gateway records its PID
 * per port before touching any port; a second gateway refuses to start and names the owner.
 */
export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export interface InstanceLock {
  readonly files: string[];
  release(): void;
}

interface LockRecord {
  pid: number;
  startedAt: string;
}

export function defaultInstanceLockDir(): string {
  return path.join(os.tmpdir(), 'sim-gateway-locks');
}

/** The program name of the process with this id, or null when there is no such process. May throw when it cannot tell. */
export type ProcessImageProbe = (pid: number) => string | null;

/** Windows: ask the task list, which answers for every process id whatever its owner, and which Node's own check does not. */
function windowsImageName(pid: number): string | null {
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const row = /^"([^"]+)","(\d+)"/m.exec(out);
  return row && Number(row[2]) === pid ? row[1] : null;
}

function isProcessAlive(pid: number, imageOf: ProcessImageProbe = windowsImageName): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
    // EPERM means "exists but belongs to someone we cannot signal"... except on Windows, where Node also answers EPERM for an id that no
    // longer exists (an owner killed by a reboot or a crash). Taken at its word that is a lock nobody can ever clear, and the gateway
    // refuses to start. So on Windows the task list decides, and only a running node process can be another gateway; an id that now
    // belongs to some other program, or to nothing, is a stale lock. If the task list cannot be read, stay on the safe side.
    if (process.platform !== 'win32') return true;
    try {
      const image = imageOf(pid);
      return image !== null && /^node(\.exe)?$/i.test(image);
    } catch {
      return true;
    }
  }
}

function readRecord(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockRecord>;
    return typeof parsed.pid === 'number' ? { pid: parsed.pid, startedAt: String(parsed.startedAt ?? '') } : null;
  } catch {
    return null;
  }
}

function lockFileFor(resource: string, dir: string): string {
  return path.join(dir, `${resource.toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}.lock`);
}

function tryCreate(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function releaseFiles(files: string[]): void {
  for (const file of files) {
    // Never delete a lock that has since been taken over by another process.
    if (readRecord(file)?.pid === process.pid) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Acquire one lock per resource (for example `COM22` and `COM26`). All-or-nothing: if any
 * resource is owned by a live foreign process nothing stays locked and InstanceLockError names it.
 * A lock left by a crashed process (dead PID) is replaced.
 */
export function acquireInstanceLock(
  resources: string[],
  dir: string = defaultInstanceLockDir(),
  /** Test seam for the Windows process lookup. */
  imageOf?: ProcessImageProbe
): InstanceLock {
  fs.mkdirSync(dir, { recursive: true });
  const acquired: string[] = [];

  try {
    for (const resource of resources) {
      const file = lockFileFor(resource, dir);
      if (acquired.includes(file)) continue;

      if (!tryCreate(file)) {
        const owner = readRecord(file);
        if (owner && owner.pid !== process.pid && isProcessAlive(owner.pid, imageOf)) {
          throw new InstanceLockError(
            `Another SIM7600 gateway process (pid ${owner.pid}, started ${owner.startedAt || 'unknown'}) already owns ${resource}. ` +
              `Stop it first (lock file: ${file}).`
          );
        }
        // Stale (dead owner), unreadable, or left by this process: take it over.
        fs.rmSync(file, { force: true });
        if (!tryCreate(file)) {
          throw new InstanceLockError(`Could not acquire the instance lock for ${resource} (${file}).`);
        }
      }
      acquired.push(file);
    }
  } catch (error) {
    releaseFiles(acquired);
    throw error;
  }

  return { files: acquired, release: () => releaseFiles(acquired) };
}
