'use client';

import { keyEnvFor } from '../../lib/ai-keys';
import React, { useEffect, useState } from 'react';
import type { AiTurnLogEntry } from '@sim-gateway/shared';
import { AiLlmTestResult, apiClient } from '../../lib/api-client';
import { formatLatency } from '../../lib/ai-inspector';
import { credentialBadges } from '../../lib/ai-secrets';
import { ActionNote, Badge, Button, Card, Field, SaveBar, Select, Tile, TextArea, TextInput, useAction } from './ui';
import { useSettingsDraft } from './useSettingsDraft';

const average = (values: Array<number | null>): number | null => {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};

/**
 * The language model dropdown. Its options are exactly the gateway's catalog (which is built from the model registry): there is no
 * list of models in the dashboard. A model that cannot run is listed but cannot be chosen.
 */
export function LlmModelSelect({ catalog, value, onChange }: { catalog: { llm: Array<{ key: string; label: string; model: string | null; implemented: boolean; unavailableReason?: string | null }> }; value: string; onChange: (key: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Language model">
      {catalog.llm.map((o) => (
        <option key={o.key} value={o.key} disabled={!o.implemented} title={o.unavailableReason ?? undefined}>
          {o.label} · {o.model}
          {o.implemented ? '' : o.unavailableReason ? ` (${o.unavailableReason.toLowerCase()})` : ' (not ported yet)'}
        </option>
      ))}
    </Select>
  );
}

function TextTest() {
  const [prompt, setPrompt] = useState('Hi, what are your opening hours?');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AiLlmTestResult | null>(null);
  const [action, run] = useAction();
  return (
    <Card
      title="Test the language model (text only)"
      subtitle="Sends one typed message to the selected model with your agent instructions. No call, no audio, no speech synthesis: nothing reaches a caller."
    >
      <Field label="Message (up to 500 characters)">
        <TextArea value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} className="min-h-[70px]" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button
              variant="primary"
              busy={action.status === 'running'}
              onClick={async () => {
                setConfirming(false);
                const r = await run(() => apiClient.testAiLlm(prompt.trim()), 'Model replied');
                if (r) setResult(r);
              }}
            >
              Send to provider (may be billed)
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={prompt.trim().length === 0}>
            Run text test…
          </Button>
        )}
      </div>
      <ActionNote state={action} />
      {result && (
        <div className="space-y-3">
          <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
            <p className="text-[10px] uppercase font-mono text-slate-500 mb-1">
              Reply from {result.model}
              {result.mock ? ' (offline mock provider)' : ''}
            </p>
            <p className="text-sm text-slate-100 whitespace-pre-wrap">{result.reply || '(empty reply)'}</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="First token">{formatLatency(result.firstTokenMs)}</Tile>
            <Tile label="Total">{formatLatency(result.totalMs)}</Tile>
            <Tile label="Tokens in / out">
              {result.usage ? `${result.usage.promptTokens} / ${result.usage.completionTokens}` : 'not reported'}
            </Tile>
            <Tile label="Estimated cost">{result.estimatedCostUsd === null ? 'n/a' : `$${result.estimatedCostUsd.toFixed(6)}`}</Tile>
          </div>
        </div>
      )}
    </Card>
  );
}

export function LlmTab() {
  const { draft, setDraft, dirty, problems, action, save, cancel, catalog, state } = useSettingsDraft();
  const [turns, setTurns] = useState<AiTurnLogEntry[]>([]);
  useEffect(() => {
    apiClient
      .listAiTurns(50)
      .then((r) => setTurns(r.turns.filter((t) => t.llmFirstTokenMs !== null)))
      .catch(() => setTurns([]));
  }, [state?.usageToday.turns]);

  if (!draft || !catalog || !state) return <p className="text-xs text-slate-500">Loading…</p>;
  const option = catalog.llm.find((o) => o.key === draft.llm);
  const keyName = keyEnvFor(option);
  const key = state.credentials.find((c) => c.name === keyName);
  const badges = key ? credentialBadges(key) : null;
  const u = state.usageToday;
  const fixed = Object.entries(option?.fixedParams ?? {});

  return (
    <div className="space-y-6">
      <Card title="Language model" subtitle="Which model writes the agent's replies. One conversation per call; no history is shared between calls.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Model" hint={option?.priceNote ?? undefined}>
            <LlmModelSelect catalog={catalog} value={draft.llm} onChange={(llm) => setDraft({ ...draft, llm })} />
          </Field>
          <Field label="Max reply tokens (empty = provider default)" hint="The only model parameter you can change. Replies are also capped by length below.">
            <TextInput
              inputMode="numeric"
              placeholder="provider default"
              value={draft.params.maxTokens ?? ''}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, maxTokens: e.target.value === '' ? null : Number(e.target.value) } })}
            />
          </Field>
          <Field label="Max reply length (characters)">
            <TextInput
              inputMode="numeric"
              value={draft.params.maxResponseChars}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, maxResponseChars: Number(e.target.value) || 0 } })}
            />
          </Field>
          <Field label="First-token timeout (ms)">
            <TextInput
              inputMode="numeric"
              value={draft.params.llmFirstTokenTimeoutMs}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, llmFirstTokenTimeoutMs: Number(e.target.value) || 0 } })}
            />
          </Field>
          <Field label="Total reply timeout (ms)">
            <TextInput
              inputMode="numeric"
              value={draft.params.llmTotalTimeoutMs}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, llmTotalTimeoutMs: Number(e.target.value) || 0 } })}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-[10px] uppercase font-mono text-slate-500">Set by the gateway for this model (not editable)</p>
          {fixed.length === 0 ? (
            <p className="text-xs text-slate-500">None.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {fixed.map(([k, v]) => (
                <Badge key={k}>
                  {k}={String(v)}
                </Badge>
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-500">Other parameters (temperature, top-p, …) are deliberately not exposed: this gateway does not send them from the dashboard.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          API key:
          {badges && (
            <>
              <Badge tone={badges.presence.tone}>{badges.presence.label}</Badge>
              <Badge tone={badges.check.tone}>{badges.check.label}</Badge>
            </>
          )}
        </div>
        <p className="text-[11px] text-slate-500">
          The system prompt is your agent instructions plus the gateway’s built-in voice-call rules; edit it on the Agent tab.
        </p>
        <SaveBar dirty={dirty} problems={problems} action={action} onSave={save} onCancel={cancel} />
      </Card>

      <Card title="Latency, tokens and cost" subtitle={u.costNote}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Avg first token (recent)">{formatLatency(average(turns.map((t) => t.llmFirstTokenMs)))}</Tile>
          <Tile label="Avg total turn (recent)">{formatLatency(average(turns.map((t) => t.totalMs)))}</Tile>
          <Tile label="Tokens in / out today">
            {u.llmPromptTokens.toLocaleString()} / {u.llmCompletionTokens.toLocaleString()}
          </Tile>
          <Tile label="Estimated cost today">{u.estimatedCostUsd === null ? 'n/a' : `$${u.estimatedCostUsd.toFixed(4)}`}</Tile>
        </div>
        <p className="text-[11px] text-slate-500">Token counts are what the provider reports; cost is shown as n/a whenever a used model has no known price.</p>
      </Card>

      <TextTest />
    </div>
  );
}
