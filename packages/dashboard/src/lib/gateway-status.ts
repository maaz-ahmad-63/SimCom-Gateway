import type { RelayStatusResponse } from './hardware-mode';

type FetchLike = (url: string, init: { headers: Record<string, string>; credentials: 'same-origin'; signal: AbortSignal; cache: 'no-store' }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Ask the dashboard server what it can see of the gateway (GET /api/gateway-status): the gateway's hardware mode and
 * configured ports from its AT-free status, and which gateway address the server uses. No key is sent or received. Null if the
 * dashboard server itself does not answer. Never throws and never retries.
 */
export async function fetchRelayStatus(fetchImpl: FetchLike = (url, init) => fetch(url, init), timeoutMs = 8_000): Promise<RelayStatusResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('/api/gateway-status', { headers: { 'x-dashboard-sms': '1' }, credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<RelayStatusResponse> | null;
    return body && body.relay && body.gateway ? (body as RelayStatusResponse) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
