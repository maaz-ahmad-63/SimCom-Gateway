'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ActionNote, Badge, Button, Card, Field, TextInput, Toggle, useAction } from '../../../components/ai/ui';
import { SettingsNav } from '../../../components/settings/SettingsNav';
import { apiClient } from '../../../lib/api-client';
import { CONSENT_TEXT, recorderState, RecordingSettingsView } from '../../../lib/recordings';
import { formatDate } from '../../../lib/utils';

/**
 * Settings > Call Recording. Recording is switched on together with the consent acknowledgement and applies from the next call without a
 * restart; switching it off or withdrawing the acknowledgement stops recording at once. Existing recordings are never deleted from here.
 */
export default function RecordingSettingsPage() {
  const [view, setView] = useState<RecordingSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [retention, setRetention] = useState('0');
  const [maxMinutes, setMaxMinutes] = useState('60');
  const [action, run] = useAction();

  const apply = useCallback((v: RecordingSettingsView) => {
    setView(v);
    setConsent(v.settings.consentAcknowledged);
    setRetention(String(v.settings.retentionDays));
    setMaxMinutes(String(Math.round(v.settings.maxSeconds / 60)));
  }, []);

  useEffect(() => {
    apiClient
      .getRecordingSettings()
      .then(apply)
      .catch((e: Error) => setLoadError(e.message));
  }, [apply]);

  const save = async (patch: Record<string, unknown>, message: string) => {
    const v = await run(() => apiClient.saveRecordingSettings(patch), message);
    if (v) apply(v);
  };

  if (loadError) {
    return (
      <div className="space-y-6">
        <SettingsNav />
        <p className="text-sm text-rose-300" role="alert">Could not load the recording settings: {loadError}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="space-y-6">
        <SettingsNav />
        <p className="text-xs text-slate-500">Loading…</p>
      </div>
    );
  }

  const s = view.settings;
  const state = recorderState(view.status);
  const retentionDays = Number(retention);
  const maxSeconds = Number(maxMinutes) * 60;
  const limitsValid = Number.isInteger(retentionDays) && retentionDays >= 0 && retentionDays <= 3650 && Number.isInteger(Number(maxMinutes)) && maxSeconds >= 60 && maxSeconds <= 86400;
  const limitsChanged = retentionDays !== s.retentionDays || maxSeconds !== s.maxSeconds;

  return (
    <div className="space-y-6">
      <SettingsNav />
      <Card
        title="Call recording"
        subtitle="Records each connected call, both sides, into one audio file you can play from Call History. Turning it on applies from the next call; no restart is needed."
        actions={<Badge tone={state.tone}>{state.label}</Badge>}
      >
        <p className="text-xs text-slate-400" data-testid="recorder-state">{state.detail}</p>

        <div className="rounded-md border border-slate-800 p-4 space-y-3">
          <Toggle
            checked={consent}
            onChange={(v) => {
              setConsent(v);
              if (!v && s.consentAcknowledged) void save({ consentAcknowledged: false }, 'Consent acknowledgement withdrawn. Recording is off.');
            }}
            label="Consent acknowledgement"
            hint={CONSENT_TEXT}
          />
          {s.consentAcknowledged && s.consentAcknowledgedAt && <p className="text-[11px] text-slate-500">Confirmed {formatDate(s.consentAcknowledgedAt)}.</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {s.enabled ? (
            <Button variant="danger" onClick={() => void save({ enabled: false }, 'Recording is off. Existing recordings are kept.')} busy={action.status === 'running'}>
              Turn recording off
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!consent}
              title={consent ? undefined : 'Confirm the consent acknowledgement first'}
              onClick={() => void save({ enabled: true, consentAcknowledged: true }, 'Recording is on. The next call will be recorded.')}
              busy={action.status === 'running'}
            >
              Turn recording on
            </Button>
          )}
          {!consent && !s.enabled && <span className="text-[11px] text-slate-500">Confirm the consent acknowledgement to turn recording on.</span>}
        </div>
        <ActionNote state={action} />
      </Card>

      <Card title="Storage" subtitle="Where recordings are kept and for how long. Changing these never deletes a recording right away, except ones older than a new, shorter retention period.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Keep recordings for (days)" hint="0 keeps recordings until you delete them.">
            <TextInput type="number" min={0} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </Field>
          <Field label="Longest recording (minutes)" hint="A longer call stops being recorded at this point; the file stays valid.">
            <TextInput type="number" min={1} max={1440} value={maxMinutes} onChange={(e) => setMaxMinutes(e.target.value)} />
          </Field>
        </div>
        <p className="text-[11px] text-slate-500">
          Folder on this computer: <span className="font-mono">{view.dir}</span>
        </p>
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!limitsValid || !limitsChanged} onClick={() => void save({ retentionDays, maxSeconds }, 'Storage settings saved.')}>
            Save storage settings
          </Button>
          {!limitsValid && <span className="text-[11px] text-amber-300">Days must be 0 to 3650 and minutes 1 to 1440.</span>}
        </div>
        {view.source === 'environment' && <p className="text-[11px] text-slate-500">These are the starting values from the gateway configuration. Saving here replaces them.</p>}
      </Card>
    </div>
  );
}
