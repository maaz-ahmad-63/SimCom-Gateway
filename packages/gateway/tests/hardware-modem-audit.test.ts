import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { Sim7600HardwareAudioAdapter } from '../src/adapters/audio/hardware-audio.js';
import { AtCommandQueue } from '../src/adapters/modem/at-command-queue.js';
import { AtParser } from '../src/adapters/modem/at-parser.js';
import { createGatewayServer } from '../src/server.js';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import { loadConfig } from '../src/config/index.js';
import {
  AtCommandError,
  AtCommandTimeoutError,
  SerialPortDisconnectedError,
} from '@sim-gateway/shared';

describe('Phase 4.1: Hardware-Readiness Deep Audit & Regression Suite', () => {
  let transport: FakeSerialTransport;
  let adapter: Sim7600HardwareAdapter;

  beforeEach(async () => {
    transport = new FakeSerialTransport('COM14', 115200);
    adapter = new Sim7600HardwareAdapter({
      atPort: 'COM14',
      atBaudRate: 115200,
      commandTimeoutMs: 1000,
      dialTimeoutMs: 2000,
      autoReconnect: false,
      transport,
    });
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('1. AT Command Queue & Timeout Stale Response Immunity', () => {
    it('discards delayed responses from timed-out commands and does not attribute them to subsequent commands', async () => {
      // Initialize adapter
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();

      // Clear write handler
      transport.clearWrittenHistory();

      let cmdCount = 0;
      transport.onWrite((written) => {
        cmdCount++;
        if (written.includes('AT+CSQ')) {
          // Command 1 (AT+CSQ): Simulate severe delay - do NOT respond before timeout
        } else if (written.includes('AT+COPS?')) {
          // Command 2 (AT+COPS?):
          // First, feed the delayed late response from the timed-out Command 1 (AT+CSQ)
          transport.feedIncomingData('+CSQ: 25,99\r\nOK\r\n');

          // Then, feed the legitimate response for Command 2 (AT+COPS?)
          setTimeout(() => {
            transport.feedIncomingData('+COPS: 0,0,"Vi India",7\r\nOK\r\n');
          }, 30);
        }
      });

      // Command 1 executes with a tight 40ms timeout and times out
      await expect(adapter.executeCommand('AT+CSQ', 40)).rejects.toThrow(
        AtCommandTimeoutError
      );

      // Command 2 executes immediately after Command 1's timeout
      const copsResponse = await adapter.executeCommand('AT+COPS?', 1000);

      // Verify Command 2 received its OWN response, NOT the stale +CSQ: 25,99!
      expect(copsResponse).toContain('+COPS: 0,0,"Vi India",7');
      expect(copsResponse).not.toContain('+CSQ:');
    });

    it('ensures in-flight commands are not terminated by unrelated terminal-looking URCs (e.g. NO CARRIER / BUSY)', async () => {
      // Initialize
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();

      const urcs: any[] = [];
      adapter.on('urc', (u) => urcs.push(u));

      transport.onWrite((written) => {
        if (written.includes('AT+CSQ')) {
          // While AT+CSQ is waiting for response, a dropped call emits NO CARRIER URC
          transport.feedIncomingData('NO CARRIER\r\n');

          // Then AT+CSQ finishes legitimately with its own signal response
          setTimeout(() => {
            transport.feedIncomingData('+CSQ: 22,99\r\nOK\r\n');
          }, 20);
        }
      });

      // AT+CSQ must NOT fail on NO CARRIER!
      const signalResp = await adapter.executeCommand('AT+CSQ', 1000);
      expect(signalResp).toContain('+CSQ: 22,99');

      // NO CARRIER was routed to the URC listener
      expect(urcs.some((u) => u.type === 'NO_CARRIER')).toBe(true);
    });

    it('rejects all active and pending queued commands on transport disconnect', async () => {
      await transport.open();

      const queue = new AtCommandQueue(transport, { defaultTimeoutMs: 5000 });

      // Queue up 3 commands without responding
      const p1 = queue.execute('AT+CMD1');
      const p2 = queue.execute('AT+CMD2');
      const p3 = queue.execute('AT+CMD3');

      // Disconnect transport
      transport.simulateDisconnect(new Error('COM port hardware unplugged'));

      await expect(p1).rejects.toThrow(SerialPortDisconnectedError);
      await expect(p2).rejects.toThrow(SerialPortDisconnectedError);
      await expect(p3).rejects.toThrow(SerialPortDisconnectedError);
    });

    it('does not duplicate listeners across multiple reconnect cycles', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });

      const initialDataListeners = transport.listenerCount('data');
      const initialErrorListeners = transport.listenerCount('error');
      const initialCloseListeners = transport.listenerCount('close');

      // Initialize
      await adapter.initialize();

      // Close and re-initialize multiple times
      await adapter.close();
      await adapter.initialize();
      await adapter.close();
      await adapter.initialize();

      // Verify listener counts did not multiply
      expect(transport.listenerCount('data')).toBe(initialDataListeners);
      expect(transport.listenerCount('error')).toBe(initialErrorListeners);
      expect(transport.listenerCount('close')).toBe(initialCloseListeners);
    });
  });

  describe('2. Hardware Modem Lifecycle & Call State Guard', () => {
    it('does NOT mark a call as ACTIVE or successful merely because ATD returned OK', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();

      const callManager = new CallSessionManager({ modem: adapter });

      // Trigger dial
      const session = await callManager.dial({ phoneNumber: '+919876543210' });

      // State MUST be DIALING, NOT ACTIVE!
      expect(session.state).toBe('DIALING');
      expect(session.outcome).toBeNull();
      expect(session.answeredAt).toBeNull();

      // Only transitions to ACTIVE when VOICE CALL: BEGIN URC arrives
      transport.feedIncomingData('VOICE CALL: BEGIN\r\n');

      const activeSession = callManager.getCurrentCall();
      expect(activeSession?.state).toBe('ACTIVE');
      expect(activeSession?.answeredAt).not.toBeNull();
    });

    it('accurately parses and reports non-registered and denied network states', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();

      // Test NOT_REGISTERED (0)
      transport.onWrite((written) => {
        if (written.includes('AT+CEREG?')) {
          transport.feedIncomingData('+CEREG: 0,0\r\nOK\r\n');
        } else if (written.includes('AT+COPS?')) {
          transport.feedIncomingData('+COPS: 0\r\nOK\r\n');
        }
      });
      const net0 = await adapter.getNetworkStatus();
      expect(net0.registration).toBe('NOT_REGISTERED');
      expect(net0.operatorName).toBeNull();

      // Test SEARCHING (2)
      transport.onWrite((written) => {
        if (written.includes('AT+CEREG?')) {
          transport.feedIncomingData('+CEREG: 0,2\r\nOK\r\n');
        } else if (written.includes('AT+COPS?')) {
          transport.feedIncomingData('+COPS: 0\r\nOK\r\n');
        }
      });
      const net2 = await adapter.getNetworkStatus();
      expect(net2.registration).toBe('SEARCHING');

      // Test REGISTRATION_DENIED (3)
      transport.onWrite((written) => {
        if (written.includes('AT+CEREG?')) {
          transport.feedIncomingData('+CEREG: 0,3\r\nOK\r\n');
        } else if (written.includes('AT+COPS?')) {
          transport.feedIncomingData('+COPS: 0\r\nOK\r\n');
        }
      });
      const net3 = await adapter.getNetworkStatus();
      expect(net3.registration).toBe('REGISTRATION_DENIED');
    });

    it('accurately reports SIM-not-ready error status without crashing', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CME ERROR: 10\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });

      const simStatus = await adapter.getSimStatus();
      expect(simStatus).toBe('ERROR');
    });

    it('propagates call control errors cleanly when modem rejects commands', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();

      // Test dial rejection
      transport.onWrite((written) => {
        if (written.includes('ATD')) {
          transport.feedIncomingData('BUSY\r\n');
        }
      });
      await expect(adapter.dial('+919876543210')).rejects.toThrow(AtCommandError);

      // Test answer failure
      transport.onWrite((written) => {
        if (written.includes('ATA')) {
          transport.feedIncomingData('ERROR\r\n');
        }
      });
      await expect(adapter.answer()).rejects.toThrow(AtCommandError);
    });

    it('ensures real hardware mode cannot silently fall back to mock modem', () => {
      const server = createGatewayServer({
        config: {
          modemDriver: 'hardware',
          atPort: 'COM20',
          audioPort: 'COM19',
          gatewayApiKey: 'secret-token-32-chars-long-audit',
        },
      });

      expect(server.modem.driverType).toBe('hardware');
      expect(server.modem.isSimulated).toBe(false);
      expect(server.audio.isSimulated).toBe(false);
      expect(server.config.atPort).toBe('COM20');
      expect(server.config.audioPort).toBe('COM19');

      dbClose(server);
    });
  });

  describe('3. Audio Adapter Unvalidated Raw Byte Behavior', () => {
    it('captures raw bytes without assuming linear PCM format and maintains safe stop/close', async () => {
      const audioTransport = new FakeSerialTransport('COM19', 115200);
      const audioAdapter = new Sim7600HardwareAudioAdapter({
        audioPort: 'COM19',
        enableDumps: false,
        transport: audioTransport,
      });

      expect(audioAdapter.isSimulated).toBe(false);

      const frames: any[] = [];
      audioAdapter.on('audio_frame', (f) => frames.push(f));

      // Start session
      await audioAdapter.startSession('call-audit-123');
      expect(audioAdapter.getStats().isStreaming).toBe(true);
      const inboundStream = audioAdapter.getInboundStream();
      expect(inboundStream).not.toBeNull();
      const streamedChunks: Buffer[] = [];
      inboundStream?.on('data', (chunk: Buffer) => streamedChunks.push(chunk));

      // Feed raw arbitrary bytes
      const testChunk = Buffer.from([0x01, 0xFE, 0x80, 0x7F, 0x00, 0xFF]);
      audioTransport.feedIncomingData(testChunk);

      expect(frames.length).toBe(1);
      expect(frames[0].data).toEqual(testChunk);
      expect(frames[0].isSimulated).toBe(false);
      expect(audioAdapter.getStats().bytesReceived).toBe(testChunk.length);
      audioTransport.feedIncomingData(Buffer.from([0x10, 0x20]));
      expect(streamedChunks).toHaveLength(2);
      expect(Buffer.concat(streamedChunks)).toEqual(Buffer.concat([testChunk, Buffer.from([0x10, 0x20])]));

      const outboundStream = audioAdapter.getOutboundStream();
      expect(outboundStream).not.toBeNull();
      await new Promise<void>((resolve, reject) => {
        outboundStream?.write(Buffer.from([0x30, 0x40]), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      expect(audioTransport.getWrittenHistory()).toContain('0@');

      // Stop session is safe and idempotent
      await audioAdapter.stopSession();
      await audioAdapter.stopSession(); // second call is safe no-op
      expect(audioAdapter.getStats().isStreaming).toBe(false);
    });

    it('does not crash when error occurs without attached error listener', async () => {
      const audioTransport = new FakeSerialTransport('COM19', 115200);
      const audioAdapter = new Sim7600HardwareAudioAdapter({
        audioPort: 'COM19',
        enableDumps: false,
        transport: audioTransport,
      });

      // Emit error on transport when no error listener attached
      expect(() => {
        audioTransport.simulateDisconnect(new Error('Audio serial glitch'));
      }).not.toThrow();
    });

    it('records bounded audio transport diagnostics without recording audio content', async () => {
      const audioTransport = new FakeSerialTransport('COM19', 115200);
      const audioAdapter = new Sim7600HardwareAudioAdapter({
        audioPort: 'COM19',
        enableDumps: false,
        transport: audioTransport,
      });
      const diagnostics: Array<{
        timestamp: string;
        event: 'inbound' | 'outbound' | 'stream_error' | 'stats';
        bytes?: number;
        success?: boolean;
        message?: string;
        isStreaming?: boolean;
      }> = [];
      const record = (
        event: 'inbound' | 'outbound' | 'stream_error' | 'stats',
        details: Omit<(typeof diagnostics)[number], 'timestamp' | 'event'> = {}
      ) => {
        if (diagnostics.length < 20) {
          diagnostics.push({ timestamp: new Date().toISOString(), event, ...details });
        }
      };

      await audioAdapter.startSession('diagnostic-call');
      const inbound = audioAdapter.getInboundStream();
      const outbound = audioAdapter.getOutboundStream();
      inbound?.on('data', (chunk: Buffer) => record('inbound', { bytes: chunk.length }));
      inbound?.on('error', (error: Error) =>
        record('stream_error', { message: error.message })
      );
      outbound?.on('error', (error: Error) =>
        record('stream_error', { message: error.message })
      );
      audioAdapter.on('stats', (stats) =>
        record('stats', {
          bytes: stats.bytesReceived + stats.bytesSent,
          isStreaming: stats.isStreaming,
        })
      );

      audioTransport.feedIncomingData(Buffer.alloc(7, 0));
      await new Promise<void>((resolve, reject) => {
        outbound?.write(Buffer.alloc(5, 0), (error) => {
          if (error) {
            record('outbound', { bytes: 5, success: false, message: error.message });
            reject(error);
          } else {
            record('outbound', { bytes: 5, success: true });
            resolve();
          }
        });
      });
      outbound?.destroy(new Error('diagnostic stream error'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.length).toBeLessThanOrEqual(20);
      expect(diagnostics.every((entry) => entry.timestamp.length > 0)).toBe(true);
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'inbound', bytes: 7 }),
          expect.objectContaining({ event: 'outbound', bytes: 5, success: true }),
          expect.objectContaining({ event: 'stream_error' }),
        ])
      );
      expect(diagnostics.some((entry) => entry.event === 'stats')).toBe(true);
      expect(diagnostics.some((entry) => 'message' in entry && entry.message?.includes('0'))).toBe(
        false
      );
      await audioAdapter.stopSession();
    });
  });

  describe('4. Hardware Configuration & Mandatory Security Enforcement', () => {
    it('enforces mandatory explicit API key when MODEM_DRIVER=hardware', () => {
      // 1. Missing API key in hardware mode must throw
      expect(() => {
        loadConfig({
          modemDriver: 'hardware',
          gatewayApiKey: undefined,
        });
      }).toThrow(/GATEWAY_API_KEY.*mandatory/i);

      // 2. Default placeholder key in hardware mode must throw
      expect(() => {
        loadConfig({
          modemDriver: 'hardware',
          gatewayApiKey: 'change-this-to-a-secure-random-token',
        });
      }).toThrow(/GATEWAY_API_KEY.*mandatory/i);

      // 3. Dev placeholder key in hardware mode must throw
      expect(() => {
        loadConfig({
          modemDriver: 'hardware',
          gatewayApiKey: 'dev-secret-api-key-sim7600ei',
        });
      }).toThrow(/GATEWAY_API_KEY.*mandatory/i);

      // 4. Key with fewer than 8 characters must throw
      expect(() => {
        loadConfig({
          modemDriver: 'hardware',
          gatewayApiKey: 'short',
        });
      }).toThrow(/GATEWAY_API_KEY.*mandatory/i);

      // 5. Valid strong key in hardware mode succeeds and defaults to COM20/COM19
      const validHwConfig = loadConfig({
        modemDriver: 'hardware',
        gatewayApiKey: 'secure-windows-hardware-key-32ch',
      });
      expect(validHwConfig.modemDriver).toBe('hardware');
      expect(validHwConfig.atPort).toBe('COM20');
      expect(validHwConfig.audioPort).toBe('COM19');

      // 6. Mock mode succeeds without custom key and uses mock dev default
      const mockConfig = loadConfig({
        modemDriver: 'mock',
      });
      expect(mockConfig.modemDriver).toBe('mock');
      expect(mockConfig.gatewayApiKey).toBe('dev-secret-api-key-sim7600ei');
    });

    it('accurately parses physical PowerShell baseline responses (Vi India on LTE, RSSI 23)', () => {
      // Confirmed PowerShell output: AT+COPS? returns "Vi India Vi India",7
      const copsResult = AtParser.parseCops('+COPS: 0,0,"Vi India Vi India",7\r\nOK');
      expect(copsResult.operatorName).toBe('Vi India');
      expect(copsResult.accessTechnology).toBe('LTE');

      // Alternative direct output format
      const copsDirect = AtParser.parseCops('"Vi India Vi India",7');
      expect(copsDirect.operatorName).toBe('Vi India');
      expect(copsDirect.accessTechnology).toBe('LTE');

      // Confirmed PowerShell output: AT+CSQ returns 23,99
      const csqResult = AtParser.parseCsq('+CSQ: 23,99\r\nOK');
      expect(csqResult.rssi).toBe(23);
      expect(csqResult.ber).toBe(99);
      expect(csqResult.dBm).toBe(-67);
      expect(csqResult.bars).toBe(4);

      // Confirmed PowerShell output: AT+CPIN? returns READY
      expect(AtParser.parseCpin('+CPIN: READY\r\nOK')).toBe('READY');

      // Confirmed PowerShell output: AT+CEREG? returns 0,1
      expect(AtParser.parseCregOrCereg('+CEREG: 0,1\r\nOK')).toBe('REGISTERED_HOME');
    });

    it('strictly enforces API key authentication on HTTP endpoints in hardware mode', async () => {
      const apiKey = 'secure-hardware-auth-test-key-32';
      const server = createGatewayServer({
        config: {
          modemDriver: 'hardware',
          atPort: 'COM20',
          audioPort: 'COM19',
          gatewayApiKey: apiKey,
        },
      });

      // 1. Missing API key returns 401 Unauthorized
      const unauthResp = await request(server.app).get('/api/gateway/health');
      expect(unauthResp.status).toBe(401);
      expect(unauthResp.body.code).toBe('UNAUTHORIZED');

      // 2. Invalid API key returns 401 Unauthorized
      const invalidResp = await request(server.app)
        .get('/api/gateway/health')
        .set('x-api-key', 'wrong-key-attempt');
      expect(invalidResp.status).toBe(401);

      // 3. Valid API key returns 200 OK with accurate hardware reporting
      const authResp = await request(server.app)
        .get('/api/gateway/health')
        .set('x-api-key', apiKey);
      expect(authResp.status).toBe(200);
      expect(authResp.body.driverType).toBe('hardware');
      expect(authResp.body.isSimulated).toBe(false);
      expect(authResp.body.modem.atPort).toBe('COM20');
      expect(authResp.body.modem.audioPort).toBe('COM19');
      expect(authResp.body.modem.connectionState).toBe('DISCONNECTED');
      expect(authResp.body.modem.simStatus).toBe('DISCONNECTED');
      expect(authResp.body.modem.atStatus).toBe('DISCONNECTED');

      dbClose(server);
    });
  });
});

function dbClose(server: any): void {
  try {
    server.db?.close();
  } catch {}
}
