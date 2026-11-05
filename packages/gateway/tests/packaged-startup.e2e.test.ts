import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The PACKAGED program, started the way an icon starts it: with the bundled Node, from installer/stage/app (made by
 * installer/build-package.ps1). It uses the mock modem driver, its own data folder and its own ports (3101, 4101, 4111), so it never
 * touches the real modem, a running development gateway, or anyone's data. It is skipped when the package folder has not been built.
 */
const app = path.resolve(__dirname, '../../../installer/stage/app');
const node = path.join(app, 'runtime', 'node.exe');
const launch = path.join(app, 'gateway', 'dist', 'supervisor', 'launch.js');
const built = process.platform === 'win32' && fs.existsSync(node) && fs.existsSync(launch);

const builtVersion = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { version: string }).version;
const PORTS = { dashboard: 3101, gateway: 4101, status: 4111 };
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'simgw-pkg-'));
fs.mkdirSync(path.join(data, 'config'), { recursive: true });
const configFile = path.join(data, 'config', 'gateway.env');
const baseConfig = `GATEWAY_API_KEY=${crypto.randomBytes(32).toString('hex')}\nHOST=127.0.0.1\nPORT=${PORTS.gateway}\nMODEM_DRIVER=mock\nCORS_ORIGIN=http://127.0.0.1:${PORTS.dashboard}\n`;
fs.writeFileSync(configFile, baseConfig);

const secretsDir = path.join(data, 'secrets-under-test');
const env = { ...process.env, SIMGW_SECRETS_DIR: secretsDir, SIMGW_DATA_DIR: data, SIMGW_APP_DIR: app, SIMGW_DASHBOARD_PORT: String(PORTS.dashboard), SIMGW_STATUS_PORT: String(PORTS.status), SIMGW_START_TIMEOUT_MS: '90000' };
const run = (...args: string[]) => spawnSync(node, [launch, ...args], { env, encoding: 'utf8', timeout: 150_000 });

