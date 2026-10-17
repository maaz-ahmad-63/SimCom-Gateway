'use client';

import React from 'react';
import { apiClient } from '../../lib/api-client';
import {
  formatLatency,
  INSPECTOR_STAGES,
  OUTCOME_LABELS,
  STAGE_LABELS,
  StageViewStatus,
  TurnOutcome,
  TurnView,
  turnSpanMs,
} from '../../lib/ai-inspector';
import type { Tone } from '../../lib/ai-secrets';
import { useAi } from '../../lib/context/AiContext';
import { formatTimeOnly } from '../../lib/utils';
import { ActionNote, Badge, Button, Card, Toggle, useAction } from './ui';

const STATUS_TONE: Record<StageViewStatus, Tone> = {
  ok: 'good',
  failed: 'bad',
  skipped: 'warn',
  cancelled: 'warn',
  'not-run': 'neutral',
  pending: 'neutral',
};
const STATUS_LABEL: Record<StageViewStatus, string> = {
  ok: 'ok',
  failed: 'FAILED',
  skipped: 'skipped',
  cancelled: 'cancelled',
  'not-run': 'not run',
  pending: 'waiting',
};
const OUTCOME_TONE: Record<TurnOutcome, Tone> = {
  running: 'neutral',
  completed: 'good',
  passive: 'good',
  failed: 'bad',
  skipped: 'warn',
  cancelled: 'warn',
};

function dataLine(data: Record<string, number | string | boolean | null> | null): string {
  if (!data) return '';
  return Object.entries(data)
    .filter(([k]) => k !== 'textHidden')
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
}

export function TurnCard({ turn }: { turn: TurnView }) {
  const span = turnSpanMs(turn);
  return (
    <article className="bg-slate-950/50 border border-slate-800 rounded-lg p-4 space-y-3" aria-label={`Turn ${turn.turnId}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-mono text-slate-300">
          {formatTimeOnly(turn.startedAt)} · call {turn.callId.slice(0, 8)} · {turn.turnId.split(':').pop()}
          {span !== null && <span className="text-slate-500"> · {formatLatency(span)} end to end</span>}
        </p>
        <Badge tone={OUTCOME_TONE[turn.outcome]}>{OUTCOME_LABELS[turn.outcome]}</Badge>
      </header>

      {turn.failure && (
        <div role="alert" className="text-xs rounded-md border border-rose-800/70 bg-rose-950/50 text-rose-200 px-3 py-2">
          <strong>{STAGE_LABELS[turn.failure.stage]} failed:</strong> <span className="font-mono">{turn.failure.detail}</span>
        </div>
      )}

      {(turn.callerText !== null || turn.agentText.length > 0) && (
        <div className="space-y-1 text-xs">
          {turn.callerText !== null && (
            <p>
              <span className="text-slate-500 font-mono">Caller: </span>
              <span className="text-slate-100">{turn.callerText}</span>
            </p>
          )}
          {turn.agentText.map((t, i) => (
            <p key={i}>
              <span className="text-slate-500 font-mono">Agent (generated): </span>
              <span className="text-slate-100">{t}</span>
            </p>
          ))}
        </div>
      )}
      {turn.textHidden && turn.callerText === null && (
        <p className="text-[11px] text-slate-500">Recognized words are hidden because transcript display is off.</p>
      )}

      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase font-mono text-slate-500 text-left">
            <th className="py-1 pr-2 font-normal">Stage</th>
            <th className="py-1 pr-2 font-normal">Status</th>
            <th className="py-1 pr-2 font-normal">Time</th>
            <th className="py-1 pr-2 font-normal">Latency</th>
            <th className="py-1 font-normal">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {INSPECTOR_STAGES.map((stage) => {
            const s = turn.stages[stage];
            return (
              <tr key={stage} className="align-top">
                <td className="py-1.5 pr-2 text-slate-300 whitespace-nowrap">{STAGE_LABELS[stage]}</td>
                <td className="py-1.5 pr-2">
                  <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                </td>
                <td className="py-1.5 pr-2 font-mono text-slate-500 whitespace-nowrap">{formatTimeOnly(s.at)}</td>
                <td className="py-1.5 pr-2 font-mono text-slate-300 whitespace-nowrap">{formatLatency(s.latencyMs)}</td>
                <td className="py-1.5 font-mono text-[11px] text-slate-400 break-words">
                  {s.detail}
                  {s.detail && s.data ? ' · ' : ''}
                  {dataLine(s.data)}
                  {s.count > 1 && <span className="text-slate-600"> · ×{s.count}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}

export function InspectorTab() {
  const { state, inspector, clearInspector, refresh } = useAi();
  const [action, run] = useAction();
  const turns = [...inspector.turns].reverse();
  const showing = state?.settings.showTranscripts ?? false;

  return (
    <div className="space-y-6">
      <Card
        title="Live call inspector"
        subtitle="Every stage of each caller turn, with its own timestamp, latency and outcome. A stage that fails is reported as failed and later stages show as not run; nothing is filled in for you."
        actions={<Button onClick={clearInspector}>Clear view</Button>}
      >
        <Toggle
          checked={showing}
          onChange={async (v) => {
            await run(() => apiClient.saveAiSettings({ showTranscripts: v }), v ? 'Transcript text is now shown' : 'Transcript text is now hidden');
            await refresh();
          }}
          label="Show recognized and generated text"
          hint="Off by default for caller privacy. When on, words are also kept in the turn log until you clear it. Takes effect from the next call."
        />
        <ActionNote state={action} />
        <ul className="text-[11px] text-slate-500 list-disc pl-4 space-y-0.5">
          <li>Speech-to-text here is batch: one request per finished utterance, so there are no partial words while the caller is still speaking.</li>
          <li>“TTS generated” means audio was produced. Only “Playback to caller” says it was written to the phone line, and even that does not prove the caller heard it.</li>
        </ul>
      </Card>

      {inspector.markers.length > 0 && (
        <Card title="Call events">
          <ul className="space-y-1 text-xs font-mono text-slate-400">
            {inspector.markers.slice(-8).reverse().map((m) => (
              <li key={m.seq}>
                {formatTimeOnly(m.timestamp)} · {m.callId.slice(0, 8)} · {m.detail}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {turns.length === 0 ? (
        <Card>
          <p className="text-xs text-slate-500">
            No turns yet. Attach the AI to an active call (Overview tab), have the caller speak, and each utterance will appear here as it moves through the pipeline.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {turns.map((t) => (
            <TurnCard key={t.turnId} turn={t} />
          ))}
        </div>
      )}
    </div>
  );
}
