'use client';

import React, { useState } from 'react';
import { formatSize, lastResultNotice, Notice, summarize } from '../../lib/updates';
import { Badge, Button, Card } from '../ai/ui';
import { useUpdates } from './useUpdates';

const TONE = { good: 'good', warn: 'warn', bad: 'bad', neutral: 'neutral' } as const;

export function NoticeLine({ n }: { n: Notice }) {
  return (
    <div className="space-y-1" role="status">
      <Badge tone={TONE[n.tone]}>{n.title}</Badge>
      {n.detail && <p className="text-xs text-slate-400">{n.detail}</p>}
    </div>
  );
}

/** Settings: the installed version, Check now and Update now. The page never installs anything itself; it asks the supervisor. */
export function UpdatesCard() {
  const u = useUpdates();
  const [confirming, setConfirming] = useState(false);
  if (u.unavailable) return null; // development run: there is nothing to update
  if (!u.update) return null;
  const v = u.update;
  const last = lastResultNotice(v.lastResult, v.currentVersion);
  const working = u.busy !== null || ['checking', 'downloading', 'verifying', 'installing'].includes(v.phase) || u.restarting;

  return (
    <Card title="Software updates" subtitle={`Installed version ${v.currentVersion}`}>
      <div className="space-y-3" data-testid="updates-card">
        <NoticeLine n={u.restarting ? { tone: 'neutral', title: 'Updating…', detail: 'The program is restarting on the new version. This page reconnects by itself.' } : summarize(v)} />
        {last && <NoticeLine n={last} />}
        {u.message && (
          <p role="alert" className="text-xs text-rose-300">
            {u.message}
          </p>
        )}
        {v.available && !v.canApply && v.cannotApplyReason && <p className="text-xs text-amber-300">{v.cannotApplyReason}</p>}

        {confirming && v.available ? (
          <div className="space-y-2 text-xs text-slate-300" role="alert">
            <p>
              Install version {v.available.version} ({formatSize(v.available.size)})? The program restarts for about a minute. Your calls, contacts, API keys and prompts are kept, and
              the update is undone automatically if the new version does not start properly. It will not start during a call.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                busy={u.busy === 'apply'}
                onClick={async () => {
                  await u.apply();
                  setConfirming(false);
                }}
              >
                Yes, update now
              </Button>
              <Button onClick={() => setConfirming(false)}>Not now</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void u.check()} busy={u.busy === 'check'} disabled={working || !v.configured}>
              Check now
            </Button>
            {v.available && (
              <Button variant="primary" onClick={() => setConfirming(true)} disabled={working || !v.canApply}>
                Update now
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
