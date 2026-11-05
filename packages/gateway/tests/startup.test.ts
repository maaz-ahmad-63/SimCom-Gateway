import { describe, expect, it } from 'vitest';
import { HttpAnswer, isHealthy, isServing, ownerFromNetstat, startAndWait, StartupDeps, tailLines } from '../src/supervisor/startup.js';

/**
 * What happens when the customer clicks the icon. The first installer opened the browser at once and showed a dead page
 * (ERR_CONNECTION_REFUSED). These tests pin the rules that prevent that: the browser opens only when the gateway and the dashboard
 * are both healthy, and every other outcome is a plain message with the log location.
 */

const ports = { dashboard: 3000, gateway: 4000, status: 4010 };
const ok = (body = '{"status":"ok"}'): HttpAnswer => ({ status: 200, body });

interface Sim {
  /** Milliseconds after which each thing starts answering (Infinity: never). */
  gatewayAt?: number;
  dashboardAt?: number;
  statusAt?: number;
  statusBody?: () => string;
  portOwners?: Record<number, string>;
  writable?: { ok: boolean; error?: string };
  supervisorExitsAt?: number | null;
  supervisorExitCode?: number;
  firstRun?: boolean;
  browser?: boolean;
  timeoutMs?: number;
}

function rig(s: Sim = {}) {
  let t = 0;
  const events: string[] = [];
  const opened: string[] = [];
  const shown = { splash: 0, hidden: 0 };
  let spawned = 0;
  let marked = false;
  const answers = (at: number | undefined, body?: () => string): HttpAnswer | null => (t >= (at ?? 0) ? ok(body?.()) : null);
  const deps: StartupDeps = {
    ports,
    http: async (url) => {
      events.push(`GET ${url.replace('http://127.0.0.1:', ':')}`);
      if (url.endsWith(':4000/health')) return answers(s.gatewayAt ?? 3000, () => '{"status":"ok","version":"0.1.1"}');
      if (url.endsWith(':3000/')) return answers(s.dashboardAt ?? 6000, () => '<html>');
      if (url.endsWith(':4010/status')) return spawned > 0 || s.statusAt !== undefined ? answers(s.statusAt ?? 1000, s.statusBody ?? (() => '{"gateway":{"state":"running"},"dashboard":{"state":"running"}}')) : null;
      return null;
    },
    spawnSupervisor: () => {
      spawned++;
      events.push('spawn supervisor');
      const exitsAt = s.supervisorExitsAt === undefined ? null : s.supervisorExitsAt;
      return { exited: () => exitsAt !== null && t >= exitsAt, exitCode: () => s.supervisorExitCode ?? 1 };
    },
    portOwner: async (p) => s.portOwners?.[p] ?? null,
    dataDirWritable: () => s.writable ?? { ok: true },
    dataDir: 'C:\\ProgramData\\SimGateway',
    logDir: 'C:\\ProgramData\\SimGateway\\logs',
    logTail: () => '2026-11-04 [error] The supervisor could not start: EPERM',
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    openBrowser: (u) => {
      events.push(`OPEN ${u}`);
      opened.push(u);
    },
    browser: s.browser ?? true,
    firstRun: () => s.firstRun ?? false,
    markFirstRunDone: () => {
      marked = true;
    },
    splash: { show: () => shown.splash++, hide: () => shown.hidden++ },
    log: () => undefined,
    timeoutMs: s.timeoutMs ?? 60_000,
    pollMs: 500,
  };
  return { deps, events, opened, shown, spawned: () => spawned, marked: () => marked, time: () => t };
}

describe('the browser opens only when everything is ready', () => {
  it('waits for both the gateway and the dashboard before opening, never just for the supervisor', async () => {
    const r = rig({ gatewayAt: 3000, dashboardAt: 9000 });
    const result = await startAndWait(r.deps);
    expect(result).toEqual({ ok: true, url: 'http://127.0.0.1:3000/', reusedExisting: false });
    expect(r.opened).toEqual(['http://127.0.0.1:3000/']);
    expect(r.time()).toBeGreaterThanOrEqual(9000); // the dashboard was the slow one, and it was waited for
    expect(r.events.indexOf('OPEN http://127.0.0.1:3000/')).toBe(r.events.length - 1); // the very last thing that happened
  });

  it('is not fooled by a dashboard that is listening but a gateway that is not healthy (and the reverse)', async () => {
    expect((await startAndWait(rig({ gatewayAt: Infinity, dashboardAt: 0, timeoutMs: 5000 }).deps)).ok).toBe(false);
    const r = rig({ gatewayAt: 0, dashboardAt: Infinity, timeoutMs: 5000 });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(r.opened).toEqual([]);
    expect(isHealthy({ status: 200, body: '{"status":"error"}' })).toBe(false);
    expect(isHealthy({ status: 500, body: '{"status":"ok"}' })).toBe(false);
    expect(isHealthy(null)).toBe(false);
    expect(isServing({ status: 404, body: '' })).toBe(false);
    expect(isServing({ status: 307, body: '' })).toBe(true);
  });

  it('shows a starting window while it waits, hides it before anything else, and does not show one for a silent start', async () => {
    const r = rig();
    await startAndWait(r.deps);
    expect(r.shown.splash).toBe(1);
    expect(r.shown.hidden).toBe(1);
    const quiet = rig({ browser: false });
    await startAndWait(quiet.deps);
    expect(quiet.shown.splash).toBe(0);
    expect(quiet.opened).toEqual([]); // the start at sign-in opens no browser
  });

  it('opens the setup page the first time and the dashboard afterwards', async () => {
    const first = rig({ firstRun: true });
    expect(await startAndWait(first.deps)).toMatchObject({ ok: true, url: 'http://127.0.0.1:3000/setup' });
    expect(first.marked()).toBe(true);
    const later = rig({ firstRun: false });
    expect(await startAndWait(later.deps)).toMatchObject({ url: 'http://127.0.0.1:3000/' });
    expect(later.marked()).toBe(false);
  });
});

