'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiClient } from '../../lib/api-client';
import { formatDate, formatDuration } from '../../lib/utils';
import { breakdownRows, CallDetail, ms, pickLabel, playbackNote, responseCodes, statusLabel, statusTone, TimelineRow, timelineRows, TurnTrace } from '../../lib/observability';
import { Badge, Button, Card, Label, Tile } from '../ai/ui';

function TimelineTable({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) return <p className="text-xs text-slate-500">No events were recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-800">
            <th className="py-1 pr-3">+ms</th>
            <th className="py-1 pr-3">Time (UTC)</th>
            <th className="py-1 pr-3">Event</th>
            <th className="py-1 pr-3">Result</th>
            <th className="py-1 pr-3">Took</th>
            <th className="py-1 pr-3">Provider</th>
            <th className="py-1 pr-3">HTTP</th>
            <th className="py-1">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-slate-800/50 align-top">
              <td className="py-1 pr-3 text-slate-400">{r.offsetMs}</td>
              <td className="py-1 pr-3 text-slate-500">{r.at.slice(11, 23)}</td>
              <td className="py-1 pr-3 text-slate-200">{r.label}</td>
              <td className="py-1 pr-3">
                <Badge tone={statusTone(r.status === 'ok' ? 'completed' : r.status)}>{r.status}</Badge>
                {r.retry && <span className="ml-1 text-amber-400">retry</span>}
              </td>
              <td className="py-1 pr-3 text-slate-300">{ms(r.latencyMs)}</td>
              <td className="py-1 pr-3 text-slate-400">{r.provider ?? '—'}</td>
              <td className="py-1 pr-3 text-slate-400">{r.httpStatus ?? '—'}</td>
              <td className="py-1 text-slate-400 break-words max-w-[28rem]">{r.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Diagnostics({ turn }: { turn: TurnTrace }) {
  const failed = turn.status === 'failed' || turn.status === 'unfinished' || turn.failingStage !== null;
  const codes = responseCodes(turn.events);
  const timeouts = turn.events.filter((e) => e.stage === 'provider-attempt' && e.data?.outcome === 'timeout').length;
  if (!failed && turn.retries === 0 && codes.length === 0) return null;
  return (
    <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-3 space-y-1 text-xs" data-testid="diagnostics">
      <Label>Failure diagnostics</Label>
      <div className="text-slate-200">
        Failing stage: <span className="font-mono">{turn.failingStage ?? (turn.status === 'unfinished' ? 'unknown (the turn never finished)' : 'none (recovered)')}</span>
        {turn.reason && <span className="text-slate-400"> · reason {turn.reason}</span>}
      </div>
      {turn.failureDetail && <div className="text-slate-300 font-mono break-words">{turn.failureDetail}</div>}
      <div className="text-slate-400">
        Retries: {turn.retries} · Timeouts: {timeouts} · Provider response codes: {codes.length > 0 ? codes.join(', ') : 'none recorded'}
      </div>
      <p className="text-[11px] text-slate-500">Messages are redacted; keys and headers are never stored.</p>
    </div>
  );
}

/** What the caller said and what the agent answered, exactly as stored; absent text is said to be absent, never guessed. */
function TurnText({ turn }: { turn: TurnTrace }) {
  const none = <span className="text-slate-500 italic">not stored</span>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2" data-testid="turn-text">
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <Label>Caller said</Label>
        <p className="text-xs text-slate-200 whitespace-pre-wrap break-words">{turn.transcript ?? none}</p>
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <Label>Agent replied</Label>
        <p className="text-xs text-slate-200 whitespace-pre-wrap break-words">{turn.reply ?? none}</p>
      </div>
    </div>
  );
}

export function TurnCard({ turn }: { turn: TurnTrace }) {
  const [open, setOpen] = useState(turn.status !== 'completed');
  const rows = breakdownRows(turn.latency);
  return (
    <Card
      title={`Turn ${turn.index}`}
      subtitle={<span className="font-mono">{turn.turnId} · {formatDate(turn.at)}</span>}
      actions={<Badge tone={statusTone(turn.status)}>{statusLabel(turn.status)}</Badge>}
    >
      <TurnText turn={turn} />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2" data-testid="latency-breakdown">
        {rows.map((r) => (
          <Tile key={r.label} label={r.label}>
            <div>{r.value}</div>
            {r.note && <div className="text-[10px] text-slate-500 font-sans mt-0.5">{r.note}</div>}
          </Tile>
        ))}
      </div>
      <div className="text-[11px] text-slate-500 font-mono">
        Caller speech {ms(turn.latency.utteranceMs)} · endpoint wait {ms(turn.latency.endpointMs)} · TTS synthesis (summed over sentences) {ms(turn.latency.ttsTotalMs)} · playback {ms(turn.latency.playMs)} · whole turn {ms(turn.latency.turnMs)}
      </div>
      <div className="text-[11px] text-slate-500 font-mono" data-testid="playback-note">
        {turn.status === 'cancelled' && <span className="text-amber-400">Cancelled by {turn.cancelSource ?? 'unknown'} · not counted as a response time · </span>}
        {playbackNote(turn.latency)}
      </div>
      <Diagnostics turn={turn} />
      <div>
        <Button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} events ({turn.events.length})</Button>
      </div>
      {open && <TimelineTable rows={timelineRows(turn.events)} />}
    </Card>
  );
}

