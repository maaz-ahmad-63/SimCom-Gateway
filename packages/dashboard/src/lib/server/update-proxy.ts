import fs from 'node:fs';
import { checkAccess } from './sms-proxy';

/**
 * SERVER-ONLY. The dashboard's way to the supervisor's update endpoints. The supervisor (not the gateway, not the browser) downloads,
 * verifies and installs; this file only relays three fixed requests, after the same checks the SMS relay uses: the page must be opened on
 * this computer, from this site, with the dashboard's own header. The supervisor token is read from a file only this Windows user can read
 * and is never sent to the browser. It exists only in the packaged product (the supervisor sets SIMGW_SUPERVISOR_URL).
 */

export const UI_HEADER = 'x-dashboard-sms';
const ROUTES = { status: { method: 'GET', path: '/update' }, check: { method: 'POST', path: '/update/check' }, apply: { method: 'POST', path: '/update/apply' } } as const;
export type UpdateAction = keyof typeof ROUTES;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function relayUpdate(request: Request, action: UpdateAction, env: NodeJS.ProcessEnv = process.env, doFetch: typeof fetch = fetch): Promise<Response> {
  const base = env.SIMGW_SUPERVISOR_URL;
  const tokenFile = env.SIMGW_SUPERVISOR_TOKEN_FILE;
  if (!base || !tokenFile) return json(404, { success: false, code: 'NOT_AVAILABLE', error: 'Updates are only available in the installed product.' });
  const route = ROUTES[action];
  const access = checkAccess(
    {
      method: route.method,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      uiHeader: request.headers.get(UI_HEADER),
      secFetchSite: request.headers.get('sec-fetch-site'),
    },
    {} // loopback only: there is no switch to allow another computer to install updates
  );
  if (access.ok === false) return json(access.status, { success: false, code: access.code, error: access.message });
  let token: string;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return json(503, { success: false, code: 'SUPERVISOR_UNAVAILABLE', error: 'The program that manages updates is not running. Start SIZH IT Solution from the Start menu.' });
  }
  try {
    // An apply may download a large package before it answers; a check is quick.
    const res = await doFetch(`${base}${route.path}`, { method: route.method, headers: { 'x-supervisor-token': token }, cache: 'no-store', signal: AbortSignal.timeout(action === 'apply' ? 30 * 60_000 : 30_000) });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return json(503, { success: false, code: 'SUPERVISOR_UNAVAILABLE', error: 'The program that manages updates did not answer.' });
  }
}
