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
import {
  AtCommandError,
  AtCommandTimeoutError,
  SerialPortDisconnectedError,
} from '@sim-gateway/shared';
import { AtParser } from '../../adapters/modem/at-parser.js';
import { redactDiagnosticText } from '../../core/logger.js';
import type { UsbPcmTestError, UsbPcmVerifier } from '../../diagnostics/usb-pcm-verification.js';
import { createHardwareRouter, RawPortInfo } from './hardware.js';
import type { CallRecorder } from '../../recording/call-recorder.js';
import type { InboundCaptureTap } from '../../diagnostics/inbound-capture.js';
import { SmsService } from '../../sms/sms-service.js';
import type { SmsInbox } from '../../sms/sms-inbox.js';
import type { SmsStore } from '../../sms/sms-store.js';
import { createSmsRouter } from './sms.js';
import type { PortDiscovery } from '../../hardware/port-discovery.js';

export interface GatewayRouteDependencies {
  /** Test seam: the SMS service (by default one is built over `modem` and `callManager`). */
  sms?: SmsService;
  /** The persistent SMS inbox (notification-driven reads) and its message store. */
  smsInbox?: SmsInbox;
  smsStore?: SmsStore;
  usbPcmVerifier?: UsbPcmVerifier;
  inboundCaptureTap?: InboundCaptureTap;
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  callManager: ICallSessionManager;
  config: GatewayConfigInput;
  /** Test seam for the Hardware page's port listing. */
  listPorts?: () => Promise<RawPortInfo[]>;
  /** Complete-call recorder (separate from the diagnostic captures). */
  recorder?: CallRecorder;
  /** Automatic port discovery (hardware mode) and the ports in use now. */
  portDiscovery?: PortDiscovery | null;
  currentPorts?: () => { at: string; audio: string };
}

