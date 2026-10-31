/**
 * SERVER-ONLY. Never import this from a component or any file that runs in the browser.
 *
 * The SMS page does not hold the gateway API key. Its requests go to this dashboard server (/api/sms/...), which adds the key
 * from its own environment and forwards them to the gateway. The key is read only here, from process.env on the server, and
 * is never part of a response, an error message, or a client bundle (it is not a NEXT_PUBLIC_ variable).
 *
 * The dashboard has no login of its own, so this relay must not become a way for anyone who can reach the dashboard port to
 * send SMS. It therefore:
 *  - only answers a loopback Host (localhost, 127.0.0.1, ::1) unless DASHBOARD_SMS_ALLOW_REMOTE=true (a Host header can be
 *    forged by a client on the LAN, so this is a safeguard against casual access and DNS rebinding, not authentication);
 *  - needs the custom header x-dashboard-sms (a browser cannot add it to a cross-site request without a CORS preflight,
 *    which this server never approves), and for POST a JSON content type and a same-origin Origin (CSRF);
 *  - forwards only an allowlist of gateway paths: status, inbox, sync, the live list, one message, and send. The write
 *    operation for the modem's text-mode parameters (/text-parameters) is deliberately NOT reachable from here.
 */

export const SMS_UI_HEADER = 'x-dashboard-sms';
const GATEWAY_SMS_BASE = '/api/gateway/sms';

export interface ProxyEnv {
  GATEWAY_API_KEY?: string;
  GATEWAY_INTERNAL_URL?: string;
  DASHBOARD_SMS_ALLOW_REMOTE?: string;
}

export interface ProxyFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

const fail = (status: number, code: string, message: string): ProxyFailure => ({ ok: false, status, code, message });

// ---------------------------------------------------------------------------------------------------- access control

export interface AccessInput {
  method: string;
  host: string | null;
  origin: string | null;
  contentType: string | null;
  uiHeader: string | null;
  secFetchSite: string | null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** "localhost:3000" -> "localhost"; "[::1]:3000" -> "::1". */
export function hostnameOf(host: string | null): string | null {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? null : trimmed.slice(1, end);
  }
  return trimmed.split(':')[0] || null;
}

