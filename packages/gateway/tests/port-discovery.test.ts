import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModemConnectionState, SerialPortDisconnectedError } from '@sim-gateway/shared';
import { Sim7600HardwareAudioAdapter } from '../src/adapters/audio/hardware-audio.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { FakeSerialTransport, SerialTransportOptions } from '../src/adapters/modem/serial-transport.js';
import {
  classifyInterface,
  groupModems,
  parsePnpId,
  PortDiscovery,
  PortDiscoveryError,
  resolveModemPorts,
  SerialInterfaceInfo,
} from '../src/hardware/port-discovery.js';

/** One SIM7600EI as Windows lists it: VID 1E0E, PID 9001, interfaces MI_00..MI_04 sharing one parent instance prefix. */
function sim7600(ports: { diag?: string; nmea?: string; at?: string; audio?: string }, parent = '6&3A1B2C4D&0', names = true): SerialInterfaceInfo[] {
  const out: SerialInterfaceInfo[] = [];
  const add = (path: string | undefined, mi: string, name: string) => {
    if (!path) return;
    out.push({
      path,
      manufacturer: 'SimTech, Incorporated',
      pnpId: `USB\\VID_1E0E&PID_9001&MI_${mi}\\${parent}&00${mi}`,
      vendorId: '1E0E',
      productId: '9001',
      friendlyName: names ? `SimTech HS-USB ${name} 9001 (${path})` : undefined,
    });
  };
  add(ports.diag, '00', 'Diagnostics');
  add(ports.nmea, '01', 'NMEA');
  add(ports.at, '02', 'AT Port');
  add(ports.audio, '04', 'Audio');
  return out;
}
const bluetooth: SerialInterfaceInfo = { path: 'COM3', manufacturer: 'Microsoft', pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\7&2B1A&0&000000000000_00000000' };
const usbSerial: SerialInterfaceInfo = { path: 'COM7', pnpId: 'USB\\VID_0403&PID_6001\\A50285BI', vendorId: '0403', productId: '6001' };

describe('reading Windows device identity', () => {
  it('takes the vendor, product, interface and parent device from the PnP id', () => {
    expect(parsePnpId('USB\\VID_1E0E&PID_9001&MI_02\\6&3A1B2C4D&0&0002')).toEqual({ vid: '1E0E', pid: '9001', iface: 'MI_02', deviceKey: '6&3A1B2C4D&0' });
    expect(parsePnpId('USB\\VID_0403&PID_6001\\A50285BI')).toEqual({ vid: '0403', pid: '6001', iface: null, deviceKey: 'A50285BI' });
    expect(parsePnpId(undefined)).toEqual({ vid: null, pid: null, iface: null, deviceKey: null });
  });

  it('assigns a role from the interface number and confirms it with the port name', () => {
    const [diag, , at, audio] = sim7600({ diag: 'COM18', nmea: 'COM17', at: 'COM20', audio: 'COM19' });
    expect(classifyInterface(at)).toMatchObject({ role: 'at', interface: 'MI_02' });
    expect(classifyInterface(at).roleBasis).toMatch(/Windows name .* agrees/);
    expect(classifyInterface(audio).role).toBe('audio');
    expect(classifyInterface(diag).role).toBe('diagnostics');
    expect(classifyInterface(usbSerial)).toMatchObject({ role: 'unknown', roleBasis: 'not a SIMCom device port' });
  });

  it('does not use an interface whose number and name disagree', () => {
    const conflicting = { ...sim7600({ at: 'COM20' })[0], friendlyName: 'SimTech HS-USB Audio 9001 (COM20)' };
    const port = classifyInterface(conflicting);
    expect(port.role).toBe('unknown');
    expect(port.roleBasis).toMatch(/not used automatically/);
  });
});

describe('choosing the ports', () => {
  it('finds the AT and audio interfaces of one modem independently, whatever their COM numbers (AT above audio here)', () => {
    const result = resolveModemPorts({}, [bluetooth, usbSerial, ...sim7600({ diag: 'COM18', nmea: 'COM17', at: 'COM20', audio: 'COM19' })]);
    expect(result).toMatchObject({ ok: true, mode: 'discovered', at: 'COM20', audio: 'COM19' });
    expect(result.ok && result.device?.id).toBe('1E0E:9001:6&3A1B2C4D&0');
  });

  it('follows the modem when Windows renumbers its ports, by its USB identity', () => {
    const before = resolveModemPorts({}, sim7600({ at: 'COM20', audio: 'COM19' }));
    const after = resolveModemPorts({ previousId: before.ok ? before.device!.id : null }, sim7600({ at: 'COM31', audio: 'COM4' }));
    expect(after).toMatchObject({ ok: true, at: 'COM31', audio: 'COM4', warnings: [] });
  });

  it('works from interface numbers alone when Windows gives no port names', () => {
    expect(resolveModemPorts({}, sim7600({ at: 'COM9', audio: 'COM12' }, '6&1&0', false))).toMatchObject({ ok: true, at: 'COM9', audio: 'COM12' });
  });

  it('refuses, naming what is missing, when the modem lacks its audio or AT interface', () => {
    const noAudio = resolveModemPorts({}, sim7600({ diag: 'COM18', at: 'COM20' }));
    expect(noAudio).toMatchObject({ ok: false, code: 'INTERFACE_MISSING' });
    expect(noAudio.ok === false && noAudio.message).toMatch(/no USB audio interface was found/);
    expect(resolveModemPorts({}, sim7600({ audio: 'COM19' }))).toMatchObject({ ok: false, code: 'INTERFACE_MISSING' });
  });

  it('says there is no modem when none is connected, and ignores other serial devices', () => {
    const result = resolveModemPorts({}, [bluetooth, usbSerial]);
    expect(result).toMatchObject({ ok: false, code: 'NO_MODEM', modems: [] });
  });

  it('ignores a SIMCom port with no device identity instead of guessing which modem it belongs to', () => {
    const anonymous: SerialInterfaceInfo = { path: 'COM40', vendorId: '1E0E', productId: '9001', friendlyName: 'SimTech HS-USB AT Port 9001 (COM40)' };
    const grouped = groupModems([anonymous]);
    expect(grouped.modems).toEqual([]);
    expect(grouped.unidentified.map((p) => p.path)).toEqual(['COM40']);
    expect(resolveModemPorts({}, [anonymous]).ok).toBe(false);
  });

  it('never guesses between two modems; a selector or the modem used before decides', () => {
    const two = [...sim7600({ at: 'COM20', audio: 'COM19' }, '6&AAAA&0'), ...sim7600({ at: 'COM25', audio: 'COM26' }, '6&BBBB&0')];
    const refused = resolveModemPorts({}, two);
    expect(refused).toMatchObject({ ok: false, code: 'MULTIPLE_MODEMS' });
    expect(refused.ok === false && refused.message).toMatch(/does not guess/);
    expect(refused.modems.map((m) => [m.id, m.at, m.audio])).toEqual([
      ['1E0E:9001:6&AAAA&0', 'COM20', 'COM19'],
      ['1E0E:9001:6&BBBB&0', 'COM25', 'COM26'],
    ]);
    expect(resolveModemPorts({ selector: '6&BBBB' }, two)).toMatchObject({ ok: true, at: 'COM25', audio: 'COM26' });
    expect(resolveModemPorts({ selector: '6&CCCC' }, two)).toMatchObject({ ok: false, code: 'SELECTOR_NO_MATCH' });
    expect(resolveModemPorts({ selector: '6&' }, two)).toMatchObject({ ok: false, code: 'MULTIPLE_MODEMS' });
    // A reconnect while a second modem is plugged in keeps the one this gateway was using.
    expect(resolveModemPorts({ previousId: '1E0E:9001:6&AAAA&0' }, two)).toMatchObject({ ok: true, at: 'COM20' });
  });

  it('adopts a single modem that reappears under another identity (moved USB socket), and says so', () => {
    const result = resolveModemPorts({ previousId: '1E0E:9001:6&OLD&0' }, sim7600({ at: 'COM5', audio: 'COM6' }, '6&NEW&0'));
    expect(result).toMatchObject({ ok: true, at: 'COM5' });
    expect(result.warnings.join(' ')).toMatch(/was 1E0E:9001:6&OLD&0/);
  });

  it('uses explicit overrides exactly as given, and only warns about what it sees', () => {
    const listing = sim7600({ at: 'COM20', audio: 'COM19' });
    expect(resolveModemPorts({ explicitAt: 'COM20', explicitAudio: 'COM19' }, listing)).toMatchObject({ ok: true, mode: 'explicit', at: 'COM20', audio: 'COM19', warnings: [] });
    const swapped = resolveModemPorts({ explicitAt: 'COM19', explicitAudio: 'COM20' }, listing);
    expect(swapped).toMatchObject({ ok: true, mode: 'explicit', at: 'COM19', audio: 'COM20' });
    expect(swapped.warnings.join(' ')).toMatch(/COM19 \(set explicitly\) looks like the module's audio interface/);
    const absent = resolveModemPorts({ explicitAt: 'COM99', explicitAudio: 'COM98' }, listing);
    expect(absent).toMatchObject({ ok: true, at: 'COM99' });
    expect(absent.warnings.join(' ')).toMatch(/not present in Windows right now/);
  });

  it('with only one port set, takes the other from the same modem, or refuses', () => {
    const listing = [...sim7600({ at: 'COM20', audio: 'COM19' }, '6&AAAA&0'), ...sim7600({ at: 'COM25', audio: 'COM26' }, '6&BBBB&0')];
    expect(resolveModemPorts({ explicitAt: 'COM25' }, listing)).toMatchObject({ ok: true, mode: 'mixed', at: 'COM25', audio: 'COM26' });
    expect(resolveModemPorts({ explicitAudio: 'COM19' }, listing)).toMatchObject({ ok: true, mode: 'mixed', at: 'COM20', audio: 'COM19' });
    expect(resolveModemPorts({ explicitAt: 'COM77' }, listing)).toMatchObject({ ok: false, code: 'EXPLICIT_PORT_UNIDENTIFIED' });
  });
});

describe('the discovery service', () => {
  it('reports a listing failure instead of throwing, and an actionable error when asked for a port', async () => {
    const discovery = new PortDiscovery(async () => {
      throw new Error('registry unavailable');
    });
    expect(await discovery.scan()).toMatchObject({ ok: false, code: 'LIST_FAILED' });
    await expect(discovery.resolveAt()).rejects.toBeInstanceOf(PortDiscoveryError);
    expect(discovery.status()).toMatchObject({ mode: 'discovery', ok: false, code: 'LIST_FAILED', at: null, audio: null });
  });

  it('remembers the modem it chose, keeps it across renumbering, and exposes what it found', async () => {
    let listing = sim7600({ at: 'COM20', audio: 'COM19' }, '6&AAAA&0');
    const discovery = new PortDiscovery(async () => listing);
    expect(await discovery.resolveAt()).toBe('COM20');
    listing = [...sim7600({ at: 'COM21', audio: 'COM22' }, '6&AAAA&0'), ...sim7600({ at: 'COM25', audio: 'COM26' }, '6&BBBB&0')];
    expect(await discovery.resolveAudio()).toBe('COM22'); // the same physical modem, although a second one is now present
    const status = discovery.status();
    expect(status).toMatchObject({ mode: 'discovery', ok: true, at: 'COM21', audio: 'COM22', device: { id: '1E0E:9001:6&AAAA&0' } });
    expect(status.modems).toHaveLength(2);
    expect(discovery.isPresent('com21')).toBe(true);
    expect(discovery.isPresent('COM20')).toBe(false);
  });

  it('is explicit only when both ports are set', () => {
    expect(new PortDiscovery(async () => [], { explicitAt: 'COM20', explicitAudio: 'COM19' }).isExplicit).toBe(true);
    expect(new PortDiscovery(async () => [], { explicitAt: 'COM20' }).isExplicit).toBe(false);
  });
});

/** A fake port that records which path each open() used, and can be unplugged. */
class PathTransport extends FakeSerialTransport {
  readonly openedPaths: string[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  failOpen = 0;
  async open(options?: Partial<SerialTransportOptions>): Promise<void> {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (this.failOpen > 0) {
        this.failOpen--;
        throw new SerialPortDisconnectedError(options?.path ?? this.path, 'File not found');
      }
      this.openedPaths.push(options?.path ?? this.path);
      await super.open();
    } finally {
      this.concurrent--;
    }
  }
}

describe('the adapters follow discovery on every (re)connect, and only then', () => {
  const adapters: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.close();
  });

  function modemOn(discovery: PortDiscovery) {
    const transport = new PathTransport('auto');
    transport.onWrite((w) => transport.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : 'OK\r\n'));
    const adapter = new Sim7600HardwareAdapter({
      atPort: 'auto',
      commandTimeoutMs: 300,
      autoReconnect: true,
      reconnectIntervalMs: 10,
      maxReconnectAttempts: 3,
      transport,
      resolvePort: () => discovery.resolveAt(),
    });
    adapter.on('error', () => {});
    adapters.push(adapter);
    const states: ModemConnectionState[] = [];
    adapter.on('connection_state', (s: ModemConnectionState) => states.push(s));
    return { transport, adapter, states };
  }

  it('opens the discovered AT port, and the new one after a USB reconnect renumbered it', async () => {
    let listing = sim7600({ at: 'COM20', audio: 'COM19' });
    const discovery = new PortDiscovery(async () => listing);
    const { transport, adapter } = modemOn(discovery);
    await adapter.initialize({ atPort: 'auto' });
    expect(transport.openedPaths).toEqual(['COM20']);
    expect(adapter.getConnectionState()).toBe('READY');

    listing = sim7600({ at: 'COM23', audio: 'COM24' }); // replugged: same modem, new numbers
    transport.simulateDisconnect();
    await vi.waitFor(() => expect(adapter.getConnectionState()).toBe('READY'), { timeout: 3000 });
    expect(transport.openedPaths).toEqual(['COM20', 'COM23']);
    expect(transport.maxConcurrent).toBe(1); // never two opens at once
    expect(adapter.getDiagnostics().port).toBe('COM23');
  });

  it('opens nothing while the modem is missing or ambiguous, and reports why', async () => {
    let listing: SerialInterfaceInfo[] = [...sim7600({ at: 'COM20', audio: 'COM19' }, '6&AAAA&0'), ...sim7600({ at: 'COM25', audio: 'COM26' }, '6&BBBB&0')];
    const discovery = new PortDiscovery(async () => listing);
    const { transport, adapter } = modemOn(discovery);
    await expect(adapter.initialize({ atPort: 'auto' })).rejects.toThrow(/does not guess/);
    expect(transport.openedPaths).toEqual([]);
    expect(adapter.getDiagnostics().lastInit).toMatchObject({ ok: false, step: 'discover-port' });

    listing = [];
    await vi.waitFor(() => expect(adapter.getDiagnostics().lastInit?.error).toMatch(/No SIMCom modem/), { timeout: 3000 });
    expect(transport.openedPaths).toEqual([]);
  });

  it('never asks discovery again while the port is open (no re-resolution under a running connection)', async () => {
    const lister = vi.fn(async () => sim7600({ at: 'COM20', audio: 'COM19' }));
    const { adapter } = modemOn(new PortDiscovery(lister));
    await adapter.initialize({ atPort: 'auto' });
    await adapter.initialize(); // already connected: shares nothing new, opens nothing
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it('the audio adapter resolves its port when a call opens it, never during the call, and opens nothing if it cannot', async () => {
    let listing = sim7600({ at: 'COM20', audio: 'COM19' });
    const lister = vi.fn(async () => listing);
    const discovery = new PortDiscovery(lister);
    const transport = new PathTransport('auto');
    const audio = new Sim7600HardwareAudioAdapter({ audioPort: 'auto', transport, resolvePort: () => discovery.resolveAudio() });
    audio.on('error', () => {});
    adapters.push({ close: () => audio.stopSession() });

    await audio.startSession('call-1');
    expect(transport.openedPaths).toEqual(['COM19']);
    expect(audio.getStats().isStreaming).toBe(true);
    listing = sim7600({ at: 'COM30', audio: 'COM31' });
    await audio.writeAudioChunk(Buffer.alloc(320)); // the call goes on on the port it has
    expect(lister).toHaveBeenCalledTimes(1);
    await audio.stopSession();

    listing = [];
    await audio.startSession('call-2');
    expect(audio.getStats().isStreaming).toBe(false);
    expect(transport.openedPaths).toEqual(['COM19']);
  });
});

describe('source rules', () => {
  it('discovery never opens a port: it only lists them', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '../src/hardware/port-discovery.ts'), 'utf8');
    expect(code).not.toMatch(/new SerialPort\(|from 'serialport'|\.open\(|executeCommand|AT\+/);
  });

  it('no fixed COM number is assumed for real hardware', () => {
    const config = fs.readFileSync(path.resolve(__dirname, '../src/config/index.ts'), 'utf8');
    expect(config).toMatch(/atPort: atPort \|\| AUTO_PORT/);
    const server = fs.readFileSync(path.resolve(__dirname, '../src/server.ts'), 'utf8');
    expect(server).not.toMatch(/['"]COM\d+['"]/);
  });
});
