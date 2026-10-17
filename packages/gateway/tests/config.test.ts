import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Sim7600HardwareAudioAdapter } from '../src/adapters/audio/hardware-audio.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';

const ENV_KEYS = [
  'MODEM_DRIVER',
  'MODEM_AT_PORT',
  'MODEM_AUDIO_PORT',
  'MODEM_AUTO_RECONNECT',
  'GATEWAY_API_KEY',
  'AUDIO_ENABLE_RAW_DUMP',
  'AUDIO_USB_DIAGNOSTIC_ENABLED',
  'AUDIO_USB_PCM_CAPTURE_TEST_ENABLED',
  'AUDIO_USB_PCM_OUTBOUND_TONE_TEST_ENABLED',
];

describe('loadConfig environment parsing', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('boolean flags', () => {
    it.each([
      ['AUDIO_USB_DIAGNOSTIC_ENABLED', 'enableUsbAudioDiagnostic'],
      ['AUDIO_ENABLE_RAW_DUMP', 'enableAudioDumps'],
      ['MODEM_AUTO_RECONNECT', 'autoReconnect'],
      ['AUDIO_USB_PCM_CAPTURE_TEST_ENABLED', 'enableUsbPcmCaptureTest'],
      ['AUDIO_USB_PCM_OUTBOUND_TONE_TEST_ENABLED', 'enableUsbPcmOutboundToneTest'],
    ] as const)('%s: the string "false" is false and "true" is true', (envName, configKey) => {
      for (const falsy of ['false', 'FALSE', ' False ', '0', 'no', 'off']) {
        process.env[envName] = falsy;
        expect(loadConfig()[configKey]).toBe(false);
      }
      for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
        process.env[envName] = truthy;
        expect(loadConfig()[configKey]).toBe(true);
      }
    });

    it('rejects unrecognised boolean values instead of guessing', () => {
      process.env.AUDIO_USB_DIAGNOSTIC_ENABLED = 'maybe';
      expect(() => loadConfig()).toThrow();
    });

    it('keeps the intended defaults, with raw call dumping off', () => {
      const config = loadConfig();
      expect(config.enableAudioDumps).toBe(false);
      expect(config.enableUsbAudioDiagnostic).toBe(false);
      expect(config.enableUsbPcmCaptureTest).toBe(false);
      expect(config.enableUsbPcmOutboundToneTest).toBe(false);
      expect(config.autoReconnect).toBe(true);

      // A blank `KEY=` line in .env counts as unset
      process.env.MODEM_AUTO_RECONNECT = '';
      process.env.AUDIO_ENABLE_RAW_DUMP = '';
      expect(loadConfig().autoReconnect).toBe(true);
      expect(loadConfig().enableAudioDumps).toBe(false);
    });
  });

  describe('serial ports', () => {
    const hardware = { modemDriver: 'hardware' as const, gatewayApiKey: 'secure-windows-hardware-key-32ch' };

    it('requires both ports to be set explicitly in hardware mode', () => {
      expect(() => loadConfig(hardware)).toThrow(/MODEM_AT_PORT and MODEM_AUDIO_PORT/);
      process.env.MODEM_AT_PORT = 'COM22';
      expect(() => loadConfig(hardware)).toThrow(/MODEM_AT_PORT and MODEM_AUDIO_PORT/);
      process.env.MODEM_AUDIO_PORT = '   ';
      expect(() => loadConfig(hardware)).toThrow(/MODEM_AT_PORT and MODEM_AUDIO_PORT/);
    });

    it('reads any port assignment from the environment', () => {
      process.env.MODEM_AT_PORT = 'COM31';
      process.env.MODEM_AUDIO_PORT = 'COM44';
      const config = loadConfig(hardware);
      expect(config.atPort).toBe('COM31');
      expect(config.audioPort).toBe('COM44');
    });

    it('rejects using one port for both interfaces', () => {
      process.env.MODEM_AT_PORT = 'COM22';
      process.env.MODEM_AUDIO_PORT = 'com22';
      expect(() => loadConfig(hardware)).toThrow(/must be different/);
    });

    it('opens exactly the configured audio port', async () => {
      const transport = new FakeSerialTransport('COM44', 115200);
      const opened: Array<string | undefined> = [];
      const originalOpen = transport.open.bind(transport);
      transport.open = async (options) => {
        opened.push(options?.path);
        return originalOpen();
      };
      const adapter = new Sim7600HardwareAudioAdapter({ audioPort: 'COM44', transport });
      await adapter.startSession('call-1');
      expect(opened).toEqual(['COM44']);
      await adapter.stopSession();
    });
  });
});
