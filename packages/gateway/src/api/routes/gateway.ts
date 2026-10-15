import { Router, Request, Response } from 'express';
import os from 'node:os';
import {
  AtCommunicationStatus,
  GatewayHealthStatus,
  IAudioAdapter,
  ICallSessionManager,
  IModemAdapter,
  ModemDeviceInfo,
  ModemNetworkStatus,
  ModemSignalQuality,
  SimPinStatus,
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
    let simStatus: SimPinStatus | null = null;
    let atStatus: AtCommunicationStatus = 'UNKNOWN';
    let lastCommunicationTime: string | null = null;

    const connectionState = deps.modem.getConnectionState();

    if (deps.modem.getLastCommunicationTime) {
      lastCommunicationTime = deps.modem.getLastCommunicationTime();
    }

    if (deps.modem.getAtCommunicationStatus) {
      atStatus = deps.modem.getAtCommunicationStatus();
    } else {
      atStatus = connectionState === 'READY' ? 'OK' : connectionState === 'DISCONNECTED' ? 'DISCONNECTED' : 'UNKNOWN';
    }

    if (connectionState === 'DISCONNECTED') {
      simStatus = 'DISCONNECTED';
      atStatus = 'DISCONNECTED';
    } else if (connectionState === 'READY') {
      try {
        const [infoRes, sigRes, netRes, simRes] = await Promise.all([
          deps.modem.getDeviceInfo().catch(() => null),
          deps.modem.getSignalQuality().catch(() => null),
          deps.modem.getNetworkStatus().catch(() => null),
          deps.modem.getSimStatus ? deps.modem.getSimStatus().catch(() => 'ERROR' as SimPinStatus) : Promise.resolve(null),
        ]);
        modemInfo = infoRes;
        signal = sigRes;
        network = netRes;
        simStatus = simRes;
      } catch {
        // Continue with partial health data
      }
    } else if (connectionState === 'ERROR') {
      simStatus = 'ERROR';
      atStatus = 'ERROR';
    } else {
      simStatus = 'UNKNOWN';
    }

    const health: GatewayHealthStatus = {
      gatewayVersion: '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      isSimulated: deps.modem.isSimulated,
      driverType: deps.modem.driverType,
      modem: {
        connectionState,
        info: modemInfo,
        signal,
        network,
        simStatus,
        atStatus,
        lastCommunicationTime,
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

  router.post('/audio/usb-diagnostic', async (req: Request, res: Response) => {
    if (deps.config.enableUsbAudioDiagnostic !== true) {
      res.status(404).json({ error: 'USB audio diagnostic is disabled' });
      return;
    }
    try {
      const action = req.body?.action;
      if (action === 'activate') {
        if (!deps.callManager.activateUsbAudioDiagnostic) {
          res.status(501).json({ error: 'USB audio diagnostic is unavailable' });
          return;
        }
        res.json(await deps.callManager.activateUsbAudioDiagnostic());
        return;
      }
      if (action === 'deactivate') {
        if (!deps.callManager.deactivateUsbAudioDiagnostic) {
          res.status(501).json({ error: 'USB audio diagnostic is unavailable' });
          return;
        }
        res.json((await deps.callManager.deactivateUsbAudioDiagnostic()) ?? { active: false });
        return;
      }
      res.status(400).json({ error: "action must be 'activate' or 'deactivate'" });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  return router;
}
