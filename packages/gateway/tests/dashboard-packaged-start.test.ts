import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectFailure, sanitizeChildOutput, summarizeFailure } from '../src/supervisor/child-output.js';
import { buildSpecs, resolveLayout } from '../src/supervisor/launcher.js';
import { spawnWithStderrFile } from '../src/supervisor/spawn-service.js';
import { ServiceSupervisor, ServiceSpec } from '../src/supervisor/supervisor.js';

/**
 * The installed dashboard stopped at once with exit code 1 and the supervisor logged nothing useful, because the packaged dashboard had no
 * node_modules (its standalone build was made from a checkout whose node_modules was a junction) and its standard error was discarded.
 * These tests pin both halves: the reason is now captured and logged (sanitized), and, with SIMGW_PACKAGED_APP pointing at a built program
 * folder, the real packaged dashboard is started the way the supervisor starts it and must answer over HTTP.
 */

const NODE_MISSING_MODULE = `node:internal/modules/cjs/loader:1433
  throw err;
  ^

Error: Cannot find module 'next'
Require stack:
- C:\\Users\\Customer\\AppData\\Local\\Programs\\SIZH IT Solution\\dashboard\\packages\\dashboard\\server.js
    at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
    at Module.require (node:internal/modules/cjs/loader:1527:12) {
  code: 'MODULE_NOT_FOUND'
}

Node.js v22.23.3
`;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simgw-dash-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

describe('what the supervisor says when a service stops at once', () => {
  it('summarizes Node\'s "Cannot find module" crash into one line with the module and the file that needed it', () => {
    const s = summarizeFailure(NODE_MISSING_MODULE)!;
    expect(s).toMatch(/^Error: Cannot find module 'next' \| Require stack:/);
    expect(s).not.toMatch(/node:internal|at Function|\^/);
  });

  it('never repeats credentials a service printed', () => {
    const raw = 'Error: request failed\nGATEWAY_API_KEY=0123456789abcdef0123456789abcdef x-api-key: abcdefghijklmnop Bearer eyJhbGciOiJIUzI1NiJ9.payload\nSIMGATEWAY-SECRETS-KEY-V1:' + 'ab'.repeat(32) + ' sk-live-ABCDEFGHIJKLMNOPQRST';
    const s = sanitizeChildOutput(raw);
    for (const leaked of ['0123456789abcdef0123456789abcdef', 'abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9', 'abababab', 'ABCDEFGHIJKLMNOPQRST']) expect(s).not.toContain(leaked);
    expect(s).toContain('Error: request failed');
  });

  it('returns nothing for empty output, and the last lines when there is no error line', () => {
    expect(summarizeFailure('')).toBeNull();
    expect(summarizeFailure('starting\nlistening failed silently\nbye')).toBe('starting | listening failed silently | bye');
  });

  it('rewrites the captured file to its sanitized form after reading it', () => {
    const f = path.join(tmp, 'dashboard-stderr.log');
    fs.writeFileSync(f, `${NODE_MISSING_MODULE}\nGATEWAY_API_KEY=deadbeefdeadbeefdeadbeefdeadbeef`);
    expect(collectFailure(f)).toMatch(/Cannot find module 'next'/);
    expect(fs.readFileSync(f, 'utf8')).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef');
    expect(collectFailure(path.join(tmp, 'missing.log'))).toBeNull();
  });
});

