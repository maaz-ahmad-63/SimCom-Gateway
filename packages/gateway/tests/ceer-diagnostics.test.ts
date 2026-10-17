import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { AtParser } from '../src/adapters/modem/at-parser.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { createGatewayServer, GatewayServerInstance } from '../src/server.js';

const KEY = 'ceer-test-key-123456';
const SECRET_MARKER = 'sk-super-secret-provider-key-0123456789';

type Respond = (written: string, transport: FakeSerialTransport) => void;

describe('AT+CEER diagnostic', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  /** A real hardware adapter over a fake serial port, behind the real gateway server. */
  async function harness(respond: Respond) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceer-'));
    const transport = new FakeSerialTransport('COM14', 115200);
    const adapter = new Sim7600HardwareAdapter({ atPort: 'COM14', atBaudRate: 115200, commandTimeoutMs: 500, dialTimeoutMs: 1000, autoReconnect: false, transport });
    // Initialization needs the usual answers; afterwards the test decides.
    let ready = false;
    transport.onWrite((written) => {
      if (!ready) transport.feedIncomingData(written.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : 'OK\r\n');
      else respond(written, transport);
    });
    await adapter.initialize();
    ready = true;
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem: adapter,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
    cleanup.push(async () => {
      await server.close();
      await adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const get = (url = '/api/gateway/diagnostics/ceer') => request(server.app).get(url).set('x-api-key', KEY);
    return { server, adapter, transport, get };
  }

  describe('parser', () => {
    it('extracts the report text and keeps anything unexpected', () => {
      expect(AtParser.parseCeer('+CEER: Normal call clearing\nOK')).toEqual({ reports: ['Normal call clearing'], other: [] });
      expect(AtParser.parseCeer('+CEER: 16,0,0\r\nOK')).toEqual({ reports: ['16,0,0'], other: [] });
      expect(AtParser.parseCeer('+CEER: first\n+CEER: second\nOK').reports).toEqual(['first', 'second']);
      expect(AtParser.parseCeer('weird line\nOK')).toEqual({ reports: [], other: ['weird line'] });
      expect(AtParser.parseCeer('OK')).toEqual({ reports: [], other: [] });
    });
  });

  describe('queue behaviour', () => {
    it('captures the +CEER line and the terminal OK as one response', async () => {
      const h = await harness((w, t) => t.feedIncomingData('+CEER: Normal call clearing\r\nOK\r\n'));
      const response = await h.adapter.executeCommand('AT+CEER');
      expect(response).toBe('+CEER: Normal call clearing\nOK');
    });

    it('is not mistaken for a URC, and a URC in the middle does not corrupt it', async () => {
      const h = await harness((w, t) => t.feedIncomingData('NO CARRIER\r\n+CEER: Call rejected\r\nOK\r\n'));
      const urcs: string[] = [];
      h.adapter.on('urc', (u) => urcs.push(u.type));
      const response = await h.adapter.executeCommand('AT+CEER');
      expect(response).toBe('+CEER: Call rejected\nOK');
      expect(urcs).toContain('NO_CARRIER'); // the unsolicited code still reaches the call manager
    });

    it('rejects with the modem error text on ERROR and on CME ERROR', async () => {
      let answer = 'ERROR\r\n';
      const h = await harness((w, t) => t.feedIncomingData(answer));
      await expect(h.adapter.executeCommand('AT+CEER')).rejects.toMatchObject({ name: 'AtCommandError', message: 'AT ERROR' });
      answer = '+CME ERROR: operation not allowed\r\n';
      await expect(h.adapter.executeCommand('AT+CEER')).rejects.toMatchObject({ name: 'AtCommandError', message: expect.stringContaining('operation not allowed') });
    });

    it('times out when the modem is silent, and a late answer cannot corrupt the next command', async () => {
      let silent = true;
      const h = await harness((w, t) => {
        if (w.includes('AT+CEER') && silent) return; // no answer
        if (w.includes('AT+CSQ')) t.feedIncomingData('+CSQ: 21,99\r\nOK\r\n');
        else t.feedIncomingData('OK\r\n');
      });
      await expect(h.adapter.executeCommand('AT+CEER', 150)).rejects.toMatchObject({ name: 'AtCommandTimeoutError' });
      silent = false;
      h.transport.feedIncomingData('+CEER: Late answer\r\nOK\r\n'); // arrives after the timeout
      const next = await h.adapter.executeCommand('AT+CSQ');
      expect(next).toBe('+CSQ: 21,99\nOK');
    });
  });

  describe('repeated timeouts', () => {
    it('does not make every later AT+CEER fail after the modem ignored it more than once', async () => {
      let unanswered = 2;
      const h = await harness((w, t) => {
        if (w.includes('AT+CEER')) {
          if (unanswered > 0) {
            unanswered--;
            return;
          }
          t.feedIncomingData('+CEER: Normal call clearing\r\nOK\r\n');
        } else t.feedIncomingData('OK\r\n');
      });
      await expect(h.adapter.executeCommand('AT+CEER', 120)).rejects.toMatchObject({ name: 'AtCommandTimeoutError' });
      await expect(h.adapter.executeCommand('AT+CEER', 120)).rejects.toMatchObject({ name: 'AtCommandTimeoutError' });
      await expect(h.adapter.executeCommand('AT+CEER', 500)).resolves.toBe('+CEER: Normal call clearing\nOK');
      await expect(h.adapter.executeCommand('AT+CEER', 500)).resolves.toBe('+CEER: Normal call clearing\nOK');
    });
  });

  describe('GET /api/gateway/diagnostics/ceer', () => {
    it('requires the gateway API key', async () => {
      const h = await harness((w, t) => t.feedIncomingData('+CEER: x\r\nOK\r\n'));
      expect((await request(h.server.app).get('/api/gateway/diagnostics/ceer')).status).toBe(401);
      expect((await request(h.server.app).get('/api/gateway/diagnostics/ceer').set('x-api-key', 'wrong-key-wrong')).status).toBe(401);
    });

    it('returns the module\'s report through the queue, with the command it ran and no number or secret', async () => {
      const written: string[] = [];
      const h = await harness((w, t) => {
        written.push(w.trim());
        t.feedIncomingData('+CEER: Unallocated number 919876543210\r\nOK\r\n');
      });
      const res = await h.get();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ command: 'AT+CEER', terminal: 'OK', isSimulated: false, driverType: 'hardware', callState: null });
      expect(res.body.reports).toEqual(['Unallocated number [REDACTED]']);
      expect(written).toEqual(['AT+CEER']); // exactly one command, on the queue
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('9876543210');
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(SECRET_MARKER);
    });

    it('reports a modem error as 502 with the modem\'s own words', async () => {
      const h = await harness((w, t) => t.feedIncomingData('+CME ERROR: operation not supported\r\n'));
      const res = await h.get();
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'MODEM_ERROR', command: 'AT+CEER' });
      expect(res.body.error).toMatch(/operation not supported/);
    });

    it('reports a silent modem as 504 and keeps serving afterwards', async () => {
      let silent = true;
      const h = await harness((w, t) => {
        if (silent) return;
        t.feedIncomingData('+CEER: Normal call clearing\r\nOK\r\n');
      });
      const timedOut = await h.get('/api/gateway/diagnostics/ceer?timeoutMs=600');
      expect(timedOut.status).toBe(504);
      expect(timedOut.body).toMatchObject({ code: 'MODEM_TIMEOUT', timeoutMs: 600 });
      silent = false;
      const next = await h.get();
      expect(next.status).toBe(200);
      expect(next.body.reports).toEqual(['Normal call clearing']);
    });

    it('reports a closed AT port as 503', async () => {
      const h = await harness((w, t) => t.feedIncomingData('OK\r\n'));
      await h.transport.close();
      const res = await h.get();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('MODEM_DISCONNECTED');
    });

    it('clamps the timeout so it cannot be used to hold the queue', async () => {
      const h = await harness((w, t) => t.feedIncomingData('+CEER: ok\r\nOK\r\n'));
      expect((await h.get('/api/gateway/diagnostics/ceer?timeoutMs=999999999')).status).toBe(200);
      expect((await h.get('/api/gateway/diagnostics/ceer?timeoutMs=abc')).status).toBe(200);
    });

    it('labels simulated answers as simulated', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceer-mock-'));
      const server = createGatewayServer({
        config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite') },
        modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
        audio: new MockAudioAdapter(),
        instanceLockDir: dir,
      });
      cleanup.push(async () => {
        await server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const res = await request(server.app).get('/api/gateway/diagnostics/ceer').set('x-api-key', KEY);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ isSimulated: true, driverType: 'mock' });
      expect(res.body.reports[0]).toMatch(/simulated/);
    });
  });
});
