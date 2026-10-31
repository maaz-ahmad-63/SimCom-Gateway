import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCatalogResponse, AiSettingsView } from '@sim-gateway/shared';
import { LlmModelSelect } from '../src/components/ai/LlmTab';
import { GatewayApiClient } from '../src/lib/api-client';
import { buildSettingsPatch, draftFromSettings, validateDraft } from '../src/lib/ai-settings-form';
import { catalogChanged, catalogRevisionOf } from '../src/lib/catalog-sync';
import { HubProtocol, HubProvider, HubView, protocolOptions, providerOptions } from '../src/lib/model-hub';

/**
 * The Language Model dropdown (AI → Language Model) is fed by GET /api/ai/catalog, which the gateway builds from its model registry.
 * These tests follow that flow with the gateway's own response shape: nothing here lists a model by name except as test data.
 */
const llm = (key: string, label: string, model: string, over: Record<string, unknown> = {}) => ({ key, label, provider: key.split('_')[0], model, implemented: true, unavailableReason: null, supportedParams: ['maxTokens'], priceNote: null, ...over });
const catalogWith = (...extra: ReturnType<typeof llm>[]): AiCatalogResponse =>
  ({
    languages: ['en'],
    stt: [{ key: 'nova-3', label: 'Deepgram Nova-3', provider: 'deepgram', model: 'nova-3', implemented: true, unavailableReason: null, streaming: false, priceNote: null }],
    llm: [llm('groq_qwen_3_8_27b', 'groq qwen 3 8 27b', 'qwen/qwen3.8-27b'), llm('telnyx_kimi_k3', 'telnyx kimi k3', 'moonshotai/Kimi-K3'), ...extra],
    tts: [{ key: 'cartesia', label: 'Cartesia Sonic-3', provider: 'cartesia', model: 'sonic-3', implemented: true, unavailableReason: null, voices: [{ id: 'katie', label: 'katie' }], sampleRates: [8000], priceNote: null }],
  }) as AiCatalogResponse;
const GEMMA = llm('inworld_gemma_4_31b', 'Inworld Gemma 4 31B', 'deepinfra/google/gemma-4-31B-it', { provider: 'inworld' });

describe('the Language Model dropdown lists the gateway’s catalog', () => {
  const markup = (catalog: AiCatalogResponse, value = 'groq_qwen_3_8_27b') => renderToStaticMarkup(React.createElement(LlmModelSelect, { catalog, value, onChange() {} }));

  it('shows a model the registry gained (Inworld) next to the existing Groq and Telnyx options', () => {
    const html = markup(catalogWith(GEMMA));
    expect(html).toContain('value="inworld_gemma_4_31b"');
    expect(html).toContain('Inworld Gemma 4 31B · deepinfra/google/gemma-4-31B-it');
    expect(html).toContain('value="groq_qwen_3_8_27b"');
    expect(html).toContain('value="telnyx_kimi_k3"');
  });

  it('shows only what the catalog holds: with no Inworld model registered there is no Inworld option (nothing is hardcoded)', () => {
    const html = markup(catalogWith());
    expect(html).not.toContain('Inworld');
    expect(html).not.toContain('inworld');
    expect(html.match(/<option/g)).toHaveLength(2);
  });

  it('marks the saved model as selected, and the option value is the registry model id', () => {
    const html = markup(catalogWith(GEMMA), 'inworld_gemma_4_31b');
    expect(html).toMatch(/<option value="inworld_gemma_4_31b"[^>]*selected/);
    expect(html).not.toMatch(/<option value="groq_qwen_3_8_27b"[^>]*selected/);
  });

  it('lists a model that cannot run, disabled, with the reason the gateway gave', () => {
    const html = markup(catalogWith(llm('inworld_off', 'Inworld off', 'm', { implemented: false, unavailableReason: 'Switched off in the model registry' })));
    expect(html).toMatch(/<option value="inworld_off" disabled=""/);
    expect(html).toContain('(switched off in the model registry)');
  });

  it('end to end from the gateway’s response: the client fetches the catalog and the dropdown shows Inworld', async () => {
    const original = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => catalogWith(GEMMA) }) as never;
    try {
      const client = new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'dashboard-test-key-123' });
      const catalog = await client.getAiCatalog();
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:4000/api/ai/catalog');
      expect(markup(catalog)).toContain('Inworld Gemma 4 31B');
    } finally {
      global.fetch = original;
    }
  });
});

