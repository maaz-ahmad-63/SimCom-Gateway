import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModemConnectionState, SerialPortDisconnectedError } from '@sim-gateway/shared';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';

/** A fake port that records how it is used and can be told to fail to open. */
class TrackedTransport extends FakeSerialTransport {
  opens = 0;
  closes = 0;
  openFailures = 0;
  private opening = 0;
  maxConcurrentOpens = 0;

  async open(): Promise<void> {
    this.opens++;
    this.opening++;
    this.maxConcurrentOpens = Math.max(this.maxConcurrentOpens, this.opening);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (this.openFailures > 0) {
        this.openFailures--;
        throw new SerialPortDisconnectedError(this.path, `Failed to open serial port '${this.path}': File not found`);
      }
      await super.open();
    } finally {
      this.opening--;
    }
  }

  async close(): Promise<void> {
    this.closes++;
    await super.close();
  }
}

describe('modem reconnect lifecycle', () => {
  const adapters: Sim7600HardwareAdapter[] = [];
  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.close();
    vi.restoreAllMocks();
  });

  function create(options: { maxReconnectAttempts?: number } = {}) {
    const transport = new TrackedTransport('COM-AT-TEST', 115200);
    const adapter = new Sim7600HardwareAdapter({
      atPort: 'COM-AT-TEST',
      atBaudRate: 115200,
      commandTimeoutMs: 300,
      dialTimeoutMs: 1000,
      autoReconnect: true,
      reconnectIntervalMs: 15,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      transport,
    });
    adapters.push(adapter);
    transport.onWrite((written) => transport.feedIncomingData(written.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : written.includes('AT+CSQ') ? '+CSQ: 20,99\r\nOK\r\n' : 'OK\r\n'));
    const states: ModemConnectionState[] = [];
    adapter.on('connection_state', (s: ModemConnectionState) => states.push(s));
    adapter.on('error', () => {}); // errors are reported through state; keep the emitter quiet
    return { transport, adapter, states };
  }

  it('releases a handle that failed without closing, then reopens it and works again', async () => {
    const { transport, adapter, states } = create();
    await adapter.initialize();
    expect(transport.opens).toBe(1);

    // Windows error 31: the driver fails, but the port object never says it closed.
    transport.simulateErrorWithoutClose(new Error('Unknown error code 31'));
    expect(transport.isOpen()).toBe(true);
    expect(adapter.getConnectionState()).toBe('ERROR');

    await vi.waitFor(() => expect(adapter.getConnectionState()).toBe('READY'), { timeout: 3000 });
    expect(transport.closes).toBe(1); // the dead handle was let go first
    expect(transport.opens).toBe(2); // and a fresh one opened
    expect(states).toEqual(expect.arrayContaining(['CONNECTING', 'INITIALIZING', 'READY', 'ERROR']));
    const signal = await adapter.getSignalQuality();
    expect(signal.rssi).toBe(20); // commands run on the new connection
  });

  it('releasing its own handle during a reconnect is not mistaken for a new failure', async () => {
    const { transport, adapter, states } = create();
    await adapter.initialize();
    transport.simulateErrorWithoutClose(new Error('Unknown error code 31'));
    await vi.waitFor(() => expect(adapter.getConnectionState()).toBe('READY'), { timeout: 3000 });
    // ERROR is entered exactly once for one failure.
    expect(states.filter((s) => s === 'ERROR')).toHaveLength(1);
  });

  it('keeps retrying with growing delays through failed opens, never overlaps two attempts, then recovers', async () => {
    const { transport, adapter, states } = create();
    await adapter.initialize();
    transport.openFailures = 2;
    transport.simulateDisconnect(new Error('device removed'));

    await vi.waitFor(() => expect(adapter.getConnectionState()).toBe('READY'), { timeout: 4000 });
    expect(transport.opens).toBe(1 + 3); // two failures, then success
    expect(transport.maxConcurrentOpens).toBe(1);
    expect(states.filter((s) => s === 'ERROR').length).toBeGreaterThanOrEqual(3);
    expect((await adapter.getSignalQuality()).rssi).toBe(20);
  });

  it('shares one initialization between concurrent callers instead of opening twice', async () => {
    const { transport, adapter } = create();
    await Promise.all([adapter.initialize(), adapter.initialize(), adapter.initialize()]);
    expect(transport.opens).toBe(1);
    expect(transport.maxConcurrentOpens).toBe(1);
    expect(adapter.getConnectionState()).toBe('READY');
  });

  it('gives up after the configured number of attempts and stops touching the port', async () => {
    const { transport, adapter } = create({ maxReconnectAttempts: 3 });
    await adapter.initialize();
    transport.openFailures = 100;
    transport.simulateDisconnect(new Error('device removed'));

    await vi.waitFor(() => expect(adapter.getConnectionState()).toBe('DISCONNECTED'), { timeout: 4000 });
    const opens = transport.opens;
    expect(opens).toBe(1 + 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(transport.opens).toBe(opens); // no timer left running
  });

  it('closing the modem cancels a pending reconnect', async () => {
    const { transport, adapter } = create();
    await adapter.initialize();
    transport.simulateDisconnect(new Error('device removed'));
    await adapter.close();
    const opens = transport.opens;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(transport.opens).toBe(opens);
    expect(adapter.getConnectionState()).toBe('DISCONNECTED');
  });

  it('a healthy connection is never closed just because initialize ran again after an init error', async () => {
    const { transport, adapter } = create();
    let pin = 'SIM PIN';
    transport.onWrite((written) => transport.feedIncomingData(written.includes('AT+CPIN?') ? `+CPIN: ${pin}\r\nOK\r\n` : 'OK\r\n'));
    await expect(adapter.initialize()).rejects.toThrow(/SIM card is not ready/);
    pin = 'READY';
    await vi.waitFor(() => expect(adapter.getConnectionState()).toBe('READY'), { timeout: 3000 });
    expect(transport.closes).toBe(0); // the open handle was fine and was reused
    expect(transport.opens).toBe(1);
  });
});
