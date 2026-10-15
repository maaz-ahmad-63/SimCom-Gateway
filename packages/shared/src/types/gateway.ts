import {
  AtCommunicationStatus,
  ModemConnectionState,
  ModemDeviceInfo,
  ModemNetworkStatus,
  ModemSignalQuality,
  SimPinStatus,
} from './modem.js';
import { CallSession } from './call.js';

export interface GatewayHealthStatus {
  gatewayVersion: string;
  uptimeSeconds: number;
  /** Explicit indicator: true if using MockModemAdapter, false if physical COM port */
  isSimulated: boolean;
  driverType: 'hardware' | 'mock';
  modem: {
    connectionState: ModemConnectionState;
    info: ModemDeviceInfo | null;
    signal: ModemSignalQuality | null;
    network: ModemNetworkStatus | null;
    simStatus?: SimPinStatus | null;
    atStatus?: AtCommunicationStatus | null;
    lastCommunicationTime?: string | null;
    atPort: string;
    audioPort: string;
  };
  activeCall: CallSession | null;
  audioStreaming: boolean;
  system: {
    platform: string;
    nodeVersion: string;
    memoryUsageMb: number;
  };
  timestamp: string;
}

export interface GatewayConfig {
  port: number;
  host: string;
  corsOrigin: string;
  modemDriver: 'hardware' | 'mock';
  atPort: string;
  atBaudRate: number;
  audioPort: string;
  audioBaudRate: number;
  audioSampleRate: number;
  enableAudioDumps: boolean;
  audioDumpDir: string;
  sqliteDbPath: string;
}
