import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayHealthStatus } from '@sim-gateway/shared';
import { defaultGatewayUrl } from '../src/lib/config';
import { fetchRelayStatus } from '../src/lib/gateway-status';
import { hardwareView, linkIssue, portText, RelayStatusResponse } from '../src/lib/hardware-mode';

const health = (over: Partial<GatewayHealthStatus> = {}): GatewayHealthStatus =>
  ({
    gatewayVersion: '0.1.0',
    uptimeSeconds: 10,
    isSimulated: false,
    driverType: 'hardware',
    modem: { connectionState: 'READY', info: null, signal: null, network: null, atPort: 'COM20', audioPort: 'COM19' },
    activeCall: null,
    audioStreaming: false,
    system: { platform: 'win32', nodeVersion: 'v22', memoryUsageMb: 50 },
    timestamp: new Date().toISOString(),
    ...over,
  }) as GatewayHealthStatus;

const relayOk = (over: { isSimulated?: boolean; at?: string | null; audio?: string | null } = {}): RelayStatusResponse => ({
  relay: { gatewayUrl: 'http://192.168.1.24:4000', keyConfigured: true, keySource: 'dashboard-env', urlSource: 'dashboard-env' },
  gateway: {
    ok: true,
    status: {
      gateway: { driverType: over.isSimulated ? 'mock' : 'hardware', isSimulated: over.isSimulated ?? false },
      modem: { connectionState: 'READY', configuredAtPort: over.at === undefined ? 'COM20' : over.at, configuredAudioPort: over.audio === undefined ? 'COM19' : over.audio },
    },
  },
});
const relayDown = (code: string): RelayStatusResponse => ({
  relay: { gatewayUrl: 'http://192.168.1.24:4000', keyConfigured: true, keySource: 'dashboard-env', urlSource: 'dashboard-env' },
  gateway: { ok: false, code, error: 'x' },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the hardware mode the dashboard shows', () => {
  it('is whatever the gateway reports, directly or through the dashboard server', () => {
    expect(hardwareView(health(), null)).toEqual({ mode: 'hardware', known: true, source: 'gateway', atPort: 'COM20', audioPort: 'COM19' });
    expect(hardwareView(health({ isSimulated: true, driverType: 'mock' }), null)).toMatchObject({ mode: 'mock', known: true });
    expect(hardwareView(null, relayOk())).toEqual({ mode: 'hardware', known: true, source: 'dashboard-server', atPort: 'COM20', audioPort: 'COM19' });
    expect(hardwareView(null, relayOk({ isSimulated: true }))).toMatchObject({ mode: 'mock', known: true });
  });

  it('is unknown, never a simulation, when the gateway has not answered', () => {
    for (const relay of [null, relayDown('GATEWAY_UNREACHABLE'), relayDown('PROXY_NOT_CONFIGURED'), relayDown('PROXY_KEY_REJECTED')]) {
      expect(hardwareView(null, relay)).toEqual({ mode: 'unknown', known: false, source: 'none', atPort: null, audioPort: null });
    }
  });

  it('prefers the gateway\'s own answer over the dashboard server\'s', () => {
    expect(hardwareView(health({ isSimulated: true, driverType: 'mock' }), relayOk()).mode).toBe('mock');
  });

  it('says "not configured" only when the gateway reported no port, and "unknown" when it reported nothing', () => {
    expect(portText(hardwareView(health(), null), 'at')).toBe('COM20');
    expect(portText(hardwareView(null, relayOk()), 'audio')).toBe('COM19');
    const none = hardwareView(null, relayOk({ at: null, audio: null }));
    expect(portText(none, 'at')).toBe('not configured on the gateway');
    expect(portText(none, 'audio')).toBe('not configured on the gateway');
    const unknown = hardwareView(null, null);
    expect(portText(unknown, 'at')).toBe('unknown (gateway not reachable)');
    expect(portText(unknown, 'audio')).not.toMatch(/not configured/);
  });
});

