import type { IAudioAdapter, ICallSessionManager, IModemAdapter } from '@sim-gateway/shared';
import { ModemAudioStatus, ModemDescriptor, ModemUnit } from './types.js';

export interface ModemUnitParts {
  descriptor: ModemDescriptor;
  modem: IModemAdapter;
  audio: IAudioAdapter | null;
  callManager: ICallSessionManager;
  aiEnabled?: boolean;
  /** Overrides the default audio status (the analog path reports 'unverified' until a real call proves it). */
  audioStatus?: () => ModemAudioStatus;
}

/** Bind a modem's existing adapters into a unit. The adapters themselves are not wrapped or changed. */
export function createModemUnit(parts: ModemUnitParts): ModemUnit {
  const { descriptor, audio } = parts;
  return {
    descriptor,
    modem: parts.modem,
    audio,
    callManager: parts.callManager,
    aiEnabled: parts.aiEnabled ?? true,
    audioStatus:
      parts.audioStatus ??
      (() => {
        if (!audio) return { state: 'not-configured', kind: descriptor.audio.kind };
        return { state: audio.getStats().isStreaming ? 'streaming' : 'configured', kind: descriptor.audio.kind };
      }),
  };
}
