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
          label={`Shared instructions (${agent.instructions.length}/8000)`}
          hint="Placed before the gateway’s built-in phone-call rules (short replies, one question at a time, no symbols). Used by every call that has no instructions of its own below. Do not put secrets here: this text is sent to the language model provider on every turn."
        >
          <TextArea value={agent.instructions} maxLength={8000} onChange={(e) => setAgent({ instructions: e.target.value })} className="min-h-[200px]" />
        </Field>
        <Field
          label="Shared greeting (spoken when the agent attaches in reply mode; empty for none)"
          hint="Used by every call that has no greeting of its own below. Never spoken in passive mode."
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

      <Card
        title="Inbound calls"
        subtitle="Used when someone rings in. Leave a field empty to use the shared one above. Everything else (speech recognition, the model, the voice, the call rules) is the same engine for every call."
      >
        <Field label={`Inbound instructions (${(agent.inboundInstructions ?? '').length}/8000)`} hint="For example: you are the receptionist for Acme; answer questions about opening hours; take a message.">
          <TextArea value={agent.inboundInstructions ?? ''} maxLength={8000} onChange={(e) => setAgent({ inboundInstructions: e.target.value })} className="min-h-[140px]" aria-label="Inbound instructions" />
        </Field>
        <Field label="Inbound greeting" hint="Spoken when an incoming call is answered.">
          <TextInput value={agent.inboundGreeting ?? ''} maxLength={500} onChange={(e) => setAgent({ inboundGreeting: e.target.value })} aria-label="Inbound greeting" />
        </Field>
      </Card>

      <Card
        title="Outbound campaign calls"
        subtitle="Used when the gateway calls someone. A campaign adds its own details for each contact on top of this, and a greeting template set on the campaign still wins for that campaign."
      >
        <Field label={`Outbound instructions (${(agent.outboundInstructions ?? '').length}/8000)`} hint="For example: you are calling on behalf of Acme about a recent enquiry; be brief; if they are busy offer a callback; never pressure.">
          <TextArea value={agent.outboundInstructions ?? ''} maxLength={8000} onChange={(e) => setAgent({ outboundInstructions: e.target.value })} className="min-h-[140px]" aria-label="Outbound instructions" />
        </Field>
        <Field label="Outbound greeting" hint="Spoken when the person answers. A campaign's greeting template, when it has one, is spoken instead.">
          <TextInput value={agent.outboundGreeting ?? ''} maxLength={500} onChange={(e) => setAgent({ outboundGreeting: e.target.value })} aria-label="Outbound greeting" />
        </Field>
        {dirty && <SaveBar dirty={dirty} problems={problems} action={action} onSave={save} onCancel={cancel} />}
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
