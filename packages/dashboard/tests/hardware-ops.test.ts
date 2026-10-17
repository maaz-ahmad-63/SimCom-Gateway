import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient } from '../src/lib/api-client';
import { canQueryModem, envLines, formatAge, HardwarePorts, HardwareStatus } from '../src/lib/hardware-ops';
import { ConnectionPanel, LayerList, PortsPanel, QueryButton } from '../src/components/hardware/HardwarePanels';

const status = (over: Partial<HardwareStatus> = {}): HardwareStatus => ({
  timestamp: '2026-10-17T10:00:00.000Z',
  gateway: { version: '0.1.0', uptimeSeconds: 10, platform: 'win32', driverType: 'hardware', isSimulated: false, usbAudioDiagnosticEnabled: true },
  call: null,
  modem: {
    connectionState: 'READY',
    atStatus: 'OK',
    lastCommunicationTime: null,
    configuredAtPort: 'COM22',
    configuredAudioPort: 'COM26',
    reconnect: { initAttempts: 1, reconnectAttempts: 0, reconnectScheduled: false, nextReconnectInMs: null, lastInit: null, lastFailure: { at: 'x', message: 'Unknown error code 31' } },
  },
  usbAudio: null,
  audio: { bytesReceived: 640, framesReceived: 2, msSinceLastFrame: 1500, lastFrameAt: 'x' },
  layers: [
    { key: 'audioPortOpen', label: 'Audio port open', state: 'ok', detail: 'open' },
    { key: 'freshPcm', label: 'Fresh PCM', state: 'bad', detail: 'stalled' },
    { key: 'playbackVerified', label: 'Playback verified', state: 'unknown', detail: 'never inferred' },
  ],
  ...over,
});

describe('hardware ops helpers', () => {
  it('refuses AT queries during a call or when the modem is not ready', () => {
    expect(canQueryModem(null).allowed).toBe(false);
    expect(canQueryModem(status()).allowed).toBe(true);
    expect(canQueryModem(status({ call: { state: 'ACTIVE', direction: 'inbound' } })).reason).toMatch(/not sent during a call/);
    expect(canQueryModem(status({ modem: { ...status().modem, connectionState: 'ERROR' } })).reason).toMatch(/ERROR/);
  });

  it('formats suggested env lines and ages', () => {
    expect(envLines(null)).toBeNull();
    expect(envLines({})).toBeNull();
    expect(envLines({ MODEM_AT_PORT: 'COM22', MODEM_AUDIO_PORT: 'COM26' })).toBe('MODEM_AT_PORT=COM22\nMODEM_AUDIO_PORT=COM26');
    expect(formatAge(null)).toBe('never');
    expect(formatAge(40)).toBe('40 ms ago');
    expect(formatAge(1500)).toBe('1.5 s ago');
  });
});

describe('hardware panels', () => {
  it('shows each layer separately, with playback unknown and the last failure visible', () => {
    const s = status();
    const html = renderToStaticMarkup(React.createElement('div', null, React.createElement(LayerList, { status: s }), React.createElement(ConnectionPanel, { status: s })));
    for (const l of ['Audio port open', 'Fresh PCM', 'Playback verified', 'Problem', 'Unknown']) expect(html).toContain(l);
    expect(html).toContain('Unknown error code 31');
    expect(html).toContain('1.5 s ago');
  });

  it('presents port findings and a manual env change without applying it', () => {
    const ports: HardwarePorts = {
      note: 'Listing opens none',
      configured: { at: 'COM20', audio: 'COM19' },
      ports: [{ path: 'COM22', interface: '02', role: 'at' }],
      findings: [{ level: 'warn', message: 'AT port COM20 is not present' }],
      suggestedEnv: { MODEM_AT_PORT: 'COM22' },
    };
    const html = renderToStaticMarkup(React.createElement(PortsPanel, { ports }));
    expect(html).toContain('MODEM_AT_PORT=COM22');
    expect(html).toContain('nothing is changed automatically');
    expect(html).toContain('role="alert"');
  });

  it('disables the AT query during a call and says why', () => {
    const html = renderToStaticMarkup(React.createElement(QueryButton, { status: status({ call: { state: 'ACTIVE', direction: 'inbound' } }), busy: false, onClick: vi.fn() }));
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('not sent during a call');
  });
});

describe('hardware API client', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('uses GET with the gateway key and surfaces the gateway error', async () => {
    const client = new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'gw-key-123456' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'A call is in progress', code: 'CALL_IN_PROGRESS' }) }) as never;
    await expect(client.getHardwareModemInfo()).rejects.toMatchObject({ message: 'A call is in progress', code: 'CALL_IN_PROGRESS' });
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/gateway/hardware/modem-info');
    expect(init.headers['x-api-key']).toBe('gw-key-123456');
    expect(init.method).toBeUndefined();
  });
});
