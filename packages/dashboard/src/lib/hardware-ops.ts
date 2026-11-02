/** Types and pure helpers for the Hardware Operations page. No network, no secrets. */

export type LayerState = 'ok' | 'warn' | 'bad' | 'unknown';

export interface HardwareLayer {
  key: string;
  label: string;
  state: LayerState;
  detail: string;
}

export interface HardwareStatus {
  timestamp: string;
  gateway: { version: string; uptimeSeconds: number; platform: string; driverType: string; isSimulated: boolean; usbAudioDiagnosticEnabled: boolean };
  call: { id?: string; state: string; direction: string } | null;
  modem: {
    connectionState: string;
    atStatus: string;
    lastCommunicationTime: string | null;
    configuredAtPort: string | null;
    configuredAudioPort: string | null;
    reconnect: {
      initAttempts: number;
      reconnectAttempts: number;
      reconnectScheduled: boolean;
      nextReconnectInMs: number | null;
      lastInit: { at: string; ok: boolean; durationMs: number; step: string; error?: string } | null;
      lastFailure: { at: string; message: string } | null;
    } | null;
  };
  /** Automatic port discovery (hardware mode). Missing on older gateways and in mock mode. */
  discovery?: DiscoveryView | null;
  usbAudio: Record<string, unknown> | null;
  audio: { bytesReceived: number; framesReceived: number; msSinceLastFrame: number | null; lastFrameAt: string | null } | null;
  layers: HardwareLayer[];
}

/** What the gateway reports about finding the modem's ports (GET /api/gateway/hardware/status, `discovery`). */
export interface DiscoveryView {
  mode: 'explicit' | 'discovery';
  explicit: { at: string | null; audio: string | null };
  selector: string | null;
  lastScanAt: string | null;
  ok: boolean | null;
  code: string | null;
  message: string | null;
  warnings: string[];
  at: string | null;
  audio: string | null;
  device: { id: string; vendorId: string; productId: string | null } | null;
  modems: Array<{ id: string; at: string | null; audio: string | null; problems: string[]; interfaces: Array<{ path: string; interface: string | null; role: string; name: string | null }> }>;
}

/** One line for the discovery state, in the operator's words. Never infers anything the gateway did not report. */
export function discoverySummary(d: DiscoveryView | null | undefined): { state: LayerState; text: string } {
  if (!d) return { state: 'unknown', text: 'This gateway does not report port discovery (mock mode or an older build).' };
  if (d.mode === 'explicit') {
    return {
      state: d.warnings.length > 0 ? 'warn' : 'ok',
      text: `Ports set explicitly: AT ${d.explicit.at}, USB audio ${d.explicit.audio}${d.warnings.length ? `. ${d.warnings.join('. ')}` : ''}`,
    };
  }
  if (d.ok === null) return { state: 'unknown', text: 'Discovery has not run yet: the gateway looks for the modem when it opens its ports.' };
  if (d.ok === false) return { state: 'bad', text: d.message ?? `Discovery failed (${d.code ?? 'unknown'})` };
  return {
    state: d.warnings.length > 0 ? 'warn' : 'ok',
    text: `Discovered automatically: AT ${d.at}, USB audio ${d.audio}${d.device ? ` on modem ${d.device.id}` : ''}${d.warnings.length ? `. ${d.warnings.join('. ')}` : ''}`,
  };
}

export interface HardwarePorts {
  mode?: 'explicit' | 'discovery';
  modems?: Array<{ id: string; at: string | null; audio: string | null; problems: string[] }>;
  configured: { at: string | null; audio: string | null };
  ports: Array<{ path: string; interface: string | null; role: string; roleBasis?: string; vendorId?: string }>;
  findings: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
  suggestedEnv: Record<string, string> | null;
  note: string;
}

export const LAYER_TONE: Record<LayerState, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'text-emerald-300 border-emerald-800 bg-emerald-950/50' },
  warn: { label: 'Check', className: 'text-amber-300 border-amber-800 bg-amber-950/50' },
  bad: { label: 'Problem', className: 'text-rose-300 border-rose-800 bg-rose-950/50' },
  unknown: { label: 'Unknown', className: 'text-slate-300 border-slate-700 bg-slate-900/60' },
};

/** Hardware-changing or AT-sending actions are only offered when no call exists. */
export function canQueryModem(status: HardwareStatus | null): { allowed: boolean; reason: string | null } {
  if (!status) return { allowed: false, reason: 'Waiting for the gateway' };
  if (status.call) return { allowed: false, reason: `A call is ${status.call.state}; AT queries are not sent during a call` };
  if (status.modem.connectionState !== 'READY') return { allowed: false, reason: `Modem is ${status.modem.connectionState}, not READY` };
  return { allowed: true, reason: null };
}

/** The .env lines to paste, or null when the configured ports already match. */
export function envLines(suggested: Record<string, string> | null): string | null {
  if (!suggested || Object.keys(suggested).length === 0) return null;
  return Object.entries(suggested).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  return ms < 1000 ? `${ms} ms ago` : `${(ms / 1000).toFixed(1)} s ago`;
}
