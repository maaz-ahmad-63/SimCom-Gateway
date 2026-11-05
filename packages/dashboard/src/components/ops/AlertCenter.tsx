'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import { bootstrapLocalConfig } from '../../lib/config';
import { alertSummary, bannerAlerts, linkState, LinkState, OpsAlert, reconnectDelayMs, SEVERITY_LABEL, severityTone, sortAlerts, timeAgo } from '../../lib/ops';
import { Badge, Button } from '../ai/ui';

const ICON = { critical: OctagonAlert, error: OctagonAlert, warning: AlertTriangle, info: Info } as const;
const BORDER = { critical: 'border-rose-700 bg-rose-950/40', error: 'border-rose-800/70 bg-rose-950/25', warning: 'border-amber-800/70 bg-amber-950/25', info: 'border-slate-700 bg-slate-900/60' } as const;

/** One alert, in customer words: what happened, where, when, and what to do. The technical detail is behind a button. */
export function AlertCard({
  alert,
  now,
  onAcknowledge,
  onDismiss,
  onRecheck,
  onDetails,
  busy,
}: {
  alert: OpsAlert;
  now?: number;
  onAcknowledge?: () => void;
  onDismiss?: () => void;
  onRecheck?: () => void;
  onDetails?: () => void;
  busy?: boolean;
}) {
  const Icon = ICON[alert.severity];
  return (
    <div role={alert.severity === 'critical' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-xs ${BORDER[alert.severity]}`} data-testid="alert-card" data-severity={alert.severity}>
      <div className="flex items-start gap-2">
        <Icon className="w-4 h-4 mt-0.5 shrink-0 text-slate-200" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-white">{alert.title}</span>
            <Badge tone={severityTone(alert.severity)}>{SEVERITY_LABEL[alert.severity]}</Badge>
            <span className="text-[10px] font-mono uppercase text-slate-400">{alert.component}</span>
          </div>
          <p className="text-slate-200">{alert.message}</p>
          {alert.action && (
            <p className="text-slate-300" data-testid="alert-action">
              <span className="font-semibold">What to do: </span>
              {alert.action}
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            Started {timeAgo(alert.firstAt, now)}
            {alert.count > 1 ? ` · seen ${alert.count} times, last ${timeAgo(alert.lastAt, now)}` : ''}
            {alert.status === 'resolved' ? ` · resolved ${timeAgo(alert.resolvedAt, now)}` : ''}
            {alert.acknowledgedAt && alert.status === 'active' ? ' · acknowledged' : ''}
          </p>
        </div>
      </div>
      {(onAcknowledge || onDismiss || onRecheck || onDetails) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
          {onRecheck && alert.retry === 'recheck' && alert.status === 'active' && (
            <Button onClick={onRecheck} busy={busy}>
              Check again
            </Button>
          )}
          {onAcknowledge && alert.status === 'active' && alert.acknowledgedAt === null && <Button onClick={onAcknowledge}>Acknowledge</Button>}
          {onDismiss && alert.severity !== 'critical' && alert.status === 'active' && <Button onClick={onDismiss}>Dismiss</Button>}
          {onDetails && (
            <button type="button" onClick={onDetails} className="text-[11px] text-cyan-400 hover:underline">
              Technical details
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DiagnosticsDialog({ alertId, onClose }: { alertId: number; onClose: () => void }) {
  const [data, setData] = useState<{ alert: OpsAlert; details: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiClient
      .getOpsAlertDiagnostics(alertId)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [alertId, onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Technical details" onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-slate-800 bg-[#0f172a] p-5 space-y-3 text-xs">
        <div className="flex items-start justify-between">
          <h2 className="text-sm font-bold text-white">Technical details</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-slate-400">For support. Keys, passwords and phone numbers are removed before anything is stored here.</p>
        {error && <p role="alert" className="text-rose-300">{error}</p>}
        {!data && !error && <p className="text-slate-400">Loading…</p>}
        {data && <pre className="whitespace-pre-wrap break-words rounded bg-slate-950 p-3 font-mono text-[11px] text-slate-300">{JSON.stringify({ key: data.alert.key, component: data.alert.component, severity: data.alert.severity, count: data.alert.count, firstAt: data.alert.firstAt, lastAt: data.alert.lastAt, details: data.details }, null, 2)}</pre>}
      </div>
    </div>
  );
}

/** The gateway cannot be reached: said once, plainly, with how long the information has been stale. */
export function ConnectionBanner({ state, message, onRetry }: { state: LinkState; message: string; onRetry: () => void }) {
  if (state === 'live') return null;
  return (
    <div role="alert" className={`px-4 py-2 text-xs flex flex-wrap items-center gap-3 border-b ${state === 'lost' ? 'bg-rose-950/60 border-rose-800 text-rose-100' : 'bg-amber-950/50 border-amber-800 text-amber-100'}`} data-testid="connection-banner" data-state={state}>
      <OctagonAlert className="w-4 h-4 shrink-0" />
      <span className="font-semibold">{state === 'lost' ? 'Gateway not reachable' : 'Reconnecting'}</span>
      <span>{message}</span>
      <Button onClick={onRetry}>Try now</Button>
    </div>
  );
}

/**
 * Sits at the top of every page. It asks the gateway for health and alerts, backs off when the gateway cannot be reached, and shows
 * critical alerts until they are acknowledged or resolved. Everything else is in the bell menu and on the System health page.
 */
export function AlertCenter() {
  const [alerts, setAlerts] = useState<OpsAlert[]>([]);
  const [failures, setFailures] = useState(0);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.getOpsAlerts();
      setAlerts(r.alerts);
      failuresRef.current = 0;
      setFailures(0);
      setLastOk(Date.now());
    } catch {
      failuresRef.current += 1;
      setFailures(failuresRef.current);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    let alive = true;
    const loop = async () => {
      await bootstrapLocalConfig(); // first run of the packaged product: pick up the local key if none is saved
      await load();
      if (alive) timer.current = setTimeout(loop, failuresRef.current === 0 ? 10_000 : reconnectDelayMs(failuresRef.current));
    };
    void loop();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } catch {
      /* the next refresh shows the real state */
    }
    setBusy(null);
    await load();
  };

  const link = linkState({ lastSuccessAt: lastOk, failures, now });
  const banner = bannerAlerts(alerts);
  const all = sortAlerts(alerts);

  return (
    <>
      <ConnectionBanner state={link.state} message={link.message} onRetry={() => void load()} />
      {banner.length > 0 && (
        <div className="px-4 py-2 space-y-2 bg-rose-950/30 border-b border-rose-900" data-testid="critical-banner">
          {banner.map((a) => (
            <AlertCard key={a.id} alert={a} now={now} busy={busy === a.id} onAcknowledge={() => void act(a.id, () => apiClient.acknowledgeOpsAlert(a.id))} onRecheck={() => void act(a.id, () => apiClient.recheckOpsAlert(a.id))} onDetails={() => setDetailsFor(a.id)} />
          ))}
        </div>
      )}
      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
        {open && (
          <div className="w-[26rem] max-w-[92vw] max-h-[70vh] overflow-y-auto rounded-xl border border-slate-800 bg-[#0f172a] p-3 space-y-2 shadow-2xl" data-testid="alert-menu">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">Alerts</h2>
              <a href="/health" className="text-[11px] text-cyan-400 hover:underline">
                System health
              </a>
            </div>
            {all.length === 0 && (
              <p className="text-xs text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> No problems right now.
              </p>
            )}
            {all.map((a) => (
              <AlertCard
                key={a.id}
                alert={a}
                now={now}
                busy={busy === a.id}
                onAcknowledge={() => void act(a.id, () => apiClient.acknowledgeOpsAlert(a.id))}
                onDismiss={() => void act(a.id, () => apiClient.dismissOpsAlert(a.id))}
                onRecheck={() => void act(a.id, () => apiClient.recheckOpsAlert(a.id))}
                onDetails={() => setDetailsFor(a.id)}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`Alerts: ${alertSummary(alerts)}`}
          aria-expanded={open}
          className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-lg ${alerts.some((a) => a.severity === 'critical' || a.severity === 'error') ? 'border-rose-700 bg-rose-950 text-rose-100' : alerts.length > 0 ? 'border-amber-700 bg-amber-950 text-amber-100' : 'border-slate-700 bg-slate-900 text-slate-200'}`}
        >
          <Bell className="w-4 h-4" />
          <span>{alerts.length === 0 ? 'All clear' : alertSummary(alerts)}</span>
        </button>
      </div>
      {detailsFor !== null && <DiagnosticsDialog alertId={detailsFor} onClose={() => setDetailsFor(null)} />}
    </>
  );
}
