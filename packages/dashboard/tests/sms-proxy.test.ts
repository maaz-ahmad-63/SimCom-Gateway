import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccessInput,
  checkAccess,
  forwardToGateway,
  hostnameOf,
  parseSendBody,
  pickQuery,
  ProxyEnv,
  resolveRoute,
} from '../src/lib/server/sms-proxy';
import { GET, POST } from '../src/app/api/sms/[[...path]]/route';

const KEY = 'gw-secret-key-0123456789-ABCDEF';
const ENV: ProxyEnv = { GATEWAY_API_KEY: KEY };

const get = (over: Partial<AccessInput> = {}): AccessInput => ({ method: 'GET', host: 'localhost:3000', origin: null, contentType: null, uiHeader: '1', secFetchSite: 'same-origin', ...over });
const post = (over: Partial<AccessInput> = {}): AccessInput => get({ method: 'POST', origin: 'http://localhost:3000', contentType: 'application/json', ...over });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('who may use the relay', () => {
  it('reads the hostname from a Host header', () => {
    expect(hostnameOf('localhost:3000')).toBe('localhost');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:3000')).toBe('::1');
    expect(hostnameOf('LOCALHOST:3000')).toBe('localhost');
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf('')).toBeNull();
  });

  it('accepts the dashboard opened on the machine that runs it', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) expect(checkAccess(get({ host }), ENV), host).toEqual({ ok: true });
    expect(checkAccess(post(), ENV)).toEqual({ ok: true });
  });

  it('refuses other hosts (a LAN address, or a name pointed at this machine) unless allowed on purpose', () => {
    for (const host of ['192.168.1.20:3000', 'evil.example.com:3000', 'localhost.evil.com']) {
      const result = checkAccess(get({ host, origin: null }), ENV);
      expect(result, host).toMatchObject({ ok: false, status: 403, code: 'PROXY_FORBIDDEN_HOST' });
    }
    expect(checkAccess(get({ host: '192.168.1.20:3000' }), { ...ENV, DASHBOARD_SMS_ALLOW_REMOTE: 'true' })).toEqual({ ok: true });
    expect(checkAccess(get({ host: '192.168.1.20:3000' }), { ...ENV, DASHBOARD_SMS_ALLOW_REMOTE: 'yes' })).toMatchObject({ ok: false }); // only the exact value
  });

  it('needs the dashboard header, and refuses cross-site requests', () => {
    expect(checkAccess(get({ uiHeader: null }), ENV)).toMatchObject({ ok: false, status: 403, code: 'PROXY_FORBIDDEN' });
    expect(checkAccess(get({ uiHeader: '0' }), ENV)).toMatchObject({ ok: false });
    expect(checkAccess(get({ secFetchSite: 'cross-site' }), ENV)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(get({ secFetchSite: 'same-site' }), ENV)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(get({ secFetchSite: null }), ENV)).toEqual({ ok: true }); // non-browser client on the same machine
  });

  it('protects POST against forged cross-site requests: JSON only, and the Origin must be this dashboard', () => {
    expect(checkAccess(post({ contentType: 'text/plain' }), ENV)).toMatchObject({ ok: false, status: 415 });
    expect(checkAccess(post({ contentType: null }), ENV)).toMatchObject({ ok: false, status: 415 });
    expect(checkAccess(post({ contentType: 'application/json; charset=utf-8' }), ENV)).toEqual({ ok: true });
    expect(checkAccess(post({ origin: null }), ENV)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(post({ origin: 'http://evil.example.com' }), ENV)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(post({ origin: 'http://localhost:3001' }), ENV)).toMatchObject({ ok: false, status: 403 });
    expect(checkAccess(post({ origin: 'not a url' }), ENV)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('which gateway endpoints are reachable', () => {
  it('routes only the SMS page\'s own operations', () => {
    expect(resolveRoute('GET', [])).toMatchObject({ gatewayPath: '/api/gateway/sms', isSend: false });
    expect(resolveRoute('GET', ['status'])).toMatchObject({ gatewayPath: '/api/gateway/sms/status' });
    expect(resolveRoute('GET', ['inbox'])).toMatchObject({ gatewayPath: '/api/gateway/sms/inbox' });
    expect(resolveRoute('GET', ['7'])).toMatchObject({ gatewayPath: '/api/gateway/sms/7' });
    expect(resolveRoute('POST', ['send'])).toMatchObject({ gatewayPath: '/api/gateway/sms/send', isSend: true });
    expect(resolveRoute('POST', ['sync'])).toMatchObject({ gatewayPath: '/api/gateway/sms/sync', isSend: false });
  });

  it('never routes the modem-settings write, other methods, other paths or traversal', () => {
    const blocked: Array<[string, string[]]> = [
      ['POST', ['text-parameters']],
      ['GET', ['text-parameters']],
      ['DELETE', ['inbox']],
      ['PUT', ['send']],
      ['GET', ['send']],
      ['POST', ['inbox']],
      ['POST', ['status']],
      ['GET', ['sync']],
      ['GET', ['abc']],
      ['GET', ['1000']],
      ['GET', ['..']],
      ['GET', ['..', 'hardware']],
      ['GET', ['inbox', 'extra']],
      ['POST', ['send', 'extra']],
      ['GET', ['%2e%2e']],
      ['GET', ['1;AT']],
    ];
    for (const [method, segments] of blocked) expect(resolveRoute(method, segments), `${method} ${segments.join('/')}`).toBeNull();
  });

  it('passes on only the query parameters a route understands', () => {
    expect(pickQuery('?direction=sent&limit=20&confirm=APPLY&x=1', ['direction', 'limit', 'offset'])).toBe('?direction=sent&limit=20');
    expect(pickQuery('?markRead=true&status=unread', ['status', 'markRead'])).toBe('?status=unread&markRead=true');
    expect(pickQuery('?anything=1', [])).toBe('');
    expect(pickQuery('?direction=' + 'x'.repeat(100), ['direction'])).toBe('');
  });

  it('accepts a send body of exactly { to, message }', () => {
    expect(parseSendBody('{"to":"+919876543210","message":"Hi"}')).toEqual({ to: '+919876543210', message: 'Hi' });
    for (const bad of ['', 'not json', '[]', 'null', '{"to":"+9198"}', '{"to":"+919876543210","message":"Hi","extra":1}', '{"to":5,"message":"Hi"}', '{"to":"+919876543210","message":"' + 'a'.repeat(5000) + '"}']) {
      expect(parseSendBody(bad), bad.slice(0, 30)).toMatchObject({ ok: false });
    }
  });
});

type Upstream = { status: number; text: () => Promise<string> };
const reply = (status: number, body: unknown): Upstream => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

describe('forwarding to the gateway', () => {
  const route = resolveRoute('GET', ['inbox'])!;
  const sendRoute = resolveRoute('POST', ['send'])!;

  it('adds the key on the server, sends no browser header, and passes the answer through', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => reply(200, { success: true, messages: [], total: 0 }));
    const result = await forwardToGateway({ route, method: 'GET', search: '?direction=sent&evil=1' }, ENV, fetchImpl);
    expect(result).toEqual({ status: 200, body: { success: true, messages: [], total: 0 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/gateway/sms/inbox?direction=sent');
    expect(init.headers['x-api-key']).toBe(KEY);
    expect(Object.keys(init.headers).sort()).toEqual(['accept', 'x-api-key']); // no cookie, authorization, origin or host
    expect(init.body).toBeUndefined();
  });

  it('uses GATEWAY_INTERNAL_URL when given, and sends a JSON body only for send', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => reply(200, { success: true }));
    await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{"to":"+919876543210","message":"Hi"}' }, { ...ENV, GATEWAY_INTERNAL_URL: 'http://10.0.0.5:4000/' }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://10.0.0.5:4000/api/gateway/sms/send');
    expect(init).toMatchObject({ method: 'POST', body: '{"to":"+919876543210","message":"Hi"}' });
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('keeps the gateway\'s error answers (status and code) so the page can explain them', async () => {
    const fetchImpl = vi.fn(async () => reply(409, { success: false, code: 'CALL_IN_PROGRESS', error: 'A call is in progress' }));
    expect(await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, fetchImpl)).toEqual({ status: 409, body: { success: false, code: 'CALL_IN_PROGRESS', error: 'A call is in progress' } });
    const unknown = vi.fn(async () => reply(504, { success: false, code: 'SMS_OUTCOME_UNKNOWN', error: 'The message MAY have been sent' }));
    expect((await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, unknown)).body.code).toBe('SMS_OUTCOME_UNKNOWN');
  });

  it('says what to set up when the dashboard server has no key, without calling the gateway', async () => {
    const fetchImpl = vi.fn();
    for (const env of [{}, { GATEWAY_API_KEY: '' }, { GATEWAY_API_KEY: '   ' }]) {
      const result = await forwardToGateway({ route, method: 'GET', search: '' }, env, fetchImpl);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('PROXY_NOT_CONFIGURED');
      expect(String(result.body.error)).toMatch(/GATEWAY_API_KEY/);
      expect(String(result.body.error)).toMatch(/never sent to the browser/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a wrong key is reported as a setup problem; the gateway\'s own message is not passed on', async () => {
    const fetchImpl = vi.fn(async () => reply(401, { success: false, error: 'Unauthorized: Invalid API key', code: 'UNAUTHORIZED' }));
    const result = await forwardToGateway({ route, method: 'GET', search: '' }, ENV, fetchImpl);
    expect(result).toMatchObject({ status: 502, body: { code: 'PROXY_KEY_REJECTED' } });
  });

  it('distinguishes "nothing was sent" from "maybe sent" when the gateway cannot be reached', async () => {
    const refused = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, refused)).toMatchObject({ status: 502, body: { code: 'GATEWAY_UNREACHABLE' } });
    expect((await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, refused)).body.error).toMatch(/Nothing was sent/);

    const reset = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    expect(await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, reset)).toMatchObject({ status: 502, body: { code: 'PROXY_UNCERTAIN' } });
    expect((await forwardToGateway({ route, method: 'GET', search: '' }, ENV, reset)).body.code).toBe('GATEWAY_UNREACHABLE'); // a read can simply be repeated
  });

  it('a gateway answer that is not JSON is uncertain for a send and an error for a read', async () => {
    const html = vi.fn(async () => reply(502, '<html>Bad gateway</html>'));
    expect((await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, html)).body.code).toBe('PROXY_UNCERTAIN');
    expect((await forwardToGateway({ route, method: 'GET', search: '' }, ENV, html)).body.code).toBe('GATEWAY_BAD_RESPONSE');
  });

  it('stops waiting after a long time, and for a send reports the outcome as unknown', async () => {
    vi.useFakeTimers();
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Upstream>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const send = forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, hang);
    await vi.advanceTimersByTimeAsync(90_000);
    const sent = await send;
    expect(sent).toMatchObject({ status: 504, body: { code: 'PROXY_TIMEOUT' } });
    expect(String(sent.body.error)).toMatch(/MAY have been sent/);

    const read = forwardToGateway({ route, method: 'GET', search: '' }, ENV, hang);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await read).toMatchObject({ status: 504, body: { code: 'GATEWAY_TIMEOUT' } });
  });

  it('never retries, whatever happens (a repeated send could send twice)', async () => {
    const scenarios: Array<() => Promise<Upstream>> = [
      async () => reply(500, { success: false }),
      async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      },
      async () => reply(200, 'not json'),
      async () => reply(401, {}),
    ];
    for (const scenario of scenarios) {
      const fetchImpl = vi.fn(scenario);
      await forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('the key is never in anything returned to the browser', async () => {
    const outcomes = await Promise.all([
      forwardToGateway({ route, method: 'GET', search: '' }, ENV, async () => reply(200, { success: true })),
      forwardToGateway({ route, method: 'GET', search: '' }, ENV, async () => reply(401, { error: `bad key ${KEY}` })),
      forwardToGateway({ route, method: 'GET', search: '' }, ENV, async () => {
        throw new Error(`failed with ${KEY}`);
      }),
      forwardToGateway({ route: sendRoute, method: 'POST', search: '', body: '{}' }, ENV, async () => reply(200, 'oops')),
      forwardToGateway({ route, method: 'GET', search: '' }, {}, async () => reply(200, {})),
    ]);
    for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toContain(KEY);
  });
});

