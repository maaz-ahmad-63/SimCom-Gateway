import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeRelaySetup, findRepositoryEnv, parseEnvFile, resolveRelaySetup } from '../src/lib/server/relay-env';
import { GET } from '../src/app/api/gateway-status/route';
import { STATUS_ROUTE } from '../src/lib/server/sms-proxy';

const KEY = 'repo-key-0123456789-ABCDEFGHIJ';
const DASH_KEY = 'dashboard-key-9876543210-ZYXWV';
const PROVIDER_SECRET = 'sk-provider-SECRET-must-never-be-copied';

const REPO_ENV = [
  '# the gateway .env',
  'PORT=4100',
  'HOST=0.0.0.0',
  `GATEWAY_API_KEY=${KEY}   # inline comment`,
  `DEEPGRAM_API_KEY=${PROVIDER_SECRET}`,
  'MODEM_DRIVER=hardware',
  'MODEM_AT_PORT=COM20',
].join('\r\n');

/** A repository layout in a temp dir: <root>/.env, <root>/packages/gateway, <root>/packages/dashboard. */
function checkout(envText: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-env-'));
  fs.mkdirSync(path.join(root, 'packages', 'gateway'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'dashboard'), { recursive: true });
  if (envText !== null) fs.writeFileSync(path.join(root, '.env'), envText);
  return { root, cwd: path.join(root, 'packages', 'dashboard'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.unstubAllGlobals();
});

describe('reading an .env file', () => {
  it('takes only the three names the relay needs, and handles quotes, comments, export and CRLF', () => {
    const text = [
      'export GATEWAY_API_KEY="quoted # key"',
      "GATEWAY_INTERNAL_URL='http://10.0.0.5:4000'  # note",
      'PORT=4000\r',
      `OPENAI_API_KEY=${PROVIDER_SECRET}`,
      '  # GATEWAY_API_KEY=commented-out',
      'not a line',
    ].join('\n');
    const parsed = parseEnvFile(text);
    expect(parsed).toEqual({ GATEWAY_API_KEY: 'quoted # key', GATEWAY_INTERNAL_URL: 'http://10.0.0.5:4000', PORT: '4000' });
    expect(JSON.stringify(parsed)).not.toContain(PROVIDER_SECRET);
  });
});

describe('where the dashboard server finds the gateway key and address', () => {
  it("uses the dashboard server's own environment first", () => {
    const c = checkout(REPO_ENV);
    cleanups.push(c.cleanup);
    const setup = resolveRelaySetup({ GATEWAY_API_KEY: DASH_KEY, GATEWAY_INTERNAL_URL: 'http://192.168.1.24:4000/' }, { cwd: c.cwd });
    expect(setup.env.GATEWAY_API_KEY).toBe(DASH_KEY);
    expect(setup).toMatchObject({ keySource: 'dashboard-env', urlSource: 'dashboard-env', gatewayUrl: 'http://192.168.1.24:4000' });
  });

  it("falls back to the repository .env the gateway uses, and contacts the gateway on that file's PORT", () => {
    const c = checkout(REPO_ENV);
    cleanups.push(c.cleanup);
    const setup = resolveRelaySetup({}, { cwd: c.cwd });
    expect(setup.env.GATEWAY_API_KEY).toBe(KEY);
    expect(setup).toMatchObject({ keySource: 'repository-env', urlSource: 'repository-env', gatewayUrl: 'http://127.0.0.1:4100' });
  });

  it('copies nothing else from that file into the dashboard', () => {
    const c = checkout(REPO_ENV);
    cleanups.push(c.cleanup);
    const setup = resolveRelaySetup({}, { cwd: c.cwd });
    expect(Object.keys(setup.env).sort()).toEqual(['DASHBOARD_SMS_ALLOW_REMOTE', 'GATEWAY_API_KEY', 'GATEWAY_INTERNAL_URL']);
    expect(JSON.stringify(setup)).not.toContain(PROVIDER_SECRET);
  });

  it('ignores example keys, and an unusable PORT', () => {
    const c = checkout(['GATEWAY_API_KEY=change-this-to-a-secure-random-token', 'PORT=99999'].join('\n'));
    cleanups.push(c.cleanup);
    const setup = resolveRelaySetup({ GATEWAY_API_KEY: 'dev-secret-api-key-sim7600ei' }, { cwd: c.cwd });
    expect(setup.keySource).toBe('missing');
    expect(setup.env.GATEWAY_API_KEY).toBeUndefined();
    expect(setup.gatewayUrl).toBe('http://127.0.0.1:4000');
    expect(setup.urlSource).toBe('default');
  });

  it('says the key is missing when neither place has it (a dashboard on another machine with no .env.local)', () => {
    const c = checkout(null);
    cleanups.push(c.cleanup);
    const setup = resolveRelaySetup({}, { cwd: c.cwd });
    expect(setup).toMatchObject({ keySource: 'missing', urlSource: 'default', gatewayUrl: 'http://127.0.0.1:4000' });
  });

  it('does not look in a folder that is not a checkout holding the gateway, or when switched off', () => {
    const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-env-lone-'));
    cleanups.push(() => fs.rmSync(lone, { recursive: true, force: true }));
    fs.writeFileSync(path.join(lone, '.env'), REPO_ENV);
    expect(findRepositoryEnv({ cwd: lone })).toBeNull();
    expect(resolveRelaySetup({}, { cwd: lone }).keySource).toBe('missing');

    const c = checkout(REPO_ENV);
    cleanups.push(c.cleanup);
    expect(findRepositoryEnv({ cwd: c.cwd })).toBe(path.join(c.root, '.env'));
    expect(resolveRelaySetup({ DASHBOARD_USE_REPOSITORY_ENV: 'false' }, { cwd: c.cwd }).keySource).toBe('missing');
  });

  it('shows where things came from, never the key', () => {
    const c = checkout(REPO_ENV);
    cleanups.push(c.cleanup);
    const shown = describeRelaySetup(resolveRelaySetup({}, { cwd: c.cwd }));
    expect(shown).toEqual({ gatewayUrl: 'http://127.0.0.1:4100', keyConfigured: true, keySource: 'repository-env', urlSource: 'repository-env' });
    expect(JSON.stringify(shown)).not.toContain(KEY);
  });
});

describe('GET /api/gateway-status', () => {
  const withEnv = (env: Record<string, string | undefined>, run: () => Promise<void>) => async () => {
    const saved = { ...process.env };
    for (const name of ['GATEWAY_API_KEY', 'GATEWAY_INTERNAL_URL', 'DASHBOARD_SMS_ALLOW_REMOTE']) delete process.env[name];
    process.env.DASHBOARD_USE_REPOSITORY_ENV = 'false'; // the checkout's own .env must not decide these tests
    for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
    try {
      await run();
    } finally {
      process.env = saved;
    }
  };
  const request = (headers: Record<string, string> = {}, host = 'localhost:3000') =>
    new Request(`http://${host}/api/gateway-status`, { headers: { host, 'x-dashboard-sms': '1', ...headers } });
  const hardwareStatus = {
    gateway: { driverType: 'hardware', isSimulated: false },
    modem: { connectionState: 'READY', configuredAtPort: 'COM20', configuredAudioPort: 'COM19' },
    call: null,
  };

  it(
    "relays the gateway's AT-free hardware status with the server-side key, and shows which gateway it asked",
    withEnv({ GATEWAY_API_KEY: DASH_KEY, GATEWAY_INTERNAL_URL: 'http://192.168.1.24:4000' }, async () => {
      const upstream = vi.fn(async (_url: string, _init: any) => new Response(JSON.stringify(hardwareStatus), { status: 200 }));
      vi.stubGlobal('fetch', upstream);
      const response = await GET(request());
      const body = await response.json();
      expect(body.gateway).toEqual({ ok: true, status: hardwareStatus });
      expect(body.relay).toEqual({ gatewayUrl: 'http://192.168.1.24:4000', keyConfigured: true, keySource: 'dashboard-env', urlSource: 'dashboard-env' });
      expect(upstream.mock.calls[0][0]).toBe('http://192.168.1.24:4000/api/gateway/hardware/status'); // the endpoint that sends no AT command
      expect(upstream.mock.calls[0][1].method).toBe('GET');
      expect(upstream.mock.calls[0][1].headers['x-api-key']).toBe(DASH_KEY);
      expect(STATUS_ROUTE.gatewayPath).not.toMatch(/health|modem-info|sms/); // /health runs AT queries
      expect(JSON.stringify(body)).not.toContain(DASH_KEY);
      expect(response.headers.get('cache-control')).toBe('no-store');
    })
  );

  it(
    'also answers a dashboard opened by LAN address (read-only), but still needs the dashboard header',
    withEnv({ GATEWAY_API_KEY: DASH_KEY }, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(hardwareStatus), { status: 200 })));
      expect((await GET(request({}, '192.168.1.24:3000'))).status).toBe(200);
      const forged = new Request('http://192.168.1.24:3000/api/gateway-status', { headers: { host: '192.168.1.24:3000' } });
      expect((await GET(forged)).status).toBe(403);
      expect((await GET(request({ 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    })
  );

  it(
    'reports each reason the gateway could not be read, without an error status and without the key',
    withEnv({ GATEWAY_API_KEY: DASH_KEY }, async () => {
      const cases: Array<[string, () => Promise<Response>, string]> = [
        ['rejected key', async () => new Response('{"error":"nope"}', { status: 401 }), 'PROXY_KEY_REJECTED'],
        ['not json', async () => new Response('<html>', { status: 200 }), 'GATEWAY_BAD_RESPONSE'],
        [
          'refused',
          async () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
          },
          'GATEWAY_UNREACHABLE',
        ],
      ];
      for (const [name, reply, code] of cases) {
        vi.stubGlobal('fetch', vi.fn(reply));
        const response = await GET(request());
        const body = await response.json();
        expect(response.status, name).toBe(200);
        expect(body.gateway, name).toMatchObject({ ok: false, code });
        expect(JSON.stringify(body), name).not.toContain(DASH_KEY);
      }
    })
  );

  it(
    'reports a missing key as a configuration problem and does not call the gateway',
    withEnv({}, async () => {
      const upstream = vi.fn();
      vi.stubGlobal('fetch', upstream);
      const body = await (await GET(request())).json();
      expect(body.gateway).toMatchObject({ ok: false, code: 'PROXY_NOT_CONFIGURED' });
      expect(body.relay.keyConfigured).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
    })
  );

  it('has no way to change anything: only GET is exported', async () => {
    const mod = await import('../src/app/api/gateway-status/route');
    expect(Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['GET']);
  });
});
