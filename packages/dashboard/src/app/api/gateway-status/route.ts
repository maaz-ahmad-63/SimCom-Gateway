import { describeRelaySetup, resolveRelaySetup } from '../../../lib/server/relay-env';
import { checkAccess, forwardToGateway, SMS_UI_HEADER, STATUS_ROUTE } from '../../../lib/server/sms-proxy';

/**
 * Read-only: what the gateway says about its own hardware mode and configured ports (its AT-free status), plus which gateway
 * this dashboard server talks to. It exists so the dashboard's MOCK / PHYSICAL HARDWARE badge and the COM-port lines come from
 * the gateway even when this browser cannot ask it directly (no key in the browser, a different network, CORS). Hardware
 * configuration stays on the gateway host: nothing here can change it. It always answers 200 with { relay, gateway }, where
 * gateway.ok says whether the gateway answered; the API key is never part of the answer.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function GET(request: Request): Promise<Response> {
  const setup = resolveRelaySetup(process.env);
  // Read-only and AT-free, so unlike the SMS relay it also answers a dashboard opened by LAN address (the header and
  // same-site checks still apply). It cannot send, change or open anything.
  const access = checkAccess(
    {
      method: 'GET',
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      uiHeader: request.headers.get(SMS_UI_HEADER),
      secFetchSite: request.headers.get('sec-fetch-site'),
    },
    { ...setup.env, DASHBOARD_SMS_ALLOW_REMOTE: 'true' }
  );
  if (access.ok === false) return json(access.status, { success: false, code: access.code, error: access.message });

  const result = await forwardToGateway({ route: STATUS_ROUTE, method: 'GET', search: '' }, setup.env, (url, init) => fetch(url, init));
  const relay = describeRelaySetup(setup);
  const body = result.body as { gateway?: unknown; code?: string; error?: string };
  if (result.status === 200 && body.gateway) return json(200, { relay, gateway: { ok: true, status: result.body } });
  return json(200, {
    relay,
    gateway: { ok: false, code: body.code ?? 'GATEWAY_ERROR', error: body.error ?? `The gateway answered ${result.status}` },
  });
}
