import { CallSession, CallStateChangeEvent, DialRequest, DtmfRequest } from './call.js';
import { ModemSignalQuality, ModemNetworkStatus, UrcEvent } from './modem.js';
import { GatewayHealthStatus } from './gateway.js';

/**
 * Socket.IO Typed Contract definitions.
 * Provides strict type-safety across backend emitter and dashboard subscriber.
 */

export interface ServerToClientEvents {
  /** Emitted periodically (e.g. every 5s) or on gateway state changes */
  'gateway:health': (health: GatewayHealthStatus) => void;

  /** Emitted on any state transition of the active call */
  'call:state_changed': (event: CallStateChangeEvent) => void;

  /** Emitted when an outbound or inbound call begins */
  'call:started': (session: CallSession) => void;

  /** Emitted when call terminates and duration is finalized */
  'call:ended': (session: CallSession) => void;

  /** Emitted when raw URC is processed from modem (useful for diagnostics) */
  'modem:urc': (urc: UrcEvent) => void;

  /** Periodic signal and network telemetry updates */
  'modem:telemetry': (telemetry: {
    signal: ModemSignalQuality;
    network: ModemNetworkStatus;
  }) => void;

  /** High-frequency (10Hz) audio level updates for dashboard VU meters */
  'audio:level': (data: {
    inboundRms: number;
    outboundRms: number;
    timestamp: number;
  }) => void;

  /** System alerts, notifications, or errors */
  'gateway:alert': (alert: {
    level: 'info' | 'warn' | 'error';
    message: string;
    timestamp: string;
  }) => void;
}

export interface ClientToServerEvents {
  /** Request dial from dashboard */
  'call:dial': (
    request: DialRequest,
    callback: (response: { success: boolean; data?: CallSession; error?: string }) => void
  ) => void;

  /** Answer currently ringing inbound call */
  'call:answer': (
    callback: (response: { success: boolean; data?: CallSession; error?: string }) => void
  ) => void;

  /** Hangup current call */
  'call:hangup': (
    callback: (response: { success: boolean; error?: string }) => void
  ) => void;

  /** Send DTMF digit */
  'call:dtmf': (
    request: DtmfRequest,
    callback: (response: { success: boolean; error?: string }) => void
  ) => void;

  /** Dev mock trigger for simulating inbound ring from dashboard */
  'mock:trigger_inbound': (
    data: { phoneNumber: string },
    callback: (response: { success: boolean; error?: string }) => void
  ) => void;
}
