'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { AiStateResponse, apiClient } from '../../lib/api-client';
import { summarizeReadiness } from '../../lib/ai-readiness';
import { credentialBadges } from '../../lib/ai-secrets';
import { Badge } from '../ai/ui';

/** Overview-page summary of the AI agent. Read-only; everything is managed on the AI Agent page. */
export function AiStatusCard() {
  const [state, setState] = useState<AiStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiClient
        .getAiState()
        .then((s) => alive && (setState(s), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const summary = summarizeReadiness(state?.readiness ?? null);
  const used = state?.credentials.filter((c) => c.requiredBySelection) ?? [];

  return (
    <div className="bg-surface border border-slate-800 rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Bot className="w-4 h-4 text-cyan-400" /> AI agent
        </h2>
        <Badge tone={error ? 'bad' : summary.tone}>{error ? 'unavailable' : summary.label}</Badge>
      </div>
      {error ? (
        <p className="text-xs text-rose-300 font-mono break-words">{error}</p>
      ) : (
        <>
          <p className="text-xs text-slate-400">{summary.detail}</p>
          {state && (
            <dl className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
              <div>
                <dt className="text-slate-500">Mode</dt>
                <dd className="text-slate-200">{state.readiness.mode}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Sessions</dt>
                <dd className="text-slate-200">{state.sessions.length}</dd>
              </div>
              <div>
                <dt className="text-slate-500">STT / LLM / TTS</dt>
                <dd className="text-slate-200 break-words">
                  {state.settings.stt} / {state.settings.llm} / {state.settings.tts}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Failed turns today</dt>
                <dd className="text-slate-200">{state.usageToday.failures}</dd>
              </div>
            </dl>
          )}
          {used.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {used.map((c) => {
                const b = credentialBadges(c);
                return (
                  <Badge key={c.name} tone={b.presence.tone === 'good' ? b.check.tone === 'bad' || b.check.tone === 'warn' ? b.check.tone : 'good' : b.presence.tone}>
                    {c.provider}
                  </Badge>
                );
              })}
            </div>
          )}
        </>
      )}
      <Link href="/ai" className="inline-block text-xs text-cyan-400 hover:text-cyan-300">
        Open AI control center →
      </Link>
    </div>
  );
}
