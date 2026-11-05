'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { CampaignUsage, formatTokens, usageLines } from '../../lib/campaign-config';
import { Button, Card } from '../ai/ui';

/** Presentational, so it can be drawn and tested without a gateway. */
export function UsagePanel({ usage, error, onRefresh }: { usage: CampaignUsage | null; error: string | null; onRefresh: () => void }) {
  return (
    <Card
      title="Token usage"
      subtitle="What the language-model provider reported for this campaign's calls. Cached tokens are shown apart from ordinary input tokens, only where the provider reported them, and nothing here is an estimate of a saving."
      actions={<Button onClick={onRefresh}>Refresh</Button>}
    >
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      {!usage && !error && <p className="text-xs text-slate-400">Loading…</p>}
      {usage && (
        <>
          <ul className="space-y-1 text-xs text-slate-300" data-testid="usage-lines">
            {usageLines(usage.totals).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {usage.calls.length > 0 && (
            <div className="overflow-x-auto border border-slate-800 rounded-lg">
              <table className="w-full text-[11px] font-mono" data-testid="usage-calls">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="py-1.5 px-2">Contact</th>
                    <th className="py-1.5 px-2">Config</th>
                    <th className="py-1.5 px-2 text-right">Turns</th>
                    <th className="py-1.5 px-2 text-right">Input</th>
                    <th className="py-1.5 px-2 text-right">Cached input</th>
                    <th className="py-1.5 px-2 text-right">Output</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.calls.map((c) => (
                    <tr key={c.callId} className="border-b border-slate-800/50 text-slate-300">
                      <td className="py-1 px-2">{c.contactName || '—'}</td>
                      <td className="py-1 px-2">{c.configVersion ? `v${c.configVersion}` : '—'}</td>
                      <td className="py-1 px-2 text-right">{c.turns}</td>
                      <td className="py-1 px-2 text-right">{c.turnsWithUsage > 0 ? formatTokens(c.inputTokens) : '—'}</td>
                      <td className="py-1 px-2 text-right">{c.cachedInputTokens === null ? <span className="text-slate-500">not reported</span> : formatTokens(c.cachedInputTokens)}</td>
                      <td className="py-1 px-2 text-right">{c.turnsWithUsage > 0 ? formatTokens(c.outputTokens) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function UsageCard({ campaignId }: { campaignId: string }) {
  const [usage, setUsage] = useState<CampaignUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setUsage(await apiClient.getCampaignUsage(campaignId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the token usage');
    }
  }, [campaignId]);
  useEffect(() => {
    void load();
  }, [load]);
  return <UsagePanel usage={usage} error={error} onRefresh={() => void load()} />;
}
