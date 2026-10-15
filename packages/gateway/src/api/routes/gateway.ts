import { Router, Request, Response } from 'express';
import os from 'node:os';
import {
  GatewayHealthStatus,
  IAudioAdapter,
  ICallSessionManager,
  IModemAdapter,
  ModemDeviceInfo,
  ModemNetworkStatus,
  ModemSignalQuality,
} from '@sim-gateway/shared';
import { GatewayConfigInput } from '@sim-gateway/shared';

export interface GatewayRouteDependencies {
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  callManager: ICallSessionManager;
  config: GatewayConfigInput;
}

export function createGatewayRouter(deps: GatewayRouteDependencies): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    let modemInfo: ModemDeviceInfo | null = null;
    let signal: ModemSignalQuality | null = null;
    let network: ModemNetworkStatus | null = null;

    try {
      if (deps.modem.getConnectionState() === 'READY') {
        [modemInfo, signal, network] = await Promise.all([
          deps.modem.getDeviceInfo().catch(() => null),
          deps.modem.getSignalQuality().catch(() => null),
          deps.modem.getNetworkStatus().catch(() => null),
        ]);
      }
    } catch {
      // Continue with partial health data
    }

    const health: GatewayHealthStatus = {
      gatewayVersion: '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      isSimulated: deps.modem.isSimulated,
      driverType: deps.modem.driverType,
      modem: {
        connectionState: deps.modem.getConnectionState(),
        info: modemInfo,
        signal,
        network,
        atPort: deps.config.atPort,
        audioPort: deps.config.audioPort,
      },
      activeCall: deps.callManager.getCurrentCall(),
      audioStreaming: deps.audio ? deps.audio.getStats().isStreaming : false,
      system: {
        platform: os.platform(),
        nodeVersion: process.version,
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    };

    res.json(health);
  });

  return router;
}
