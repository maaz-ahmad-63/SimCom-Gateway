/**
 * What the dashboard may say about the gateway's hardware mode, its COM ports, and why it cannot reach it. Pure functions: no
 * network, no secrets, no React.
 *
 * The rule: the gateway is the only authority on its hardware. "No answer yet" is `unknown`, never "mock" and never "not
 * configured". A dashboard that has no key, or looks at the wrong address, knows nothing about the modem.
 */
import type { GatewayHealthStatus } from '@sim-gateway/shared';

export type HardwareMode = 'hardware' | 'mock' | 'unknown';

export interface HardwareView {
  mode: HardwareMode;
  /** True when the gateway itself said so (directly, or through the dashboard server). */
  known: boolean;
  source: 'gateway' | 'dashboard-server' | 'none';
  atPort: string | null;
  audioPort: string | null;
}

/** The AT-free status the dashboard server relays from the gateway (/api/gateway-status). */
export interface RelayStatusResponse {
  relay: { gatewayUrl: string; keyConfigured: boolean; keySource: 'dashboard-env' | 'repository-env' | 'missing'; urlSource: 'dashboard-env' | 'repository-env' | 'default' };
  gateway:
    | { ok: true; status: { gateway: { driverType: string; isSimulated: boolean }; modem: { connectionState: string; configuredAtPort: string | null; configuredAudioPort: string | null } } }
    | { ok: false; code: string; error: string };
}

const UNKNOWN: HardwareView = { mode: 'unknown', known: false, source: 'none', atPort: null, audioPort: null };

export function hardwareView(health: GatewayHealthStatus | null, relay: RelayStatusResponse | null): HardwareView {
  if (health) {
    return { mode: health.isSimulated ? 'mock' : 'hardware', known: true, source: 'gateway', atPort: health.modem?.atPort || null, audioPort: health.modem?.audioPort || null };
  }
  if (relay?.gateway.ok) {
    const { gateway, modem } = relay.gateway.status;
    return { mode: gateway.isSimulated ? 'mock' : 'hardware', known: true, source: 'dashboard-server', atPort: modem.configuredAtPort || null, audioPort: modem.configuredAudioPort || null };
  }
  return UNKNOWN;
}

/** The wording for a COM port. "not configured" is only ever said when the gateway reported that it has none. */
export function portText(view: HardwareView, which: 'at' | 'audio'): string {
  if (!view.known) return 'unknown (gateway not reachable)';
  const port = which === 'at' ? view.atPort : view.audioPort;
  // 'auto' is the gateway saying it discovers the port and has not found the modem yet.
  if (port && port.toLowerCase() === 'auto') return 'automatic (modem not found yet)';
  return port || 'not configured on the gateway';
}

export type LinkIssueKind = 'key-rejected' | 'browser-cannot-reach' | 'gateway-down' | 'unknown';

export interface LinkIssue {
  kind: LinkIssueKind;
  /** Short label for the status badge. */
  label: string;
  /** What is wrong and what to do about it. */
  message: string;
}

export interface HealthError {
  status?: number;
  code?: string;
  message: string;
}

/**
 * Why this browser has no live connection, from what its own request to the gateway returned and from what the dashboard
 * server (which has its own key and its own route to the gateway) could see. Null when nothing is wrong.
 */
export function linkIssue(healthError: HealthError | null, relay: RelayStatusResponse | null): LinkIssue | null {
  if (!healthError) return null;
  const url = relay?.relay.gatewayUrl ?? null;

  if (healthError.status === 401 || healthError.status === 403) {
    return {
      kind: 'key-rejected',
      label: 'KEY REQUIRED',
      message: 'The gateway is running but refused the API key this browser sent. Enter the gateway\'s API key on the Settings page (it is kept in this browser only).',
    };
  }

  const unreachable = healthError.status === 0 || healthError.code === 'NETWORK_ERROR';
  if (unreachable) {
    if (relay?.gateway.ok) {
      return {
        kind: 'browser-cannot-reach',
        label: 'NO ROUTE',
        message: `The dashboard server reaches the gateway${url ? ` at ${url}` : ''}, but this browser cannot. On the Settings page use an address this browser can open (not 127.0.0.1 if the gateway is on another machine), and make sure the gateway's CORS_ORIGIN is this page's address.`,
      };
    }
    const gateway = relay?.gateway;
    if (gateway && gateway.ok === false && (gateway.code === 'GATEWAY_UNREACHABLE' || gateway.code === 'GATEWAY_TIMEOUT')) {
      return {
        kind: 'gateway-down',
        label: 'OFFLINE',
        message: `No gateway is answering${url ? ` at ${url}` : ''}. Start it on the machine that has the modem (npm run start:gateway), or correct GATEWAY_INTERNAL_URL if it runs elsewhere.`,
      };
    }
    return { kind: 'gateway-down', label: 'OFFLINE', message: 'Could not reach the gateway. Check that it is running and that the Gateway URL on the Settings page is right.' };
  }

  return { kind: 'unknown', label: 'ERROR', message: healthError.message };
}