export function createGatewayRouter(deps: GatewayRouteDependencies): Router {
  const router = Router();

  // Hardware Operations: status, port discovery, logs and the redacted report. Read-only and AT-free (except
  // /hardware/modem-info, which refuses while any call exists).
  router.use('/hardware', createHardwareRouter(deps));

  // SMS (send, list, read, and a read-only configuration check) over the modem's own AT port. One service per server,
  // so "one SMS operation at a time" holds across requests. Refused during any call.
  router.use('/sms', createSmsRouter(deps.sms ?? new SmsService({ modem: deps.modem, callManager: deps.callManager }), { inbox: deps.smsInbox, store: deps.smsStore }));

  // Complete-call recordings (not diagnostic captures): status, metadata, and the WAV tracks.
  router.get('/recordings', (_req: Request, res: Response) => {
    if (!deps.recorder) {
      res.json({ status: null, recordings: [] });
      return;
    }
    res.json({ status: deps.recorder.getStatus(), recordings: deps.recorder.list() });
  });

  router.get('/recordings/:callId/:track.wav', (req: Request, res: Response) => {
    const file = deps.recorder?.trackFile(String(req.params.callId), String(req.params.track)) ?? null;
    if (!file) {
      res.status(404).json({ error: 'Recording not found', code: 'RECORDING_NOT_FOUND' });
      return;
    }
    res.type('audio/wav').sendFile(file);
  });

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
        atPort: deps.currentPorts?.().at ?? deps.config.atPort,
        audioPort: deps.currentPorts?.().audio ?? deps.config.audioPort,
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

  /**
   * Why did the last call end or fail? Runs AT+CEER through the modem's own command queue (the same
   * serialized path as every other command; no second handle on the AT port). Read-only on the modem.
   * The answer is only meaningful right after a failed or ended call, so ask promptly.
   */
  router.get('/diagnostics/ceer', async (req: Request, res: Response) => {
    const requested = Number(req.query.timeoutMs);
    const timeoutMs = Number.isFinite(requested) ? Math.min(15_000, Math.max(500, requested)) : 5000;
    const call = deps.callManager.getCurrentCall();
    const base = {
      command: 'AT+CEER',
      isSimulated: deps.modem.isSimulated,
      driverType: deps.modem.driverType,
      callState: call?.state ?? null,
      timestamp: new Date().toISOString(),
    };
    try {
      const response = await deps.modem.executeCommand('AT+CEER', timeoutMs);
      const parsed = AtParser.parseCeer(response);
      res.json({
        ...base,
        terminal: 'OK',
        // Digit runs (phone numbers) are masked the same way the logs mask them.
        reports: parsed.reports.map(redactDiagnosticText),
        other: parsed.other.map(redactDiagnosticText),
        note: 'The module\'s own report of why the last call ended or failed. Only meaningful right after that call.',
      });
    } catch (error) {
      if (error instanceof AtCommandTimeoutError) {
        res.status(504).json({ ...base, error: 'The modem did not answer AT+CEER in time', code: 'MODEM_TIMEOUT', timeoutMs });
        return;
      }
      if (error instanceof SerialPortDisconnectedError) {
        res.status(503).json({ ...base, error: 'The modem AT port is not connected', code: 'MODEM_DISCONNECTED' });
        return;
      }
      if (error instanceof AtCommandError) {
        res.status(502).json({
          ...base,
          error: redactDiagnosticText(error.message),
          code: 'MODEM_ERROR',
          response: redactDiagnosticText(error.rawResponse ?? ''),
        });
        return;
      }
      res.status(500).json({ ...base, error: 'AT+CEER failed', code: 'INTERNAL_ERROR' });
    }
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
      if (action === 'recover') {
        if (!deps.callManager.recoverUsbAudio) {
          res.status(501).json({ error: 'USB audio recovery is unavailable' });
          return;
        }
        res.json(await deps.callManager.recoverUsbAudio('manual'));
        return;
      }
      if (action === 'status') {
        res.json(deps.callManager.getUsbAudioStatus?.() ?? { registrationActive: false, needsRecovery: false, lastRecovery: null });
        return;
      }
      res.status(400).json({ error: "action must be 'activate', 'deactivate', 'recover' or 'status'" });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  router.post('/audio/usb-pcm/capture', async (_req: Request, res: Response) => {
    if (!deps.usbPcmVerifier || deps.config.enableUsbPcmCaptureTest !== true) {
      res.status(404).json({ error: 'USB PCM capture test is disabled' });
      return;
    }
    try {
      res.json(await deps.usbPcmVerifier.captureInbound());
    } catch (error) {
      res.status((error as UsbPcmTestError).status ?? 409).json({ error: (error as Error).message });
    }
  });

  router.post('/audio/usb-pcm/tone', async (req: Request, res: Response) => {
    if (!deps.usbPcmVerifier || deps.config.enableUsbPcmOutboundToneTest !== true) {
      res.status(404).json({ error: 'USB PCM outbound tone test is disabled' });
      return;
    }
    try {
      res.json(await deps.usbPcmVerifier.playOutboundTone(req.body ?? {}));
    } catch (error) {
      res.status((error as UsbPcmTestError).status ?? 409).json({ error: (error as Error).message });
    }
  });

  // Arm a read-only capture of the next incoming call's audio (beside the AI agent), or read / cancel it.
  router.post('/audio/inbound-capture/arm', (req: Request, res: Response) => {
    if (!deps.inboundCaptureTap || deps.config.enableUsbPcmCaptureTest !== true) {
      res.status(404).json({ error: 'USB PCM capture test is disabled' });
      return;
    }
    try {
      res.json(deps.inboundCaptureTap.arm({ startDelayMs: Number(req.body?.startDelayMs) }));
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });

  router.get('/audio/inbound-capture', (_req: Request, res: Response) => {
    if (!deps.inboundCaptureTap || deps.config.enableUsbPcmCaptureTest !== true) {
      res.status(404).json({ error: 'USB PCM capture test is disabled' });
      return;
    }
    res.json(deps.inboundCaptureTap.status());
  });

  router.post('/audio/inbound-capture/disarm', (_req: Request, res: Response) => {
    if (!deps.inboundCaptureTap || deps.config.enableUsbPcmCaptureTest !== true) {
      res.status(404).json({ error: 'USB PCM capture test is disabled' });
      return;
    }
    deps.inboundCaptureTap.disarm();
    res.json(deps.inboundCaptureTap.status());
  });

  router.post('/audio/usb-pcm/abort', (_req: Request, res: Response) => {
    deps.usbPcmVerifier?.abort();
    res.json({ aborted: true });
  });

  return router;
}
