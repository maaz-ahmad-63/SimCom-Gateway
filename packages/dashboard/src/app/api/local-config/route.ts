import fs from 'node:fs';
import { checkAccess, SMS_UI_HEADER } from '../../../lib/server/sms-proxy';

/**
 * SERVER-ONLY. Automatic connection of the packaged dashboard to the gateway on the same computer.
 *
 * The packaged product creates a random gateway API key at install time and keeps it in a file the customer never opens. This route
 * reads that key HERE, on the dashboard server, and trades it with the local gateway for a short-lived session token
 * (POST /api/auth/session). Only the token is returned: the master key never reaches a browser. The browser keeps the token in memory
 * and asks again when it expires or the gateway restarts.
 *
 * It is OFF unless the supervisor that launches the packaged dashboard sets SIMGW_LOCAL_CONFIG=1, so a development or LAN dashboard never
 * offers it. It answers only a loopback Host requested by this dashboard's own pages (same-origin, custom header), so another website or
 * another computer cannot obtain a token. Not cached, never part of any bundle.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function readKey(file: string): string | null {
  try {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('GATEWAY_API_KEY='));
    const key = line?.slice('GATEWAY_API_KEY='.length).trim().replace(/^"|"$/g, '');
    return key && key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.SIMGW_LOCAL_CONFIG !== '1') return json(404, { success: false, code: 'NOT_AVAILABLE', error: 'Not available' });
  const access = checkAccess(
    {
      method: 'GET',
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      uiHeader: request.headers.get(SMS_UI_HEADER),
      secFetchSite: request.headers.get('sec-fetch-site'),
    },
    {} // no DASHBOARD_SMS_ALLOW_REMOTE: loopback only
  );
  if (access.ok === false) return json(access.status, { success: false, code: access.code, error: access.message });
  // This route issues sessions, so it also refuses any Origin that is not this dashboard (the shared check compares Origin for POST only).
  const origin = request.headers.get('origin');
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (originHost !== (request.headers.get('host') ?? '').trim().toLowerCase()) {
      return json(403, { success: false, code: 'PROXY_FORBIDDEN', error: 'Cross-origin requests are not accepted' });
    }
  }
  const file = process.env.SIMGW_CONFIG_FILE;
  const key = file ? readKey(file) : null;
  if (!key) return json(404, { success: false, code: 'NOT_AVAILABLE', error: 'No local configuration was found' });

  const gatewayUrl = process.env.SIMGW_GATEWAY_URL || 'http://127.0.0.1:4000';
  const internal = (process.env.GATEWAY_INTERNAL_URL || gatewayUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${internal}/api/auth/session`, { method: 'POST', headers: { 'x-api-key': key }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: string };
    if (!res.ok || !body.token) {
      // 429: the gateway's failed-attempt limit is active; say so instead of retrying into it.
      return json(res.status === 429 ? 429 : 502, { success: false, code: res.status === 429 ? 'RATE_LIMITED' : 'SESSION_REFUSED', error: 'The gateway did not issue a session' });
    }
    return json(200, { success: true, gatewayUrl, sessionToken: body.token, expiresAt: body.expiresAt ?? null });
  } catch {
    return json(503, { success: false, code: 'GATEWAY_UNREACHABLE', error: 'The gateway is not reachable yet' });
  }
}
