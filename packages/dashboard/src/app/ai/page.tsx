'use client';

import React, { useState } from 'react';
import { AiProvider, useAi } from '../../lib/context/AiContext';
import { summarizeReadiness } from '../../lib/ai-readiness';
import { AgentTab } from '../../components/ai/AgentTab';
import { IntegrationsTab } from '../../components/ai/IntegrationsTab';
import { InspectorTab } from '../../components/ai/InspectorTab';
import { KeysTab } from '../../components/ai/KeysTab';
import { LlmTab } from '../../components/ai/LlmTab';
import { ModelHubTab } from '../../components/ai/ModelHubTab';
import { OverviewTab } from '../../components/ai/OverviewTab';
import { SttTab } from '../../components/ai/SttTab';
import { TtsTab } from '../../components/ai/TtsTab';
import { UsageTab } from '../../components/ai/UsageTab';
import { Badge } from '../../components/ai/ui';
import { AlertCircle } from 'lucide-react';

const TABS = [
  { id: 'overview', label: 'Overview', Component: OverviewTab },
  { id: 'inspector', label: 'Live Inspector', Component: InspectorTab },
  { id: 'stt', label: 'Speech-to-Text', Component: SttTab },
  { id: 'llm', label: 'Language Model', Component: LlmTab },
  { id: 'tts', label: 'Text-to-Speech', Component: TtsTab },
  { id: 'hub', label: 'Model Hub', Component: ModelHubTab },
  { id: 'agent', label: 'Agent', Component: AgentTab },
  { id: 'integrations', label: 'Integrations', Component: IntegrationsTab },
  { id: 'keys', label: 'API Keys', Component: KeysTab },
  { id: 'usage', label: 'Usage & Logs', Component: UsageTab },
] as const;

function AiControlCenter() {
  const { state, error } = useAi();
  const [active, setActive] = useState<(typeof TABS)[number]['id']>('overview');
  const summary = summarizeReadiness(state?.readiness ?? null);
  const Current = TABS.find((t) => t.id === active)!.Component;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800/80 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">AI Calling Control Center</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Configure providers, watch each call move through the pipeline, and decide when the agent may speak.
          </p>
        </div>
        <Badge tone={summary.tone}>{summary.label}</Badge>
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs font-mono flex items-center gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          <span>
            <span className="font-semibold">Gateway AI API: </span>
            {error}
          </span>
        </div>
      )}

      <div role="tablist" aria-label="AI control center sections" className="flex flex-wrap gap-1 border-b border-slate-800">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`ai-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`ai-panel-${tab.id}`}
            onClick={() => setActive(tab.id)}
            className={`px-3 py-2 text-xs font-medium rounded-t-md transition ${
              active === tab.id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/80'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`ai-panel-${active}`} aria-labelledby={`ai-tab-${active}`}>
        <Current />
      </div>
    </div>
  );
}

export default function AiPage() {
  return (
    <AiProvider>
      <AiControlCenter />
    </AiProvider>
  );
}
