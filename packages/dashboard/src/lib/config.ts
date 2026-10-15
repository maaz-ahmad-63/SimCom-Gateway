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
    gatewayUrl: storedUrl || DEFAULT_GATEWAY_URL,
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
