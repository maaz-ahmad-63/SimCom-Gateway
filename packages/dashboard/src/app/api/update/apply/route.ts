import { relayUpdate } from '../../../../lib/server/update-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = (request: Request): Promise<Response> => relayUpdate(request, 'apply');
