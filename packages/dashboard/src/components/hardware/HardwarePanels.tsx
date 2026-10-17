import React from 'react';
import { canQueryModem, envLines, formatAge, HardwarePorts, HardwareStatus, LAYER_TONE } from '../../lib/hardware-ops';

export function LayerList({ status }: { status: HardwareStatus }) {
  return (
    <ul className="space-y-2" aria-label="Hardware layers">
      {status.layers.map((l) => {
        const tone = LAYER_TONE[l.state];
        return (
          <li key={l.key} className={`rounded-lg border px-3 py-2 text-xs ${tone.className}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{l.label}</span>
              <span className="font-mono">{tone.label}</span>
            </div>
            <p className="mt-1 opacity-80">{l.detail}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function ConnectionPanel({ status }: { status: HardwareStatus }) {
  const r = status.modem.reconnect;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-300">
      <dt className="text-slate-500">Modem</dt>
      <dd>{status.modem.connectionState} (AT {status.modem.atStatus})</dd>
      <dt className="text-slate-500">Configured AT / audio</dt>
      <dd className="font-mono">{status.modem.configuredAtPort ?? '-'} / {status.modem.configuredAudioPort ?? '-'}</dd>
      <dt className="text-slate-500">Last PCM frame</dt>
      <dd>{status.audio ? formatAge(status.audio.msSinceLastFrame) : 'no audio adapter'}</dd>
      <dt className="text-slate-500">PCM received</dt>
      <dd>{status.audio ? `${status.audio.bytesReceived} bytes / ${status.audio.framesReceived} frames` : '-'}</dd>
      <dt className="text-slate-500">Init attempts</dt>
      <dd>{r ? r.initAttempts : '-'}</dd>
      <dt className="text-slate-500">Reconnect</dt>
      <dd>{r ? (r.reconnectScheduled ? `attempt ${r.reconnectAttempts}, next in ${Math.round((r.nextReconnectInMs ?? 0) / 1000)} s` : 'not scheduled') : '-'}</dd>
      <dt className="text-slate-500">Last failure</dt>
      <dd className="break-words">{r?.lastFailure ? r.lastFailure.message : 'none'}</dd>
    </dl>
  );
}

export function PortsPanel({ ports }: { ports: HardwarePorts }) {
  const lines = envLines(ports.suggestedEnv);
  return (
    <div className="space-y-3 text-xs">
      <ul className="space-y-1 font-mono text-slate-300">
        {ports.ports.map((p) => (
          <li key={p.path}>{p.path} — {p.interface ? `MI_${p.interface}` : 'no interface'} — {p.role}</li>
        ))}
      </ul>
      {ports.findings.map((f, i) => (
        <p key={i} role={f.level === 'info' ? undefined : 'alert'} className={f.level === 'info' ? 'text-slate-400' : f.level === 'warn' ? 'text-amber-300' : 'text-rose-300'}>{f.message}</p>
      ))}
      {lines && (
        <div>
          <p className="text-slate-400">Suggested change (edit .env yourself, then restart the gateway when no call is running; nothing is changed automatically):</p>
          <pre className="mt-1 rounded bg-slate-950 p-2 text-slate-200">{lines}</pre>
        </div>
      )}
      <p className="text-slate-500">{ports.note}</p>
    </div>
  );
}

export function QueryButton({ status, busy, onClick }: { status: HardwareStatus | null; busy: boolean; onClick: () => void }) {
  const gate = canQueryModem(status);
  return (
    <div>
      <button type="button" disabled={!gate.allowed || busy} onClick={onClick} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50">
        Query signal / SIM (sends AT commands)
      </button>
      {gate.reason && <p className="mt-1 text-xs text-amber-300">{gate.reason}</p>}
    </div>
  );
}
