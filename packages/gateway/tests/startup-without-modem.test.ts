import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { createGatewayServer } from '../src/server.js';

const KEY = 'startup-test-key-123456';

/** A modem whose COM port is not there (as after a USB re-enumeration) until `present` is set. */
class MissingPortTransport extends FakeSerialTransport {
  present = false;
  opens = 0;
  async open(): Promise<void> {
    this.opens++;
    if (!this.present) throw new Error("Opening COM-T1: File not found");
    await super.open();
  }
}

describe('gateway startup when the modem is not reachable', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  function build(autoReconnect: boolean) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
    const transport = new MissingPortTransport('COM-T1', 115200);
    transport.onWrite((w) => transport.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : 'OK\r\n'));
    const modem = new Sim7600HardwareAdapter({
      atPort: 'COM-T1', atBaudRate: 115200, commandTimeoutMs: 500, dialTimeoutMs: 1000,
      autoReconnect, reconnectIntervalMs: 100, transport,
    } as never);
    const server = createGatewayServer({
      config: {
        modemDriver: 'hardware', gatewayApiKey: KEY, atPort: 'COM-T1', audioPort: 'COM-T2', autoReconnect,
        port: 51152 + Math.floor(Math.random() * 1000), host: '127.0.0.1', sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'd'),
      },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
    cleanup.push(async () => {
      await modem.close();
      await new Promise<void>((r) => (server.httpServer.listening ? server.httpServer.close(() => r()) : r()));
      server.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { server, modem, transport, get: (p: string) => request(server.app).get(p).set('x-api-key', KEY) };
  }

  it('serves the API anyway, shows the problem, and connects once the modem appears', async () => {
    const h = build(true);
    await expect(h.server.start()).resolves.toBeUndefined(); // does not throw or hang on the missing port
    expect(h.server.httpServer.listening).toBe(true);

    const status = await h.get('/api/gateway/hardware/status');
    expect(status.status).toBe(200);
    expect(status.body.modem.connectionState).not.toBe('READY');
    await new Promise((r) => setTimeout(r, 300));
    const failed = await h.get('/api/gateway/hardware/status');
    expect(failed.body.modem.reconnect.lastFailure.message).toMatch(/File not found/);
    expect(h.transport.opens).toBeGreaterThan(1); // it is retrying by itself

    h.transport.present = true; // the modem re-enumerates
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = async () => {
        const s = await h.get('/api/gateway/hardware/status');
        if (s.body.modem.connectionState === 'READY') return resolve();
        if (Date.now() - started > 5000) return reject(new Error(`still ${s.body.modem.connectionState}`));
        setTimeout(poll, 100);
      };
      void poll();
    });
  });

  it('still fails fast when auto-reconnect is off, and releases the port lock', async () => {
    const h = build(false);
    await expect(h.server.start()).rejects.toThrow(/File not found/);
    expect(h.server.httpServer.listening).toBe(false);
  });
});
