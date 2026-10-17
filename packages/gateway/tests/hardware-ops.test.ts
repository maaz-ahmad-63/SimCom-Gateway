import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { buildHardwareLayers, classifyPort, comparePorts, RawPortInfo } from '../src/api/routes/hardware.js';
import { createLogger, getRecentLogs } from '../src/core/logger.js';
import { createGatewayServer, GatewayServerInstance } from '../src/server.js';

const KEY = 'hardware-ops-key-123456';

/** What Windows lists after the modem re-enumerated: the documented COM20/COM19 are stale, the live ones differ. */
const WINDOWS_PORTS: RawPortInfo[] = [
  { path: 'COM3', manufacturer: 'Intel', pnpId: 'ACPI\\PNP0501\\0' },
  { path: 'COM22', manufacturer: 'SimTech', pnpId: 'USB\\VID_1E0E&PID_9001&MI_02\\7&2A3B&0&0002', vendorId: '1E0E', productId: '9001' },
  { path: 'COM23', manufacturer: 'SimTech', pnpId: 'USB\\VID_1E0E&PID_9001&MI_01\\7&2A3B&0&0001', vendorId: '1E0E', productId: '9001' },
  { path: 'COM24', manufacturer: 'SimTech', pnpId: 'USB\\VID_1E0E&PID_9001&MI_00\\7&2A3B&0&0000', vendorId: '1E0E', productId: '9001' },
  { path: 'COM26', manufacturer: 'SimTech', pnpId: 'USB\\VID_1E0E&PID_9001&MI_04\\7&2A3B&0&0004', vendorId: '1E0E', productId: '9001' },
];

