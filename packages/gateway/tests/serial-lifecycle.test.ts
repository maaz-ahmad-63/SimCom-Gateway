import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SerialPortDisconnectedError } from '@sim-gateway/shared';

/**
 * A scripted stand-in for the `serialport` package. It models what matters on Windows: a port can be held by
 * only one handle at a time (the exclusive lock), releasing a handle takes time, and a driver failure such as
 * "Unknown error code 31" does NOT make the handle report itself closed.
 */
const sim = vi.hoisted(() => ({
  ports: [] as Array<Record<string, any>>,
  held: new Map<string, unknown>(),
  log: [] as string[],
  releaseDelayMs: 0,
  neverRelease: false,
  openFailures: 0,
  writeError: null as Error | null,
}));

vi.mock('serialport', async () => {
  const { EventEmitter } = await import('node:events');
  class SerialPort extends EventEmitter {
    isOpen = false;
    readonly id: number;
    constructor(public options: { path: string }) {
      super();
      this.id = sim.ports.length;
      sim.ports.push(this);
      sim.log.push(`new#${this.id}`);
    }
    open(cb: (err: Error | null) => void) {
      queueMicrotask(() => {
        const holder = sim.held.get(this.options.path);
        if (holder && holder !== this) {
          sim.log.push(`open#${this.id}:denied`);
          cb(new Error(`Opening ${this.options.path}: Access denied`));
          return;
        }
        if (sim.openFailures > 0) {
          sim.openFailures--;
          sim.log.push(`open#${this.id}:failed`);
          cb(new Error(`Opening ${this.options.path}: File not found`));
          return;
        }
        sim.held.set(this.options.path, this);
        this.isOpen = true;
        sim.log.push(`open#${this.id}`);
        cb(null);
      });
    }
    private release(error?: Error) {
      if (sim.neverRelease) return;
      this.isOpen = false;
      if (sim.held.get(this.options.path) === this) sim.held.delete(this.options.path);
      this.emit('close', error);
    }
    close(cb?: () => void) {
      sim.log.push(`close#${this.id}`);
      setTimeout(() => {
        this.release();
        cb?.();
      }, sim.releaseDelayMs);
    }
    destroy() {
      sim.log.push(`destroy#${this.id}`);
      setTimeout(() => this.release(), sim.releaseDelayMs);
    }
    write(_data: unknown, cb: (err?: Error | null) => void) {
      cb(sim.writeError);
    }
    drain(cb: (err?: Error | null) => void) {
      cb(null);
    }
  }
  return { SerialPort };
});

import { isFatalSerialError, NodeSerialTransport, SerialCloseInfo } from '../src/adapters/modem/serial-transport.js';

