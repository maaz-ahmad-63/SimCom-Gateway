'use client';

import React, { useMemo } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { referencedAssets } from '../../lib/ivr';
import { ActionNote, Button, Card } from '../ai/ui';
import { AudioLibrary } from './AudioLibrary';
import { AnnouncementsCard, BehaviorCard, OptionsCard } from './MenuEditor';
import { IssuesCard, ReadinessCard, StatusCard } from './StatusPanel';
import { useIvr } from './useIvr';

/** The whole IVR builder: status and the on/off switch, the audio library, the menu, and the Save / Publish bar. */
export function IvrView() {
  const ivr = useIvr();
  const { overview, draft } = ivr;

  const inUse = useMemo(() => {
    const ids = new Set<string>();
    if (draft) referencedAssets(draft).forEach((id) => ids.add(id));
    // What the published menu still uses cannot be deleted either, whatever the draft says.
    if (overview?.published) referencedAssets(overview.published.config).forEach((id) => ids.add(id));
    return ids;
  }, [draft, overview]);

  if (ivr.loadError && !overview) {
    return (
      <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs font-mono flex items-center gap-3">
        <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
        <span>
          <span className="font-semibold">Gateway IVR API: </span>
          {ivr.loadError}
        </span>
      </div>
    );
  }
  if (!overview || !draft) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-400" role="status">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading the IVR…
      </p>
    );
  }

  const blockedBySave = ivr.problems.length > 0;
  return (
    <div className="space-y-5">
      {ivr.loadError && <p className="text-[11px] text-amber-300">The gateway stopped answering ({ivr.loadError}); what is shown may be out of date.</p>}
      <StatusCard status={overview.status} runtime={overview.runtime} state={ivr.enableState} onEnable={ivr.setEnabled} />
      {ivr.ready && <ReadinessCard items={ivr.ready.items} canRun={ivr.ready.canRun} />}
      <AudioLibrary assets={overview.assets} rules={overview.audio} inUse={inUse} state={ivr.assetState} onUpload={ivr.upload} onDelete={ivr.removeAsset} />
      <AnnouncementsCard config={draft} assets={overview.assets} onChange={ivr.setDraft} />
      <OptionsCard config={draft} assets={overview.assets} onAdd={ivr.edit.addOption} onRemove={ivr.edit.removeOption} onUpdate={ivr.edit.updateOption} />
      <BehaviorCard config={draft} assets={overview.assets} onChange={ivr.setDraft} />
      <IssuesCard issues={ivr.issues} dirty={ivr.dirty} />

      <Card title="Save and publish" subtitle="A draft is private to this page: calls use only the PUBLISHED menu. Publishing saves your edits first, checks everything, and refuses an incomplete menu.">
        {blockedBySave && (
          <ul className="text-xs text-amber-300 list-disc pl-4 space-y-0.5" aria-label="Problems to fix before saving">
            {ivr.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={ivr.save} disabled={!ivr.dirty || blockedBySave} busy={ivr.saveState.status === 'running'}>
            Save draft
          </Button>
          <Button onClick={ivr.discardEdits} disabled={!ivr.dirty}>
            Discard my edits
          </Button>
          <Button variant="primary" onClick={ivr.publish} disabled={blockedBySave || (ivr.issues ? !ivr.issues.ok : true)} busy={ivr.publishState.status === 'running'}>
            {ivr.dirty ? 'Save and publish' : 'Publish'}
          </Button>
          <Button
            variant="danger"
            onClick={ivr.resetToPublished}
            disabled={!overview.status.hasSavedDraft || ivr.dirty}
            busy={ivr.resetState.status === 'running'}
            title="Throw away the saved draft and go back to the published menu"
          >
            Reset draft to published
          </Button>
          {ivr.dirty && <span className="text-[11px] text-amber-300">Unsaved edits</span>}
        </div>
        <ActionNote state={ivr.saveState} />
        <ActionNote state={ivr.publishState} />
        <ActionNote state={ivr.resetState} />
      </Card>
    </div>
  );
}
