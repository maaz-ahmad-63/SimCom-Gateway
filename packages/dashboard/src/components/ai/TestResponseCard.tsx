'use client';

import React, { useState } from 'react';
import { Volume2 } from 'lucide-react';
import type { AiTestResponseReadiness, AiTestResponseResult } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { formatLatency } from '../../lib/ai-inspector';
import { testResponseRows } from '../../lib/ai-readiness';
import { useAi } from '../../lib/context/AiContext';
import { useGateway } from '../../lib/context/GatewayContext';
import { ActionNote, Badge, Button, Card, useAction } from './ui';

const TONE = { ok: 'good', failed: 'bad', cancelled: 'warn', 'not-run': 'neutral' } as const;

/** Presentational: readiness, the two-step confirmation, and the four separate stage results. */
export function TestResponsePanel({
  readiness,
  result,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  readiness: AiTestResponseReadiness;
  result: AiTestResponseResult | null;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-4">
      {!readiness.allowed && (
        <ul className="text-xs text-amber-300 list-disc pl-4 space-y-0.5" aria-label="Why the test is unavailable">
          {readiness.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {readiness.allowed && (
        <p className="text-xs text-slate-400">
          Answers the caller’s latest words (heard {readiness.transcriptAgeSeconds ?? '?'} s ago) once, in {readiness.format}. Nothing else is sent, and the agent stays passive.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button variant="danger" onClick={onConfirm} busy={busy}>
              Yes: speak one reply to the remote party now
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        ) : (
          <Button variant="primary" onClick={onAsk} disabled={!readiness.allowed || busy} busy={busy} title={readiness.allowed ? undefined : readiness.blockers[0]}>
            <Volume2 className="w-3.5 h-3.5" /> Generate &amp; Play Test Response
          </Button>
        )}
      </div>
      {confirming && (
        <p className="text-xs text-rose-200">
          This sends the caller’s transcript to your language-model provider, then plays the generated voice to the person on the call. Both are billed. It happens once.
        </p>
      )}
      {result && (
        <div className="space-y-2" aria-label="Test response result">
          <ul className="divide-y divide-slate-800/80 border border-slate-800/80 rounded-lg overflow-hidden">
            {testResponseRows(result).map((row) => (
              <li key={row.key} className="flex flex-wrap items-start gap-3 px-3 py-2 bg-slate-950/40">
                <Badge tone={TONE[row.status]}>{row.status === 'not-run' ? 'not run' : row.status}</Badge>
                <div className="min-w-0">
                  <p className="text-xs text-slate-200">
                    {row.label}
                    <span className="ml-2 text-[11px] font-mono text-slate-500">{formatLatency(row.ms)}</span>
                  </p>
                  {row.detail && <p className="text-[11px] text-slate-500 font-mono">{row.detail}</p>}
                  {row.error && <p className="text-[11px] text-rose-300 font-mono break-words">{row.error}</p>}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-300">
            Heard by the remote party: <strong>unknown</strong>. {result.note}
          </p>
          {result.mock && <p className="text-xs text-amber-300">Offline mock providers were used; this proves nothing about the phone line.</p>}
        </div>
      )}
    </div>
  );
}

export function TestResponseCard() {
  const { state, refresh } = useAi();
  const { activeCall } = useGateway();
  const [action, run] = useAction();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AiTestResponseResult | null>(null);
  if (!state || !activeCall || activeCall.state === 'IDLE') return null;
  const readiness = state.testResponse;
  const shown = result && result.callId === activeCall.id ? result : readiness.last;
  return (
    <Card
      title="One-shot test response"
      subtitle="Checks that the AI’s voice can travel to the other party. A single operator-triggered reply to the caller’s latest words: no conversation follows, and it does not enable replies or confirm anything for you."
    >
      <TestResponsePanel
        readiness={readiness}
        result={shown}
        busy={action.status === 'running'}
        confirming={confirming}
        onAsk={() => setConfirming(true)}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          const r = await run(() => apiClient.playAiTestResponse(activeCall.id), 'The gateway finished the test. Ask the other party what they heard.');
          if (r) setResult(r);
          await refresh();
        }}
      />
      <ActionNote state={action} />
    </Card>
  );
}
