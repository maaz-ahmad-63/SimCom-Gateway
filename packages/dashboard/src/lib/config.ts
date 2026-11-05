/**
 * Client-side Gateway Configuration Management
 * Supports runtime configuration via localStorage with fallback to build-time environment variables.
 */

export interface GatewayClientConfig {
  gatewayUrl: string;
  apiKey: string;
}

const STORAGE_KEY_URL = 'sim_gateway_url';
const STORAGE_KEY_API_KEY = 'sim_gateway_api_key';

export const DEFAULT_GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://127.0.0.1:4000';

/** The gateway's default port. */
const GATEWAY_PORT = 4000;

/**
 * The address a browser uses when nothing was saved on the Settings page and no build-time default exists. 127.0.0.1 means
 * "this browser's own computer", which is wrong whenever the dashboard page was opened from another machine (a Mac browser on
 * the Windows PC's LAN address), so the default is the host the page itself was loaded from. A gateway on yet another
 * machine is set on the Settings page.
 */
export function defaultGatewayUrl(pageHostname?: string | null): string {
  if (process.env.NEXT_PUBLIC_GATEWAY_URL) return process.env.NEXT_PUBLIC_GATEWAY_URL;
  const host = pageHostname?.trim();
  if (!host) return DEFAULT_GATEWAY_URL;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${GATEWAY_PORT}`;
}

export const DEFAULT_API_KEY =
  process.env.NEXT_PUBLIC_GATEWAY_API_KEY || 'change-this-to-a-secure-random-token';

export function getGatewayClientConfig(): GatewayClientConfig {
  if (typeof window === 'undefined') {
    return {
      gatewayUrl: DEFAULT_GATEWAY_URL,
      apiKey: DEFAULT_API_KEY,
    };
  }

  const storedUrl = localStorage.getItem(STORAGE_KEY_URL);
  const storedKey = localStorage.getItem(STORAGE_KEY_API_KEY);

  return {
    gatewayUrl: storedUrl || defaultGatewayUrl(window.location.hostname),
    apiKey: storedKey || DEFAULT_API_KEY,
  };
}

export function saveGatewayClientConfig(url: string, apiKey: string): void {
  if (typeof window === 'undefined') return;

  const cleanUrl = url.trim().replace(/\/+$/, '');
  const cleanKey = apiKey.trim();

  localStorage.setItem(STORAGE_KEY_URL, cleanUrl);
  localStorage.setItem(STORAGE_KEY_API_KEY, cleanKey);

  // Dispatch event so active services can reinitialize
  window.dispatchEvent(
    new CustomEvent('gateway-config-changed', {
      detail: { gatewayUrl: cleanUrl, apiKey: cleanKey },
    })
  );
}

export function clearGatewayClientConfig(): void {
  if (typeof window === 'undefined') return;

  localStorage.removeItem(STORAGE_KEY_URL);
  localStorage.removeItem(STORAGE_KEY_API_KEY);

  window.dispatchEvent(new CustomEvent('gateway-config-changed'));
}

/**
 * First run of the packaged product: pick up the gateway address and key from the dashboard server, once, if this browser has none
 * saved. Only works for a dashboard opened on the computer that runs it (the server refuses anything else) and only when the
 * packaged product turned the route on. Returns true when a key was saved.
 */
export async function bootstrapLocalConfig(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    if (localStorage.getItem(STORAGE_KEY_API_KEY)) return false;
    const res = await fetch('/api/local-config', { headers: { 'x-dashboard-sms': '1' }, cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { gatewayUrl?: string; apiKey?: string };
    if (!body.apiKey) return false;
    saveGatewayClientConfig(body.gatewayUrl || defaultGatewayUrl(window.location.hostname), body.apiKey);
    return true;
  } catch {
    return false;
  }
}
