'use client';

import React, { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { Campaign, DAY_LABELS, formFromSettings, SettingsForm, settingsPatch, settingsProblems } from '../../lib/campaigns';
import { ActionNote, Button, Card, Field, Select, TextArea, TextInput, useAction } from '../ai/ui';

const RETRY_LABELS: Record<'no_answer' | 'busy' | 'failed', string> = { no_answer: 'No answer (rang, nobody picked up)', busy: 'Busy (a declined call can be reported as busy)', failed: 'Call failed' };

export function SettingsStep({ campaign, onSaved, readOnly }: { campaign: Campaign; onSaved: () => void; readOnly?: boolean }) {
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(campaign.settings));
  const [dirty, setDirty] = useState(false);
  const [action, run] = useAction();
  useEffect(() => {
    if (!dirty) setForm(formFromSettings(campaign.settings));
  }, [campaign.settings, dirty]);

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };
  const problems = settingsProblems(form);
  // Everything except a running campaign can be edited (a finished one too). It only affects calls placed afterwards.
  const locked = readOnly || campaign.status === 'running';
  const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const save = async () => {
    const ok = await run(() => apiClient.updateCampaign(campaign.id, { settings: settingsPatch(form) }), 'Settings saved');
    if (ok) {
      setDirty(false);
      onSaved();
    }
  };

  return (
    <Card title="2. Pacing, retries and rules" subtitle="These are checked before every call, not just when the campaign starts. They are your settings, not legal advice: calling rules differ by country and by the recipient's registration status, and you are responsible for following them.">
      <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Delay between calls (s)" hint="Calls are always one at a time.">
            <TextInput inputMode="numeric" value={form.interCallDelaySeconds} onChange={(e) => set('interCallDelaySeconds', e.target.value)} />
          </Field>
          <Field label="Maximum attempts">
            <TextInput inputMode="numeric" value={form.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} />
          </Field>
          <Field label="Retry after (minutes)">
            <TextInput inputMode="numeric" value={form.retryDelayMinutes} onChange={(e) => set('retryDelayMinutes', e.target.value)} />
          </Field>
          <Field label="Ring timeout (s)">
            <TextInput inputMode="numeric" value={form.callTimeoutSeconds} onChange={(e) => set('callTimeoutSeconds', e.target.value)} />
          </Field>
          <Field label="Wait for the AI after an answer (s)" hint="If the agent has not joined by then, the campaign pauses and alerts you. It never hangs up for you.">
            <TextInput inputMode="numeric" value={form.agentAttachTimeoutSeconds} onChange={(e) => set('agentAttachTimeoutSeconds', e.target.value)} />
          </Field>
        </div>
        <div>
          <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Retry when the call ended as</span>
          <div className="flex gap-4">
            {(Object.keys(RETRY_LABELS) as Array<keyof typeof RETRY_LABELS>).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-xs text-slate-300">
                <input type="checkbox" className="accent-cyan-500" checked={form.retryOn.includes(k)} onChange={() => set('retryOn', toggle(form.retryOn, k))} />
                {RETRY_LABELS[k]}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            An answered call is never retried. Neither is a call that ended before it was answered: the modem cannot tell a declined call from an unreachable number or a network drop, so those are left alone rather than redialled. Ticking “Busy” can re-call someone who declined.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Calling hours start">
            <TextInput value={form.start} onChange={(e) => set('start', e.target.value)} placeholder="09:00" />
          </Field>
          <Field label="Calling hours end">
            <TextInput value={form.end} onChange={(e) => set('end', e.target.value)} placeholder="20:00" />
          </Field>
          <Field label="Time zone (of the people you call)" hint="Calls only start inside these hours in this zone.">
            <TextInput value={form.timeZone} onChange={(e) => set('timeZone', e.target.value)} placeholder="Asia/Kolkata" />
          </Field>
          <div>
            <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Days</span>
            <div className="flex flex-wrap gap-2">
              {DAY_LABELS.map((d, i) => (
                <label key={d} className="flex items-center gap-1 text-[11px] text-slate-300">
                  <input type="checkbox" className="accent-cyan-500" checked={form.days.includes(i)} onChange={() => set('days', toggle(form.days, i))} />
                  {d}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Consent" hint={campaign.status === 'draft' ? '“From the file”: only contacts marked yes are called. “I attest”: you confirm consent for the whole list at start; contacts marked no are still skipped. It cannot be changed after the campaign starts.' : 'Fixed once the campaign has started.'}>
            <Select disabled={campaign.status !== 'draft'} value={form.consentMode} onChange={(e) => set('consentMode', e.target.value as SettingsForm['consentMode'])}>
              <option value="column">Required for each contact, from the file</option>
              <option value="attested">I attest consent for the whole list</option>
            </Select>
          </Field>
          <Field label="Default country code" hint={campaign.status === 'draft' ? 'For numbers written without a + or 00: 91 (India), 1 (US/Canada), 44, 61, 65 or 971. Other countries: write numbers as +<code><number>. A local number must have that country\'s exact length; it is never guessed.' : 'Fixed once the campaign has started.'}>
            <TextInput disabled={campaign.status !== 'draft'} value={form.defaultCountryCode} onChange={(e) => set('defaultCountryCode', e.target.value)} placeholder="91" />
          </Field>
          <Field label="Skip numbers called within (hours)" hint="Across all campaigns. 0 turns it off.">
            <TextInput inputMode="numeric" value={form.skipRecentlyCalledHours} onChange={(e) => set('skipRecentlyCalledHours', e.target.value)} />
          </Field>
          <Field label="Pause after failed calls in a row" hint="Protects against a dead modem burning through the list.">
            <TextInput inputMode="numeric" value={form.maxConsecutiveFailures} onChange={(e) => set('maxConsecutiveFailures', e.target.value)} />
          </Field>
        </div>

        <Field label="Why this campaign is calling (older campaigns without their own prompt)" hint="Used only when the campaign has no prompt of its own (see “Campaign AI agent”). A campaign with its own prompt ignores this field.">
          <TextArea value={form.contextNote} onChange={(e) => set('contextNote', e.target.value)} maxLength={600} rows={3} />
        </Field>
        <Field label="Greeting for this campaign (optional)" hint="Use {name}, {designation}, {company}. Leave empty to use the agent's normal greeting (a campaign with its own prompt then starts by listening). Applies to this campaign's calls only.">
          <TextInput value={form.greetingTemplate} onChange={(e) => set('greetingTemplate', e.target.value)} maxLength={300} placeholder="Hello {name}, this is Sarah calling from…" />
        </Field>
      </fieldset>

      {problems.length > 0 && !locked && (
        <ul className="text-xs text-rose-300 list-disc ml-4" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {!locked && (
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || problems.length > 0} busy={action.status === 'running'}>
            Save settings
          </Button>
          <ActionNote state={action} />
        </div>
      )}
      {locked && <p className="text-[11px] text-slate-500">Pause the campaign to change its settings. Edits only affect calls placed afterwards.</p>}
    </Card>
  );
}
