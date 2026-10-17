'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { AiTurnLogEntry, AiUsageTotals } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { formatLatency } from '../../lib/ai-inspector';
import { useAi } from '../../lib/context/AiContext';
import { formatDate } from '../../lib/utils';
import { ActionNote, Badge, Button, Card, Select, Tile, Toggle, useAction } from './ui';

type Range = 'today' | '7d' | '30d' | 'all';

export function UsageTab() {
  const { state, refresh } = useAi();
  const [range, setRange] = useState<Range>('today');
  const [totals, setTotals] = useState<AiUsageTotals | null>(null);
  const [turns, setTurns] = useState<AiTurnLogEntry[]>([]);
  const [load, runLoad] = useAction();
  const [clearAction, runClear] = useAction();
  const [recAction, runRec] = useAction();
  const [confirmClear, setConfirmClear] = useState(false);

  const reload = useCallback(async () => {
    await runLoad(async () => {
      const [u, t] = await Promise.all([apiClient.getAiUsage(range), apiClient.listAiTurns(100)]);
      setTotals(u.totals);
      setTurns(t.turns);
      return true;
    }, 'Loaded');
  }, [range, runLoad]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="space-y-6">
      <Card
        title="Usage"
        subtitle={totals?.costNote ?? 'Usage recorded by this gateway.'}
        actions={
          <Select value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="Range">
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All recorded</option>
          </Select>
        }
      >
        {load.status === 'error' && <ActionNote state={load} />}
        {totals && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Calls with AI">{totals.calls}</Tile>
            <Tile label="Turns (failed)">
              {totals.turns} ({totals.failures})
            </Tile>
            <Tile label="STT minutes">{(totals.sttSeconds / 60).toFixed(2)}</Tile>
            <Tile label="LLM tokens in / out">
              {totals.llmPromptTokens.toLocaleString()} / {totals.llmCompletionTokens.toLocaleString()}
            </Tile>
            <Tile label="TTS characters">{totals.ttsChars.toLocaleString()}</Tile>
            <Tile label="Estimated cost">{totals.estimatedCostUsd === null ? 'n/a' : `$${totals.estimatedCostUsd.toFixed(4)}`}</Tile>
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          Counted from real provider requests only (including your tests). Offline mock runs are never counted. Costs are estimates from a price table, and “n/a” appears when any model used has no known price.
        </p>
      </Card>

      <Card
        title="Turn log"
        subtitle="One row per caller turn, newest first. Timings are in milliseconds. Words are stored only while transcript display is on."
        actions={
          confirmClear ? (
            <div className="flex gap-2">
              <Button
                variant="danger"
                onClick={async () => {
                  setConfirmClear(false);
                  await runClear(() => apiClient.clearAiTurns(), 'Turn log cleared');
                  await reload();
                }}
              >
                Delete all logs
              </Button>
              <Button onClick={() => setConfirmClear(false)}>Keep</Button>
            </div>
          ) : (
            <Button onClick={() => setConfirmClear(true)} disabled={turns.length === 0}>
              Clear logs…
            </Button>
          )
        }
      >
        <ActionNote state={clearAction} />
        {turns.length === 0 ? (
          <p className="text-xs text-slate-500">No turns recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[720px]">
              <thead>
                <tr className="text-[10px] uppercase font-mono text-slate-500 text-left">
                  {['When', 'Call', 'Result', 'STT', 'LLM 1st token', 'TTS 1st', 'Total', 'Words'].map((h) => (
                    <th key={h} className="py-1 pr-3 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {turns.map((t) => (
                  <tr key={t.id} className="align-top">
                    <td className="py-1.5 pr-3 font-mono text-slate-500 whitespace-nowrap">{formatDate(t.at)}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-400">{t.callId.startsWith('test:') ? `test ${t.callId.slice(5)}` : t.callId.slice(0, 8)}</td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={t.status === 'completed' ? 'good' : t.status === 'failed' ? 'bad' : 'warn'}>{t.reason ?? t.status}</Badge>
                    </td>
                    <td className="py-1.5 pr-3 font-mono">{formatLatency(t.sttMs)}</td>
                    <td className="py-1.5 pr-3 font-mono">{formatLatency(t.llmFirstTokenMs)}</td>
                    <td className="py-1.5 pr-3 font-mono">{formatLatency(t.ttsFirstMs)}</td>
                    <td className="py-1.5 pr-3 font-mono">{formatLatency(t.totalMs)}</td>
                    <td className="py-1.5 text-slate-300">
                      {t.transcript ? <span>“{t.transcript}”{t.reply && <span className="text-slate-500"> → “{t.reply}”</span>}</span> : <span className="text-slate-600">not stored</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-500">Logs older than 30 days are removed automatically when the gateway starts.</p>
      </Card>

      <Card title="Diagnostic recording" subtitle="Optional. Saves each utterance the AI hears as a WAV file in the gateway’s audio-dumps/ai-diagnostic folder so you can listen to what the speech-to-text received.">
        <Toggle
          checked={state?.settings.diagnosticRecording ?? false}
          onChange={async (v) => {
            await runRec(() => apiClient.saveAiSettings({ diagnosticRecording: v }), v ? 'Diagnostic recording is on' : 'Diagnostic recording is off');
            await refresh();
          }}
          label="Record what the AI hears (local files only)"
          hint="Off by default. Files stay on the gateway machine, are capped at 60 s each and 50 files total (oldest deleted), and contain the caller’s voice: enable only with a lawful basis, and delete them when finished. Takes effect from the next call."
        />
        <ActionNote state={recAction} />
      </Card>
    </div>
  );
}
