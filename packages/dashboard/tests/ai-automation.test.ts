import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AiCatalogResponse, AiSettingsView } from '@sim-gateway/shared';
import { AutomationCard, automationSummary } from '../src/components/ai/AutomationCard';
import { buildSettingsPatch, draftFromSettings, validateDraft } from '../src/lib/ai-settings-form';

const catalog: AiCatalogResponse = {
  languages: ['en'],
  stt: [{ key: 'nova-3', label: 'Nova-3', provider: 'deepgram', model: 'nova-3', implemented: true, unavailableReason: null, streaming: false, priceNote: null }],
  llm: [{ key: 'groq_qwen_3_8_27b', label: 'qwen', provider: 'groq', model: 'q', implemented: true, unavailableReason: null, priceNote: null }],
  tts: [{ key: 'cartesia', label: 'Cartesia', provider: 'cartesia', model: 'sonic-3', implemented: true, unavailableReason: null, voices: [{ id: 'katie', label: 'katie' }], sampleRates: [8000, 16000], priceNote: null }],
};

const settings = (over: Partial<AiSettingsView> = {}): AiSettingsView =>
  ({
    mode: 'passive',
    stt: 'nova-3',
    llm: 'groq_qwen_3_8_27b',
    tts: 'cartesia',
    ttsVoice: 'katie',
    agent: { name: 'Phone agent', instructions: '', greeting: '', language: 'en', enabled: true, allowHangup: false },
    showTranscripts: false,
    diagnosticRecording: false,
    audioSampleRate: 8000,
    autoHandle: 'off',
    automation: { autoAnswer: false, autoAnswerRings: 2, autoActivateUsbAudio: false, autoReplies: false, maxCallSeconds: 900, idleFollowUps: true },
    params: { maxTokens: null, sttTimeoutMs: 8000, llmFirstTokenTimeoutMs: 8000, llmTotalTimeoutMs: 30000, ttsTimeoutMs: 8000, maxResponseChars: 600, vadMinSilenceMs: 1000, vadRmsThreshold: 0.003 },
    attestations: {
      inbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' },
      outbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' },
    },
    configErrors: [],
    configWarnings: [],
    secretStorageAvailable: true,
    updatedAt: null,
    ...over,
  }) as AiSettingsView;

describe('automation settings form', () => {
  it('everything defaults off', () => {
    const d = draftFromSettings(settings());
    expect(d.autoHandle).toBe('off');
    expect(d.automation).toMatchObject({ autoAnswer: false, autoActivateUsbAudio: false, autoReplies: false });
    expect(validateDraft(d, catalog)).toEqual([]);
  });

  it('sends only the automation fields that changed', () => {
    const original = draftFromSettings(settings());
    const edited = { ...original, autoHandle: 'inbound' as const, automation: { ...original.automation, autoAnswer: true, autoActivateUsbAudio: true } };
    expect(buildSettingsPatch(original, edited)).toEqual({ autoHandle: 'inbound', automation: { autoAnswer: true, autoActivateUsbAudio: true } });
    expect(buildSettingsPatch(original, original)).toEqual({});
  });

  it('refuses combinations that would answer a call nobody can serve', () => {
    const base = draftFromSettings(settings());
    const answerOnly = { ...base, automation: { ...base.automation, autoAnswer: true } };
    const problems = validateDraft(answerOnly, catalog).join(' ');
    expect(problems).toMatch(/needs "Attach the AI automatically" set to incoming/);
    expect(problems).toMatch(/needs automatic USB audio activation/);

    const ok = { ...answerOnly, autoHandle: 'inbound' as const, automation: { ...answerOnly.automation, autoActivateUsbAudio: true } };
    expect(validateDraft(ok, catalog)).toEqual([]);
    expect(validateDraft({ ...ok, autoHandle: 'outbound' }, catalog).join(' ')).toMatch(/incoming calls/);
    expect(validateDraft({ ...ok, automation: { ...ok.automation, autoAnswerRings: 0 } }, catalog).join(' ')).toMatch(/1 to 10 rings/);
    expect(validateDraft({ ...ok, automation: { ...ok.automation, maxCallSeconds: 5 } }, catalog).join(' ')).toMatch(/30 to 3600/);
  });
});

describe('automation card', () => {
  const render = (s: AiSettingsView, mutate = (d: ReturnType<typeof draftFromSettings>) => d) =>
    renderToStaticMarkup(React.createElement(AutomationCard, { draft: mutate(draftFromSettings(s)), setDraft: vi.fn(), attestations: s.attestations }));

  it('locks automatic replies until both audio paths are confirmed, and says why', () => {
    const html = render(settings());
    expect(html).toContain('Locked until you have confirmed both');
    expect(html).toMatch(/role="switch"[^>]*disabled=""[^>]*>[\s\S]{0,200}Let the agent speak without a click/);
    expect(html).toContain('listening only');
  });

  it('unlocks the toggle once both are confirmed, and labels an automatic-reply setup', () => {
    const confirmed = settings({
      attestations: {
        inbound: { confirmed: true, confirmedAt: 'x', note: 'n', source: 'stored' },
        outbound: { confirmed: true, confirmedAt: 'x', note: 'n', source: 'stored' },
      },
    });
    const html = render(confirmed, (d) => ({ ...d, automation: { ...d.automation, autoReplies: true } }));
    expect(html).toContain('replies automatic');
    expect(html).toContain('only while every readiness check passes');
  });

  it('describes in words what is and is not automatic', () => {
    expect(automationSummary(settings())).toEqual([
      'Does not answer calls by itself',
      'Does not activate USB audio by itself',
      'Does not attach to calls by itself (use Attach to this call)',
      'Never speaks by itself: replies need a click per call',
    ]);
    const on = automationSummary(settings({ autoHandle: 'inbound', automation: { autoAnswer: true, autoAnswerRings: 3, autoActivateUsbAudio: true, autoReplies: false, maxCallSeconds: 900, idleFollowUps: true } }));
    expect(on[0]).toBe('Answers incoming calls after 3 rings');
    expect(on[2]).toBe('Attaches automatically to inbound calls, listening only');
    expect(on[3]).toMatch(/Never speaks by itself/);
  });
});
