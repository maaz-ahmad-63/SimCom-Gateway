import fs from 'node:fs';
import path from 'node:path';

/**
 * Structured log file with rotation.
 *
 * One JSON object per line: timestamp, level, component, message, and a call id or correlation id when the log call carried one.
 * The file is rotated by size and old files are removed by age, so logs cannot grow without limit. Writes are asynchronous: logging
 * never waits on the disk, and a disk error is swallowed (it is reported once through `onError`) so a full disk cannot break a call.
 * Callers pass text and data that were ALREADY redacted by the logger.
 */

export interface LogRecord {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  msg: string;
  callId?: string;
  data?: unknown;
}

export interface LogFileOptions {
  dir: string;
  maxBytes?: number;
  /** Rotated files kept besides the current one. */
  maxFiles?: number;
  retentionDays?: number;
  onError?: (message: string) => void;
  now?: () => Date;
}

const NAME = 'gateway.log';

export class RotatingFileLog {
  private stream: fs.WriteStream | null = null;
  private size = 0;
  private failed = false;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly retentionDays: number;

  constructor(private readonly o: LogFileOptions) {
    this.maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    this.maxFiles = o.maxFiles ?? 10;
    this.retentionDays = o.retentionDays ?? 14;
    try {
      fs.mkdirSync(o.dir, { recursive: true });
      this.size = fs.existsSync(this.file()) ? fs.statSync(this.file()).size : 0;
      this.prune();
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private file(n = 0): string {
    return path.join(this.o.dir, n === 0 ? NAME : `${NAME}.${n}`);
  }

  private fail(e: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.o.onError?.(`Log file unavailable: ${e.message}`);
  }

  write(record: LogRecord): void {
    if (this.failed) return;
    try {
      const line = `${JSON.stringify(record)}\n`;
      if (this.size + line.length > this.maxBytes) this.rotate();
      if (!this.stream) {
        // The file is opened now (not when the stream gets round to it), so it exists on disk before it can ever be rotated.
        this.stream = fs.createWriteStream(this.file(), { fd: fs.openSync(this.file(), 'a'), autoClose: true });
        this.stream.on('error', (e) => this.fail(e));
      }
      this.stream.write(line);
      this.size += Buffer.byteLength(line);
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private rotate(): void {
    this.stream?.end();
    this.stream = null;
    for (let n = this.maxFiles; n >= 1; n--) {
      const from = this.file(n - 1);
      if (!fs.existsSync(from)) continue;
      if (n === this.maxFiles) fs.rmSync(this.file(n), { force: true });
      fs.renameSync(from, this.file(n));
    }
    this.size = 0;
    this.prune();
  }

  /** Remove rotated files older than the retention period. The current file is never removed. */
  prune(): void {
    const cutoff = (this.o.now?.() ?? new Date()).getTime() - this.retentionDays * 86_400_000;
    for (let n = 1; n <= this.maxFiles + 5; n++) {
      const f = this.file(n);
      try {
        if (fs.existsSync(f) && fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true });
      } catch {
        /* a file that cannot be removed now is tried again at the next rotation */
      }
    }
  }

  /** The newest records, oldest first, read back from the files (for the support bundle). */
  tail(limit = 2000): LogRecord[] {
    const out: LogRecord[] = [];
    for (let n = 0; n <= this.maxFiles && out.length < limit; n++) {
      const f = this.file(n);
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          out.push(JSON.parse(lines[i]) as LogRecord);
        } catch {
          /* a partly written last line */
        }
      }
    }
    return out.reverse();
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }
}