describe('hardware operations', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(options: { atPort?: string; audioPort?: string; ports?: RawPortInfo[]; ready?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-ops-'));
    const transport = new FakeSerialTransport('COM-AT-TEST', 115200);
    const modem = new Sim7600HardwareAdapter({ atPort: 'COM-AT-TEST', atBaudRate: 115200, commandTimeoutMs: 500, dialTimeoutMs: 1000, autoReconnect: false, transport });
    transport.onWrite((w) => transport.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : w.includes('AT+CSQ') ? '+CSQ: 21,99\r\nOK\r\n' : 'OK\r\n'));
    if (options.ready !== false) await modem.initialize();
    const lister = vi.fn(async () => options.ports ?? WINDOWS_PORTS);
    const server: GatewayServerInstance = createGatewayServer({
      config: {
        modemDriver: 'mock',
        gatewayApiKey: KEY,
        sqliteDbPath: path.join(dir, 'g.sqlite'),
        audioDumpDir: path.join(dir, 'rec'),
        atPort: options.atPort ?? 'COM20',
        audioPort: options.audioPort ?? 'COM19',
        enableUsbAudioDiagnostic: true,
      },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { hardwarePortLister: lister },
    });
    cleanup.push(async () => {
      await server.close();
      await modem.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const get = (p: string) => request(server.app).get(`/api/gateway/hardware${p}`).set('x-api-key', KEY);
    return { server, modem, transport, lister, get, written: () => transport.getWrittenHistory() };
  }

  describe('layers are kept apart', () => {
    const base = { connectionState: 'READY', atStatus: 'OK', callActive: true, audioPortOpen: true, registrationActive: true, needsRecovery: false, wireState: 'flowing', msSinceLastFrame: 20, bytesReceived: 5000 };
    const by = (layers: ReturnType<typeof buildHardwareLayers>) => Object.fromEntries(layers.map((l) => [l.key, l.state]));

    it('an open port is not registration, registration is not fresh bytes, and nothing makes playback verified', () => {
      expect(by(buildHardwareLayers(base))).toEqual({ atPort: 'ok', audioPortOpen: 'ok', usbAudioRegistered: 'ok', freshPcm: 'ok', playbackVerified: 'unknown' });
      // Port open, registered, but nothing arriving (the situation behind "stalled").
      const stalled = by(buildHardwareLayers({ ...base, wireState: 'stalled', msSinceLastFrame: 9000 }));
      expect(stalled).toMatchObject({ audioPortOpen: 'ok', usbAudioRegistered: 'ok', freshPcm: 'bad' });
      // Port open (audioStreaming true) but never registered.
      expect(by(buildHardwareLayers({ ...base, registrationActive: false, wireState: 'not-expected', msSinceLastFrame: null }))).toMatchObject({ audioPortOpen: 'ok', usbAudioRegistered: 'bad', freshPcm: 'bad' });
      // Unverified after a drop.
      expect(by(buildHardwareLayers({ ...base, registrationActive: false, needsRecovery: true, wireState: 'unverified' })).usbAudioRegistered).toBe('warn');
      expect(buildHardwareLayers(base).at(-1)!.detail).toMatch(/never inferred/);
    });

    it('says unknown, not failed, when there is no call', () => {
      const idle = by(buildHardwareLayers({ ...base, callActive: false, audioPortOpen: false, registrationActive: false, wireState: 'not-expected', msSinceLastFrame: null }));
      expect(idle).toMatchObject({ audioPortOpen: 'unknown', usbAudioRegistered: 'unknown', freshPcm: 'unknown' });
    });

    it('reports a disconnected AT port as bad and a connecting one as a warning', () => {
      expect(by(buildHardwareLayers({ ...base, connectionState: 'DISCONNECTED', atStatus: 'DISCONNECTED' })).atPort).toBe('bad');
      expect(by(buildHardwareLayers({ ...base, connectionState: 'INITIALIZING' })).atPort).toBe('warn');
    });
  });

  describe('port discovery', () => {
    it('recognises the module\'s interfaces from the USB interface numbers', () => {
      const roles = Object.fromEntries(WINDOWS_PORTS.map((p) => [p.path, classifyPort(p).role]));
      expect(roles).toEqual({ COM3: 'unknown', COM22: 'at', COM23: 'nmea', COM24: 'diagnostics', COM26: 'audio' });
      expect(classifyPort(WINDOWS_PORTS[1]).roleBasis).toMatch(/interface 02/);
    });

    it('names a stale configuration and the exact change, and never picks silently when it is ambiguous', () => {
      const discovered = WINDOWS_PORTS.map(classifyPort).filter((p) => p.vendorId === '1E0E');
      const stale = comparePorts({ at: 'COM20', audio: 'COM19' }, discovered);
      expect(stale.suggested).toEqual({ MODEM_AT_PORT: 'COM22', MODEM_AUDIO_PORT: 'COM26' });
      expect(stale.findings.map((f) => f.message).join(' ')).toMatch(/AT port COM20 is not present .* set MODEM_AT_PORT=COM22/);

      const fine = comparePorts({ at: 'COM22', audio: 'COM26' }, discovered);
      expect(fine.suggested).toEqual({});
      expect(fine.findings.every((f) => f.level === 'info')).toBe(true);

      const swapped = comparePorts({ at: 'COM26', audio: 'COM22' }, discovered);
      expect(swapped.findings.map((f) => f.message).join(' ')).toMatch(/COM26 is the module's audio interface, not its at interface/);

      const same = comparePorts({ at: 'COM22', audio: 'COM22' }, discovered);
      expect(same.findings.some((f) => /must differ/.test(f.message))).toBe(true);

      const two = comparePorts({ at: 'COM20', audio: 'COM26' }, [...discovered, classifyPort({ path: 'COM30', pnpId: 'USB\\VID_1E0E&PID_9001&MI_02\\x', vendorId: '1E0E' })]);
      expect(two.suggested.MODEM_AT_PORT).toBeUndefined();
      expect(two.findings.map((f) => f.message).join(' ')).toMatch(/Several ports look like/);
    });

    it('lists through the endpoint without opening any port or sending any command', async () => {
      const h = await harness();
      const before = h.written().length;
      const res = await h.get('/ports');
      expect(res.status).toBe(200);
      expect(h.lister).toHaveBeenCalledTimes(1);
      expect(res.body.configured).toEqual({ at: 'COM20', audio: 'COM19' });
      expect(res.body.suggestedEnv).toEqual({ MODEM_AT_PORT: 'COM22', MODEM_AUDIO_PORT: 'COM26' });
      expect(res.body.ports.map((p: any) => p.path)).toEqual(['COM3', 'COM22', 'COM23', 'COM24', 'COM26']);
      expect(h.written().length).toBe(before); // nothing was written to the modem
    });

    it('turns a listing failure into a clear error', async () => {
      const h = await harness();
      h.lister.mockRejectedValueOnce(new Error('SetupAPI failed'));
      const res = await h.get('/ports');
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: 'PORT_LIST_FAILED' });
    });
  });

  describe('status', () => {
    it('is built from what the gateway already knows and sends no AT command', async () => {
      const h = await harness();
      const before = h.written().length;
      const res = await h.get('/status');
      expect(res.status).toBe(200);
      expect(h.written().length).toBe(before);
      expect(res.body.modem).toMatchObject({ connectionState: 'READY', configuredAtPort: 'COM20', configuredAudioPort: 'COM19' });
      expect(res.body.modem.reconnect).toMatchObject({ connectionState: 'READY', initAttempts: 1, reconnectScheduled: false, lastInit: { ok: true } });
      expect(res.body.layers.map((l: any) => l.key)).toEqual(['atPort', 'audioPortOpen', 'usbAudioRegistered', 'freshPcm', 'playbackVerified']);
      expect(res.body.layers.at(-1)).toMatchObject({ key: 'playbackVerified', state: 'unknown' });
      expect(res.body.call).toBeNull();
    });

    it('shows the reconnect state after a failure', async () => {
      const h = await harness();
      h.transport.simulateErrorWithoutClose(new Error('Unknown error code 31'));
      const res = await h.get('/status');
      expect(res.body.modem.reconnect.lastFailure).toMatchObject({ message: expect.stringContaining('code 31') });
      expect(res.body.modem.connectionState).toBe('ERROR');
      expect(res.body.layers[0]).toMatchObject({ key: 'atPort', state: 'bad' });
    });
  });

  describe('modem info (AT queries)', () => {
    it('answers with signal and SIM when idle', async () => {
      const h = await harness();
      const res = await h.get('/modem-info');
      expect(res.status).toBe(200);
      expect(res.body.signal.rssi).toBe(21);
      expect(res.body.simStatus).toBe('READY');
    });

    it('refuses, and sends nothing, while any call exists', async () => {
      const h = await harness();
      vi.spyOn(h.server.callManager, 'getCurrentCall').mockReturnValue({ id: 'c', state: 'ACTIVE', direction: 'inbound' } as never);
      const before = h.written().length;
      const res = await h.get('/modem-info');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CALL_IN_PROGRESS');
      expect(h.written().length).toBe(before);
    });

    it('refuses when the modem is not ready', async () => {
      const h = await harness({ ready: false });
      const res = await h.get('/modem-info');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODEM_NOT_READY');
    });
  });

  describe('logs and the diagnostic report', () => {
    it('keeps recent log lines already redacted', () => {
      const log = createLogger('HardwareTest');
      log.warn('Serial port COM22 dropped; caller +919876543210 was on the line; Authorization: Bearer sk-secret-token-123456789');
      const lines = getRecentLogs(20, 'warn').map((e) => e.line).join('\n');
      expect(lines).toContain('Serial port COM22 dropped');
      expect(lines).not.toContain('919876543210');
      expect(lines).not.toContain('sk-secret-token');
    });

    it('builds a copyable report with the layers, ports and recent problems, and no secrets or numbers', async () => {
      const h = await harness();
      createLogger('HardwareTest').error('Modem init failed: caller 919876543210 key=sk-live-abcdef1234567890');
      const res = await h.get('/report');
      expect(res.status).toBe(200);
      const text: string = res.body.report;
      for (const heading of ['AI Caller hardware report', 'Layers', 'Configured ports: AT=COM20  audio=COM19', 'SIMCom ports present now', 'COM26  MI_04  audio', 'Recent log']) {
        expect(text).toContain(heading);
      }
      expect(text).toContain('Playback verified');
      expect(text).not.toContain('919876543210');
      expect(text).not.toContain('sk-live-abcdef');
      expect(text).not.toContain(KEY);
    });

    it('serves the log tail at the requested level', async () => {
      const h = await harness();
      createLogger('HardwareTest').warn('a warning worth seeing');
      const res = await h.get('/logs?level=warn&limit=5');
      expect(res.status).toBe(200);
      expect(res.body.entries.some((e: any) => /a warning worth seeing/.test(e.line))).toBe(true);
      expect(res.body.entries.every((e: any) => e.level === 'warn' || e.level === 'error')).toBe(true);
    });
  });

  it('requires the gateway API key on every hardware route', async () => {
    const h = await harness();
    for (const p of ['/status', '/ports', '/modem-info', '/logs', '/report']) {
      expect((await request(h.server.app).get(`/api/gateway/hardware${p}`)).status, p).toBe(401);
      expect((await request(h.server.app).get(`/api/gateway/hardware${p}`).set('x-api-key', 'wrong-key-wrong-key')).status, p).toBe(401);
    }
  });
});
