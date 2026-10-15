import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { gatewayConfigSchema, GatewayConfigInput } from '@sim-gateway/shared';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

// Load .env from process.cwd() or fallback to repository root
dotenv.config();
dotenv.config({ path: path.resolve(currentDir, '../../../.env') });

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
  }

  const rawConfig = {
    port: process.env.PORT ?? 4000,
    host: process.env.HOST ?? '127.0.0.1',
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    modemDriver: driver,
    atPort: process.env.MODEM_AT_PORT ?? 'COM20',
    atBaudRate: process.env.MODEM_AT_BAUD ?? 115200,
    audioPort: process.env.MODEM_AUDIO_PORT ?? 'COM19',
    audioBaudRate: process.env.MODEM_AUDIO_BAUD ?? 115200,
    audioSampleRate: process.env.AUDIO_SAMPLE_RATE ?? 8000,
    enableAudioDumps: process.env.AUDIO_ENABLE_RAW_DUMP ?? true,
    audioDumpDir: process.env.AUDIO_DUMP_DIRECTORY ?? './audio-dumps',
    sqliteDbPath: process.env.SQLITE_DB_PATH ?? './data/gateway.sqlite',
    gatewayApiKey: rawApiKey ?? 'dev-secret-api-key-sim7600ei',
    commandTimeoutMs: process.env.MODEM_COMMAND_TIMEOUT_MS ?? 5000,
    dialTimeoutMs: process.env.MODEM_DIAL_TIMEOUT_MS ?? 20000,
    autoReconnect: process.env.MODEM_AUTO_RECONNECT ?? true,
    ...overrides,
  };

  return gatewayConfigSchema.parse(rawConfig);
}
