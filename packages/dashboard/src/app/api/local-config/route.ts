import fs from 'node:fs';
import { checkAccess, SMS_UI_HEADER } from '../../../lib/server/sms-proxy';

/**
 * SERVER-ONLY. First-run hand-off of the gateway address and API key to the browser of the person who installed the product.
 *
 * The packaged product creates a random API key at install time and keeps it in a file the customer never has to open. This route
 * lets the dashboard, opened on the SAME computer, pick the key up once instead of the customer copying it by hand. It is OFF unless
 * the supervisor that launches the packaged dashboard sets SIMGW_LOCAL_CONFIG=1, so a development or LAN dashboard never offers it.
 * It answers only a loopback Host (never remote, there is no switch for that), needs the custom header, is not cached and is
 * never part of any bundle. This is a local convenience, not authentication.
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
  const file = process.env.SIMGW_CONFIG_FILE;
  const key = file ? readKey(file) : null;
  if (!key) return json(404, { success: false, code: 'NOT_AVAILABLE', error: 'No local configuration was found' });
  return json(200, { success: true, gatewayUrl: process.env.SIMGW_GATEWAY_URL || 'http://127.0.0.1:4000', apiKey: key });
}
