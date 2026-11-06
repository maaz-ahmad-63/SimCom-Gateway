import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Automatic connection of the installed dashboard: the server route trades the gateway key (read from the local config file) for a
 * short-lived session token; the browser keeps only the token, in memory, and removes keys older versions saved.
 */

const MASTER = 'master-gateway-key-0123456789abcdef';
const TOKEN_A = `st_${'a'.repeat(64)}`;
const TOKEN_B = `st_${'b'.repeat(64)}`;

describe('GET /api/local-config (server route)', () => {
  let dir: string;
  const env = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localcfg-'));
    fs.writeFileSync(path.join(dir, 'gateway.env'), `GATEWAY_API_KEY=${MASTER}\nPORT=4000\n`);
    process.env.SIMGW_LOCAL_CONFIG = '1';
    process.env.SIMGW_CONFIG_FILE = path.join(dir, 'gateway.env');
    process.env.SIMGW_GATEWAY_URL = 'http://127.0.0.1:4000';
  });
  afterEach(() => {
    process.env = { ...env };
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const call = async (headers: Record<string, string>) => {
    const { GET } = await import('../src/app/api/local-config/route');
    const res = await GET(new Request('http://127.0.0.1:3000/api/local-config', { headers }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const ok = { host: '127.0.0.1:3000', 'x-dashboard-sms': '1', 'sec-fetch-site': 'same-origin' };

  it('returns a session token minted with the master key, never the key itself', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get('x-api-key') });
      return new Response(JSON.stringify({ success: true, token: TOKEN_A, expiresAt: '2030-01-01T00:00:00.000Z' }), { status: 200 });
    });
    const r = await call(ok);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, gatewayUrl: 'http://127.0.0.1:4000', sessionToken: TOKEN_A, expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(JSON.stringify(r.body)).not.toContain(MASTER);
    expect(seen).toEqual([{ url: 'http://127.0.0.1:4000/api/auth/session', key: MASTER }]); // the key went only to the local gateway
  });

  it('refuses another computer, another website and a request without the dashboard header (no token is minted)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await call({ ...ok, host: '192.168.1.50:3000' })).status).toBe(403); // opened from another computer / a rebinding name
    expect((await call({ ...ok, origin: 'https://evil.example' })).status).toBe(403); // another website
    expect((await call({ host: '127.0.0.1:3000' })).status).toBe(403); // no custom header
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is off outside the packaged product, and reports an unreachable or refusing gateway without retry loops', async () => {
    process.env.SIMGW_LOCAL_CONFIG = '0';
    expect((await call(ok)).status).toBe(404);
    process.env.SIMGW_LOCAL_CONFIG = '1';
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await call(ok)).body).toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }));
    expect((await call(ok))).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
  });
});

describe('the browser side (config.ts)', () => {
  let store: Map<string, string>;
  let events: string[];
  let tokens: string[];
  let localConfigStatus: number;

  beforeEach(async () => {
    store = new Map();
    events = [];
    tokens = [TOKEN_A, TOKEN_B];
    localConfigStatus = 200;
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1' },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      dispatchEvent: (e: Event) => void events.push(e.type),
    });
    vi.stubGlobal('localStorage', (globalThis as any).window.localStorage);
    vi.stubGlobal('CustomEvent', class extends Event {
      constructor(type: string) {
        super(type);
      }
    });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url !== '/api/local-config') throw new Error(`unexpected ${url}`);
      if (localConfigStatus !== 200) return new Response('{}', { status: localConfigStatus });
      return new Response(JSON.stringify({ success: true, gatewayUrl: 'http://127.0.0.1:4000', sessionToken: tokens.shift(), expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() }), { status: 200 });
    });
    const cfg = await import('../src/lib/config');
    cfg.resetLocalSessionForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('fresh install: connects with a session token and stores nothing in the browser', async () => {
    const cfg = await import('../src/lib/config');
    expect(await cfg.ensureLocalSession()).toBe(true);
    expect(cfg.getGatewayClientConfig()).toEqual({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: TOKEN_A });
    expect(cfg.isLocalSession()).toBe(true);
    expect(store.size).toBe(0);
    expect(events).toContain('gateway-config-changed');
  });

  it('an existing install with a wrong saved key: the old key is removed and the session is used instead', async () => {
    store.set('sim_gateway_api_key', 'an-old-key-from-a-previous-install');
    store.set('sim_gateway_url', 'http://127.0.0.1:4000');
    const cfg = await import('../src/lib/config');
    await cfg.bootstrapLocalConfig();
    expect(store.has('sim_gateway_api_key')).toBe(false);
    expect(store.has('sim_gateway_url')).toBe(false);
    expect(cfg.getGatewayClientConfig().apiKey).toBe(TOKEN_A);
  });

  it('expired token or gateway restart (401): one renewal gives a fresh token; it does not loop', async () => {
    const cfg = await import('../src/lib/config');
    await cfg.ensureLocalSession();
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ['Date'] });
    expect(await cfg.renewAfterAuthFailure()).toBe(true);
    expect(cfg.getGatewayClientConfig().apiKey).toBe(TOKEN_B);
    // a second 401 straight away does not ask again (no storm into the gateway's failure limit)
    tokens.push(`st_${'c'.repeat(64)}`);
    await cfg.renewAfterAuthFailure();
    expect(cfg.getGatewayClientConfig().apiKey).toBe(TOKEN_B);
    vi.useRealTimers();
  });

  it('concurrent first requests share one session request', async () => {
    let calls = 0;
    const realFetch = (globalThis as any).fetch;
    vi.stubGlobal('fetch', async (u: string) => {
      calls++;
      return realFetch(u);
    });
    const cfg = await import('../src/lib/config');
    await Promise.all([cfg.ensureLocalSession(), cfg.ensureLocalSession(), cfg.ensureLocalSession()]);
    expect(calls).toBe(1);
  });

  it('not the packaged dashboard (404): the key saved in Settings is used, as before', async () => {
    localConfigStatus = 404;
    store.set('sim_gateway_api_key', 'a-key-entered-in-settings');
    const cfg = await import('../src/lib/config');
    expect(await cfg.ensureLocalSession()).toBe(false);
    expect(cfg.isLocalSession()).toBe(false);
    expect(cfg.getGatewayClientConfig().apiKey).toBe('a-key-entered-in-settings');
    expect(store.get('sim_gateway_api_key')).toBe('a-key-entered-in-settings');
    expect(await cfg.renewAfterAuthFailure()).toBe(false);
  });
});

describe('source rules', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '../src', f), 'utf8');
  it('the browser never writes a session token or the master key to storage', () => {
    const cfg = read('lib/config.ts');
    // the only storage writes are the manual (remote) Settings key, inside saveGatewayClientConfig
    const writes = cfg.match(/localStorage\.setItem\([^)]*\)/g) ?? [];
    expect(writes).toEqual(['localStorage.setItem(STORAGE_KEY_URL, cleanUrl)', 'localStorage.setItem(STORAGE_KEY_API_KEY, cleanKey)']);
    expect(cfg).not.toMatch(/sessionStorage\s*[.[]/);
    expect(read('app/api/local-config/route.ts')).not.toMatch(/apiKey:\s*key/);
  });
  it('Settings no longer claims the key is kept in a "browser session"', () => {
    expect(read('app/settings/page.tsx')).not.toMatch(/browser session/);
  });
});
