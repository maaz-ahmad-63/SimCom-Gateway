import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FakeSerialTransport,
} from '../src/adapters/modem/serial-transport.js';
import {
  Sim7600HardwareAdapter,
} from '../src/adapters/modem/hardware-modem.js';
import {
  AtParser,
} from '../src/adapters/modem/at-parser.js';
import {
  AtCommandError,
  AtCommandTimeoutError,
  SerialPortDisconnectedError,
  ClipUrcEvent,
  CallEndUrcEvent,
} from '@sim-gateway/shared';

describe('Phase 4: Windows Hardware Integration Readiness', () => {
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

  describe('AtParser Pure Unit Tests', () => {
    it('correctly parses signal quality from +CSQ responses', () => {
      const parsedGood = AtParser.parseCsq('+CSQ: 24,99\r\nOK');
      expect(parsedGood.rssi).toBe(24);
      expect(parsedGood.ber).toBe(99);
      expect(parsedGood.dBm).toBe(-65);
      expect(parsedGood.bars).toBe(4);

      const parsedPoor = AtParser.parseCsq('+CSQ: 8,99\r\nOK');
      expect(parsedPoor.rssi).toBe(8);
      expect(parsedPoor.bars).toBe(1);

      const parsedUnknown = AtParser.parseCsq('+CSQ: 99,99\r\nOK');
      expect(parsedUnknown.rssi).toBe(99);
      expect(parsedUnknown.dBm).toBeNull();
      expect(parsedUnknown.bars).toBe(0);
    });

    it('correctly parses SIM PIN status (+CPIN)', () => {
      expect(AtParser.parseCpin('+CPIN: READY\r\nOK')).toBe('READY');
      expect(AtParser.parseCpin('+CPIN: SIM PIN\r\nOK')).toBe('SIM_PIN');
      expect(AtParser.parseCpin('+CPIN: SIM PUK\r\nOK')).toBe('SIM_PUK');
      expect(AtParser.parseCpin('ERROR')).toBe('ERROR');
      expect(AtParser.parseCpin('+CME ERROR: 10')).toBe('ERROR');
      expect(AtParser.parseCpin('SOMETHING_ELSE')).toBe('UNKNOWN');
    });

    it('correctly parses network registration (+CEREG / +CREG)', () => {
      expect(AtParser.parseCregOrCereg('+CEREG: 0,1\r\nOK')).toBe('REGISTERED_HOME');
      expect(AtParser.parseCregOrCereg('+CEREG: 0,5\r\nOK')).toBe('REGISTERED_ROAMING');
      expect(AtParser.parseCregOrCereg('+CEREG: 0,2\r\nOK')).toBe('SEARCHING');
      expect(AtParser.parseCregOrCereg('+CREG: 1,1\r\nOK')).toBe('REGISTERED_HOME');
    });

    it('correctly parses carrier operator (+COPS)', () => {
      const parsed = AtParser.parseCops('+COPS: 0,0,"Vi India",7\r\nOK');
      expect(parsed.operatorName).toBe('Vi India');
      expect(parsed.accessTechnology).toBe('LTE');

      const parsedGsm = AtParser.parseCops('+COPS: 0,0,"Vi India",0\r\nOK');
      expect(parsedGsm.operatorName).toBe('Vi India');
      expect(parsedGsm.accessTechnology).toBe('GSM');
    });

    it('correctly parses caller ID (+CLIP)', () => {
      const clip = AtParser.parseClip('+CLIP: "+919876543210",145,,,,0');
      expect(clip).not.toBeNull();
      expect(clip?.phoneNumber).toBe('+919876543210');
      expect(clip?.typeOfAddress).toBe(145);
    });

    it('correctly parses call termination with duration', () => {
      const end = AtParser.parseVoiceCallEnd('VOICE CALL: END: 42');
      expect(end).not.toBeNull();
      expect(end?.durationSeconds).toBe(42);
    });
  });

  describe('Hardware Initialization & Serial Handshake', () => {
    it('executes full SIM7600EI initialization sequence', async () => {
      // Simulate modem responding to setup commands
      transport.onWrite((written) => {
        if (written.includes('AT\r')) {
          transport.feedIncomingData('OK\r\n');
        } else if (written.includes('ATE0\r')) {
          transport.feedIncomingData('OK\r\n');
        } else if (written.includes('AT+CMEE=2\r')) {
          transport.feedIncomingData('OK\r\n');
        } else if (written.includes('AT+CLIP=1\r')) {
          transport.feedIncomingData('OK\r\n');
        } else if (written.includes('AT+CRC=1\r')) {
          transport.feedIncomingData('OK\r\n');
        } else if (written.includes('AT+CPIN?\r')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        }
      });

      await adapter.initialize();

      expect(adapter.getConnectionState()).toBe('READY');
      expect(adapter.driverType).toBe('hardware');
      expect(adapter.isSimulated).toBe(false);

      const history = transport.getWrittenHistory();
      expect(history.some((cmd) => cmd.includes('ATE0'))).toBe(true);
      expect(history.some((cmd) => cmd.includes('AT+CMEE=2'))).toBe(true);
      expect(history.some((cmd) => cmd.includes('AT+CLIP=1'))).toBe(true);
      expect(history.some((cmd) => cmd.includes('AT+CPIN?'))).toBe(true);
    });

    it('fails initialization if SIM card is not ready', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?\r')) {
          transport.feedIncomingData('+CPIN: SIM PIN\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });

      await expect(adapter.initialize()).rejects.toThrow('SIM card is not ready');
      expect(adapter.getConnectionState()).toBe('ERROR');
    });
  });

  describe('Command Serialization & Concurrency Safety', () => {
    beforeEach(async () => {
      // Fast initialize
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();
    });

    it('strictly serializes concurrent AT commands through FIFO queue without response corruption', async () => {
      const activeCommandsSent: string[] = [];

      // Intercept and track order
      transport.onWrite((written) => {
        activeCommandsSent.push(written.trim());

        // Respond after a tiny asynchronous tick
        setTimeout(() => {
          if (written.includes('AT+CSQ')) {
            transport.feedIncomingData('+CSQ: 26,99\r\nOK\r\n');
          } else if (written.includes('AT+CEREG?')) {
            transport.feedIncomingData('+CEREG: 0,1\r\nOK\r\n');
          } else if (written.includes('AT+COPS?')) {
            transport.feedIncomingData('+COPS: 0,0,"Vi India",7\r\nOK\r\n');
          }
        }, 10);
      });

      // Fire 3 commands concurrently
      const [resp1, resp2, resp3] = await Promise.all([
        adapter.executeCommand('AT+CSQ'),
        adapter.executeCommand('AT+CEREG?'),
        adapter.executeCommand('AT+COPS?'),
      ]);

      expect(resp1).toContain('+CSQ: 26,99');
      expect(resp2).toContain('+CEREG: 0,1');
      expect(resp3).toContain('+COPS: 0,0,"Vi India",7');

      // Verify each command was dispatched strictly one after another
      expect(activeCommandsSent).toEqual(['AT+CSQ', 'AT+CEREG?', 'AT+COPS?']);
    });

    it('handles command echo from modem gracefully', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CSQ')) {
          // Modem echoes command before returning result
          transport.feedIncomingData('AT+CSQ\r\n+CSQ: 21,99\r\nOK\r\n');
        }
      });

      const response = await adapter.executeCommand('AT+CSQ');
      expect(response).toBe('+CSQ: 21,99\nOK');
    });

    it('rejects with AtCommandError when modem returns ERROR or CME ERROR', async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+BAD')) {
          transport.feedIncomingData('+CME ERROR: Operation not supported\r\n');
        }
      });

      await expect(adapter.executeCommand('AT+BAD')).rejects.toThrow(AtCommandError);
    });
  });

  describe('Call Controls & Formatting', () => {
    beforeEach(async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();
    });

    it('formats dial command with required cellular trailing semicolon', async () => {
      let capturedCmd = '';
      transport.onWrite((written) => {
        capturedCmd = written;
        transport.feedIncomingData('OK\r\n');
      });

      await adapter.dial('+919876543210');
      expect(capturedCmd.trim()).toBe('ATD+919876543210;');
    });

    it('sends ATA for call answer', async () => {
      let capturedCmd = '';
      transport.onWrite((written) => {
        capturedCmd = written;
        transport.feedIncomingData('OK\r\n');
      });

      await adapter.answer();
      expect(capturedCmd.trim()).toBe('ATA');
    });

    it('sends AT+CHUP for call hangup', async () => {
      let capturedCmd = '';
      transport.onWrite((written) => {
        capturedCmd = written;
        transport.feedIncomingData('OK\r\n');
      });

      await adapter.hangup();
      expect(capturedCmd.trim()).toBe('AT+CHUP');
    });

    it('sends AT+VTS=<digit> for DTMF tones', async () => {
      let capturedCmd = '';
      transport.onWrite((written) => {
        capturedCmd = written;
        transport.feedIncomingData('OK\r\n');
      });

      await adapter.sendDtmf('9');
      expect(capturedCmd.trim()).toBe('AT+VTS=9');
    });
  });

  describe('Asynchronous URC Handling & Interleaving', () => {
    beforeEach(async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();
    });

    it('dispatches incoming RING and +CLIP events immediately to listeners', async () => {
      const urcs: any[] = [];
      adapter.on('urc', (event) => {
        urcs.push(event);
      });

      transport.feedIncomingData('RING\r\n');
      transport.feedIncomingData('+CLIP: "+919876543210",145,,,,0\r\n');

      expect(urcs.length).toBe(2);
      expect(urcs[0].type).toBe('RING');
      expect(urcs[1].type).toBe('CLIP');
      expect((urcs[1] as ClipUrcEvent).phoneNumber).toBe('+919876543210');
      expect((urcs[1] as ClipUrcEvent).typeOfAddress).toBe(145);
    });

    it('dispatches VOICE CALL: BEGIN and VOICE CALL: END URCs', async () => {
      const urcs: any[] = [];
      adapter.on('urc', (event) => {
        urcs.push(event);
      });

      transport.feedIncomingData('VOICE CALL: BEGIN\r\n');
      transport.feedIncomingData('VOICE CALL: END: 35\r\n');

      expect(urcs.length).toBe(2);
      expect(urcs[0].type).toBe('VOICE_CALL_BEGIN');
      expect(urcs[1].type).toBe('VOICE_CALL_END');
      expect((urcs[1] as CallEndUrcEvent).durationSeconds).toBe(35);
    });

    it('dispatches SIM7600 CONNECT as the answered-call event while dialing', async () => {
      const urcs: any[] = [];
      adapter.on('urc', (event) => urcs.push(event));
      transport.onWrite((written) => {
        if (written.includes('ATD')) {
          transport.feedIncomingData('CONNECT\r\n');
        }
      });

      await adapter.dial('+919876543210');

      expect(urcs).toHaveLength(1);
      expect(urcs[0].type).toBe('VOICE_CALL_BEGIN');
      expect(urcs[0].raw).toBe('CONNECT');
    });

    it('dispatches SIMCom ^CEND call-end URCs', async () => {
      const urcs: any[] = [];
      adapter.on('urc', (event) => urcs.push(event));

      transport.feedIncomingData('^CEND: 0,35,16\r\n');

      expect(urcs).toHaveLength(1);
      expect(urcs[0].type).toBe('VOICE_CALL_END');
      expect(urcs[0].payload.modemCode).toBe('0,35,16');
    });

    it('dispatches URC arriving in the middle of an active command without corrupting command response', async () => {
      const urcs: any[] = [];
      adapter.on('urc', (event) => {
        urcs.push(event);
      });

      transport.onWrite((written) => {
        if (written.includes('AT+CSQ')) {
          // URC arrives BEFORE the command response finishes!
          transport.feedIncomingData('+CLIP: "+919999988888",145\r\n');
          // Then the command response finishes
          transport.feedIncomingData('+CSQ: 28,99\r\nOK\r\n');
        }
      });

      const response = await adapter.executeCommand('AT+CSQ');

      // Command resolved cleanly with its own data
      expect(response).toBe('+CSQ: 28,99\nOK');

      // URC was captured by the event listener
      expect(urcs.length).toBe(1);
      expect(urcs[0].type).toBe('CLIP');
      expect((urcs[0] as ClipUrcEvent).phoneNumber).toBe('+919999988888');
    });
  });

  describe('Timeouts & Disconnect Recovery', () => {
    beforeEach(async () => {
      transport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          transport.feedIncomingData('OK\r\n');
        }
      });
      await adapter.initialize();
    });

    it('times out commands that do not receive responses and allows subsequent commands to proceed', async () => {
      let commandIndex = 0;
      transport.onWrite((written) => {
        commandIndex++;
        if (commandIndex === 1) {
          // Do not respond to first command -> trigger timeout
        } else {
          // Respond to second command
          transport.feedIncomingData('OK\r\n');
        }
      });

      // First command with short 50ms timeout
      await expect(adapter.executeCommand('AT+TIMEOUT_TEST', 50)).rejects.toThrow(
        AtCommandTimeoutError
      );

      // Second command succeeds: the queue is not deadlocked
      const nextResp = await adapter.executeCommand('AT', 200);
      expect(nextResp).toBe('OK');
    });

    it('rejects in-flight and queued commands when serial connection disconnects', async () => {
      transport.onWrite(() => {
        // Drop connection while command is waiting
        transport.simulateDisconnect(new Error('USB Unplugged'));
      });

      await expect(adapter.executeCommand('AT+WAITING')).rejects.toThrow(
        SerialPortDisconnectedError
      );
      expect(adapter.getConnectionState()).toBe('ERROR');
    });

    it('handles transport error followed by close once and reconnects', async () => {
      const reconnectTransport = new FakeSerialTransport('COM15', 115200);
      const reconnectingAdapter = new Sim7600HardwareAdapter({
        atPort: 'COM15',
        atBaudRate: 115200,
        commandTimeoutMs: 1000,
        autoReconnect: true,
        reconnectIntervalMs: 1,
        maxReconnectAttempts: 2,
        transport: reconnectTransport,
      });
      const errors: Error[] = [];
      reconnectingAdapter.on('error', (error) => errors.push(error));

      reconnectTransport.onWrite((written) => {
        if (written.includes('AT+CPIN?')) {
          reconnectTransport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
        } else {
          reconnectTransport.feedIncomingData('OK\r\n');
        }
      });
      await reconnectingAdapter.initialize();

      reconnectTransport.simulateDisconnect(new Error('serial driver reported a disconnect'));

      await vi.waitFor(() => {
        expect(reconnectingAdapter.getConnectionState()).toBe('READY');
      });
      expect(errors).toHaveLength(1);

      await reconnectingAdapter.close();
    });
  });
});
