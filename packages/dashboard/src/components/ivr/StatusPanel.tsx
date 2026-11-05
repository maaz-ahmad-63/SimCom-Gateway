'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { issueWhere, IvrRuntime, IvrStatus, IvrValidation, ReadinessItem, statusSummary, Tone } from '../../lib/ivr';
import { ActionNote, ActionState, Badge, Button, Card } from '../ai/ui';

export function StatusCard({
  status,
  runtime,
  state,
  onEnable,
}: {
  status: IvrStatus;
  runtime: IvrRuntime | null;
  state: ActionState;
  onEnable: (enabled: boolean) => void;
}) {
  const summary = statusSummary(status, runtime);
  const canEnable = status.publishedVersion > 0;
  const turnOn = () => {
    const ok = typeof window === 'undefined' || window.confirm('Turn the IVR on?\n\nFrom now on every OUTGOING call plays the published menu as soon as the person answers, and listens for their key presses. Incoming calls are not affected: they still go to the AI exactly as before.');
    if (ok) onEnable(true);
  };
  return (
    <Card
      title="IVR status"
      subtitle={summary.detail}
      actions={
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <Badge tone={summary.tone}>{summary.label}</Badge>
          {status.publishedVersion > 0 ? <Badge tone="neutral">published v{status.publishedVersion}</Badge> : <Badge tone="warn">nothing published</Badge>}
          {status.unpublishedChanges && <Badge tone="warn">unpublished changes</Badge>}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        {status.enabled ? (
          <Button variant="danger" onClick={() => onEnable(false)} busy={state.status === 'running'}>
            Turn the IVR off
          </Button>
        ) : (
          <Button variant="primary" onClick={turnOn} disabled={!canEnable} busy={state.status === 'running'} title={canEnable ? undefined : 'Publish a menu first'}>
            Turn the IVR on
          </Button>
        )}
        {!canEnable && <span className="text-[11px] text-slate-500">Publish a menu below before turning the IVR on. It is off until you do.</span>}
        {status.publishedAt && <span className="text-[11px] text-slate-500 font-mono">published {new Date(status.publishedAt).toLocaleString()}</span>}
      </div>
      {status.problems.length > 0 && (
        <ul className="text-xs text-rose-300 list-disc pl-4 space-y-0.5" aria-label="Stored IVR problems">
          {status.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {runtime && runtime.activeCalls.length > 0 && <p className="text-xs text-cyan-300">The IVR is handling {runtime.activeCalls.length} call{runtime.activeCalls.length === 1 ? '' : 's'} right now.</p>}
      <ActionNote state={state} />
    </Card>
  );
}

const ICONS: Record<Tone, React.ReactNode> = {
  good: <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />,
  warn: <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />,
  bad: <XCircle className="w-4 h-4 text-rose-400 shrink-0" />,
  neutral: <CheckCircle2 className="w-4 h-4 text-slate-500 shrink-0" />,
};

export function ReadinessCard({ items, canRun }: { items: ReadinessItem[]; blockers?: string[]; canRun: boolean }) {
  return (
    <Card
      title="Ready for a real call?"
      subtitle="What can be checked now. Items marked with a warning can only be confirmed on a real test call."
      actions={<Badge tone={canRun ? 'good' : 'bad'}>{canRun ? 'nothing blocking' : 'blocked'}</Badge>}
    >
      <ul className="space-y-2" aria-label="Readiness checks">
        {items.map((item) => (
          <li key={item.label} className="flex items-start gap-2 text-xs">
            {ICONS[item.tone]}
            <span>
              <span className="text-slate-200 font-medium">{item.label}</span>
              <span className="text-slate-400"> — {item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function IssuesCard({ issues, dirty }: { issues: IvrValidation | null; dirty: boolean }) {
  if (!issues) return null;
  const clean = issues.errors.length === 0 && issues.warnings.length === 0;
  return (
    <Card
      title="Checks before publishing"
      subtitle={dirty ? 'Worked out from your unsaved edits. The gateway checks again when you save and publish.' : "The gateway's own check of the saved draft."}
      actions={<Badge tone={issues.ok ? 'good' : 'bad'}>{issues.ok ? 'can be published' : `${issues.errors.length} to fix`}</Badge>}
    >
      {clean && <p className="text-xs text-emerald-300">Nothing to fix.</p>}
      {issues.errors.length > 0 && (
        <ul className="space-y-1.5" aria-label="Errors to fix">
          {issues.errors.map((e, i) => (
            <li key={`e${i}`} className="flex items-start gap-2 text-xs text-rose-300">
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                <span className="font-semibold">{issueWhere(e.path)}:</span> {e.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {issues.warnings.length > 0 && (
        <ul className="space-y-1.5" aria-label="Warnings">
          {issues.warnings.map((w, i) => (
            <li key={`w${i}`} className="flex items-start gap-2 text-xs text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                <span className="font-semibold">{issueWhere(w.path)}:</span> {w.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
