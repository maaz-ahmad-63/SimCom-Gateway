'use client';

import React, { useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { cachingSummary, configDirty, configPatch, ConfigDraft, draftFromConfig, LlmChoice, promptCounter, promptProblem, PROMPT_MAX_CHARS } from '../../lib/campaign-config';
import { Campaign } from '../../lib/campaigns';
import { ActionNote, ActionState, Badge, Button, Card, Field, Select, TextArea, useAction } from '../ai/ui';

export interface AgentConfigFormProps {
  campaign: Pick<Campaign, 'status' | 'config'>;
  draft: ConfigDraft;
  models: LlmChoice[] | null;
  modelsError: string | null;
  saveState: ActionState;
  onPrompt: (text: string) => void;
  onModel: (key: string | null) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** The editor itself, with no state of its own, so every state of it can be drawn and tested. */
export function AgentConfigForm(p: AgentConfigFormProps) {
  const counter = promptCounter(p.draft.prompt);
  const problem = promptProblem(p.draft.prompt);
  const dirty = configDirty(p.campaign.config, p.draft);
  const current = p.models?.find((m) => m.current);
  const selected = p.draft.llmKey ? p.models?.find((m) => m.key === p.draft.llmKey) : undefined;
  const selectedProblem = selected && !selected.available ? selected.unavailableReason : null;
  const version = p.campaign.config.version;

  return (
    <Card
      title="Campaign AI agent"
      subtitle="This campaign's own instructions and model. The prompt below is the only instruction the agent gets on this campaign's calls: it is not mixed with the gateway's outbound prompt, the default prompt or any other campaign. Each call is its own conversation, and sees only its own contact's information."
      actions={<Badge tone={version === 0 ? 'neutral' : 'good'}>{version === 0 ? 'no prompt saved' : `version ${version}`}</Badge>}
    >
      {version === 0 && (
        <p className="text-xs text-slate-400" data-testid="no-prompt-note">
          No prompt is saved, so this campaign's calls use the gateway's outbound agent (as before). Add a prompt to give this campaign its own agent.
        </p>
      )}
      <Field label="Campaign prompt" hint="Say who the agent is, why it is calling and how it should behave. It can be used for any purpose. Contact information (name, city, anything else in the CSV) is added for each call separately, so do not paste it here.">
        <TextArea
          value={p.draft.prompt}
          onChange={(e) => p.onPrompt(e.target.value)}
          rows={14}
          aria-label="Campaign prompt"
          aria-invalid={counter.over}
          aria-describedby="prompt-counter"
          placeholder="You are a friendly assistant calling on behalf of …"
          className={counter.over ? 'border-rose-700' : ''}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span id="prompt-counter" data-testid="prompt-counter" className={`font-mono ${counter.over ? 'text-rose-300' : counter.remaining < 500 ? 'text-amber-300' : 'text-slate-400'}`}>
          {counter.used.toLocaleString('en-US')} / {PROMPT_MAX_CHARS.toLocaleString('en-US')} characters
        </span>
        {problem && (
          <span role="alert" className="text-rose-300">
            {problem}
          </span>
        )}
      </div>

      <Field label="Language model for this campaign" hint={cachingSummary(selected ?? current)}>
        <Select value={p.draft.llmKey ?? ''} onChange={(e) => p.onModel(e.target.value || null)} aria-label="Language model">
          <option value="">{current ? `The gateway's selected model (${current.label})` : "The gateway's selected model"}</option>
          {(p.models ?? []).map((m) => (
            <option key={m.key} value={m.key} disabled={!m.available && m.key !== p.draft.llmKey}>
              {m.label} · {m.provider}
              {m.available ? '' : ' (unavailable)'}
            </option>
          ))}
        </Select>
      </Field>
      {p.modelsError && (
        <p role="alert" className="text-xs text-rose-300">
          {p.modelsError}
        </p>
      )}
      {selectedProblem && (
        <p role="alert" className="text-xs text-rose-300" data-testid="model-problem">
          {selectedProblem}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={p.onSave} disabled={!dirty || counter.over || selectedProblem !== null} busy={p.saveState.status === 'running'}>
          Save prompt and model
        </Button>
        <Button onClick={p.onDiscard} disabled={!dirty}>
          Discard changes
        </Button>
        <span className="text-[11px] text-slate-500">
          Saving applies to calls placed from now on; a call already in progress keeps what it started with. It never starts, resumes or stops the campaign
          {p.campaign.status === 'completed' ? ' (this one stays completed)' : ''}. Every call records which version it used.
        </span>
      </div>
      <ActionNote state={p.saveState} />
    </Card>
  );
}

/** Loads the model choices, holds the draft, and saves it through the gateway (which validates again and refuses a prompt that is too long). */
export function AgentConfigCard({ campaign, onSaved }: { campaign: Campaign; onSaved: () => void }) {
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFromConfig(campaign.config));
  const [models, setModels] = useState<LlmChoice[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveState, run, reset] = useAction();

  // The editor follows what is saved while the person has not changed anything; unsaved edits are never replaced.
  useEffect(() => {
    if (!configDirty(campaign.config, draft)) setDraft(draftFromConfig(campaign.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.config.version]);

  useEffect(() => {
    let alive = true;
    apiClient
      .getCampaignLlmOptions()
      .then((res) => alive && setModels(res.models))
      .catch((e: Error) => alive && setModelsError(`Could not load the model list: ${e.message}`));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    const patch = configPatch(campaign.config, draft);
    const saved = await run(() => apiClient.updateCampaign(campaign.id, { config: patch }), 'Saved. Calls placed from now on use it; the campaign\'s state is unchanged.');
    if (saved) {
      setDraft(draftFromConfig(saved.campaign.config));
      onSaved();
    }
  };

  return (
    <AgentConfigForm
      campaign={campaign}
      draft={draft}
      models={models}
      modelsError={modelsError}
      saveState={saveState}
      onPrompt={(prompt) => {
        reset();
        setDraft((d) => ({ ...d, prompt }));
      }}
      onModel={(llmKey) => {
        reset();
        setDraft((d) => ({ ...d, llmKey }));
      }}
      onSave={() => void save()}
      onDiscard={() => {
        reset();
        setDraft(draftFromConfig(campaign.config));
      }}
    />
  );
}
