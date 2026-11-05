import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Keeps a service running, safely.
 *
 * A service that exits is restarted after a growing delay. A service that keeps crashing is NOT restarted forever: after too many
 * crashes in a short time the supervisor stops, marks it as failed (a "crash loop") and says so, because a restart loop can hammer the
 * modem and hide the real fault. A service that is merely slow is left alone: it is only stopped (and then restarted) after it has
 * not answered its liveness probe for a long time. The supervisor never sends a command to the modem and never touches a call; it only
 * starts and stops processes.
 */

export type ServiceState = 'starting' | 'running' | 'backoff' | 'failed' | 'stopping' | 'stopped';

export interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  pid: number | null;
  startedAt: string | null;
  restarts: number;
  crashLoop: boolean;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  nextRestartAt: string | null;
  message: string;
}

/** The part of a child process the supervisor needs, so tests can supply a fake. */
export interface ChildLike {
  pid?: number;
  /** Present when the child was started with a message channel. On Windows a signal is an immediate kill, so this is the only way to let a service finish cleanly. */
  send?(message: unknown): boolean;
  connected?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface SupervisorDeps {
  spawn: (spec: ServiceSpec) => ChildLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Resolves true when the service answers. Absent: the service is never judged hung. */
  probe?: () => Promise<boolean>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Delays before a restart, by consecutive crash. The last value repeats. */
  backoffMs?: number[];
  /** Crashes inside `windowMs` that count as a crash loop. */
  maxCrashes?: number;
  windowMs?: number;
  /** A service that has run this long is considered healthy again: its crash count restarts from zero. */
  stableAfterMs?: number;
  probeEveryMs?: number;
  /** How long a service may stay unresponsive before it is stopped. Long, because it may be in the middle of a call. */
  hungAfterMs?: number;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

export class ServiceSupervisor {
  private child: ChildLike | null = null;
  private state: ServiceState = 'stopped';
  private startedAt: number | null = null;
  private restarts = 0;
  private crashes: number[] = [];
  private consecutive = 0;
  private lastExit: ServiceStatus['lastExit'] = null;
  private nextRestartAt: number | null = null;
  private message = 'Not started';
  private restartTimer: unknown = null;
  private probeTimer: unknown = null;
  private unresponsiveSince: number | null = null;
  private wantRunning = false;
  private stopWaiters: Array<() => void> = [];

  constructor(
    private readonly spec: ServiceSpec,
    private readonly deps: SupervisorDeps
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private timer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, m) => { const t = setTimeout(f, m); t.unref?.(); return t; }))(fn, ms);
  }
  private clear(handle: unknown): void {
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(handle);
  }
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.log?.(level, `[${this.spec.name}] ${message}`);
  }

  status(): ServiceStatus {
    return {
      name: this.spec.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      restarts: this.restarts,
      crashLoop: this.state === 'failed',
      lastExit: this.lastExit,
      nextRestartAt: this.nextRestartAt ? new Date(this.nextRestartAt).toISOString() : null,
      message: this.message,
    };
  }

  start(): void {
    if (this.wantRunning) return;
    this.wantRunning = true;
    this.launch();
  }

  /** Clear a crash loop and try again (the customer asked for it). */
  retry(): void {
    if (this.state !== 'failed') return;
    this.crashes = [];
    this.consecutive = 0;
    this.wantRunning = true;
    this.launch();
  }

  private launch(): void {
    if (this.child) return;
    this.state = 'starting';
    this.message = 'Starting…';
    this.nextRestartAt = null;
    let child: ChildLike;
    try {
      child = this.deps.spawn(this.spec);
    } catch (e) {
      this.log('error', `could not start: ${(e as Error).message}`);
      this.onExit(null, null, `could not start: ${(e as Error).message}`);
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    this.unresponsiveSince = null;
    this.state = 'running';
    this.message = 'Running';
    this.log('info', `started (pid ${child.pid ?? '?'})`);
    child.on('error', (e) => this.log('error', `process error: ${e.message}`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.onExit(code, signal);
    });
    this.scheduleProbe();
  }

  private onExit(code: number | null, signal: string | null, why?: string): void {
    const at = this.now();
    this.child = null;
    if (this.probeTimer) this.clear(this.probeTimer);
    this.probeTimer = null;
    this.lastExit = { code, signal, at: new Date(at).toISOString() };
    const ranFor = this.startedAt ? at - this.startedAt : 0;
    this.startedAt = null;
    if (this.state === 'stopping' || !this.wantRunning) {
      this.state = 'stopped';
      this.message = 'Stopped';
      this.log('info', 'stopped');
      for (const w of this.stopWaiters.splice(0)) w();
      return;
    }
    if (ranFor >= (this.deps.stableAfterMs ?? 60_000)) {
      this.consecutive = 0;
      this.crashes = [];
    }
    this.crashes = this.crashes.filter((t) => at - t <= (this.deps.windowMs ?? 600_000));
    this.crashes.push(at);
    this.consecutive += 1;
    this.log('warn', `exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})${why ? `: ${why}` : ''}`);
    if (this.crashes.length >= (this.deps.maxCrashes ?? 5)) {
      this.state = 'failed';
      this.message = `Stopped after ${this.crashes.length} crashes in ${Math.round((this.deps.windowMs ?? 600_000) / 60_000)} minutes. It is not restarted again automatically.`;
      this.nextRestartAt = null;
      this.log('error', this.message);
      return;
    }
    const table = this.deps.backoffMs ?? DEFAULT_BACKOFF;
    const delay = table[Math.min(this.consecutive - 1, table.length - 1)];
    this.state = 'backoff';
    this.nextRestartAt = at + delay;
    this.message = `Restarting in ${Math.round(delay / 1000)} seconds (attempt ${this.consecutive})`;
    this.restarts += 1;
    this.restartTimer = this.timer(() => {
      this.restartTimer = null;
      if (this.wantRunning && !this.child) this.launch();
    }, delay);
  }

  private scheduleProbe(): void {
    if (!this.deps.probe) return;
    this.probeTimer = this.timer(async () => {
      if (!this.child) return;
      let ok = false;
      try {
        ok = await this.deps.probe!();
      } catch {
        ok = false;
      }
      if (!this.child) return;
      if (ok) this.unresponsiveSince = null;
      else {
        this.unresponsiveSince ??= this.now();
        if (this.now() - this.unresponsiveSince >= (this.deps.hungAfterMs ?? 180_000)) {
          this.log('warn', 'has not answered for a long time: stopping it so it can be restarted');
          this.unresponsiveSince = null;
          this.child.kill('SIGTERM');
          return;
        }
      }
      this.scheduleProbe();
    }, this.deps.probeEveryMs ?? 15_000);
  }

  /** Stop the service gracefully: ask it to finish, and only force it after `graceMs`. */
  stop(graceMs = 25_000): Promise<void> {
    this.wantRunning = false;
    if (this.restartTimer) this.clear(this.restartTimer);
    this.restartTimer = null;
    if (this.probeTimer) this.clear(this.probeTimer);
    this.probeTimer = null;
    if (!this.child) {
      this.state = this.state === 'failed' ? 'failed' : 'stopped';
      return Promise.resolve();
    }
    this.state = 'stopping';
    this.message = 'Stopping…';
    const child = this.child;
    return new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve);
      // Ask politely first. A service that listens on the message channel finishes its cleanup and exits by itself; one that does not
      // (or a platform without the channel) is stopped by signal, and forced only after the grace period.
      let asked = false;
      if (typeof child.send === 'function' && child.connected !== false) {
        try {
          asked = child.send({ type: 'shutdown' }) !== false;
        } catch {
          asked = false;
        }
      }
      if (!asked) child.kill('SIGTERM');
      this.timer(() => {
        if (this.child === child) {
          this.log('warn', `did not stop within ${Math.round(graceMs / 1000)} seconds: forcing it`);
          child.kill('SIGKILL');
        }
      }, graceMs);
    });
  }
}

