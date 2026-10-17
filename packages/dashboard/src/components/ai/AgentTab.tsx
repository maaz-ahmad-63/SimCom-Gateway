'use client';

import React from 'react';
import { INSPECTOR_STAGES, STAGE_LABELS } from '../../lib/ai-inspector';
import { unique } from '../../lib/ai-settings-form';
import { AutomationCard } from './AutomationCard';
import { Badge, Card, Field, SaveBar, Select, TextArea, TextInput, Toggle } from './ui';
import { useSettingsDraft } from './useSettingsDraft';

export function AgentTab() {
  const { draft, setDraft, dirty, problems, action, save, cancel, catalog, state } = useSettingsDraft();
  if (!draft || !catalog || !state) return <p className="text-xs text-slate-500">Loading…</p>;
  const attached = state.sessions.length;
  const agent = draft.agent;
  const setAgent = (patch: Partial<typeof agent>) => setDraft({ ...draft, agent: { ...agent, ...patch } });

  return (
    <div className="space-y-6">
      <Card
        title="Agent profile"
        subtitle="This gateway runs one agent. Its settings apply to the next call; a call already in progress keeps the settings it started with."
        actions={<Badge tone={agent.enabled ? 'good' : 'neutral'}>{agent.enabled ? 'enabled' : 'disabled'}</Badge>}
      >
        <Toggle
          checked={agent.enabled}
          onChange={(v) => setAgent({ enabled: v })}
          label="Agent enabled"
          hint="Turning it off makes every AI path inert: no transcription, no provider requests, nothing sent to callers."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Name (for your reference)">
            <TextInput value={agent.name} maxLength={80} onChange={(e) => setAgent({ name: e.target.value })} />
          </Field>
          <Field label="Language">
            <Select value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })}>
              {unique([draft.language, ...catalog.languages]).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label={`Instructions (${agent.instructions.length}/8000)`}
          hint="Placed before the gateway’s built-in phone-call rules (short replies, one question at a time, no symbols). Do not put secrets here: this text is sent to the language model provider on every turn."
        >
          <TextArea value={agent.instructions} maxLength={8000} onChange={(e) => setAgent({ instructions: e.target.value })} className="min-h-[200px]" />
        </Field>
        <Field
          label="Greeting (spoken when the agent attaches in reply mode; empty for none)"
          hint="Never spoken in passive mode."
        >
          <TextInput value={agent.greeting} maxLength={500} onChange={(e) => setAgent({ greeting: e.target.value })} />
        </Field>
        <Toggle
          checked={agent.allowHangup}
          onChange={(v) => setAgent({ allowHangup: v })}
          label="Let the agent end the call"
          hint="When the model says END_CALL the gateway hangs up once. Off: it only records that the agent wanted to end the call."
        />
        <SaveBar dirty={dirty} problems={problems} action={action} onSave={save} onCancel={cancel} />
      </Card>

      <AutomationCard draft={draft} setDraft={setDraft} attestations={state.settings.attestations} />
      {dirty && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5">
          <SaveBar dirty={dirty} problems={problems} action={action} onSave={save} onCancel={cancel} />
        </div>
      )}

      <Card title="How a turn runs" subtitle="The same pipeline for every call, one isolated conversation per call.">
        <ol className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {INSPECTOR_STAGES.map((stage, i) => (
            <li key={stage} className="flex items-center gap-2 text-xs text-slate-300 bg-slate-950/50 border border-slate-800 rounded-md px-3 py-2">
              <span className="text-slate-500 font-mono w-4">{i + 1}</span>
              {STAGE_LABELS[stage]}
            </li>
          ))}
        </ol>
        <ul className="text-xs text-slate-400 list-disc pl-4 space-y-1 leading-relaxed">
          <li>Interruptions: new caller speech cancels the reply in progress, including audio being played, and the newest utterance wins.</li>
          <li>Duplicates: the same utterance is processed once; utterances that arrive while one is being cancelled are merged into a single turn.</li>
          <li>Call end: when the call ends, every outstanding provider request and playback is cancelled and that call’s history is discarded.</li>
          <li>Failures: after repeated provider failures the agent stops replying and the call is left alone.</li>
          <li>Isolation: history, timers and audio belong to one call. Nothing carries over to the next.</li>
        </ul>
        <p className="text-xs text-slate-500">Sessions attached right now: {attached}.</p>
      </Card>
    </div>
  );
}