export function checkAccess(input: AccessInput, env: ProxyEnv): { ok: true } | ProxyFailure {
  const hostname = hostnameOf(input.host);
  if (!hostname) return fail(400, 'PROXY_BAD_REQUEST', 'The request has no Host header');
  if (!LOOPBACK.has(hostname) && env.DASHBOARD_SMS_ALLOW_REMOTE !== 'true') {
    return fail(
      403,
      'PROXY_FORBIDDEN_HOST',
      'The SMS page only works when the dashboard is opened as http://localhost:3000 on the machine that runs it. The dashboard has no login, so it does not relay SMS requests to other hosts. Set DASHBOARD_SMS_ALLOW_REMOTE=true in the dashboard server environment to allow it deliberately.'
    );
  }
  if (input.uiHeader !== '1') return fail(403, 'PROXY_FORBIDDEN', 'This endpoint is for the dashboard SMS page only');
  if (input.secFetchSite && input.secFetchSite !== 'same-origin' && input.secFetchSite !== 'none') {
    return fail(403, 'PROXY_FORBIDDEN', 'Cross-site requests are not accepted');
  }
  if (input.method === 'POST') {
    if (!/^application\/json(\s*;|$)/i.test(input.contentType ?? '')) return fail(415, 'PROXY_BAD_REQUEST', 'POST needs Content-Type: application/json');
    if (!input.origin) return fail(403, 'PROXY_FORBIDDEN', 'POST needs an Origin header');
    let originHost: string | null = null;
    try {
      originHost = new URL(input.origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== (input.host ?? '').trim().toLowerCase()) return fail(403, 'PROXY_FORBIDDEN', 'Cross-origin requests are not accepted');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------- routing

export interface ResolvedRoute {
  /** The path on the gateway, without a query string. */
  gatewayPath: string;
  /** The query parameters that may be passed on for this route. */
  allowedQuery: readonly string[];
  /** POST /send can take a long time and its outcome is uncertain if the wait ends. */
  isSend: boolean;
}

const READ_QUERY = ['status', 'markRead'] as const;
const INBOX_QUERY = ['direction', 'limit', 'offset'] as const;

/**
 * The allowlist. `segments` are the path parts after /api/sms. Anything not listed (other methods, other paths, path
 * traversal, the text-parameters write) is not routed.
 */
export function resolveRoute(method: string, segments: string[]): ResolvedRoute | null {
  const [first, ...rest] = segments;
  if (rest.length > 0) return null;
  if (method === 'GET') {
    if (first === undefined) return { gatewayPath: GATEWAY_SMS_BASE, allowedQuery: READ_QUERY, isSend: false };
    if (first === 'status') return { gatewayPath: `${GATEWAY_SMS_BASE}/status`, allowedQuery: [], isSend: false };
    if (first === 'inbox') return { gatewayPath: `${GATEWAY_SMS_BASE}/inbox`, allowedQuery: INBOX_QUERY, isSend: false };
    if (/^\d{1,3}$/.test(first)) return { gatewayPath: `${GATEWAY_SMS_BASE}/${Number(first)}`, allowedQuery: READ_QUERY, isSend: false };
    return null;
  }
  if (method === 'POST') {
    if (first === 'send') return { gatewayPath: `${GATEWAY_SMS_BASE}/send`, allowedQuery: [], isSend: true };
    if (first === 'sync') return { gatewayPath: `${GATEWAY_SMS_BASE}/sync`, allowedQuery: [], isSend: false };
  }
  return null;
}

/**
 * The gateway's AT-free status (driver type, simulated or not, the configured COM ports, modem connection state). It sends no
 * AT command and opens no port, so it is safe to read at any time, including during a call. Used by the dashboard's status
 * indicators when the browser itself cannot ask the gateway.
 */
export const STATUS_ROUTE: ResolvedRoute = { gatewayPath: '/api/gateway/hardware/status', allowedQuery: [], isSend: false };

export function pickQuery(search: string, allowed: readonly string[]): string {
  const incoming = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const name of allowed) {
    const value = incoming.get(name);
    if (value !== null && value.length <= 40) out.set(name, value);
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

// ---------------------------------------------------------------------------------------------------- forwarding

export interface ProxyResponse {
  status: number;
  body: Record<string, unknown>;
}

const LIMITS = { sendMs: 90_000, otherMs: 25_000 };
const MAX_BODY_CHARS = 4_000;

/** The body of a send: exactly { to, message }, both strings. (The gateway validates them again, strictly.) */
export function parseSendBody(raw: string): { to: string; message: string } | ProxyFailure {
  if (raw.length > MAX_BODY_CHARS) return fail(413, 'PROXY_BAD_REQUEST', 'The request is too large');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail(400, 'PROXY_BAD_REQUEST', 'The request body is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'PROXY_BAD_REQUEST', 'The request body must be a JSON object');
  const keys = Object.keys(value as object).sort().join(',');
  const { to, message } = value as Record<string, unknown>;
  if (keys !== 'message,to' || typeof to !== 'string' || typeof message !== 'string') return fail(400, 'PROXY_BAD_REQUEST', "The request body must be exactly { to, message }");
  return { to, message };
}

export interface ForwardInput {
  route: ResolvedRoute;
  method: 'GET' | 'POST';
  search: string;
  body?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * One request to the gateway, made once, with the key added here. No browser header (cookies, authorization, origin) is
 * passed on. It is never retried: a repeated POST /send could send twice. If the wait for a send ends, or the connection
 * breaks after the request was written, the result is reported as UNCERTAIN, never as a failure that is safe to repeat.
 */
export async function forwardToGateway(input: ForwardInput, env: ProxyEnv, fetchImpl: FetchLike): Promise<ProxyResponse> {
  const key = env.GATEWAY_API_KEY?.trim();
  if (!key) {
    return {
      status: 503,
      body: {
        success: false,
        code: 'PROXY_NOT_CONFIGURED',
        error:
          'The dashboard server has no gateway API key. It looks in its own environment (packages/dashboard/.env.local) and then in the repository .env that the gateway uses, and found none. Put GATEWAY_API_KEY in packages/dashboard/.env.local (with GATEWAY_INTERNAL_URL if the gateway is on another machine, e.g. http://192.168.1.24:4000) and restart the dashboard. The key stays on the dashboard server and is never sent to the browser.',
      },
    };
  }
  const base = (env.GATEWAY_INTERNAL_URL?.trim() || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const url = `${base}${input.route.gatewayPath}${pickQuery(input.search, input.route.allowedQuery)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.route.isSend ? LIMITS.sendMs : LIMITS.otherMs);
  try {
    const response = await fetchImpl(url, {
      method: input.method,
      headers: { 'x-api-key': key, accept: 'application/json', ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: input.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        status: 502,
        body: { success: false, code: input.route.isSend ? 'PROXY_UNCERTAIN' : 'GATEWAY_BAD_RESPONSE', error: 'The gateway did not answer with JSON' + (input.route.isSend ? '; the message may or may not have been sent' : '') },
      };
    }
    if (response.status === 401) {
      // The configured key is wrong. The gateway's own message is not passed on.
      return { status: 502, body: { success: false, code: 'PROXY_KEY_REJECTED', error: 'The gateway rejected the dashboard server\'s API key. Check GATEWAY_API_KEY in the dashboard server environment.' } };
    }
    return { status: response.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : { success: false, code: 'GATEWAY_BAD_RESPONSE', error: 'Unexpected gateway response' } };
  } catch (error) {
    const err = error as { name?: string; cause?: { code?: string } };
    if (err.name === 'AbortError') {
      return input.route.isSend
        ? { status: 504, body: { success: false, code: 'PROXY_TIMEOUT', error: 'No answer from the gateway in time. The message MAY have been sent: check before sending again.' } }
        : { status: 504, body: { success: false, code: 'GATEWAY_TIMEOUT', error: 'The gateway did not answer in time' } };
    }
    if (err.cause?.code === 'ECONNREFUSED' || err.cause?.code === 'ENOTFOUND') {
      return { status: 502, body: { success: false, code: 'GATEWAY_UNREACHABLE', error: `Could not connect to the gateway at ${base}. Nothing was sent.` } };
    }
    return input.route.isSend
      ? { status: 502, body: { success: false, code: 'PROXY_UNCERTAIN', error: 'The connection to the gateway broke. The message may or may not have been sent: check before sending again.' } }
      : { status: 502, body: { success: false, code: 'GATEWAY_UNREACHABLE', error: 'The connection to the gateway failed' } };
  } finally {
    clearTimeout(timer);
  }
}