export function CallErrors({ errors }: { errors: CallDetail['errors'] }) {
  if (errors.length === 0) return null;
  return (
    <Card title={`Errors (${errors.length})`} subtitle="Every failed stage and failed provider request of this call, oldest first.">
      <ul className="space-y-1 text-[11px] font-mono" data-testid="call-errors">
        {errors.map((e, i) => (
          <li key={i} className="text-rose-200">
            {e.at.slice(11, 23)} · {e.turnId ?? 'call'} · {e.stage}
            {e.provider ? ` · ${e.provider}` : ''}
            {e.httpStatus !== null ? ` · HTTP ${e.httpStatus}` : ''}
            {e.attempt ? ` · attempt ${e.attempt}` : ''}
            {e.detail ? ` · ${e.detail}` : ''}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The whole of one call. Mounted with key={callId}, so switching calls starts from a clean state and a stale answer cannot leak in. */
export function CallDetailPanel({ callId, onClose }: { callId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    apiClient
      .getObservabilityCall(callId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load the call');
      });
    return () => {
      alive = false;
    };
  }, [callId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // Defence in depth: never show a body that is not for the call that was asked for.
  const shown = detail && detail.call.id === callId ? detail : null;
  const anyText = shown?.turns.some((t) => t.transcript !== null || t.reply !== null) ?? false;

  return (
    <Card title="Call detail" subtitle={<span className="font-mono break-all">{callId}</span>} actions={<Button onClick={onClose}>Close</Button>}>
      {error && (
        <div className="space-y-2" role="alert" data-testid="detail-error">
          <p className="text-xs text-rose-300">{error}</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      )}
      {!error && !shown && <p className="text-xs text-slate-400" data-testid="detail-loading">Loading this call…</p>}
      {shown && (
        <div className="space-y-4" data-testid="detail-body">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Tile label="Status">
              <Badge tone={statusTone(shown.call.status)}>{statusLabel(shown.call.status)}</Badge>
              {shown.call.simulated && <span className="ml-1 text-amber-400 text-[10px]">simulated</span>}
            </Tile>
            <Tile label="Direction / duration">
              {shown.call.direction} · {formatDuration(shown.call.durationSeconds)}
            </Tile>
            <Tile label="Started">{formatDate(shown.call.startedAt)}</Tile>
            <Tile label="Termination">{shown.call.terminationReason ?? '—'}</Tile>
            <Tile label="STT">{pickLabel(shown.selection.stt)}</Tile>
            <Tile label="LLM">{pickLabel(shown.selection.llm)}</Tile>
            <Tile label="TTS">{pickLabel(shown.selection.tts)}</Tile>
            <Tile label="First caller audio">{shown.firstAudioReceivedAt ? shown.firstAudioReceivedAt.slice(11, 23) + ' UTC' : '—'}</Tile>
          </div>
          {shown.call.campaign && (
            <p className="text-xs text-slate-300" data-testid="campaign-link">
              Placed by a campaign (attempt {shown.call.campaign.attempt ?? '?'}).{' '}
              <Link className="text-cyan-400 hover:underline" href={`/campaigns/${shown.call.campaign.campaignId}`}>
                Open the campaign
              </Link>
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            {shown.totals.turns} turn(s), {shown.totals.failedTurns} failed, {shown.totals.cancelledTurns} cancelled, {shown.totals.events} recorded events.
          </p>
          <CallErrors errors={shown.errors} />
          {shown.turns.length === 0 && (
            <p className="text-xs text-slate-400" data-testid="no-turns">
              No AI turns were recorded for this call (the AI was not attached, or the caller never spoke).
            </p>
          )}
          {shown.turns.length > 0 && !anyText && (
            <p className="text-[11px] text-amber-300/80" data-testid="text-hint">
              What was said is not stored. Turn on “show transcripts” (AI &gt; Inspector) to keep caller text and replies for future calls.
            </p>
          )}
          {shown.turns.map((t) => (
            <TurnCard key={t.turnId} turn={t} />
          ))}
          <Card title="Call-level events" subtitle="AI attach/detach, mode changes, and the call's state changes.">
            <TimelineTable rows={timelineRows(shown.callEvents)} />
            {shown.lifecycle.length > 0 && (
              <ul className="text-[11px] font-mono text-slate-400 space-y-0.5">
                {shown.lifecycle.map((l, i) => (
                  <li key={i}>
                    {l.at.slice(11, 23)} · {l.type}
                    {l.from || l.to ? ` · ${l.from ?? '—'} → ${l.to ?? '—'}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Card>
  );
}
