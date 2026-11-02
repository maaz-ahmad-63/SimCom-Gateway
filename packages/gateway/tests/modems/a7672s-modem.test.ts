import { afterEach, describe, expect, it } from 'vitest';
import { A7672sAdapter } from '../../src/adapters/modem/a7672s-modem.js';
import { FakeSerialTransport } from '../../src/adapters/modem/serial-transport.js';
import { Sim7600HardwareAdapter } from '../../src/adapters/modem/hardware-modem.js';
import { ModemRegistry } from '../../src/modems/registry.js';
import { createA7672sUnit, modemBFromEnv } from '../../src/modems/a7672s-unit.js';
import { identifyDiagPort } from '../../src/modems/diag-port.js';
import { ModemEvent } from '../../src/modems/types.js';
import { createModemUnit } from '../../src/modems/unit.js';
import { CallSessionManager } from '../../src/core/call-session-manager.js';
import { GatewayEventBus } from '../../src/core/event-bus.js';

// A scripted serial line, not a real A7672S: these tests prove the command flow and call tracking against responses written
// from SIMCom public A76xx manual. They do not prove behavior of the physical unit or its firmware.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ScriptedModem {
  readonly transport: FakeSerialTransport;
  clcc: string[] = []; // lines returned for AT+CLCC
  pin = 'READY';
  commands: string[] = [];
  constructor(path: string) {
    this.transport = new FakeSerialTransport(path, 115200);
    this.transport.onWrite((raw) => {
      const cmd = raw.replace(/[\r\n]+$/, '');
      this.commands.push(cmd);
      let body = '';
      if (cmd === 'AT+CPIN?') body = `+CPIN: ${this.pin}\r\n`;
      else if (cmd === 'AT+CSQ') body = '+CSQ: 20,99\r\n';
      else if (cmd === 'AT+CLCC') body = this.clcc.map((l) => `${l}\r\n`).join('');
      else if (cmd === 'AT+CEREG?') body = '+CEREG: 0,1\r\n';
      else if (cmd === 'AT+COPS?') body = '+COPS: 0,0,"TestNet",7\r\n';
      setTimeout(() => this.transport.feedIncomingData(`${cmd}\r\n${body}\r\nOK\r\n`), 1);
    });
  }
  urc(line: string) {
    this.transport.feedIncomingData(`\r\n${line}\r\n`);
  }
}

const adapters: A7672sAdapter[] = [];
function make(path = 'COM27', extra: Partial<ConstructorParameters<typeof A7672sAdapter>[0]> = {}) {
  const modem = new ScriptedModem(path);
  const adapter = new A7672sAdapter({ atPort: path, diagPort: 'COM29', transport: modem.transport, autoReconnect: false, callPollMs: 20, commandTimeoutMs: 500, ...extra });
  adapters.push(adapter);
  return { modem, adapter };
}
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close().catch(() => {})));
});

describe('A7672sAdapter', () => {
  it('initializes with baseline AT commands only: no SIM7600 audio or USB PCM command is ever sent', async () => {
    const { modem, adapter } = make();
    await adapter.initialize();
    expect(adapter.getConnectionState()).toBe('READY');
    expect(modem.commands).toEqual(['AT', 'ATE0', 'AT+CMEE=2', 'AT+CLIP=1', 'AT+CPIN?']);
    expect(modem.commands.some((c) => /CPCMREG|CPCMFRM|CRC/.test(c))).toBe(false);
  });

  it('fails initialization when the SIM is not ready', async () => {
    const { modem, adapter } = make();
    modem.pin = 'SIM PIN';
    await expect(adapter.initialize()).rejects.toThrow(/SIM card is not ready/);
    expect(adapter.getConnectionState()).toBe('ERROR');
  });

  it('answers, hangs up, dials and reads signal / network / SIM through its own queue', async () => {
    const { modem, adapter } = make();
    await adapter.initialize();
    modem.commands.length = 0;
    await adapter.answer();
    await adapter.hangup();
    await adapter.dial('+919876543210');
    expect(modem.commands).toEqual(expect.arrayContaining(['ATA', 'AT+CHUP', 'ATD+919876543210;']));
    expect((await adapter.getSignalQuality()).rssi).toBe(20);
    expect((await adapter.getNetworkStatus()).operatorName).toBe('TestNet');
    expect(await adapter.getSimStatus()).toBe('READY');
  });

  it('reports caller ID from +CLIP and never opens the diagnostics port', async () => {
    const { modem, adapter } = make();
    await adapter.initialize();
    const urcs: Array<{ type: string; phoneNumber?: string }> = [];
    adapter.on('urc', (u) => urcs.push(u as never));
    modem.urc('RING');
    modem.urc('+CLIP: "+919999999999",145');
    await sleep(15);
    expect(urcs.find((u) => u.type === 'CLIP')?.phoneNumber).toBe('+919999999999');
    expect(adapter.getDiagnostics()).toMatchObject({ atPort: 'COM27', diagPort: 'COM29', diagPortOpened: false });
  });

  it('detects the end of a call from AT+CLCC when the modem sends no end URC', async () => {
    const { modem, adapter } = make();
    await adapter.initialize();
    const types: string[] = [];
    adapter.on('urc', (u) => types.push(u.type));
    modem.urc('RING');
    modem.clcc = ['+CLCC: 1,1,0,0,0,"+919999999999",145']; // active
    await sleep(60);
    expect(types).toContain('VOICE_CALL_BEGIN');
    modem.clcc = []; // gone
    await sleep(60);
    expect(types).toContain('NO_CARRIER');
    expect(adapter.getDiagnostics().callWatched).toBe(false);
  });

  it('does not poll when no call exists', async () => {
    const { modem, adapter } = make();
    await adapter.initialize();
    modem.commands.length = 0;
    await sleep(80);
    expect(modem.commands).not.toContain('AT+CLCC');
  });

  it('recovers its own serial connection after a drop', async () => {
    const { modem, adapter } = make('COM27', { autoReconnect: true, reconnectIntervalMs: 10 });
    await adapter.initialize();
    const states: string[] = [];
    adapter.on('connection_state', (s) => states.push(s));
    modem.transport.simulateDisconnect(new Error('device removed'));
    await sleep(150);
    expect(states).toContain('ERROR');
    expect(adapter.getConnectionState()).toBe('READY');
  });
});

