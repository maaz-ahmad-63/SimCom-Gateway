import { resolveRelaySetup } from '../../../../lib/server/relay-env';
import { checkAccess, forwardToGateway, parseSendBody, resolveRoute, SMS_UI_HEADER } from '../../../../lib/server/sms-proxy';

/**
 * Same-origin relay from the SMS page to the gateway. The gateway API key is added on the server (GATEWAY_API_KEY from the
 * dashboard server's own environment); the browser never has it. See lib/server/sms-proxy.ts for the access rules.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const failure = (status: number, code: string, error: string): Response => json(status, { success: false, code, error });

async function handle(request: Request, context: { params: { path?: string[] } }): Promise<Response> {
  // The dashboard's own environment first, then the repository .env the gateway uses (see lib/server/relay-env.ts).
  const { env } = resolveRelaySetup(process.env);
  const method = request.method.toUpperCase();

  const access = checkAccess(
    {
      method,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      uiHeader: request.headers.get(SMS_UI_HEADER),
      secFetchSite: request.headers.get('sec-fetch-site'),
    },
    env
  );
  if (access.ok === false) return failure(access.status, access.code, access.message);

  const route = resolveRoute(method, context.params.path ?? []);
  if (!route || (method !== 'GET' && method !== 'POST')) return failure(404, 'PROXY_NOT_FOUND', 'No such SMS endpoint');

  let body: string | undefined;
  if (route.isSend) {
    const parsed = parseSendBody(await request.text());
    if ('ok' in parsed) return failure(parsed.status, parsed.code, parsed.message);
    body = JSON.stringify(parsed);
  }

  const result = await forwardToGateway({ route, method, search: new URL(request.url).search, body }, env, (url, init) => fetch(url, init));
  return json(result.status, result.body);
}

export const GET = handle;
export const POST = handle;
