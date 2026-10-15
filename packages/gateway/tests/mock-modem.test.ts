import { describe, expect, it } from 'vitest';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';

describe('MockModemAdapter', () => {
  it('identifies as simulated mock driver', () => {
    const modem = new MockModemAdapter();
    expect(modem.driverType).toBe('mock');
    expect(modem.isSimulated).toBe(true);
  });

  it('initializes and reports READY connection state', async () => {
    const modem = new MockModemAdapter();
    expect(modem.getConnectionState()).toBe('DISCONNECTED');

    await modem.initialize();
    expect(modem.getConnectionState()).toBe('READY');

    await modem.close();
    expect(modem.getConnectionState()).toBe('DISCONNECTED');
  });

  it('responds correctly to SIM7600EI AT command set', async () => {
    const modem = new MockModemAdapter();
    await modem.initialize();

    const ati = await modem.executeCommand('ATI');
    expect(ati).toContain('SIMCOM_SIM7600EI');
    expect(ati).toContain('SIM7600M21-A_V1.1');

    const csq = await modem.executeCommand('AT+CSQ');
    expect(csq).toMatch(/^\+CSQ: \d+,99\nOK$/);

    const cops = await modem.executeCommand('AT+COPS?');
    expect(cops).toContain('Vi India');

    const cpin = await modem.executeCommand('AT+CPIN?');
    expect(cpin).toContain('+CPIN: READY');
  });

  it('queries signal quality and network telemetry', async () => {
    const modem = new MockModemAdapter({ initialRssi: 28, carrierName: 'Vi India' });
    await modem.initialize();

    const signal = await modem.getSignalQuality();
    expect(signal.rssi).toBe(28);
    expect(signal.bars).toBe(5);
    expect(signal.dBm).toBe(-113 + 28 * 2);

    const network = await modem.getNetworkStatus();
    expect(network.operatorName).toBe('Vi India');
    expect(network.registration).toBe('REGISTERED_HOME');
  });

  it('emits CLIP URCs during simulated inbound call', async () => {
    const modem = new MockModemAdapter({ ringIntervalMs: 50 });
    await modem.initialize();

    const urcs: any[] = [];
    modem.on('urc', (u) => urcs.push(u));

    modem.simulateInboundCall('+919876543210', 2);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(urcs.length).toBeGreaterThanOrEqual(1);
    const clip = urcs.find((u) => u.type === 'CLIP');
    expect(clip).toBeDefined();
    expect(clip.phoneNumber).toBe('+919876543210');
    expect(clip.isSimulated).toBe(true);

    await modem.close();
  });
});
