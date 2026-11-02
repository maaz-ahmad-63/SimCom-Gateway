import type { CallSession, IAudioAdapter, ICallSessionManager, IModemAdapter, ModemConnectionState } from '@sim-gateway/shared';

/** Stable identifier of one physical modem ("modem-a"). Every modem operation is addressed with it. */
export type ModemId = string;

export type ModemModel = 'SIM7600EI' | 'A7672S' | 'MOCK';

/** How audio reaches the AI for this modem. Never shared between modems. */
export type ModemAudioConfig =
  | { kind: 'usb-pcm'; port: string }
  | { kind: 'analog'; captureDevice: string | null; playbackDevice: string | null }
  | { kind: 'mock' };

export interface ModemDescriptor {
  modemId: ModemId;
  /** Operator-facing name. */
  name: string;
  model: ModemModel;
  atPort: string;
  /** Diagnostics port. Identified and reported only; never opened as an AT or audio port. */
  diagPort?: string;
  audio: ModemAudioConfig;
}

export type ModemAudioState = 'not-configured' | 'configured' | 'streaming' | 'error' | 'unverified';

export interface ModemAudioStatus {
  state: ModemAudioState;
  kind: ModemAudioConfig['kind'];
  detail?: string;
}

/** Everything that belongs to exactly one modem. Nothing in it is shared with another unit. */
export interface ModemUnit {
  descriptor: ModemDescriptor;
  modem: IModemAdapter;
  audio: IAudioAdapter | null;
  callManager: ICallSessionManager;
  /** Whether the shared AI agent may answer calls on this modem. Starts true. */
  aiEnabled: boolean;
  audioStatus: () => ModemAudioStatus;
}

export interface ModemStatusSnapshot {
  modemId: ModemId;
  name: string;
  model: ModemModel;
  connection: ModemConnectionState;
  audio: ModemAudioStatus;
  aiEnabled: boolean;
  call: CallSession | null;
  timestamp: string;
}

/** Events published per modem. All carry modemId; call events also carry callId. */
export type ModemEvent =
  | { type: 'modem.status'; modemId: ModemId; status: ModemStatusSnapshot; timestamp: string }
  | { type: 'modem.call.ringing'; modemId: ModemId; callId: string; remoteNumber: string; timestamp: string }
  | { type: 'modem.call.answered'; modemId: ModemId; callId: string; timestamp: string }
  | { type: 'modem.call.ended'; modemId: ModemId; callId: string; outcome: CallSession['outcome']; durationSeconds: number; timestamp: string }
  | { type: 'modem.audio.status'; modemId: ModemId; audio: ModemAudioStatus; timestamp: string }
  | { type: 'modem.error'; modemId: ModemId; message: string; timestamp: string };

export class ModemNotFoundError extends Error {
  constructor(public readonly modemId: ModemId) {
    super(`Modem '${modemId}' is not registered`);
    this.name = 'ModemNotFoundError';
  }
}

export class ModemRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModemRegistrationError';
  }
}