// ---- one supervisor at a time ----------------------------------------------------------------------------------------------------------

export class SupervisorLockError extends Error {}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Refuses to start a second supervisor: two of them would each start a gateway, and two gateways must never open the same COM port. */
export function acquireSupervisorLock(file: string, pid = process.pid, isAlive: (pid: number) => boolean = alive): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const other = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(other) && other !== pid && isAlive(other)) throw new SupervisorLockError(`Another supervisor is already running (process ${other}).`);
  }
  fs.writeFileSync(file, String(pid));
  return () => {
    try {
      if (Number(fs.readFileSync(file, 'utf8').trim()) === pid) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}

/**
 * A tiny local status page, so the dashboard can say "the gateway crashed, restarting (attempt 2)" even while the gateway itself is down.
 * It listens on the loopback address only and shows process state, never a secret or call data.
 */
/**
 * Extra authenticated routes (the updater). The handler is only called for a request that carries the supervisor token, and returns the
 * JSON body and status to send. It is never called for a request without the token, so a web page in a browser cannot reach it.
 */
export type TokenRoute = (method: string, url: string) => Promise<{ status: number; body: unknown }> | null;

export function startStatusServer(getStatus: () => unknown, port: number, host = '127.0.0.1', stop?: { token: string; onStop: () => void; route?: TokenRoute }): http.Server {
  const server = http.createServer((req, res) => {
    if (stop?.route && req.url?.startsWith('/update')) {
      const given = req.headers['x-supervisor-token'];
      if (typeof given !== 'string' || given.length !== stop.token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(stop.token))) {
        res.writeHead(403, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      const pending = stop.route(req.method ?? 'GET', req.url);
      if (!pending) {
        res.writeHead(404).end();
        return;
      }
      pending.then(
        (r) => res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(r.body)),
        () => res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ success: false, code: 'UNEXPECTED', error: 'The update step failed unexpectedly.' }))
      );
      return;
    }
    // POST /stop asks the supervisor to shut down cleanly. Windows cannot deliver a polite signal to a hidden process, so this is how the
    // stop script does it. It needs the token written to the customer's data folder, which a web page cannot read.
    if (req.method === 'POST' && req.url === '/stop' && stop) {
      const given = req.headers['x-supervisor-token'];
      if (typeof given !== 'string' || given.length !== stop.token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(stop.token))) {
        res.writeHead(403, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      res.writeHead(202, { 'Cache-Control': 'no-store' }).end('stopping');
      setImmediate(stop.onStop);
      return;
    }
    if (req.method !== 'GET' || (req.url !== '/status' && req.url !== '/')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(getStatus()));
  });
  server.listen(port, host);
  server.unref();
  return server;
}