const gatewayKey = /GATEWAY_API_KEY=([0-9a-f]{64})/.exec(baseConfig)![1];
const api = async (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.gateway}${url}`, { method, headers: { 'x-api-key': gatewayKey, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  return { status: res.status, text: await res.text() };
};
const credential = async (name: string) => (JSON.parse((await api('GET', '/api/ai/credentials')).text).credentials as Array<{ name: string; source: string }>).find((c) => c.name === name)!;
const CUSTOMER_KEY = 'dg-packaged-customer-secret-ABCDEFGH';

const get = (url: string) =>
  new Promise<{ status: number; body: string } | null>((resolve) => {
    fetch(url, { signal: AbortSignal.timeout(4000) })
      .then(async (r) => resolve({ status: r.status, body: await r.text() }))
      .catch(() => resolve(null));
  });

afterAll(() => {
  if (built) spawnSync(node, [launch, '--stop', '--force'], { env, timeout: 60_000 });
  fs.rmSync(data, { recursive: true, force: true });
});

describe.skipIf(!built)('the packaged program (bundled Node, mock modem, isolated ports)', () => {
  it('starts both services from one click, waits until both are healthy, and opens the setup page the first time', async () => {
    const r = run('--no-browser');
    expect(r.status, r.stderr).toBe(0);
    const gateway = await get(`http://127.0.0.1:${PORTS.gateway}/health`);
    expect(gateway?.status).toBe(200);
    expect(JSON.parse(gateway!.body)).toMatchObject({ status: 'ok', version: builtVersion }); // the version it was built as, not 0.0.0
    expect((await get(`http://127.0.0.1:${PORTS.dashboard}/`))?.status).toBe(200);
    expect((await get(`http://127.0.0.1:${PORTS.dashboard}/setup`))?.status).toBe(200);
    expect(fs.readFileSync(path.join(data, 'logs', 'launcher.log'), 'utf8')).toContain(`ready: http://127.0.0.1:${PORTS.dashboard}/setup`);
    // data goes to the data folder only
    expect(fs.existsSync(path.join(data, 'gateway.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(app, 'gateway', 'gateway.sqlite'))).toBe(false);
  }, 180_000);

  it('made its own encryption key at first start (protected, never shown), so a customer can add a provider key with no file edited', async () => {
    const status = JSON.parse((await get(`http://127.0.0.1:${PORTS.status}/status`))!.body) as { secrets: { state: string; usable: boolean } };
    expect(status.secrets).toMatchObject({ state: 'created', usable: true });
    const keyFile = path.join(secretsDir, 'master.key');
    const key = /SIMGATEWAY-SECRETS-KEY-V1:([0-9a-f]{64})/.exec(fs.readFileSync(keyFile, 'utf8'))![1];
    expect(JSON.stringify(status)).not.toContain(key); // the status page never shows it
    expect(fs.readFileSync(path.join(data, 'logs', 'supervisor.log'), 'utf8')).not.toContain(key);
    expect(JSON.parse((await api('GET', '/api/ai/settings')).text).secretStorageAvailable).toBe(true);
    expect((await credential('DEEPGRAM_API_KEY')).source).toBe('missing'); // "Not configured"
    const saved = await api('PUT', '/api/ai/credentials/DEEPGRAM_API_KEY', { value: CUSTOMER_KEY });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(CUSTOMER_KEY);
    expect((await credential('DEEPGRAM_API_KEY')).source).toBe('stored'); // "Configured"
    expect(fs.readFileSync(path.join(data, 'gateway.sqlite')).includes(Buffer.from(CUSTOMER_KEY))).toBe(false); // encrypted at rest
    if (process.platform === 'win32') {
      const acl = spawnSync('icacls.exe', [keyFile], { encoding: 'utf8' }).stdout;
      expect(acl).toContain(process.env.USERNAME!);
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|Authenticated Users/i);
    }
  }, 60_000);

  it('does not start a second copy on a second click', () => {
    const before = fs.readFileSync(path.join(data, 'supervisor.lock'), 'utf8').trim();
    const r = run('--no-browser');
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(data, 'supervisor.lock'), 'utf8').trim()).toBe(before);
    expect(fs.readFileSync(path.join(data, 'logs', 'launcher.log'), 'utf8')).toContain('already running');
  }, 60_000);

  it('stops cleanly: the gateway finishes by itself (it is not forced) and nothing is left listening', async () => {
    const r = run('--stop');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const log = fs.readFileSync(path.join(data, 'logs', 'supervisor.log'), 'utf8');
    expect(log).toMatch(/\[gateway\] stopped/);
    expect(log).not.toMatch(/\[gateway\] did not stop within/); // the shutdown message reached the gateway's own graceful shutdown
    for (const port of Object.values(PORTS)) expect(await get(`http://127.0.0.1:${port}/`)).toBeNull();
  }, 60_000);

  it('keeps the saved key across a restart: the same encryption key is found, never regenerated', async () => {
    const keyFile = path.join(secretsDir, 'master.key');
    const before = fs.readFileSync(keyFile, 'utf8');
    const r = run('--no-browser');
    expect(r.status, r.stderr).toBe(0);
    const status = JSON.parse((await get(`http://127.0.0.1:${PORTS.status}/status`))!.body) as { secrets: { state: string } };
    expect(status.secrets.state).toBe('ok'); // read, not created
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(before);
    expect((await credential('DEEPGRAM_API_KEY')).source).toBe('stored'); // still Configured after the restart
    expect((await api('DELETE', '/api/ai/credentials/DEEPGRAM_API_KEY')).status).toBe(200); // and it can be removed
    expect((await credential('DEEPGRAM_API_KEY')).source).toBe('missing');
    const stop = run('--stop');
    expect(stop.status, stop.stdout + stop.stderr).toBe(0);
  }, 180_000);

  it('explains a port that something else uses, and starts nothing', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(PORTS.dashboard, '127.0.0.1', resolve));
    try {
      const r = run('--no-browser');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Port ${PORTS.dashboard}`);
      expect(r.stderr).toContain('the dashboard');
      expect(r.stderr).toMatch(/\(process \d+\)/);
      expect(await get(`http://127.0.0.1:${PORTS.gateway}/health`)).toBeNull();
    } finally {
      blocker.close();
    }
  }, 60_000);

  it('explains a data folder that cannot be written, and starts nothing', async () => {
    const file = path.join(os.tmpdir(), `simgw-block-${process.pid}.txt`);
    fs.writeFileSync(file, 'x');
    try {
      const r = spawnSync(node, [launch, '--no-browser'], { env: { ...env, SIMGW_DATA_DIR: path.join(file, 'data') }, encoding: 'utf8', timeout: 60_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('cannot write to its data folder');
      expect(await get(`http://127.0.0.1:${PORTS.gateway}/health`)).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  }, 60_000);

  it('gives up with a plain message when the gateway keeps crashing, instead of waiting or opening a dead page', async () => {
    fs.writeFileSync(configFile, `${baseConfig}MODEM_AT_BAUD=not-a-number\n`); // the gateway refuses to start with this
    const r = run('--no-browser');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The gateway could not start');
    expect(r.stderr).toMatch(/gave up restarting/);
    expect(r.stderr).toContain('Details are in the log folder');
    spawnSync(node, [launch, '--stop', '--force'], { env, timeout: 60_000 });
    fs.writeFileSync(configFile, baseConfig);
  }, 120_000);
});

// keep the unused import honest for tools that list it
void spawn;
