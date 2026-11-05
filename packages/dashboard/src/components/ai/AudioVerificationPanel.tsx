'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import {
  AspectResult,
  ASPECTS,
  AudioVerificationResponse,
  CallAudioVerification,
  formatTime,
  latestEvidence,
  sourceLabel,
  STATUS_LABEL,
  STATUS_TONE,
  warningsOf,
} from '../../lib/audio-verification';
import { socketService } from '../../lib/socket-service';
import { ActionNote, Badge, Button, Card, useAction } from './ui';

/** Loads the gateway's verification state once, then follows the socket and refreshes now and then. */
export function useAudioVerification(pollMs = 15_000) {
  const [data, setData] = useState<AudioVerificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await apiClient.getAudioVerification(10));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), pollMs);
    // 'ai:audio-verification' is pushed by the gateway on every change of the call in progress.
    const off = (socketService.on as unknown as (e: string, l: (v: CallAudioVerification) => void) => () => void)('ai:audio-verification', (v) =>
      setData((d) => (d ? { ...d, current: v } : d))
    );
    return () => {
      clearInterval(t);
      off();
    };
  }, [load, pollMs]);
  return { data, error, reload: load };
}

export function AspectRow({ result, title, explains }: { result: AspectResult; title: string; explains: string }) {
  const warnings = warningsOf(result);
  return (
    <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/40 space-y-1.5" data-testid={`aspect-${result.aspect}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-100">{title}</p>
          <p className="text-[11px] text-slate-500">{explains}</p>
        </div>
        <Badge tone={STATUS_TONE[result.status]}>
          <span data-testid={`status-${result.aspect}`}>{STATUS_LABEL[result.status]}</span>
        </Badge>
      </div>
      <p className="text-xs text-slate-300" data-testid={`reason-${result.aspect}`}>
        {result.reason}
      </p>
      <p className="text-[11px] text-slate-500">
        Evidence: {sourceLabel(result.source)} · updated {formatTime(result.updatedAt)}
      </p>
      {warnings.length > 0 && (
        <p className="text-[11px] text-amber-300" role="status" data-testid={`warning-${result.aspect}`}>
          Warning: {warnings[warnings.length - 1].detail}
        </p>
      )}
      {result.evidence.length > 0 && (
        <details className="text-[11px] text-slate-400">
          <summary className="cursor-pointer">Evidence ({result.evidence.length})</summary>
          <ul className="mt-1 space-y-0.5 list-disc ml-4">
            {latestEvidence(result, 8).map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {formatTime(e.at)}: {e.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function AudioVerificationView({
  data,
  onToggle,
  onArmKeyTest,
  busy,
  note,
}: {
  data: AudioVerificationResponse;
  onToggle: (next: boolean) => void;
  onArmKeyTest?: (callId: string) => void;
  busy?: boolean;
  note?: React.ReactNode;
}) {
  const v = data.current;
  const live = v && !v.final;
  return (
    <Card
      title="Call Audio Verification"
      subtitle="Judged automatically from each call's own audio. Three separate results: a reply reaching the modem is not proof that the caller heard it."
      actions={<Badge tone={data.enabled ? 'good' : 'warn'}>{data.enabled ? 'Automatic' : 'Off'}</Badge>}
    >
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={data.enabled} disabled={busy} onChange={(e) => onToggle(e.target.checked)} aria-label="Verify call audio automatically" data-testid="auto-verify-toggle" />
        Verify call audio automatically
      </label>
      {!data.enabled && <p className="text-[11px] text-amber-300">Automatic verification is off: new calls are not judged, and the manual confirmations in Diagnostics are required again for replies.</p>}
      {v ? (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500" data-testid="verification-call">
            Call <span className="font-mono text-slate-300">{v.callId}</span>
            {v.direction ? ` (${v.direction})` : ''} · started {formatTime(v.startedAt)}
            {v.endedAt ? ` · ended ${formatTime(v.endedAt)}` : ' · in progress'}
            {v.simulated ? ' · simulated: nothing can be verified' : ''}
          </p>
          {ASPECTS.map((a) => (
            <AspectRow key={a.key} result={v[a.key]} title={a.title} explains={a.explains} />
          ))}
          {live && onArmKeyTest && (
            <div className="text-[11px] text-slate-400 space-y-1">
              <p>Diagnostic only: ask the caller to press 1 if they can hear the agent, then arm the test. It is never done automatically on normal calls.</p>
              <Button onClick={() => onArmKeyTest(v.callId)} busy={busy}>
                Arm key-press audibility test
              </Button>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-400" data-testid="verification-none">
          {data.enabled ? 'No call has been verified yet. Results appear here during the next call.' : 'No results.'}
        </p>
      )}
      {data.recent.length > 0 && (
        <details className="text-[11px] text-slate-400">
          <summary className="cursor-pointer">Recent calls ({data.recent.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {data.recent.map((r) => (
              <li key={r.callId} className="font-mono">
                {r.callId.slice(0, 8)} · {formatTime(r.startedAt)} · caller {STATUS_LABEL[r.inbound]} · transport {STATUS_LABEL[r.transport]} · audibility {STATUS_LABEL[r.audibility]}
              </li>
            ))}
          </ul>
        </details>
      )}
      {note}
    </Card>
  );
}

export function AudioVerificationPanel() {
  const { data, error, reload } = useAudioVerification();
  const [action, run] = useAction();
  if (!data) return <Card title="Call Audio Verification">{<p className="text-xs text-slate-500">{error ?? 'Loading…'}</p>}</Card>;
  return (
    <AudioVerificationView
      data={data}
      busy={action.status === 'running'}
      note={<ActionNote state={action} />}
      onToggle={(next) =>
        void run(async () => {
          await apiClient.saveAiSettings({ audioAutoVerify: next });
          await reload();
        }, next ? 'Automatic verification is on' : 'Automatic verification is off')
      }
      onArmKeyTest={(callId) =>
        void run(async () => {
          await apiClient.armAudibilityKeyTest(callId, '1');
          await reload();
        }, 'Test armed: waiting for the caller to press 1')
      }
    />
  );
}