describe('selecting a model saves its registry id', () => {
  const settings = (llmKey: string): AiSettingsView =>
    ({
      mode: 'passive',
      stt: 'nova-3',
      llm: llmKey,
      tts: 'cartesia',
      ttsVoice: 'katie',
      agent: { name: 'Phone agent', instructions: '', greeting: '', language: 'en', enabled: true, allowHangup: false },
      showTranscripts: false,
      diagnosticRecording: false,
      audioSampleRate: 8000,
      autoHandle: 'off',
      automation: { autoAnswer: false, autoAnswerRings: 2, autoActivateUsbAudio: false, autoReplies: false, maxCallSeconds: 900, idleFollowUps: true },
      params: { maxTokens: null, sttTimeoutMs: 8000, llmFirstTokenTimeoutMs: 8000, llmTotalTimeoutMs: 30000, ttsTimeoutMs: 8000, maxResponseChars: 600, vadMinSilenceMs: 1000, vadRmsThreshold: 0.003 },
      attestations: { inbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' }, outbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' } },
      configErrors: [],
      configWarnings: [],
      secretStorageAvailable: true,
      updatedAt: null,
    }) as AiSettingsView;

  it('choosing the Inworld model sends exactly its id, validates against the catalog, and changes nothing else', () => {
    const baseline = draftFromSettings(settings('groq_qwen_3_8_27b'));
    const chosen = { ...baseline, llm: 'inworld_gemma_4_31b' };
    expect(buildSettingsPatch(baseline, chosen)).toEqual({ llm: 'inworld_gemma_4_31b' });
    expect(validateDraft(chosen, catalogWith(GEMMA))).toEqual([]);
  });

  it('after a refresh the saved id is what the settings report, so the dropdown shows it selected; Groq and Telnyx can be chosen back', () => {
    const saved = draftFromSettings(settings('inworld_gemma_4_31b'));
    expect(saved.llm).toBe('inworld_gemma_4_31b');
    expect(renderToStaticMarkup(React.createElement(LlmModelSelect, { catalog: catalogWith(GEMMA), value: saved.llm, onChange() {} }))).toMatch(/<option value="inworld_gemma_4_31b"[^>]*selected/);
    for (const key of ['groq_qwen_3_8_27b', 'telnyx_kimi_k3']) {
      expect(buildSettingsPatch(saved, { ...saved, llm: key })).toEqual({ llm: key });
      expect(validateDraft({ ...saved, llm: key }, catalogWith(GEMMA))).toEqual([]);
    }
  });

  it('a model the catalog does not know, or cannot run, is refused before saving', () => {
    const base = draftFromSettings(settings('groq_qwen_3_8_27b'));
    expect(validateDraft({ ...base, llm: 'inworld_gemma_4_31b' }, catalogWith()).join(' ')).toMatch(/Unknown/i);
    expect(validateDraft({ ...base, llm: 'inworld_off' }, catalogWith(llm('inworld_off', 'x', 'm', { implemented: false, unavailableReason: 'Switched off in the model registry' }))).join(' ')).toMatch(/not ported|off|switched/i);
  });
});

describe('the page notices a registry change without a reload', () => {
  it('reads the revision the gateway reports with each state poll, and ignores anything else', () => {
    expect(catalogRevisionOf({ catalogRevision: 7 })).toBe(7);
    expect(catalogRevisionOf({ catalogRevision: '7' })).toBeNull();
    expect(catalogRevisionOf({})).toBeNull();
    expect(catalogRevisionOf(null)).toBeNull();
  });

  it('fetches the catalog again when the revision differs from the last one seen, and not otherwise', () => {
    expect(catalogChanged(null, { catalogRevision: 3 })).toEqual({ reload: true, revision: 3 });
    expect(catalogChanged(3, { catalogRevision: 3 })).toEqual({ reload: false, revision: 3 });
    expect(catalogChanged(3, { catalogRevision: 4 })).toEqual({ reload: true, revision: 4 });
    // a gateway that reports no revision never triggers a reload by itself (the Model Hub refreshes explicitly after a save)
    expect(catalogChanged(3, {})).toEqual({ reload: false, revision: 3 });
    expect(catalogChanged(null, {})).toEqual({ reload: false, revision: null });
  });
});

describe('the Model Hub offers Inworld and the openai-chat protocol for a language model', () => {
  const protocol = (id: string, stage: HubProtocol['stage']): HubProtocol => ({ id, stage, title: id, summary: '', endpoint: { kind: 'base', scheme: 'https', default: null }, facts: { streaming: true, batch: false, functionCalling: true, structuredOutput: false, voiceSelection: false, languages: 'any', cancellation: true } });
  const provider = (id: string): HubProvider => ({ id, name: id, credential: `${id.toUpperCase()}_API_KEY`, baseUrl: null, enabled: true, builtin: true, modified: false, credentialState: null, models: 0 });
  const view = { protocols: [protocol('openai-chat', 'llm'), protocol('inworld-tts', 'tts'), protocol('soniox-stt', 'stt')], providers: [provider('groq'), provider('telnyx'), provider('inworld')] } as unknown as HubView;

  it('every provider can be chosen, and the language-model protocols are the llm ones', () => {
    expect(providerOptions(view).map((p) => p.id)).toEqual(['groq', 'telnyx', 'inworld']);
    expect(protocolOptions(view, 'llm').map((p) => p.id)).toEqual(['openai-chat']);
    expect(protocolOptions(view, 'tts').map((p) => p.id)).toEqual(['inworld-tts']);
  });
});

beforeEach(() => undefined);
afterEach(() => undefined);