describe('why the browser has no live connection', () => {
  it('says nothing when nothing failed', () => {
    expect(linkIssue(null, null)).toBeNull();
  });

  it('a rejected key means the gateway is up and the browser\'s key is wrong', () => {
    for (const status of [401, 403]) {
      const issue = linkIssue({ status, message: 'Unauthorized' }, relayOk())!;
      expect(issue).toMatchObject({ kind: 'key-rejected', label: 'KEY REQUIRED' });
      expect(issue.message).toMatch(/Settings page/);
    }
  });

  it('a browser that cannot connect, while the dashboard server can, has the wrong address or CORS, not a stopped gateway', () => {
    const issue = linkIssue({ status: 0, code: 'NETWORK_ERROR', message: 'Network error' }, relayOk())!;
    expect(issue.kind).toBe('browser-cannot-reach');
    expect(issue.message).toContain('http://192.168.1.24:4000');
    expect(issue.message).toMatch(/CORS_ORIGIN/);
    expect(issue.message).toMatch(/not 127\.0\.0\.1 if the gateway is on another machine/);
  });

  it('a gateway that nobody can reach is offline, and the message names where it was looked for', () => {
    for (const code of ['GATEWAY_UNREACHABLE', 'GATEWAY_TIMEOUT']) {
      const issue = linkIssue({ status: 0, code: 'NETWORK_ERROR', message: 'x' }, relayDown(code))!;
      expect(issue).toMatchObject({ kind: 'gateway-down', label: 'OFFLINE' });
      expect(issue.message).toContain('http://192.168.1.24:4000');
    }
    expect(linkIssue({ status: 0, code: 'NETWORK_ERROR', message: 'x' }, null)).toMatchObject({ kind: 'gateway-down', label: 'OFFLINE' });
  });

  it('keeps an unexpected error\'s own message', () => {
    expect(linkIssue({ status: 500, message: 'Internal error' }, null)).toEqual({ kind: 'unknown', label: 'ERROR', message: 'Internal error' });
  });
});