describe('modem A and modem B side by side (scripted serial lines)', () => {
  function pair() {
    const aScript = new ScriptedModem('COM14');
    const aAdapter = new Sim7600HardwareAdapter({ atPort: 'COM14', transport: aScript.transport, autoReconnect: false, commandTimeoutMs: 500 });
    const aBus = new GatewayEventBus();
    aBus.on('error', () => {});
    const aCalls = new CallSessionManager({ modem: aAdapter, eventBus: aBus });
    const a = createModemUnit({ descriptor: { modemId: 'modem-a', name: 'A', model: 'SIM7600EI', atPort: 'COM14', audio: { kind: 'usb-pcm', port: 'COM13' } }, modem: aAdapter, audio: null, callManager: aCalls });
    const bScript = new ScriptedModem('COM27');
    const built = createA7672sUnit({ modemId: 'modem-b', atPort: 'COM27', diagPort: 'COM29', transport: bScript.transport, autoReconnect: false, callPollMs: 0, commandTimeoutMs: 500 });
    const registry = new ModemRegistry();
    registry.register(a);
    registry.register(built.unit);
    const events: ModemEvent[] = [];
    registry.onModemEvent((e) => events.push(e));
    return { registry, a, b: built.unit, aScript, bScript, events };
  }

  it('separate serial connections and command queues: a command on B never reaches A', async () => {
    const { a, b, aScript, bScript } = pair();
    await a.modem.initialize();
    await b.modem.initialize();
    aScript.commands.length = 0;
    bScript.commands.length = 0;
    await b.modem.executeCommand('AT+CSQ');
    expect(bScript.commands).toEqual(['AT+CSQ']);
    expect(aScript.commands).toEqual([]);
    expect(aScript.transport).not.toBe(bScript.transport);
  });

  it('simultaneous rings are two calls; answering B leaves A ringing; a drop on B leaves A READY', async () => {
    const { registry, a, b, aScript, bScript, events } = pair();
    await a.modem.initialize();
    await b.modem.initialize();
    aScript.urc('RING');
    aScript.urc('+CLIP: "+911111111111",145');
    bScript.urc('RING');
    bScript.urc('+CLIP: "+922222222222",145');
    await sleep(40);
    const callA = registry.getCall('modem-a');
    const callB = registry.getCall('modem-b');
    expect(callA?.remoteNumber).toBe('+911111111111');
    expect(callB?.remoteNumber).toBe('+922222222222');
    expect(callA?.id).not.toBe(callB?.id);
    expect(events.filter((e) => e.type === 'modem.call.ringing').map((e) => e.modemId).sort()).toEqual(['modem-a', 'modem-b']);

    aScript.commands.length = 0;
    await b.callManager.answer();
    expect(bScript.commands).toContain('ATA');
    expect(aScript.commands).not.toContain('ATA');
    expect(registry.getCall('modem-a')?.state).toBe('INBOUND_RINGING');

    bScript.transport.simulateDisconnect(new Error('usb reset'));
    await sleep(30);
    expect(registry.status('modem-b').connection).not.toBe('READY');
    expect(registry.status('modem-a').connection).toBe('READY');
    expect(registry.getCall('modem-a')?.state).toBe('INBOUND_RINGING');
  });
});

describe('modem B configuration and diagnostics port', () => {
  it('is absent unless MODEM_B_AT_PORT is set, and refuses AT and diagnostics on the same port', () => {
    expect(modemBFromEnv({})).toBeNull();
    expect(modemBFromEnv({ MODEM_B_AT_PORT: 'COM27', MODEM_B_DIAG_PORT: 'COM29' })).toMatchObject({ modemId: 'modem-b', atPort: 'COM27', diagPort: 'COM29' });
    expect(() => modemBFromEnv({ MODEM_B_AT_PORT: 'COM27', MODEM_B_DIAG_PORT: 'com27' })).toThrow(/different ports/);
  });

  it('identifies the diagnostics port from the port list without opening it', async () => {
    const list = async () => [{ path: 'COM27', friendlyName: 'AT Port' }, { path: 'COM29', friendlyName: 'Diag Port', manufacturer: 'SIMCom' }];
    expect(await identifyDiagPort(list, 'COM29')).toMatchObject({ present: true, opened: false, role: 'diagnostics', friendlyName: 'Diag Port' });
    expect(await identifyDiagPort(async () => [], 'COM29')).toMatchObject({ present: false, opened: false });
    expect(await identifyDiagPort(async () => { throw new Error('x'); }, 'COM29')).toMatchObject({ present: false });
  });
});
