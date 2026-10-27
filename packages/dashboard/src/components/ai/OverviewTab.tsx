'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Mic, ShieldCheck } from 'lucide-react';
import type { AiMode, AiSessionView } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { attachControlState, checklist, CHECK_LABELS, describeAudioHealth, formatDb, summarizeReadiness } from '../../lib/ai-readiness';
import { AttachControl } from './AttachControl';
import { ConversationCard } from './ConversationCard';
import { RecordingCard } from './RecordingCard';
import { TestResponseCard } from './TestResponseCard';
import { credentialBadges } from '../../lib/ai-secrets';
import { useAi } from '../../lib/context/AiContext';
import { useGateway } from '../../lib/context/GatewayContext';
import { ActionNote, Badge, Button, Card, Field, TextArea, Tile, useAction } from './ui';

const MODE_TEXT: Record<AiMode, string> = {
  off: 'Off: nothing is transcribed, generated or sent.',
  passive: 'Passive: caller audio is transcribed so you can inspect it. No reply is generated or played.',
  active: 'Active: the agent replies to the caller. Lasts for the current call only.',
};

function ModeControls() {
  const { state, refresh } = useAi();
  const [action, run] = useAction();
  const [confirming, setConfirming] = useState(false);
  if (!state) return null;
  const { readiness } = state;
  const canActivate = readiness.ok;
  const set = async (mode: AiMode) => {
    setConfirming(false);
    await run(() => apiClient.setAiMode(mode), `AI mode set to ${mode}`);
    await refresh();
  };
  return (
    <Card title="Mode" subtitle={MODE_TEXT[readiness.mode]}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={readiness.mode === 'off' ? 'primary' : 'secondary'} onClick={() => set('off')} disabled={readiness.mode === 'off'}>
          Off
        </Button>
        <Button variant={readiness.mode === 'passive' ? 'primary' : 'secondary'} onClick={() => set('passive')} disabled={readiness.mode === 'passive'}>
          Passive transcription
        </Button>
        {confirming ? (
          <>
            <Button variant="danger" onClick={() => set('active')}>
              Yes, let the agent speak on this call
            </Button>
            <Button onClick={() => setConfirming(false)}>Not now</Button>
          </>
        ) : (
          <Button
            variant={readiness.mode === 'active' ? 'primary' : 'secondary'}
            onClick={() => setConfirming(true)}
            disabled={!canActivate || readiness.mode === 'active'}
            title={canActivate ? undefined : 'Blocked until every readiness check passes'}
          >
            Enable replies
          </Button>
        )}
      </div>
      {!canActivate && (
        <p className="text-xs text-slate-400">
          Replies stay disabled until every check below passes, including your confirmation that caller audio is intelligible and agent audio is audible.
        </p>
      )}
      <ActionNote state={action} />
    </Card>
  );
}

