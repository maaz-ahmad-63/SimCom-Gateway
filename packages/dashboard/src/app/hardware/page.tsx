'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import type { HardwarePorts, HardwareStatus } from '../../lib/hardware-ops';
import { ConnectionPanel, DiscoveryPanel, LayerList, PortsPanel, QueryButton } from '../../components/hardware/HardwarePanels';

export default function HardwarePage() {
  const [status, setStatus] = useState<HardwareStatus | null>(null);
  const [ports, setPorts] = useState<HardwarePorts | null>(null);
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const refresh = useCallback(async () => {
    try {
      setStatus(await apiClient.getHardwareStatus());
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800/80 pb-4">
        <h1 className="text-lg font-semibold text-white">Hardware Operations</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Port open, USB audio registration, fresh PCM and verified playback are separate facts. This page reads state and never dials, answers, restarts the gateway or changes USB registration.
        </p>
      </div>
      {error && <div role="alert" className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs font-mono">{error}</div>}
      {status && (
        <div className="grid gap-6 lg:grid-cols-2">
          <LayerList status={status} />
          <div className="space-y-4">
            <ConnectionPanel status={status} />
            <DiscoveryPanel status={status} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <button type="button" disabled={busy} onClick={() => run(async () => setPorts(await apiClient.getHardwarePorts()))} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50">
          List serial ports (opens none)
        </button>
        <QueryButton status={status} busy={busy} onClick={() => run(async () => setInfo(await apiClient.getHardwareModemInfo()))} />
        <button type="button" disabled={busy} onClick={() => run(async () => setReport((await apiClient.getHardwareReport()).report))} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50">
          Build redacted report
        </button>
      </div>
      {ports && <PortsPanel ports={ports} />}
      {info && <pre className="rounded bg-slate-950 p-3 text-xs text-slate-200 overflow-auto">{JSON.stringify(info, null, 2)}</pre>}
      {report && (
        <div className="space-y-2">
          <textarea readOnly value={report} rows={16} className="w-full rounded bg-slate-950 p-3 font-mono text-xs text-slate-200" aria-label="Diagnostic report" />
          <button type="button" onClick={() => void navigator.clipboard?.writeText(report)} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white">Copy report</button>
        </div>
      )}
    </div>
  );
}
