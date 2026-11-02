import { IAudioAdapter } from '@sim-gateway/shared';
import { A7672sAdapter, A7672sOptions } from '../adapters/modem/a7672s-modem.js';
import { CallSessionManager } from '../core/call-session-manager.js';
import { GatewayEventBus } from '../core/event-bus.js';
import { ModemAudioStatus, ModemUnit } from './types.js';
import { createModemUnit } from './unit.js';

export interface A7672sUnitOptions extends A7672sOptions {
  modemId: string;
  name?: string;
  /** The analog audio path for this modem (Stage 5). Without it the unit has no call audio and says so. */
  audio?: IAudioAdapter | null;
  audioStatus?: () => ModemAudioStatus;
  captureDevice?: string | null;
  playbackDevice?: string | null;
}

/**
 * A modem unit for an A7672S: its own adapter, its own call manager and its own private event bus (calls on this modem are
 * never announced through another modem's bus). No USB PCM registration is ever sent: audio is the analog interface.
 */
export function createA7672sUnit(options: A7672sUnitOptions): { unit: ModemUnit; eventBus: GatewayEventBus; adapter: A7672sAdapter } {
  const adapter = new A7672sAdapter(options);
  const eventBus = new GatewayEventBus();
  eventBus.on('error', () => {}); // reported through the registry as modem.error
  const audio = options.audio ?? null;
  const callManager = new CallSessionManager({ modem: adapter, audio: audio ?? undefined, eventBus });
  const unit = createModemUnit({
    descriptor: {
      modemId: options.modemId,
      name: options.name ?? 'Modem B',
      model: 'A7672S',
      atPort: options.atPort,
      diagPort: options.diagPort,
      audio: { kind: 'analog', captureDevice: options.captureDevice ?? null, playbackDevice: options.playbackDevice ?? null },
    },
    modem: adapter,
    audio,
    callManager,
    audioStatus: options.audioStatus ?? (() => (audio ? { state: 'unverified', kind: 'analog', detail: 'configured; full-duplex not verified' } : { state: 'not-configured', kind: 'analog' })),
  });
  return { unit, eventBus, adapter };
}

/** Modem B from environment variables. Returns null when MODEM_B_AT_PORT is not set, so nothing changes by default. */
export function modemBFromEnv(env: Record<string, string | undefined>): A7672sUnitOptions | null {
  const atPort = env.MODEM_B_AT_PORT?.trim();
  if (!atPort) return null;
  const diagPort = env.MODEM_B_DIAG_PORT?.trim() || undefined;
  if (diagPort && diagPort.toUpperCase() === atPort.toUpperCase()) {
    throw new Error(`Configuration Error: MODEM_B_AT_PORT and MODEM_B_DIAG_PORT must be different ports (both are ${atPort}).`);
  }
  return {
    modemId: env.MODEM_B_ID?.trim() || 'modem-b',
    name: env.MODEM_B_NAME?.trim() || 'Modem B',
    atPort,
    diagPort,
    atBaudRate: Number(env.MODEM_B_AT_BAUD) || 115200,
    captureDevice: env.MODEM_B_CAPTURE_DEVICE?.trim() || null,
    playbackDevice: env.MODEM_B_PLAYBACK_DEVICE?.trim() || null,
  };
}
