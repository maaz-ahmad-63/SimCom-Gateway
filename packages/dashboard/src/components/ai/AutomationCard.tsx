'use client';

import React from 'react';
import type { AiSettingsView } from '@sim-gateway/shared';
import type { SettingsDraft } from '../../lib/ai-settings-form';
import { Badge, Card, Field, Select, TextInput, Toggle } from './ui';

/** What the hands-free switches currently do, in plain words. Pure, so it can be tested. */
export function automationSummary(s: Pick<AiSettingsView, 'autoHandle' | 'automation'>): string[] {
  const a = s.automation;
  const lines: string[] = [];
  lines.push(a.autoAnswer ? `Answers incoming calls after ${a.autoAnswerRings} ring${a.autoAnswerRings === 1 ? '' : 's'}` : 'Does not answer calls by itself');
  lines.push(a.autoActivateUsbAudio ? 'Activates USB audio when an eligible call becomes ACTIVE' : 'Does not activate USB audio by itself');
  lines.push(
    s.autoHandle === 'off'
      ? 'Does not attach to calls by itself (use Attach to this call)'
      : `Attaches automatically to ${s.autoHandle === 'all' ? 'incoming and outgoing' : s.autoHandle} calls, listening only`
  );
  lines.push(a.autoReplies ? 'Speaks to callers by itself while every readiness check passes' : 'Never speaks by itself: replies need a click per call');
  return lines;
}

export function AutomationCard({
  draft,
  setDraft,
  attestations,
}: {
  draft: SettingsDraft;
  setDraft: (d: SettingsDraft) => void;
  attestations: AiSettingsView['attestations'];
}) {
  const a = draft.automation;
  const set = (patch: Partial<typeof a>) => setDraft({ ...draft, automation: { ...a, ...patch } });
  const confirmed = attestations.inbound.confirmed && attestations.outbound.confirmed;
  return (
    <Card
      title="Call automation"
      subtitle="Hands-free handling of real calls. Everything here is off until you turn it on, each step is tried once per call, and every result is written to the Live Inspector."
      actions={<Badge tone={a.autoReplies ? 'warn' : 'neutral'}>{a.autoReplies ? 'replies automatic' : 'listening only'}</Badge>}
    >
      <Toggle
        checked={a.autoAnswer}
        onChange={(v) => set({ autoAnswer: v })}
        label="Answer incoming calls automatically"
        hint="Sends the answer command after the number of rings below. Callers cost provider fees, so turn this on only for a number you intend to serve."
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Answer after (rings)">
          <TextInput inputMode="numeric" value={a.autoAnswerRings} disabled={!a.autoAnswer} onChange={(e) => set({ autoAnswerRings: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Attach the AI automatically to">
          <Select value={draft.autoHandle} onChange={(e) => setDraft({ ...draft, autoHandle: e.target.value as SettingsDraft['autoHandle'] })}>
            <option value="off">Nothing (attach by hand)</option>
            <option value="inbound">Incoming calls</option>
            <option value="outbound">Outgoing calls</option>
            <option value="all">Incoming and outgoing calls</option>
          </Select>
        </Field>
        <Field label="AI time limit per call (seconds)" hint="The AI lets go after this long. The call is not ended.">
          <TextInput inputMode="numeric" value={a.maxCallSeconds} onChange={(e) => set({ maxCallSeconds: Number(e.target.value) || 0 })} />
        </Field>
      </div>
      <Toggle
        checked={a.autoActivateUsbAudio}
        onChange={(v) => set({ autoActivateUsbAudio: v })}
        label="Activate USB audio automatically when an eligible call becomes ACTIVE"
        hint="Sends the documented AT+CPCMREG=1 once per call, then waits for real audio bytes before the AI attaches. Needs AUDIO_USB_DIAGNOSTIC_ENABLED=true on the gateway."
      />
      <Toggle
        checked={a.autoReplies}
        onChange={(v) => set({ autoReplies: v })}
        disabled={!confirmed && !a.autoReplies}
        label="Let the agent speak without a click"
        hint={
          confirmed
            ? 'The agent replies on attached calls only while every readiness check passes; otherwise it stays listening. Hang-up stays governed by the agent setting.'
            : 'Locked until you have confirmed both: caller audio is intelligible and agent audio is audible (Overview tab). Written bytes are not a confirmation.'
        }
      />
      <Toggle
        checked={a.idleFollowUps}
        onChange={(v) => set({ idleFollowUps: v })}
        label="Ask “are you still there?” when the caller goes quiet"
        hint="Spoken only when replies are on: a follow-up after 15 s, another after 9 s more, then a goodbye. It hangs up only if the agent is allowed to."
      />
      <ul className="text-[11px] text-slate-400 list-disc pl-4 space-y-0.5" aria-label="Current behaviour">
        {automationSummary({ autoHandle: draft.autoHandle, automation: a }).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Card>
  );
}
