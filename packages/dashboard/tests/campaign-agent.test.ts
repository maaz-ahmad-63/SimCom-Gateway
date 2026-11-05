import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentConfigForm } from '../src/components/campaigns/AgentConfigCard';
import { UsagePanel } from '../src/components/campaigns/UsageCard';
import { configDirty, configPatch, contactFields, draftFromConfig, promptCounter, promptProblem, PROMPT_MAX_CHARS } from '../src/lib/campaign-config';

const config = { version: 2, prompt: 'You are calling about a checkup.', promptSha: 'abc', promptChars: 32, llmKey: null, createdAt: null };
const idle = { status: 'idle' } as never;
const form = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(AgentConfigForm, {
      campaign: { status: 'completed', config },
      draft: draftFromConfig(config),
      models: [],
      modelsError: null,
      saveState: idle,
      onPrompt: () => {},
      onModel: () => {},
      onSave: () => {},
      onDiscard: () => {},
      ...over,
    } as never)
  );

describe('campaign prompt limit', () => {
  it('counts exactly and refuses over 10,000 characters without truncating', () => {
    expect(PROMPT_MAX_CHARS).toBe(10_000);
    expect(promptCounter('a'.repeat(10_000)).over).toBe(false);
    expect(promptCounter('a'.repeat(10_001)).over).toBe(true);
    expect(promptProblem('a'.repeat(10_001))).toMatch(/10,000/);
    expect(promptProblem('fine')).toBeNull();
  });

  it('shows the live counter and an error when over, and disables saving', () => {
    const html = form({ draft: { prompt: 'a'.repeat(10_050), llmKey: null } });
    expect(html).toContain('10,050 / 10,000 characters');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save prompt and model/);
  });

  it('edits a completed campaign and says it stays completed', () => {
    const html = form();
    expect(html).toContain('version 2');
    expect(html).toContain('this one stays completed');
  });
});

describe('config draft', () => {
  it('sends only what changed', () => {
    const d = draftFromConfig(config);
    expect(configDirty(config, d)).toBe(false);
    expect(configPatch(config, { ...d, prompt: 'new' })).toEqual({ prompt: 'new' });
    expect(configPatch(config, { ...d, llmKey: 'x' })).toEqual({ llmKey: 'x' });
  });
});

describe('contact fields and usage', () => {
  it('lists notes then custom columns, skipping blanks', () => {
    expect(contactFields({ context: 'n', extra: { City: 'Pune', Empty: '' } })).toEqual([['Notes', 'n'], ['City', 'Pune']]);
  });

  it('never shows an unreported cache figure as zero', () => {
    const html = renderToStaticMarkup(
      React.createElement(UsagePanel, {
        usage: { totals: { calls: 1, turns: 2, turnsWithUsage: 2, inputTokens: 100, outputTokens: 10, cachedInputTokens: null, cacheWriteTokens: null, turnsReportingCache: 0, uncachedInputTokens: null, inputTokensOnTurnsReportingCache: null }, calls: [{ callId: 'c', contactName: 'Asha', configVersion: 1, turns: 2, turnsWithUsage: 2, inputTokens: 100, outputTokens: 10, cachedInputTokens: null }] },
        error: null,
        onRefresh: () => {},
      } as never)
    );
    expect(html).toContain('not reported');
  });
});
