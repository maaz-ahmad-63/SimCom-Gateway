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

// ---- local session (the packaged dashboard on the gateway's own computer) ------------------------------------------------------------
// The browser holds only a short-lived session token, in memory (never localStorage or sessionStorage). The dashboard server mints it
// from the gateway API key, which never reaches the browser. A page reload asks again.
let localSession: { gatewayUrl: string; token: string; expiresAt: number | null } | null = null;
/** 'local': the packaged dashboard on this computer (sessions are issued). 'manual': a key entered in Settings is used. */
let mode: 'unknown' | 'local' | 'manual' = 'unknown';
let inFlight: Promise<boolean> | null = null;
let lastAttempt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Whether this dashboard connects by itself (packaged, on the gateway's computer). */
export const isLocalSession = (): boolean => mode === 'local';

async function fetchLocalSession(): Promise<boolean> {
  lastAttempt = Date.now();
  try {
    const res = await fetch('/api/local-config', { headers: { 'x-dashboard-sms': '1' }, cache: 'no-store' });
    if (res.status === 404) {
      if (mode === 'unknown') mode = 'manual'; // not the packaged dashboard: the Settings key is used
      return false;
    }
    if (!res.ok) return false;
    const body = (await res.json()) as { gatewayUrl?: string; sessionToken?: string; expiresAt?: string | null };
    if (!body.sessionToken) return false;
    mode = 'local';
    localSession = {
      gatewayUrl: body.gatewayUrl || defaultGatewayUrl(window.location.hostname),
      token: body.sessionToken,
      expiresAt: body.expiresAt ? Date.parse(body.expiresAt) : null,
    };
    // Earlier versions kept the gateway's master key in this browser. It is no longer needed here: remove it.
    const s = storage();
    try {
      s?.removeItem(STORAGE_KEY_API_KEY);
      s?.removeItem(STORAGE_KEY_URL);
    } catch {
      /* storage blocked: nothing was kept there either */
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    if (localSession.expiresAt) {
      // Renew five minutes before it expires (at least a minute from now), so a working page never hits an expired token.
      const inMs = Math.max(60_000, localSession.expiresAt - Date.now() - 5 * 60_000);
      refreshTimer = setTimeout(() => void ensureLocalSession(true), inMs);
    }
    window.dispatchEvent(new CustomEvent('gateway-config-changed', { detail: { gatewayUrl: localSession.gatewayUrl } }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get (or renew, with `force`) the local session. One request at a time, and after a failure not again for 5 s, so a dashboard that
 * cannot get a session never floods the gateway (whose failed-attempt limit would then lock the right credential out too).
 */
export function ensureLocalSession(force = false): Promise<boolean> {
  if (typeof window === 'undefined' || mode === 'manual') return Promise.resolve(false);
  if (!force && localSession) return Promise.resolve(true);
  if (inFlight) return inFlight;
  if (Date.now() - lastAttempt < 5_000 && !localSession) return Promise.resolve(false);
  inFlight = fetchLocalSession().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** The gateway refused the current credential (401). In the local mode, get a fresh session once; returns true when there is one. */
export async function renewAfterAuthFailure(): Promise<boolean> {
  if (mode !== 'local') return false;
  if (Date.now() - lastAttempt < 2_000) return localSession !== null; // just renewed: do not loop
  localSession = null;
  return ensureLocalSession(true);
}

/** Test seam: forget the in-memory session and mode. */
export function resetLocalSessionForTests(): void {
  localSession = null;
  mode = 'unknown';
  inFlight = null;
  lastAttempt = 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

export function getGatewayClientConfig(): GatewayClientConfig {
  if (typeof window === 'undefined') {
    return {
      gatewayUrl: DEFAULT_GATEWAY_URL,
      apiKey: DEFAULT_API_KEY,
    };
  }
  if (localSession) return { gatewayUrl: localSession.gatewayUrl, apiKey: localSession.token };

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
 * The packaged product on its own computer: connect by itself with a local session, whatever key an older version left in this browser.
 * Elsewhere (development, a dashboard opened from another computer) nothing changes and the key from Settings is used.
 */
export async function bootstrapLocalConfig(): Promise<boolean> {
  return ensureLocalSession();
}