describe('NodeSerialTransport lifecycle', () => {
  let transport: NodeSerialTransport;
  let errors: Error[];
  let closes: SerialCloseInfo[];
  let data: string[];

  beforeEach(() => {
    sim.ports.length = 0;
    sim.held.clear();
    sim.log.length = 0;
    sim.releaseDelayMs = 0;
    sim.neverRelease = false;
    sim.openFailures = 0;
    sim.writeError = null;
    transport = new NodeSerialTransport({ path: 'COM19', baudRate: 115200 });
    errors = [];
    closes = [];
    data = [];
    transport.on('error', (e) => errors.push(e));
    transport.on('close', (c) => closes.push(c as SerialCloseInfo));
    transport.on('data', (d) => data.push(d.toString()));
  });

  const port = (n: number) => sim.ports[n];

  it('treats a fatal driver error as a dead handle even though the port still says it is open', async () => {
    await transport.open();
    port(0).emit('error', new Error('Unknown error code 31'));

    expect(port(0).isOpen).toBe(true); // what serialport claims
    expect(transport.isOpen()).toBe(false); // what the gateway now knows
    expect(errors.map((e) => e.message)).toEqual(['Unknown error code 31']);
    expect(closes).toEqual([{ disconnected: true, requestedByHost: false, detail: 'Unknown error code 31' }]);
  });

  it('announces a dead handle exactly once, whatever the real close event does afterwards', async () => {
    await transport.open();
    port(0).emit('error', new Error('Unknown error code 31'));
    await vi.waitFor(() => expect(port(0).isOpen).toBe(false)); // destroy() released it and it emitted close
    port(0).emit('close', Object.assign(new Error('gone'), { disconnected: true }));
    port(0).emit('error', new Error('Unknown error code 31'));
    expect(closes).toHaveLength(1);
  });

  it('releases the dead handle before creating a new one, and then works', async () => {
    sim.releaseDelayMs = 20;
    await transport.open();
    port(0).emit('error', new Error('Unknown error code 31'));
    await transport.open();

    expect(sim.ports).toHaveLength(2);
    expect(sim.log).not.toContain('open#1:denied');
    expect(sim.log.indexOf('destroy#0')).toBeLessThan(sim.log.indexOf('new#1'));
    expect(transport.isOpen()).toBe(true);
    port(1).emit('data', Buffer.from('fresh'));
    expect(data).toEqual(['fresh']);
  });

  it('ignores every event from a replaced handle, so it cannot corrupt the new connection', async () => {
    await transport.open();
    port(0).emit('error', new Error('Unknown error code 31'));
    await transport.open();
    errors.length = 0;
    closes.length = 0;

    port(0).emit('close', Object.assign(new Error('late'), { disconnected: true }));
    port(0).emit('error', new Error('late error'));
    port(0).emit('data', Buffer.from('stale'));

    expect(closes).toEqual([]);
    expect(errors).toEqual([]);
    expect(data).toEqual([]);
    expect(transport.isOpen()).toBe(true);
    port(1).emit('data', Buffer.from('fresh'));
    expect(data).toEqual(['fresh']);
  });

  it('marks the handle dead when a write fails with a device-gone error, and only then', async () => {
    await transport.open();
    sim.writeError = new Error('Unknown error code 31');
    await expect(transport.write('AT\r\n')).rejects.toThrow(/code 31/);
    expect(transport.isOpen()).toBe(false);
    expect(closes).toHaveLength(1);

    await transport.open();
    sim.writeError = new Error('EAGAIN: resource temporarily unavailable');
    await expect(transport.write('AT\r\n')).rejects.toThrow(/EAGAIN/);
    expect(transport.isOpen()).toBe(true); // an ordinary write error is not a reason to drop the connection
    expect(closes).toHaveLength(1);
  });

  it('never starts a reopen while the previous handle is still being released', async () => {
    sim.releaseDelayMs = 60;
    await transport.open();
    const closing = transport.close();
    const reopening = transport.open(); // arrives while the old handle still holds the port
    await Promise.all([closing, reopening]);

    expect(sim.log).not.toContain('open#1:denied');
    expect(sim.ports).toHaveLength(2);
    expect(transport.isOpen()).toBe(true);
  });

  it('shares one open between concurrent callers', async () => {
    await Promise.all([transport.open(), transport.open(), transport.open()]);
    expect(sim.ports).toHaveLength(1);
    expect(transport.isOpen()).toBe(true);
  });

  it('reports a host close once as requested by the host, and stays reusable', async () => {
    await transport.open();
    await transport.close();
    expect(closes).toEqual([{ disconnected: false, requestedByHost: true, detail: undefined }]);
    expect(transport.isOpen()).toBe(false);
    await transport.open();
    expect(transport.isOpen()).toBe(true);
    expect(closes).toHaveLength(1);
  });

  it('a failed open leaves no state behind, and the next open succeeds', async () => {
    sim.openFailures = 1;
    await expect(transport.open()).rejects.toBeInstanceOf(SerialPortDisconnectedError);
    expect(transport.isOpen()).toBe(false);
    await transport.open();
    expect(transport.isOpen()).toBe(true);
    expect(sim.ports).toHaveLength(2);
  });

  it('does not wait forever for a handle that will not release, and reports the lock error if the port stays busy', async () => {
    await transport.open();
    port(0).emit('error', new Error('Unknown error code 31'));
    sim.neverRelease = true; // the driver never lets go
    const attempt = transport.open();
    await expect(attempt).rejects.toThrow(/Access denied/);
    expect(sim.log).toContain('open#1:denied');
    // Once the driver does release it, the next attempt works.
    sim.neverRelease = false;
    port(0).isOpen = false;
    sim.held.clear();
    await transport.open();
    expect(transport.isOpen()).toBe(true);
  }, 10_000);

  it('recognises device-gone errors, including Windows error 31, and not ordinary ones', () => {
    for (const message of ['Unknown error code 31', 'Error code 55', 'ERROR_GEN_FAILURE', 'A device attached to the system is not functioning', 'EIO: i/o error']) {
      expect(isFatalSerialError(new Error(message)), message).toBe(true);
    }
    for (const message of ['EAGAIN: resource temporarily unavailable', 'Opening COM19: Access denied', 'timeout', 'Unknown error code 311']) {
      expect(isFatalSerialError(new Error(message)), message).toBe(false);
    }
  });
});