describe('a real child that dies at start, run exactly through the supervisor', () => {
  it('logs the real reason for every crash, stops after the limit, and reports it as failed, never as ready', async () => {
    const entry = path.join(tmp, 'server.js');
    fs.writeFileSync(entry, "console.error('GATEWAY_API_KEY=' + 'f'.repeat(40)); require('next');\n");
    const stderrFile = path.join(tmp, 'logs', 'dashboard-stderr.log');
    const spec: ServiceSpec = { name: 'dashboard', command: process.execPath, args: [entry], cwd: tmp, env: { ...process.env } };
    const lines: string[] = [];
    const sup = new ServiceSupervisor(spec, {
      spawn: ((s: ServiceSpec) => spawnWithStderrFile(s, stderrFile)) as never,
      diagnose: () => collectFailure(stderrFile),
      log: (level, m) => lines.push(`${level} ${m}`),
      backoffMs: [20],
      maxCrashes: 3,
    });
    sup.start();
    expect(await until(() => sup.status().state === 'failed', 20_000)).toBe(true);
    const crashes = lines.filter((l) => /exited \(code 1/.test(l));
    expect(crashes).toHaveLength(3);
    for (const c of crashes) expect(c).toMatch(/Cannot find module 'next'/);
    const st = sup.status();
    expect(st.crashLoop).toBe(true);
    expect(st.lastError).toMatch(/Cannot find module 'next'/);
    expect(st.message).toMatch(/Stopped after 3 crashes.*Last error: Error: Cannot find module 'next'/);
    expect(lines.join('\n')).not.toContain('f'.repeat(40)); // the secret the child printed is not in the log
    expect(fs.readFileSync(stderrFile, 'utf8')).not.toContain('f'.repeat(40)); // nor left on disk
  });

  it('a clean stop is not a failure: no error is collected or reported', async () => {
    const entry = path.join(tmp, 'server.js');
    fs.writeFileSync(entry, "process.on('message', (m) => { if (m && m.type === 'shutdown') process.exit(0); }); setInterval(() => {}, 1000);\n");
    let diagnosed = 0;
    const stderrFile = path.join(tmp, 'logs', 'dashboard-stderr.log');
    const sup = new ServiceSupervisor({ name: 'dashboard', command: process.execPath, args: [entry], cwd: tmp, env: { ...process.env } }, {
      spawn: ((s: ServiceSpec) => spawnWithStderrFile(s, stderrFile)) as never,
      diagnose: () => {
        diagnosed++;
        return 'should not be asked';
      },
    });
    sup.start();
    await new Promise((r) => setTimeout(r, 300));
    await sup.stop(3000);
    expect(sup.status().state).toBe('stopped');
    expect(sup.status().lastError).toBeNull();
    expect(diagnosed).toBe(0);
  });
});

const packaged = process.env.SIMGW_PACKAGED_APP;
describe.skipIf(!packaged)('the REAL packaged dashboard, started the way the supervisor starts it (SIMGW_PACKAGED_APP)', () => {
  const startViaSupervisor = async (appDir: string, nodeExe: string, port: number) => {
    const dataDir = path.join(tmp, 'data');
    const env = { ...process.env, SIMGW_DATA_DIR: dataDir, SIMGW_SECRETS_DIR: path.join(tmp, 'secrets'), SIMGW_NODE: nodeExe, SIMGW_DASHBOARD_PORT: String(port) };
    const layout = resolveLayout(appDir, env);
    const spec = buildSpecs(layout, env).dashboard; // the same command, arguments, working folder and environment as main.ts
    const stderrFile = path.join(dataDir, 'logs', 'dashboard-stderr.log');
    const lines: string[] = [];
    const sup = new ServiceSupervisor(spec, { spawn: ((s: ServiceSpec) => spawnWithStderrFile(s, stderrFile)) as never, diagnose: () => collectFailure(stderrFile), log: (l, m) => lines.push(m), backoffMs: [50], maxCrashes: 2 });
    sup.start();
    return { sup, lines, spec };
  };

  it('starts and answers HTTP on its port', async () => {
    const port = await freePort();
    const { sup, spec } = await startViaSupervisor(packaged!, path.join(packaged!, 'runtime', 'node.exe'), port);
    expect(spec.args[0]).toBe(path.join(packaged!, 'dashboard', 'packages', 'dashboard', 'server.js'));
    let status = 0;
    const end = Date.now() + 45_000;
    while (Date.now() < end && status === 0 && sup.status().state !== 'failed') {
      try {
        status = (await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) })).status;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    await sup.stop(5000);
    expect(status).toBeGreaterThan(0);
    expect(status).toBeLessThan(500);
  }, 60_000);

  it('with the dependencies missing (as in the broken installers) it fails with the real reason in the log', async () => {
    // a copy of the program folder WITHOUT dashboard\node_modules, which is what the worktree-built installers contained
    const app = path.join(tmp, 'app with spaces');
    fs.cpSync(path.join(packaged!, 'dashboard'), path.join(app, 'dashboard'), { recursive: true, filter: (src) => !src.startsWith(path.join(packaged!, 'dashboard', 'node_modules')) });
    const port = await freePort();
    const { sup, lines } = await startViaSupervisor(app, path.join(packaged!, 'runtime', 'node.exe'), port);
    expect(await until(() => sup.status().state === 'failed', 30_000)).toBe(true);
    expect(sup.status().lastError).toMatch(/Cannot find module 'next'/);
    expect(lines.join('\n')).toMatch(/exited \(code 1, signal none\): Error: Cannot find module 'next'/);
  }, 60_000);
});
