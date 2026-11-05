'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { BackupInfo, COMPONENT_HELP, ComponentHealth, formatBytes, NetworkReading, OpsAlert, OpsHealth, registrationLine, signalBars, STATUS_LABEL, statusTone, timeAgo } from '../../lib/ops';
import { ActionNote, Badge, Button, Card, Tile, useAction } from '../ai/ui';
import { AlertCard } from './AlertCenter';

export function ComponentRow({ c, now }: { c: ComponentHealth; now?: number }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2 border-b border-slate-800/60" data-testid="health-row" data-status={c.status}>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-white">{c.label}</p>
        <p className="text-[11px] text-slate-500">{COMPONENT_HELP[c.id] ?? ''}</p>
        <p className="text-xs text-slate-300 mt-0.5">{c.summary}</p>
      </div>
      <div className="text-right shrink-0">
        <Badge tone={statusTone(c.status)}>{STATUS_LABEL[c.status]}</Badge>
        <p className="text-[10px] text-slate-500 mt-1">checked {timeAgo(c.observedAt, now)}</p>
      </div>
    </li>
  );
}

/** The SIM and mobile network, in plain words, with the raw modem replies kept for a technician. */
export function NetworkPanel({ reading, now, onRefresh, busy }: { reading: NetworkReading | null; now?: number; onRefresh: () => void; busy: boolean }) {
  return (
    <Card
      title="SIM and mobile network"
      subtitle="Read from the modem while no call is in progress. It is never read during a call."
      actions={
        <Button onClick={onRefresh} busy={busy}>
          Read now
        </Button>
      }
    >
      {!reading && <p className="text-xs text-slate-400">No reading yet.</p>}
      {reading && (
        <div className="space-y-3" data-testid="network-panel">
          <p className="text-xs text-slate-200">
            <span className="font-semibold">{reading.verdict.title}.</span> {reading.verdict.explanation}
          </p>
          {reading.verdict.action && <p className="text-xs text-slate-300">What to do: {reading.verdict.action}</p>}
          {reading.verdict.uncertain && <p className="text-[11px] text-amber-300" data-testid="uncertain">The modem did not give enough information for a firm conclusion.</p>}
          {reading.skippedBecause && <p className="text-[11px] text-slate-500">Latest attempt skipped: {reading.skippedBecause}</p>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Tile label="SIM">{reading.sim.state.replace(/_/g, ' ')}</Tile>
            <Tile label="Operator">{reading.operator ?? 'Not reported'}</Tile>
            <Tile label="Signal">{reading.signal.dbm === null ? 'Unknown' : `${reading.signal.dbm} dBm · ${'▮'.repeat(signalBars(reading.signal.level))}${'▯'.repeat(4 - signalBars(reading.signal.level))}`}</Tile>
            <Tile label="Voice registration">{registrationLine(reading.registration.cs)}</Tile>
            <Tile label="LTE registration">{registrationLine(reading.registration.eps)}</Tile>
            <Tile label="Data registration">{registrationLine(reading.registration.ps)}</Tile>
            <Tile label="Last reading">{timeAgo(reading.takenAt, now)}</Tile>
          </div>
          <details className="text-[11px] text-slate-400">
            <summary className="cursor-pointer">Raw modem replies (for support)</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-slate-400">
              {[`SIM: ${reading.sim.raw ?? '—'}`, `CSQ: ${reading.signal.raw ?? '—'}`, `CREG: ${reading.registration.cs.raw ?? '—'}`, `CEREG: ${reading.registration.eps.raw ?? '—'}`, `CGREG: ${reading.registration.ps.raw ?? '—'}`].join('\n')}
            </pre>
          </details>
        </div>
      )}
    </Card>
  );
}

export function BackupsPanel({
  backups,
  pending,
  onCreate,
  onRestore,
  onCancel,
  create,
  restore,
}: {
  backups: BackupInfo[];
  pending: { name: string; stagedAt: string } | null;
  onCreate: () => void;
  onRestore: (name: string) => void;
  onCancel: () => void;
  create: Parameters<typeof ActionNote>[0]['state'];
  restore: Parameters<typeof ActionNote>[0]['state'];
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Card title="Backups" subtitle="Copies of the database: calls, campaigns, settings and results. Recordings are files on disk and are not copied here. Restoring is applied the next time the application starts, and the current data is kept first.">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onCreate} busy={create.status === 'running'}>
          Back up now
        </Button>
        <span className="text-[11px] text-slate-500">A backup is also made automatically about once a day while no call is in progress.</span>
      </div>
      <ActionNote state={create} />
      {pending && (
        <div className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-xs space-y-2" role="status" data-testid="pending-restore">
          <p className="text-amber-100">
            A restore of <span className="font-mono">{pending.name}</span> is waiting. It is applied the next time the application starts. Restart the application when no call is in progress.
          </p>
          <Button onClick={onCancel}>Cancel the restore</Button>
        </div>
      )}
      {backups.length === 0 ? (
        <p className="text-xs text-slate-400">No backups yet.</p>
      ) : (
        <ul className="divide-y divide-slate-800/60 text-xs" data-testid="backup-list">
          {backups.map((b) => (
            <li key={b.name} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-mono text-slate-200">{b.name}</span>
                <span className="text-slate-500">
                  {' '}
                  · {formatBytes(b.bytes)} · {timeAgo(b.createdAt)} · {b.kind}
                </span>
              </div>
              {confirm === b.name ? (
                <span className="flex items-center gap-2">
                  <span className="text-slate-300">Restore this backup at the next start?</span>
                  <Button
                    variant="danger"
                    onClick={() => {
                      onRestore(b.name);
                      setConfirm(null);
                    }}
                  >
                    Yes, stage the restore
                  </Button>
                  <Button onClick={() => setConfirm(null)}>Cancel</Button>
                </span>
              ) : (
                <Button onClick={() => setConfirm(b.name)}>Restore…</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ActionNote state={restore} />
    </Card>
  );
}

/** The System health page: everything the customer might need to see when something is wrong, in one place. */
export function HealthView() {
  const [health, setHealth] = useState<OpsHealth | null>(null);
  const [alerts, setAlerts] = useState<OpsAlert[]>([]);
  const [history, setHistory] = useState<OpsAlert[]>([]);
  const [network, setNetwork] = useState<NetworkReading | null>(null);
  const [backups, setBackups] = useState<{ backups: BackupInfo[]; pending: { name: string; stagedAt: string } | null }>({ backups: [], pending: null });
  const [version, setVersion] = useState<Awaited<ReturnType<typeof apiClient.getOpsVersion>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [checking, runCheck] = useAction();
  const [reading, runReading] = useAction();
  const [create, runCreate] = useAction();
  const [restore, runRestore] = useAction();
  const [bundle, runBundle] = useAction();

  const load = useCallback(async () => {
    try {
      const [h, a, hist, n, b, v] = await Promise.all([apiClient.getOpsHealth(), apiClient.getOpsAlerts(), apiClient.getOpsAlertHistory(), apiClient.getOpsNetwork(), apiClient.getOpsBackups(), apiClient.getOpsVersion()]);
      setHealth(h);
      setAlerts(a.alerts);
      setHistory(hist.items);
      setNetwork(n.reading);
      setBackups({ backups: b.backups, pending: b.pendingRestore });
      setVersion(v);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the system health');
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const saveBundle = async () => {
    const blob = await runBundle(() => apiClient.downloadSupportBundle(), 'Support bundle downloaded. It contains no keys, passwords, phone numbers or transcripts.');
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `support-bundle-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-5">
      {error && (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
          The system health could not be loaded: {error}
        </p>
      )}
      <Card
        title="System health"
        subtitle="Everything the product depends on, checked every few seconds. A problem appears here and in the alert bell, and disappears by itself when it is fixed."
        actions={
          <Button onClick={() => void runCheck(async () => setHealth(await apiClient.getOpsHealth(true)), 'Checked')} busy={checking.status === 'running'}>
            Check now
          </Button>
        }
      >
        {!health && !error && <p className="text-xs text-slate-400">Loading…</p>}
        {health && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={statusTone(health.overall)}>{health.overall === 'ok' ? 'Ready' : health.overall === 'unknown' ? 'Not sure yet' : 'Needs attention'}</Badge>
              <span className="text-[11px] text-slate-500">updated {timeAgo(health.generatedAt, now)}</span>
              {version && (
                <span className="text-[11px] text-slate-500">
                  version {version.app} · database v{version.schema} · started {timeAgo(version.startedAt, now)}
                </span>
              )}
            </div>
            {version && !version.compatible && (
              <p role="alert" className="text-xs text-rose-300" data-testid="incompatible">
                {version.message}
              </p>
            )}
            <ul data-testid="health-list">{health.components.map((c) => <ComponentRow key={c.id} c={c} now={now} />)}</ul>
          </>
        )}
        <ActionNote state={checking} />
      </Card>

      {alerts.length > 0 && (
        <Card title="Open alerts">
          <div className="space-y-2">
            {alerts.map((a) => (
              <AlertCard key={a.id} alert={a} now={now} onRecheck={() => void apiClient.recheckOpsAlert(a.id).then(load)} onAcknowledge={() => void apiClient.acknowledgeOpsAlert(a.id).then(load)} onDismiss={() => void apiClient.dismissOpsAlert(a.id).then(load)} />
            ))}
          </div>
        </Card>
      )}

      <NetworkPanel reading={network} now={now} busy={reading.status === 'running'} onRefresh={() => void runReading(async () => setNetwork((await apiClient.refreshOpsNetwork()).reading), 'Read')} />
      <ActionNote state={reading} />

      <BackupsPanel
        backups={backups.backups}
        pending={backups.pending}
        create={create}
        restore={restore}
        onCreate={() => void runCreate(() => apiClient.createOpsBackup(), 'Backup created').then(load)}
        onRestore={(name) => void runRestore(() => apiClient.stageOpsRestore(name), 'Restore staged. It is applied the next time the application starts.').then(load)}
        onCancel={() => void apiClient.cancelOpsRestore().then(load)}
      />

      <Card title="Support" subtitle="If something is wrong and you contact support, send this file. It holds health, alerts and recent logs, and none of your keys, passwords, phone numbers, transcripts or recordings.">
        <Button onClick={() => void saveBundle()} busy={bundle.status === 'running'}>
          Download support bundle
        </Button>
        <ActionNote state={bundle} />
      </Card>

      <Card title="Alert history">
        {history.length === 0 ? (
          <p className="text-xs text-slate-400">Nothing has gone wrong yet.</p>
        ) : (
          <div className="space-y-2" data-testid="alert-history">
            {history.map((a) => (
              <AlertCard key={a.id} alert={a} now={now} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
