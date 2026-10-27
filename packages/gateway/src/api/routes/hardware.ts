import { Request, Response, Router } from 'express';
import os from 'node:os';
import { SerialPort } from 'serialport';
import { IAudioAdapter, ICallSessionManager, IModemAdapter } from '@sim-gateway/shared';
import { getRecentLogs, redactDiagnosticText } from '../../core/logger.js';

export interface HardwareRouteDependencies {
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  callManager: ICallSessionManager;
  config: { atPort?: string; audioPort?: string; enableUsbAudioDiagnostic?: boolean; modemDriver?: string; audioBaudRate?: number; atBaudRate?: number };
  /** Test seam; production lists the Windows serial ports without opening any of them. */
  listPorts?: () => Promise<RawPortInfo[]>;
}

export interface RawPortInfo {
  path: string;
  manufacturer?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

export type PortRole = 'at' | 'audio' | 'diagnostics' | 'nmea' | 'modem' | 'unknown';

export interface DiscoveredPort {
  path: string;
  vendorId: string | null;
  productId: string | null;
  interface: string | null;
  role: PortRole;
  /** Why this role was assigned, so a wrong guess is easy to spot. */
  roleBasis: string;
}

export type LayerState = 'ok' | 'warn' | 'bad' | 'unknown';

export interface HardwareLayer {
  key: 'atPort' | 'audioPortOpen' | 'usbAudioRegistered' | 'freshPcm' | 'playbackVerified';
  label: string;
  state: LayerState;
  detail: string;
}

const SIMCOM_VID = '1E0E';

// The USB interface order of this SIM7600EI (VID_1E0E&PID_9001), observed on this PC and recorded in
// docs/WINDOWS_HARDWARE_INTEGRATION.md. It is a guide: confirm against the Device Manager names.
const INTERFACE_ROLE: Record<string, { role: PortRole; basis: string }> = {
  MI_00: { role: 'diagnostics', basis: 'USB interface 00 (diagnostics on this module)' },
  MI_01: { role: 'nmea', basis: 'USB interface 01 (NMEA on this module)' },
  MI_02: { role: 'at', basis: 'USB interface 02 (AT port on this module, observed 2026-10-16)' },
  MI_03: { role: 'modem', basis: 'USB interface 03 (modem port on this module)' },
  MI_04: { role: 'audio', basis: 'USB interface 04 (USB audio, documented in docs/WINDOWS_HARDWARE_INTEGRATION.md)' },
};

export function classifyPort(raw: RawPortInfo): DiscoveredPort {
  const pnp = raw.pnpId ?? '';
  const vid = (raw.vendorId ?? pnp.match(/VID_([0-9A-F]{4})/i)?.[1] ?? '').toUpperCase() || null;
  const pid = (raw.productId ?? pnp.match(/PID_([0-9A-F]{4})/i)?.[1] ?? '').toUpperCase() || null;
  const iface = pnp.match(/MI_[0-9A-F]{2}/i)?.[0]?.toUpperCase() ?? null;
  if (vid === SIMCOM_VID && iface && INTERFACE_ROLE[iface]) {
    const known = INTERFACE_ROLE[iface];
    return { path: raw.path, vendorId: vid, productId: pid, interface: iface, role: known.role, roleBasis: known.basis };
  }
  return {
    path: raw.path,
    vendorId: vid,
    productId: pid,
    interface: iface,
    role: 'unknown',
    roleBasis: vid === SIMCOM_VID ? 'a SIMCom port whose interface is not recognised' : 'not a SIMCom device port',
  };
}

/**
 * Compare what is configured with what Windows currently has. Never decides anything by itself: it names the
 * mismatch and the line to change, and a person applies it.
 */
export function comparePorts(
  configured: { at?: string; audio?: string },
  discovered: DiscoveredPort[]
): { findings: Array<{ level: 'info' | 'warn' | 'error'; message: string }>; suggested: { MODEM_AT_PORT?: string; MODEM_AUDIO_PORT?: string } } {
  const findings: Array<{ level: 'info' | 'warn' | 'error'; message: string }> = [];
  const suggested: { MODEM_AT_PORT?: string; MODEM_AUDIO_PORT?: string } = {};
  const present = new Set(discovered.map((p) => p.path.toUpperCase()));
  const roleOf = (path?: string) => discovered.find((p) => p.path.toUpperCase() === (path ?? '').toUpperCase())?.role;
  const find = (role: PortRole) => discovered.filter((p) => p.role === role);

  const check = (label: string, path: string | undefined, role: PortRole, key: 'MODEM_AT_PORT' | 'MODEM_AUDIO_PORT') => {
    const candidates = find(role);
    if (!path) {
      findings.push({ level: 'error', message: `${label} is not configured (${key} is empty).` });
    } else if (!present.has(path.toUpperCase())) {
      findings.push({ level: 'error', message: `${label} ${path} is not present in Windows right now (stale or unplugged).` });
    } else if (roleOf(path) && roleOf(path) !== role && roleOf(path) !== 'unknown') {
      findings.push({ level: 'error', message: `${label} ${path} is the module's ${roleOf(path)} interface, not its ${role} interface.` });
    } else {
      findings.push({ level: 'info', message: `${label} ${path} is present${roleOf(path) === role ? ` and matches the module's ${role} interface` : ' (its role could not be identified)'}.` });
      return;
    }
    if (candidates.length === 1) {
      suggested[key] = candidates[0].path;
      findings.push({ level: 'warn', message: `The module's ${role} interface is currently ${candidates[0].path}; set ${key}=${candidates[0].path} and restart the gateway.` });
    } else if (candidates.length > 1) {
      findings.push({ level: 'warn', message: `Several ports look like the module's ${role} interface (${candidates.map((c) => c.path).join(', ')}); choose by hand in Device Manager.` });
    } else {
      findings.push({ level: 'warn', message: `No port currently looks like the module's ${role} interface. Is the modem connected?` });
    }
  };
  check('AT port', configured.at, 'at', 'MODEM_AT_PORT');
  check('Audio port', configured.audio, 'audio', 'MODEM_AUDIO_PORT');
  if (configured.at && configured.audio && configured.at.toUpperCase() === configured.audio.toUpperCase()) {
    findings.push({ level: 'error', message: 'The AT and audio ports are the same port; they must differ.' });
  }
  return { findings, suggested };
}

export function buildHardwareLayers(input: {
  connectionState: string;
  atStatus: string;
  callActive: boolean;
  audioPortOpen: boolean;
  registrationActive: boolean;
  needsRecovery: boolean;
  wireState: string;
  msSinceLastFrame: number | null;
  bytesReceived: number;
}): HardwareLayer[] {
  const at: HardwareLayer =
    input.connectionState === 'READY'
      ? { key: 'atPort', label: 'AT port connection', state: input.atStatus === 'OK' || input.atStatus === 'UNKNOWN' ? 'ok' : 'warn', detail: `modem READY, last AT status ${input.atStatus}` }
      : { key: 'atPort', label: 'AT port connection', state: input.connectionState === 'DISCONNECTED' || input.connectionState === 'ERROR' ? 'bad' : 'warn', detail: `modem ${input.connectionState}, last AT status ${input.atStatus}` };

  const open: HardwareLayer = input.callActive
    ? { key: 'audioPortOpen', label: 'Audio port open for the call', state: input.audioPortOpen ? 'ok' : 'bad', detail: input.audioPortOpen ? 'the gateway holds the audio COM port for this call (this alone says nothing about data)' : 'the audio port is not open for this call' }
    : { key: 'audioPortOpen', label: 'Audio port open for the call', state: 'unknown', detail: 'no active call; the audio port is only opened for a call' };

  const registered: HardwareLayer = !input.callActive
    ? { key: 'usbAudioRegistered', label: 'USB audio registered (gateway record)', state: 'unknown', detail: 'no active call' }
    : input.registrationActive
      ? { key: 'usbAudioRegistered', label: 'USB audio registered (gateway record)', state: 'ok', detail: 'AT+CPCMREG=1 was accepted for this call; the module has not been re-asked' }
      : { key: 'usbAudioRegistered', label: 'USB audio registered (gateway record)', state: input.needsRecovery ? 'warn' : 'bad', detail: input.needsRecovery ? 'registration is unverified after a drop or a failed stop' : 'not activated for this call, so the module sends no PCM' };

  const fresh: HardwareLayer = !input.callActive
    ? { key: 'freshPcm', label: 'Fresh PCM received (last 500 ms)', state: 'unknown', detail: `no active call; ${input.bytesReceived} byte(s) received since the gateway started` }
    : input.wireState === 'flowing'
      ? { key: 'freshPcm', label: 'Fresh PCM received (last 500 ms)', state: 'ok', detail: `bytes are arriving (last frame ${input.msSinceLastFrame ?? '?'} ms ago); bytes are not proof of speech` }
      : { key: 'freshPcm', label: 'Fresh PCM received (last 500 ms)', state: 'bad', detail: input.msSinceLastFrame === null ? 'no frame has arrived since the gateway started' : `the stream is '${input.wireState}'; the last frame was ${input.msSinceLastFrame} ms ago` };

  const playback: HardwareLayer = {
    key: 'playbackVerified',
    label: 'Playback verified',
    state: 'unknown',
    detail: 'never inferred: bytes written to the port do not show the other party heard anything. Only your confirmation after a real listening test counts',
  };
  return [at, open, registered, fresh, playback];
}

export function createHardwareRouter(deps: HardwareRouteDependencies): Router {
  const router = Router();
  const startedAt = Date.now();

  const diagnostics = () => (deps.modem as unknown as { getDiagnostics?: () => unknown }).getDiagnostics?.() ?? null;

  const snapshot = () => {
    const call = deps.callManager.getCurrentCall();
    const usb = deps.callManager.getUsbAudioStatus?.() ?? null;
    const stats = deps.audio?.getStats() ?? null;
    const now = Date.now();
    const msSinceLastFrame = stats?.lastFrameAt ? now - stats.lastFrameAt : null;
    const connectionState = deps.modem.getConnectionState();
    const atStatus = deps.modem.getAtCommunicationStatus?.() ?? 'UNKNOWN';
    const callActive = call?.state === 'ACTIVE';
    return {
      timestamp: new Date(now).toISOString(),
      gateway: {
        version: '0.1.0',
        uptimeSeconds: Math.round(process.uptime()),
        platform: os.platform(),
        driverType: deps.modem.driverType,
        isSimulated: deps.modem.isSimulated,
        usbAudioDiagnosticEnabled: deps.config.enableUsbAudioDiagnostic === true,
      },
      call: call ? { id: call.id, state: call.state, direction: call.direction } : null,
      modem: {
        connectionState,
        atStatus,
        lastCommunicationTime: deps.modem.getLastCommunicationTime?.() ?? null,
        configuredAtPort: deps.config.atPort ?? null,
        configuredAudioPort: deps.config.audioPort ?? null,
        reconnect: diagnostics(),
      },
      usbAudio: usb,
      audio: stats
        ? {
            isStreaming: stats.isStreaming,
            bytesReceived: stats.bytesReceived,
            framesReceived: stats.framesReceived,
            bytesSent: stats.bytesSent,
            framesSent: stats.framesSent,
            droppedFrames: stats.droppedFrames,
            lastFrameAt: stats.lastFrameAt ? new Date(stats.lastFrameAt).toISOString() : null,
            msSinceLastFrame,
          }
        : null,
      layers: buildHardwareLayers({
        connectionState,
        atStatus,
        callActive,
        audioPortOpen: stats?.isStreaming === true,
        registrationActive: usb?.registrationActive === true,
        needsRecovery: usb?.needsRecovery === true,
        wireState: usb?.audio.state ?? 'not-expected',
        msSinceLastFrame,
        bytesReceived: stats?.bytesReceived ?? 0,
      }),
    };
  };

  /** Everything the gateway already knows. Sends no AT command and touches no port. */
  router.get('/status', (_req: Request, res: Response) => {
    res.json(snapshot());
  });

  /** Lists the serial ports Windows has now. Opens none of them. */
  router.get('/ports', async (_req: Request, res: Response) => {
    try {
      const raw = await (deps.listPorts ? deps.listPorts() : (SerialPort.list() as Promise<RawPortInfo[]>));
      const discovered = raw.map(classifyPort).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      const simcom = discovered.filter((p) => p.vendorId === SIMCOM_VID);
      const compared = comparePorts({ at: deps.config.atPort, audio: deps.config.audioPort }, simcom);
      res.json({
        timestamp: new Date().toISOString(),
        note: 'Listing the ports opens none of them. Roles come from USB interface numbers and should be confirmed in Device Manager.',
        configured: { at: deps.config.atPort ?? null, audio: deps.config.audioPort ?? null },
        ports: discovered,
        findings: compared.findings,
        suggestedEnv: Object.keys(compared.suggested).length > 0 ? compared.suggested : null,
      });
    } catch (error) {
      res.status(500).json({ error: `Could not list serial ports: ${redactDiagnosticText((error as Error).message)}`, code: 'PORT_LIST_FAILED' });
    }
  });

  /**
   * Fresh signal, registration and SIM state. These are AT commands, so they are refused while any call exists:
   * nothing is sent to the modem during a call from this page.
   */
  router.get('/modem-info', async (_req: Request, res: Response) => {
    if (deps.callManager.getCurrentCall()) {
      res.status(409).json({ error: 'A call is in progress; AT queries are not sent during a call', code: 'CALL_IN_PROGRESS' });
      return;
    }
    if (deps.modem.getConnectionState() !== 'READY') {
      res.status(409).json({ error: `The modem is ${deps.modem.getConnectionState()}, not READY`, code: 'MODEM_NOT_READY' });
      return;
    }
    const [signal, network, sim] = await Promise.allSettled([
      deps.modem.getSignalQuality(),
      deps.modem.getNetworkStatus(),
      deps.modem.getSimStatus ? deps.modem.getSimStatus() : Promise.resolve(null),
    ]);
    const value = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
    res.json({
      timestamp: new Date().toISOString(),
      isSimulated: deps.modem.isSimulated,
      signal: value(signal),
      network: value(network),
      simStatus: value(sim),
      errors: [signal, network, sim].flatMap((r) => (r.status === 'rejected' ? [redactDiagnosticText(String((r.reason as Error)?.message ?? r.reason))] : [])),
    });
  });

  router.get('/logs', (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const level = req.query.level === 'error' ? 'error' : req.query.level === 'warn' ? 'warn' : 'info';
    res.json({ entries: getRecentLogs(limit, level) });
  });

  /** One redacted text block to paste into a support message. */
  router.get('/report', async (_req: Request, res: Response) => {
    const s = snapshot();
    let ports = 'unavailable';
    try {
      const raw = await (deps.listPorts ? deps.listPorts() : (SerialPort.list() as Promise<RawPortInfo[]>));
      ports = raw
        .map(classifyPort)
        .filter((p) => p.vendorId === SIMCOM_VID)
        .map((p) => `  ${p.path}  ${p.interface ?? '-'}  ${p.role}`)
        .join('\n') || '  (no SIMCom ports present)';
    } catch (error) {
      ports = `  could not list: ${(error as Error).message}`;
    }
    const lines = [
      `AI Caller hardware report  ${s.timestamp}`,
      `Gateway ${s.gateway.version}  up ${s.gateway.uptimeSeconds}s  ${s.gateway.platform}  driver=${s.gateway.driverType}  simulated=${s.gateway.isSimulated}`,
      `Call: ${s.call ? `${s.call.state} (${s.call.direction})` : 'none'}`,
      '',
      'Layers',
      ...s.layers.map((l) => `  [${l.state.toUpperCase().padEnd(7)}] ${l.label}: ${l.detail}`),
      '',
      `Modem: ${s.modem.connectionState}  at=${s.modem.atStatus}  last communication ${s.modem.lastCommunicationTime ?? 'never'}`,
      `Configured ports: AT=${s.modem.configuredAtPort ?? '-'}  audio=${s.modem.configuredAudioPort ?? '-'}`,
      `Reconnect: ${JSON.stringify(s.modem.reconnect)}`,
      `USB audio: ${JSON.stringify(s.usbAudio)}`,
      `Audio counters: ${JSON.stringify(s.audio)}`,
      '',
      'SIMCom ports present now',
      ports,
      '',
      'Recent log (warnings and errors)',
      ...getRecentLogs(60, 'warn').map((e) => `  ${e.line}`),
    ];
    // The same masking the logs use: long digit runs (numbers, identifiers) and credential-looking text.
    const text = lines
      .map((line) => redactDiagnosticText(line))
      .join('\n')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/(api[-_]?key|token|secret|password)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
    res.json({ timestamp: s.timestamp, report: text });
  });

  return router;
}
