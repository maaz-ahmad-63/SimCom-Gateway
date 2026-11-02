import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { gatewayConfigSchema, GatewayConfigInput } from '@sim-gateway/shared';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

// Load .env from process.cwd() or fallback to repository root
dotenv.config();
dotenv.config({ path: path.resolve(currentDir, '../../../.env') });

/** Env value, or undefined when unset/blank so schema defaults apply (a blank `KEY=` is "unset"). */
function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** The port value meaning "discover it at runtime" (never a COM name, so it can never be opened by mistake). */
export const AUTO_PORT = 'auto';
export const isAutoPort = (port: string | undefined | null): boolean => !port || port.trim().toLowerCase() === AUTO_PORT;

export function loadConfig(overrides: Partial<GatewayConfigInput> = {}): GatewayConfigInput {
  const driver = overrides.modemDriver ?? process.env.MODEM_DRIVER ?? 'mock';
  const rawApiKey = overrides.gatewayApiKey ?? process.env.GATEWAY_API_KEY;

  // In hardware mode, an explicit, secure API key is mandatory
  if (driver === 'hardware') {
    if (
      !rawApiKey ||
      rawApiKey.trim().length < 8 ||
      rawApiKey === 'change-this-to-a-secure-random-token' ||
      rawApiKey === 'dev-secret-api-key-sim7600ei'
    ) {
      throw new Error(
        'Security Error: An explicit, secure GATEWAY_API_KEY (minimum 8 characters) is mandatory when running with MODEM_DRIVER=hardware. Default development placeholders are strictly forbidden.'
      );
    }

    // COM numbers are reassigned by Windows whenever the modem re-enumerates, so no port is assumed. A port that is not set
    // is discovered at runtime from the USB identity of the modem's interfaces (src/hardware/port-discovery.ts); a port that
    // is set is used exactly as given.
    const atPort = (overrides.atPort ?? envString('MODEM_AT_PORT'))?.trim();
    const audioPort = (overrides.audioPort ?? envString('MODEM_AUDIO_PORT'))?.trim();
    if (atPort && audioPort && atPort.toUpperCase() === audioPort.toUpperCase() && !isAutoPort(atPort)) {
      throw new Error(
        `Configuration Error: MODEM_AT_PORT and MODEM_AUDIO_PORT must be different ports (both are ${atPort}).`
      );
    }
    overrides = { ...overrides, atPort: atPort || AUTO_PORT, audioPort: audioPort || AUTO_PORT };
  }

  // Booleans are passed through as raw env strings; the shared schema parses them strictly.
  // In mock mode the port names below are cosmetic placeholders only.
  const rawConfig = {
    port: process.env.PORT ?? 4000,
    host: process.env.HOST ?? '127.0.0.1',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    modemDriver: driver,
    atPort: envString('MODEM_AT_PORT'),
    atBaudRate: process.env.MODEM_AT_BAUD ?? 115200,
    audioPort: envString('MODEM_AUDIO_PORT'),
    audioBaudRate: process.env.MODEM_AUDIO_BAUD ?? 115200,
    audioSampleRate: process.env.AUDIO_SAMPLE_RATE ?? 8000,
    enableAudioDumps: process.env.AUDIO_ENABLE_RAW_DUMP,
    enableUsbAudioDiagnostic: process.env.AUDIO_USB_DIAGNOSTIC_ENABLED,
    enableUsbPcmCaptureTest: process.env.AUDIO_USB_PCM_CAPTURE_TEST_ENABLED,
    enableUsbPcmOutboundToneTest: process.env.AUDIO_USB_PCM_OUTBOUND_TONE_TEST_ENABLED,
    audioDumpDir: process.env.AUDIO_DUMP_DIRECTORY ?? './audio-dumps',
    sqliteDbPath: process.env.SQLITE_DB_PATH ?? './data/gateway.sqlite',
    gatewayApiKey: rawApiKey ?? 'dev-secret-api-key-sim7600ei',
    commandTimeoutMs: process.env.MODEM_COMMAND_TIMEOUT_MS ?? 5000,
    dialTimeoutMs: process.env.MODEM_DIAL_TIMEOUT_MS ?? 20000,
    autoReconnect: process.env.MODEM_AUTO_RECONNECT,
    ...overrides,
  };

  return gatewayConfigSchema.parse(rawConfig);
}
