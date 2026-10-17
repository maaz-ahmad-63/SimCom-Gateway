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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone we cannot signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
  dir: string = defaultInstanceLockDir()
): InstanceLock {
  fs.mkdirSync(dir, { recursive: true });
  const acquired: string[] = [];

  try {
    for (const resource of resources) {
      const file = lockFileFor(resource, dir);
      if (acquired.includes(file)) continue;

      if (!tryCreate(file)) {
        const owner = readRecord(file);
        if (owner && owner.pid !== process.pid && isProcessAlive(owner.pid)) {
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