describe('the route handler, end to end with a stubbed gateway', () => {
  const withEnv = (env: Record<string, string | undefined>, run: () => Promise<void>) => async () => {
    const saved = { ...process.env };
    // (process.env turns an assigned undefined into the text "undefined", so unset values are deleted.)
    for (const name of ['GATEWAY_API_KEY', 'GATEWAY_INTERNAL_URL', 'DASHBOARD_SMS_ALLOW_REMOTE']) delete process.env[name];
    // The checkout's own .env must never decide these tests' outcome.
    process.env.DASHBOARD_USE_REPOSITORY_ENV = 'false';
    for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
    try {
      await run();
    } finally {
      process.env = saved;
    }
  };

  const request = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    new Request(`http://localhost:3000/api/sms${path}`, { method, headers: { host: 'localhost:3000', 'x-dashboard-sms': '1', ...headers }, body });
  const ctx = (path: string[] = []) => ({ params: { path } });

  it(
    'relays an inbox read with the server-side key',
    withEnv({ GATEWAY_API_KEY: KEY }, async () => {
      const upstream = vi.fn(async (_url: string, _init: any) => new Response(JSON.stringify({ success: true, messages: [], total: 0, unread: 0, inbox: null }), { status: 200 }));
      vi.stubGlobal('fetch', upstream);
      const response = await GET(request('GET', '/inbox?direction=received'), ctx(['inbox']));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, total: 0 });
      expect(upstream.mock.calls[0][0]).toBe('http://127.0.0.1:4000/api/gateway/sms/inbox?direction=received');
      expect(upstream.mock.calls[0][1].headers['x-api-key']).toBe(KEY);
      expect(response.headers.get('cache-control')).toBe('no-store');
    })
  );

  it(
    'relays a send as exactly { to, message } and returns the gateway\'s answer',
    withEnv({ GATEWAY_API_KEY: KEY }, async () => {
      const upstream = vi.fn(async (_url: string, _init: any) => new Response(JSON.stringify({ success: true, to: '+919876543210', messageReference: 4 }), { status: 200 }));
      vi.stubGlobal('fetch', upstream);
      const response = await POST(
        request('POST', '/send', { 'content-type': 'application/json', origin: 'http://localhost:3000' }, '{"to":"+919876543210","message":"Hello"}'),
        ctx(['send'])
      );
      expect(response.status).toBe(200);
      expect((await response.json()).messageReference).toBe(4);
      expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({ to: '+919876543210', message: 'Hello' });
    })
  );

  it(
    'refuses a forged or malformed request without calling the gateway',
    withEnv({ GATEWAY_API_KEY: KEY }, async () => {
      const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', upstream);
      const send = '{"to":"+919876543210","message":"Hello"}';
      const json = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
      const cases: Array<[string, Promise<Response>]> = [
        ['no dashboard header', POST(new Request('http://localhost:3000/api/sms/send', { method: 'POST', headers: { host: 'localhost:3000', ...json }, body: send }), ctx(['send']))],
        ['foreign origin', POST(request('POST', '/send', { ...json, origin: 'http://evil.example.com' }, send), ctx(['send']))],
        ['text/plain body', POST(request('POST', '/send', { 'content-type': 'text/plain', origin: 'http://localhost:3000' }, send), ctx(['send']))],
        ['LAN host', POST(request('POST', '/send', { ...json, host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' }, send), ctx(['send']))],
        ['extra field', POST(request('POST', '/send', json, '{"to":"+919876543210","message":"Hi","extra":1}'), ctx(['send']))],
        ['text-parameters', POST(request('POST', '/text-parameters', json, '{"confirm":"APPLY AT+CSMP=17,167,0,0"}'), ctx(['text-parameters']))],
        ['unknown path', GET(request('GET', '/hardware'), ctx(['hardware']))],
      ];
      const statuses: Record<string, number> = {};
      for (const [name, promise] of cases) statuses[name] = (await promise).status;
      expect(statuses).toEqual({ 'no dashboard header': 403, 'foreign origin': 403, 'text/plain body': 415, 'LAN host': 403, 'extra field': 400, 'text-parameters': 404, 'unknown path': 404 });
      expect(upstream).not.toHaveBeenCalled();
    })
  );

  it(
    'tells the page when the dashboard server has no key',
    withEnv({ GATEWAY_API_KEY: undefined }, async () => {
      const upstream = vi.fn();
      vi.stubGlobal('fetch', upstream);
      const response = await GET(request('GET', '/inbox'), ctx(['inbox']));
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('PROXY_NOT_CONFIGURED');
      expect(upstream).not.toHaveBeenCalled();
    })
  );
});