describe('a second click does not start a second copy', () => {
  it('finds the supervisor already running, starts nothing, and only waits for readiness', async () => {
    const r = rig({ statusAt: 0, gatewayAt: 2000, dashboardAt: 2000 });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: true, reusedExisting: true });
    expect(r.spawned()).toBe(0);
    expect(r.opened).toHaveLength(1);
  });

  it('treats a duplicate supervisor that hands over to the running one (exit code 3) as a wait, not an error, even before its status page is up', async () => {
    // two quick clicks: our supervisor exits at once because the first one holds the lock, which is still starting
    const r = rig({ supervisorExitsAt: 0, supervisorExitCode: 3, statusAt: 4000, gatewayAt: 6000, dashboardAt: 8000 });
    expect(await startAndWait(r.deps)).toMatchObject({ ok: true });
    expect(r.opened).toHaveLength(1);
    // any other exit before the services are up is still a failure
    expect(await startAndWait(rig({ supervisorExitsAt: 0, supervisorExitCode: 1, statusAt: Infinity }).deps)).toMatchObject({ ok: false, code: 'SUPERVISOR_EXITED' });
  });
});

describe('every failure is a plain message, never a dead page', () => {
  it('names a port that something else is using, and what is using it, and starts nothing', async () => {
    const r = rig({ portOwners: { 3000: 'node.exe (process 4120)' } });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: false, code: 'PORT_CONFLICT' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('Port 3000');
    expect(result.message).toContain('the dashboard');
    expect(result.message).toContain('node.exe (process 4120)');
    expect(result.message).toContain('C:\\ProgramData\\SimGateway\\logs');
    expect(r.spawned()).toBe(0);
    expect(r.opened).toEqual([]);
    expect(await startAndWait(rig({ portOwners: { 4000: 'java.exe (process 9)' } }).deps)).toMatchObject({ code: 'PORT_CONFLICT' });
    expect(await startAndWait(rig({ portOwners: { 4010: 'x.exe (process 1)' } }).deps)).toMatchObject({ code: 'PORT_CONFLICT' });
  });

  it('explains an unwritable data folder (the reason the first installer showed a dead page) before starting anything', async () => {
    const r = rig({ writable: { ok: false, error: "EPERM: operation not permitted, open 'C:\\ProgramData\\SimGateway\\supervisor.lock'" } });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: false, code: 'DATA_DIR' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('C:\\ProgramData\\SimGateway');
    expect(result.message).toMatch(/installer again|write access/);
    expect(r.spawned()).toBe(0);
    expect(r.opened).toEqual([]);
  });

  it('reports a supervisor that dies right after starting, with the last log lines and the log folder', async () => {
    const r = rig({ supervisorExitsAt: 1000, statusAt: Infinity });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: false, code: 'SUPERVISOR_EXITED' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('EPERM');
    expect(result.message).toContain('exit code 1');
    expect(result.message).toContain('Details are in the log folder');
    expect(r.opened).toEqual([]);
    expect(r.shown.hidden).toBe(1); // the starting window never stays up over an error
  });

  it('gives up with an explanation when a service is in a crash loop instead of waiting for the full timeout', async () => {
    const r = rig({ gatewayAt: Infinity, dashboardAt: 0, statusAt: 0, statusBody: () => '{"gateway":{"state":"failed","crashLoop":true,"message":"Stopped after 5 crashes in 10 minutes."},"dashboard":{"state":"running"}}', timeoutMs: 120_000 });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_FAILED', title: 'The gateway could not start' });
    expect(r.time()).toBeLessThan(5000);
    expect(r.opened).toEqual([]);
  });

  it('times out with which part was not ready', async () => {
    const r = rig({ gatewayAt: 0, dashboardAt: Infinity, timeoutMs: 4000 });
    const result = await startAndWait(r.deps);
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toMatch(/^The dashboard did not become ready within 4 seconds/);
    expect(result.message).not.toContain('gateway and');
  });
});

describe('helpers', () => {
  it('reads the owner of a listening port from netstat output', () => {
    const net = ['  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4120', '  TCP    127.0.0.1:50000        127.0.0.1:3000         ESTABLISHED     777'].join('\r\n');
    expect(ownerFromNetstat(net, 3000, (pid) => (pid === 4120 ? 'node.exe' : null))).toBe('node.exe (process 4120)');
    expect(ownerFromNetstat(net, 3000, () => null)).toBe('another program (process 4120)');
    expect(ownerFromNetstat(net, 3001, () => 'x')).toBeNull();
    expect(ownerFromNetstat(net, 300, () => 'x')).toBeNull(); // 3000 is not 300
  });

  it('keeps the last non-empty log lines', () => {
    expect(tailLines('a\n\nb\r\nc\n', 2)).toBe('b\nc');
    expect(tailLines('', 5)).toBe('');
  });
});