function ReadinessCard() {
  const { state } = useAi();
  if (!state) return null;
  const { readiness } = state;
  const summary = summarizeReadiness(readiness);
  return (
    <Card
      title="Readiness"
      subtitle={summary.detail}
      actions={<Badge tone={summary.tone}>{summary.label}</Badge>}
    >
      <ul className="divide-y divide-slate-800/80 border border-slate-800/80 rounded-lg overflow-hidden">
        {checklist(readiness).map((row) => (
          <li key={row.name} className="flex items-start gap-3 px-3 py-2 bg-slate-950/40">
            <Badge tone={row.status === 'pass' ? 'good' : row.status === 'fail' ? 'bad' : 'warn'}>
              {row.status === 'pass' ? 'pass' : row.status === 'fail' ? 'fail' : 'unverified'}
            </Badge>
            <div className="min-w-0">
              <p className="text-xs text-slate-200">
                {CHECK_LABELS[row.name] ?? row.name}
                <span className="ml-2 text-[10px] text-slate-500 font-mono">{row.needed === 'passive' ? 'needed to transcribe' : 'needed to reply'}</span>
              </p>
              <p className="text-[11px] text-slate-500 font-mono break-words">{row.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      {readiness.checks.some((c) => c.name === 'inbound-wire' && c.status !== 'pass') && (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Caller audio starts only after the modem’s USB audio is activated for the call. This page never sends that command (it changes the modem’s PCM registration); use the documented activate step in docs/WINDOWS_HARDWARE_INTEGRATION.md, then watch this check turn to pass.
        </p>
      )}
    </Card>
  );
}

function AttestationCard({ kind }: { kind: 'inbound' | 'outbound' }) {
  const { state, refresh } = useAi();
  const [note, setNote] = useState('');
  const [action, run] = useAction();
  if (!state) return null;
  const view = state.settings.attestations[kind];
  const inbound = kind === 'inbound';
  const title = inbound ? 'Caller audio is intelligible' : 'Agent audio is audible to the caller';
  const how = inbound
    ? 'Confirm only after a real call, in passive mode, produced a live transcript in the inspector that matched what the caller actually said. Bytes arriving, or a transcript of a saved file, is not enough.'
    : 'Confirm only after a remote party on a real call clearly heard a blind test tone written to the USB audio port. A generated preview in this browser proves nothing about the phone line.';
  return (
    <Card title={title} actions={<Badge tone={view.confirmed ? 'good' : 'warn'}>{view.confirmed ? `Confirmed (${view.source})` : 'Not confirmed'}</Badge>}>
      <p className="text-xs text-slate-400 leading-relaxed">{how}</p>
      {view.confirmed ? (
        <div className="space-y-2">
          {view.note && <p className="text-xs text-slate-300 font-mono">“{view.note}”</p>}
          {view.source === 'stored' && (
            <Button
              onClick={async () => {
                await run(() => apiClient.revokeAiAttestation(kind), 'Confirmation removed');
                await refresh();
              }}
            >
              Remove confirmation
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Field label="What you verified (kept with the confirmation)">
            <TextArea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={inbound ? 'e.g. Call at 14:05: transcript read “what time do you open” and that is what I said' : 'e.g. Call at 14:20: the other phone heard two tones clearly'}
              className="min-h-[70px]"
            />
          </Field>
          <Button
            variant="primary"
            disabled={note.trim().length < 10}
            onClick={async () => {
              const ok = await run(() => apiClient.attestAiAudio(kind, note.trim()), 'Confirmation saved');
              if (ok) setNote('');
              await refresh();
            }}
          >
            <ShieldCheck className="w-3.5 h-3.5" /> I verified this
          </Button>
        </div>
      )}
      <ActionNote state={action} />
    </Card>
  );
}

export function MeterCard({ session }: { session: AiSessionView }) {
  const health = describeAudioHealth(session.audio);
  const a = session.audio;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-300 font-mono">
          Call {session.callId.slice(0, 8)} · {session.mode}
          {session.isSimulated && ' · SIMULATED'}
        </p>
        <Badge tone={health.tone}>{health.tone === 'good' ? 'audio steady' : health.tone === 'warn' ? 'check audio' : 'no audio'}</Badge>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Audio received">{a.receivedSeconds.toFixed(1)} s</Tile>
        <Tile label="Submitted to STT">{a.submittedSeconds.toFixed(1)} s</Tile>
        <Tile label="Utterances">{a.utterances}</Tile>
        <Tile label="Last frame">{a.lastFrameAgoMs === null ? '—' : `${a.lastFrameAgoMs} ms ago`}</Tile>
        <Tile label="RMS (1 s)">{formatDb(a.rms)}</Tile>
        <Tile label="Peak (1 s)">{formatDb(a.peak)}</Tile>
        <Tile label="Longest gap (10 s)">{a.maxGapMs} ms</Tile>
        <Tile label="Silent for">{a.silentForMs === null ? '—' : `${(a.silentForMs / 1000).toFixed(1)} s`}</Tile>
        <Tile label="Observed rate">{a.observedSampleRate === null ? 'measuring…' : `${a.observedSampleRate} /s (assumed ${a.expectedSampleRate})`}</Tile>
      </div>
      <ul className="text-[11px] text-slate-400 list-disc pl-4 space-y-0.5">
        {health.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        <li>Frames arriving show the line is alive, not that anyone is speaking intelligibly.</li>
      </ul>
      {session.degraded && <p className="text-xs text-rose-300">The agent stopped after repeated provider failures; the call itself is untouched.</p>}
    </div>
  );
}

function SessionCard() {
  const { state, refresh } = useAi();
  const { activeCall } = useGateway();
  const [action, run] = useAction();
  // A call state change (pushed over the socket) changes what the gateway will allow, so re-read its AI status now
  // instead of waiting for the next poll.
  useEffect(() => {
    void refresh();
  }, [activeCall?.id, activeCall?.state, refresh]);
  if (!state) return null;
  const attached = state.sessions.some((s) => s.callId === activeCall?.id);
  const control = attachControlState(activeCall, state.readiness, attached);
  return (
    <Card
      title="Live session"
      subtitle="Attach the AI to the current call to watch it transcribe. Attaching never answers, dials or hangs up."
      actions={
        <AttachControl
          callId={activeCall?.id ?? null}
          callState={activeCall?.state ?? null}
          control={control}
          busy={action.status === 'running'}
          onAttach={async (id) => {
            await run(() => apiClient.armAiCall(id), 'AI attached to the call');
            await refresh();
          }}
          onDetach={async (id) => {
            await run(() => apiClient.disarmAiCall(id), 'AI detached from the call');
            await refresh();
          }}
        />
      }
    >
      {!control.visible && <p className="text-xs text-slate-500">{control.reason}</p>}
      {control.visible && !control.enabled && control.reason && (
        <p className="text-xs text-amber-300" role="status">
          {control.reason}
        </p>
      )}
      {state.sessions.map((s) => (
        <MeterCard key={s.callId} session={s} />
      ))}
      <ActionNote state={action} />
    </Card>
  );
}

function ProviderHealthCard() {
  const { state } = useAi();
  if (!state) return null;
  const used = state.credentials.filter((c) => c.requiredBySelection);
  return (
    <Card title="Provider health" subtitle="From the keys the current selection uses. Validate them on the API Keys tab.">
      {used.length === 0 && <p className="text-xs text-slate-500">No provider keys are required by the current selection.</p>}
      <ul className="space-y-2">
        {used.map((c) => {
          const b = credentialBadges(c);
          return (
            <li key={c.name} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-300 w-24">{c.provider}</span>
              <Badge tone={b.presence.tone}>{b.presence.label}</Badge>
              <Badge tone={b.check.tone}>{b.check.label}</Badge>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function OverviewTab() {
  const { state, error } = useAi();
  if (!state) return <p className="text-xs text-slate-500">{error ?? 'Loading…'}</p>;
  const u = state.usageToday;
  return (
    <div className="space-y-6">
      {state.readiness.simulatedHardware && (
        <div className="p-3 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-300 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>The gateway is using simulated (mock) hardware. Nothing done here can establish that real calls work, and the agent can never become ready.</p>
        </div>
      )}
      <ReadinessCard />
      <ModeControls />
      <SessionCard />
      <ConversationCard />
      <TestResponseCard />
      <RecordingCard />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <AttestationCard kind="inbound" />
        <AttestationCard kind="outbound" />
      </div>
      <ProviderHealthCard />
      <Card title="Today" subtitle={u.costNote}>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Tile label="Calls">{u.calls}</Tile>
          <Tile label="STT audio">{(u.sttSeconds / 60).toFixed(2)} min</Tile>
          <Tile label="LLM tokens">{(u.llmPromptTokens + u.llmCompletionTokens).toLocaleString()}</Tile>
          <Tile label="TTS characters">{u.ttsChars.toLocaleString()}</Tile>
          <Tile label="Estimated cost">{u.estimatedCostUsd === null ? 'n/a' : `$${u.estimatedCostUsd.toFixed(4)}`}</Tile>
        </div>
      </Card>
    </div>
  );
}