describe('asking the dashboard server for the gateway\'s status', () => {
  const reply = (ok: boolean, body: unknown) => async () => ({ ok, json: async () => body });

  it('sends the dashboard header, the same origin only, and no key', async () => {
    const fetchImpl = vi.fn(reply(true, relayOk()));
    expect(await fetchRelayStatus(fetchImpl as never)).toEqual(relayOk());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('/api/gateway-status');
    expect(init.headers).toEqual({ 'x-dashboard-sms': '1' });
    expect(init.credentials).toBe('same-origin');
    expect(JSON.stringify(init)).not.toMatch(/api-key|authorization|bearer/i);
  });

  it('is null for any failure, never throws, and does not retry', async () => {
    for (const impl of [reply(false, {}), reply(true, null), reply(true, { relay: {} }), async () => { throw new TypeError('Failed to fetch'); }]) {
      const fetchImpl = vi.fn(impl as never);
      expect(await fetchRelayStatus(fetchImpl as never)).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after the limit', async () => {
    vi.useFakeTimers();
    const hang = (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = fetchRelayStatus(hang as never, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeNull();
  });
});

describe('the default gateway address of a browser', () => {
  it('is the host the page was opened from, so a Mac browser on the PC\'s LAN address does not look at its own 127.0.0.1', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', '');
    expect(defaultGatewayUrl('192.168.1.24')).toBe('http://192.168.1.24:4000');
    expect(defaultGatewayUrl('localhost')).toBe('http://localhost:4000');
    expect(defaultGatewayUrl('::1')).toBe('http://[::1]:4000');
    expect(defaultGatewayUrl(null)).toBe('http://127.0.0.1:4000');
    expect(defaultGatewayUrl('')).toBe('http://127.0.0.1:4000');
  });

  it('is overridden by an explicit build-time address', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', 'http://10.0.0.9:4000');
    expect(defaultGatewayUrl('192.168.1.24')).toBe('http://10.0.0.9:4000');
  });
});

describe('what the header and sidebar show', () => {
  /** The gateway context, as the header and sidebar would see it in each situation. */
  const scenario = (health: GatewayHealthStatus | null, relay: RelayStatusResponse | null, issue: ReturnType<typeof linkIssue>, connection: string) => ({
    connectionState: connection,
    health,
    activeCall: null,
    telemetry: { signal: null, network: null },
    hardware: hardwareView(health, relay),
    linkIssue: issue,
    isSimulated: hardwareView(health, relay).mode === 'mock',
    refreshHealth: () => undefined,
    isLoading: false,
  });

  const render = async (value: ReturnType<typeof scenario>) => {
    vi.resetModules();
    vi.doMock('../src/lib/context/GatewayContext', () => ({ useGateway: () => value }));
    vi.doMock('next/navigation', () => ({ usePathname: () => '/' }));
    const { Header } = await import('../src/components/layout/Header');
    const { Navigation } = await import('../src/components/layout/Navigation');
    return { header: renderToStaticMarkup(React.createElement(Header)), nav: renderToStaticMarkup(React.createElement(Navigation)) };
  };

  afterEach(() => {
    vi.doUnmock('../src/lib/context/GatewayContext');
    vi.doUnmock('next/navigation');
  });

  it('does not call a gateway it has not heard from a simulation, and does not call its ports unconfigured (the reported bug)', async () => {
    const { header, nav } = await render(scenario(null, null, linkIssue({ status: 401, message: 'Unauthorized' }, null), 'error'));
    expect(header).not.toContain('MOCK SIMULATION');
    expect(header).not.toContain('PHYSICAL HARDWARE');
    expect(header).toContain('HARDWARE UNKNOWN');
    expect(header).toContain('KEY REQUIRED');
    expect(header).not.toContain('Vi India'); // no invented carrier either
    expect(nav).not.toContain('not configured');
    expect(nav).toContain('unknown (gateway not reachable)');
  });

  it('shows the real mode and ports from the dashboard server while the browser itself cannot reach the gateway', async () => {
    const relay = relayOk();
    const { header, nav } = await render(scenario(null, relay, linkIssue({ status: 0, code: 'NETWORK_ERROR', message: 'x' }, relay), 'error'));
    expect(header).toContain('PHYSICAL HARDWARE');
    expect(header).toContain('NO ROUTE');
    expect(nav).toContain('COM20');
    expect(nav).toContain('COM19');
  });

  it('shows MOCK SIMULATION only for a gateway that says it is simulated, and OFFLINE only for a connection that was there and dropped', async () => {
    const mock = await render(scenario(health({ isSimulated: true, driverType: 'mock' }), null, null, 'connected'));
    expect(mock.header).toContain('MOCK SIMULATION');
    expect(mock.header).toContain('ONLINE');
    const dropped = await render(scenario(health(), null, null, 'disconnected'));
    expect(dropped.header).toContain('PHYSICAL HARDWARE');
    expect(dropped.header).toContain('OFFLINE');
  });

  it('says "not configured" only for a gateway that reported no port', async () => {
    const { nav } = await render(scenario(null, relayOk({ at: null, audio: null }), null, 'error'));
    expect(nav).toContain('not configured on the gateway');
  });
});

describe('source rules', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');

  it('no component invents hardware mode, ports or modem details when there is no data', () => {
    expect(read('lib/context/GatewayContext.tsx')).not.toMatch(/isSimulated\s*=\s*health\?\.isSimulated\s*\?\?\s*true/);
    expect(read('lib/context/GatewayContext.tsx')).not.toMatch(/driverType\s*=\s*health\?\.driverType\s*\?\?\s*'mock'/);
    for (const file of ['components/layout/Header.tsx', 'components/layout/Navigation.tsx', 'app/settings/page.tsx']) {
      expect(read(file), file).not.toMatch(/health\?\.modem\.(atPort|audioPort)\s*\|\|\s*'not configured'/);
    }
    const card = read('components/dashboard/ModemTelemetryCard.tsx');
    expect(card).not.toMatch(/SIM7600M21|REGISTERED_HOME|Vi India/);
  });

  it('keeps hardware configuration on the gateway host: the dashboard has no COM-port or driver setting', () => {
    for (const file of ['lib/gateway-status.ts', 'lib/hardware-mode.ts', 'app/api/gateway-status/route.ts']) {
      expect(read(file), file).not.toMatch(/MODEM_AT_PORT|MODEM_AUDIO_PORT|MODEM_DRIVER|localStorage/);
    }
  });

  it('the browser-side status files never touch the key', () => {
    for (const file of ['lib/gateway-status.ts', 'lib/hardware-mode.ts']) {
      expect(read(file), file).not.toMatch(/x-api-key|GATEWAY_API_KEY|process\.env|apiClient|getGatewayClientConfig/);
    }
  });
});
