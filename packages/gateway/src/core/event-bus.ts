import { EventEmitter } from 'node:events';
import {
  AudioFrame,
  AudioStreamStats,
  CallSession,
  CallStateChangeEvent,
  ModemConnectionState,
  UrcEvent,
} from '@sim-gateway/shared';

export interface GatewayEventMap {
  'call:state_changed': (event: CallStateChangeEvent) => void;
  'call:started': (session: CallSession) => void;
  'call:ended': (session: CallSession) => void;
  'modem:urc': (urc: UrcEvent) => void;
  'modem:connection_state': (state: ModemConnectionState) => void;
  'audio:frame': (frame: AudioFrame) => void;
  'audio:stats': (stats: AudioStreamStats) => void;
  'gateway:alert': (alert: {
    level: 'info' | 'warn' | 'error';
    message: string;
    timestamp: string;
  }) => void;
  'error': (error: Error) => void;
}

export class GatewayEventBus extends EventEmitter {
  emit<E extends keyof GatewayEventMap>(
    event: E,
    ...args: Parameters<GatewayEventMap[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  on<E extends keyof GatewayEventMap>(
    event: E,
    listener: GatewayEventMap[E]
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  once<E extends keyof GatewayEventMap>(
    event: E,
    listener: GatewayEventMap[E]
  ): this {
    return super.once(event, listener as (...args: any[]) => void);
  }

  off<E extends keyof GatewayEventMap>(
    event: E,
    listener: GatewayEventMap[E]
  ): this {
    return super.off(event, listener as (...args: any[]) => void);
  }
}
