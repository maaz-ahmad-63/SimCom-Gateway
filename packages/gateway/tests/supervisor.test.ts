import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireSupervisorLock, ChildLike, ServiceSpec, ServiceSupervisor, startStatusServer, SupervisorLockError } from '../src/supervisor/supervisor.js';

const spec: ServiceSpec = { name: 'gateway', command: 'node', args: ['x'], cwd: '.', env: {} };

/** A clock and a timer wheel the test moves by hand, and children that exit when the test says so. */
function rig(over: Record<string, unknown> = {}, channel = false) {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
  let nextId = 1;
  const children: Array<ChildLike & { exit: (code: number | null, signal?: string | null) => void; killed: string[]; sent: unknown[] }> = [];
  const logs: string[] = [];
  const sup = new ServiceSupervisor(spec, {
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { at: t + ms, fn, id: nextId++, live: true };
      timers.push(e);
      return e;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
    spawn: () => {
      const listeners: Array<(code: number | null, signal: string | null) => void> = [];
      const c = {
        pid: 1000 + children.length,
        killed: [] as string[],
        sent: [] as unknown[],
        ...(channel ? { connected: true, send(m: unknown) { (this as { sent: unknown[] }).sent.push(m); return true; } } : {}),
        kill(signal?: NodeJS.Signals | number) {
          this.killed.push(String(signal ?? 'SIGTERM'));
          return true;
        },
        on(event: string, l: (...a: never[]) => void) {
          if (event === 'exit') listeners.push(l as never);
          return c;
        },
        exit(code: number | null, signal: string | null = null) {
          listeners.forEach((l) => l(code, signal));
        },
      };
      children.push(c as never);
      return c as never;
    },
    log: (_l, m) => logs.push(m),
    ...over,
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.live = false;
      due.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    t = end;
  };
  return { sup, children, advance, logs, now: () => t };
}

describe('restarting a crashed service', () => {
  it('restarts after a growing delay and says what it is doing', async () => {
    const r = rig();
    r.sup.start();
    expect(r.sup.status()).toMatchObject({ state: 'running', pid: 1000, restarts: 0 });
    r.children[0].exit(1);
    expect(r.sup.status()).toMatchObject({ state: 'backoff', restarts: 1, lastExit: { code: 1 } });
    expect(r.sup.status().message).toMatch(/Restarting in 1 seconds/);
    await r.advance(999);
    expect(r.children).toHaveLength(1); // not before the delay
    await r.advance(2);
    expect(r.children).toHaveLength(2);
    expect(r.sup.status().state).toBe('running');
    r.children[1].exit(1);
    expect(r.sup.status().message).toMatch(/Restarting in 2 seconds/);
    await r.advance(2001);
    r.children[2].exit(1);
    expect(r.sup.status().message).toMatch(/Restarting in 4 seconds/);
  });

  it('gives up after a crash loop instead of restarting forever, and can be retried on request', async () => {
    const r = rig({ maxCrashes: 3, backoffMs: [10] });
    r.sup.start();
    for (let i = 0; i < 3; i++) {
      r.children[i].exit(1);
      await r.advance(11);
    }
    expect(r.children).toHaveLength(3);
    expect(r.sup.status()).toMatchObject({ state: 'failed', crashLoop: true, nextRestartAt: null });
    expect(r.sup.status().message).toMatch(/not restarted again automatically/);
    await r.advance(60_000);
    expect(r.children).toHaveLength(3); // still not restarted
    r.sup.retry();
    expect(r.children).toHaveLength(4);
    expect(r.sup.status().crashLoop).toBe(false);
  });

  it('forgets old crashes once the service has run steadily', async () => {
    const r = rig({ maxCrashes: 3, backoffMs: [10], stableAfterMs: 60_000 });
    r.sup.start();
    r.children[0].exit(1);
    await r.advance(11);
    await r.advance(120_000); // ran for two minutes
    r.children[1].exit(1);
    await r.advance(11);
    expect(r.sup.status().state).toBe('running'); // one crash, not a loop
    expect(r.sup.status().message).toBe('Running');
  });
});

describe('leaving a slow service alone', () => {
  it('stops a service only after it has been unresponsive for a long time, and a quick recovery resets the clock', async () => {
    let answer = false;
    const r = rig({ probe: async () => answer, probeEveryMs: 1000, hungAfterMs: 5000 });
    r.sup.start();
    await r.advance(3000);
    expect(r.children[0].killed).toEqual([]); // unresponsive for 3 s: not enough
    answer = true;
    await r.advance(2000);
    answer = false;
    await r.advance(4000);
    expect(r.children[0].killed).toEqual([]); // the clock restarted when it answered
    await r.advance(2000);
    expect(r.children[0].killed).toEqual(['SIGTERM']);
    r.children[0].exit(null, 'SIGTERM');
    expect(r.sup.status().state).toBe('backoff'); // and it comes back
  });
});

describe('stopping, with a message channel (the way a service finishes cleanly on Windows)', () => {
  it('asks the service to shut down through the channel first, and only forces it if it does not', async () => {
    const r = rig({}, true);
    r.sup.start();
    const stopped = r.sup.stop(5000);
    expect(r.children[0].sent).toEqual([{ type: 'shutdown' }]);
    expect(r.children[0].killed).toEqual([]); // no signal: on Windows that would be an instant kill that skips cleanup
    r.children[0].exit(0);
    await stopped;
    expect(r.children[0].killed).toEqual([]);
    const slow = rig({}, true);
    slow.sup.start();
    const p = slow.sup.stop(5000);
    await slow.advance(5001);
    expect(slow.children[0].killed).toEqual(['SIGKILL']);
    slow.children[0].exit(null, 'SIGKILL');
    await p;
  });
});

describe('stopping', () => {
  it('asks the service to finish, waits, and only forces it after the grace period', async () => {
    const r = rig();
    r.sup.start();
    const stopped = r.sup.stop(5000);
    expect(r.children[0].killed).toEqual(['SIGTERM']);
    expect(r.sup.status().state).toBe('stopping');
    await r.advance(5001);
    expect(r.children[0].killed).toEqual(['SIGTERM', 'SIGKILL']);
    r.children[0].exit(null, 'SIGKILL');
    await stopped;
    expect(r.sup.status().state).toBe('stopped');
    await r.advance(120_000);
    expect(r.children).toHaveLength(1); // a requested stop is never restarted
  });

  it('does not force a service that stops by itself in time', async () => {
    const r = rig();
    r.sup.start();
    const stopped = r.sup.stop(5000);
    r.children[0].exit(0);
    await stopped;
    await r.advance(10_000);
    expect(r.children[0].killed).toEqual(['SIGTERM']);
  });

  it('reports a service that cannot even be started as a crash, not an exception', () => {
    const sup = new ServiceSupervisor(spec, { spawn: () => { throw new Error('ENOENT'); }, setTimer: () => ({}), clearTimer: () => {} });
    expect(() => sup.start()).not.toThrow();
    expect(sup.status().state).toBe('backoff');
  });
});

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('only one supervisor, and so only one gateway', () => {
  it('refuses a second supervisor, replaces a stale lock, and releases its own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
    dirs.push(dir);
    const file = path.join(dir, 'supervisor.lock');
    const release = acquireSupervisorLock(file, 111, () => false);
    expect(fs.readFileSync(file, 'utf8')).toBe('111');
    expect(() => acquireSupervisorLock(file, 222, (pid) => pid === 111)).toThrow(SupervisorLockError);
    const takeover = acquireSupervisorLock(file, 333, () => false); // the owner is gone: stale
    expect(fs.readFileSync(file, 'utf8')).toBe('333');
    release();
    expect(fs.existsSync(file)).toBe(true); // 111 no longer owns it
    takeover();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('status page', () => {
  it('serves process state on the loopback address only and nothing else', async () => {
    const server = startStatusServer(() => ({ gateway: { state: 'running' } }), 0);
    await new Promise((r) => server.once('listening', r));
    const { port, address } = server.address() as { port: number; address: string };
    expect(address).toBe('127.0.0.1');
    const get = (p: string, method = 'GET') =>
      new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        });
        req.end();
      });
    const ok = await get('/status');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ gateway: { state: 'running' } });
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await get('/secrets')).status).toBe(404);
    expect((await get('/status', 'POST')).status).toBe(404);
    expect((await get('/stop', 'POST')).status).toBe(404); // no stop request is offered unless a token was configured
    server.close();
  });

  it('accepts a stop request only with the token from the data folder', async () => {
    let stopped = 0;
    const server = startStatusServer(() => ({}), 0, '127.0.0.1', { token: 'a'.repeat(48), onStop: () => stopped++ });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as { port: number };
    const post = (token?: string) =>
      new Promise<number>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/stop', method: 'POST', headers: token ? { 'x-supervisor-token': token } : {} }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.end();
      });
    expect(await post()).toBe(403);
    expect(await post('b'.repeat(48))).toBe(403);
    expect(await post('short')).toBe(403);
    expect(stopped).toBe(0);
    expect(await post('a'.repeat(48))).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(1);
    server.close();
  });
});
