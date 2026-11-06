import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/ai/catalog-view.js';
import { LLM_ALIASES, LLM_CATALOG, STT_CATALOG, STT_KEY_ENV, TTS_CATALOG, TTS_KEY_ENV, TTS_MODELS, TTS_PCM_RATES } from '../../src/ai/catalog.js';
import { estimateCostUsd, priceNote } from '../../src/ai/pricing.js';
import { resetActiveRegistry } from '../../src/ai/registry/active.js';
import { builtinPricing } from '../../src/ai/registry/pricing-view.js';
import { builtinRegistry, buildLlmSpec } from '../../src/ai/registry/registry.js';

/**
 * The migration of catalog.ts into the registry must change nothing. registry-baseline.json was produced from the code as it was
 * BEFORE the registry existed (catalog view, every model's request spec under several environments, alias resolution, price notes
 * and cost estimates); each assertion here compares the registry-backed code with it.
 */
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'registry-baseline.json'), 'utf8')) as any;
const ENVS: Record<string, Record<string, string>> = {
  none: {},
  reasoning: { AI_LLM_REASONING_EFFORT: 'high', AI_LLM_REASONING_TOKENS: '2048' },
  strict: { TELNYX_LLM_REGION_MODE: 'strict' },
  badEffort: { AI_LLM_REASONING_EFFORT: 'extreme' },
  badTokens: { AI_LLM_REASONING_TOKENS: '99999' },
  badMode: { TELNYX_LLM_REGION_MODE: 'sometimes' },
};
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
/** Deliberate additions since the baseline: the seeded Inworld Router model, and each LLM option naming its credential (keyEnv). */
const ADDED_LLM = ['inworld_gemma_4_31b', 'inworld_gpt_5_4'];
const asBaseline = (catalog: any) => ({
  ...catalog,
  llm: catalog.llm.filter((o: any) => !ADDED_LLM.includes(o.key)).map(({ keyEnv: _keyEnv, ...o }: any) => o),
});

beforeEach(() => resetActiveRegistry());

describe('the built-in registry is the original catalog', () => {
  const registry = builtinRegistry();

  it('keeps every LLM id, provider mapping, model id and alias', () => {
    expect(registry.llmKeys().filter((k) => !ADDED_LLM.includes(k))).toEqual(Object.keys(LLM_CATALOG));
    for (const [key, entry] of Object.entries(LLM_CATALOG)) {
      const r = registry.llm(key)!;
      expect(r.model, key).toBe(entry.model);
      expect(r.family, key).toBe(entry.family);
      expect(r.vendor, key).toBe(entry.family.startsWith('groq') ? 'groq' : entry.family);
      expect(r.entry.aliases.sort(), key).toEqual(Object.entries(LLM_ALIASES).filter(([, t]) => t === key).map(([a]) => a).sort());
    }
  });

  it('keeps every STT id with its provider, model and implemented flag', () => {
    expect(registry.sttKeys()).toEqual(Object.keys(STT_CATALOG));
    for (const [key, entry] of Object.entries(STT_CATALOG)) {
      const r = registry.stt(key)!;
      expect(r.vendor, key).toBe(entry.provider);
      expect(r.model, key).toBe(entry.model);
      expect(r.implemented, key).toBe(entry.implemented);
      expect(r.keyEnv, key).toBe(STT_KEY_ENV[entry.provider]);
    }
  });

  it('keeps every TTS id with its default voice, models, credential, sample rates and implemented flag', () => {
    expect(registry.ttsKeys()).toEqual(Object.keys(TTS_CATALOG));
    for (const [key, entry] of Object.entries(TTS_CATALOG)) {
      const r = registry.tts(key)!;
      expect(r.defaultVoice, key).toBe(entry.defaultVoice);
      expect(r.implemented, key).toBe(entry.implemented);
      expect(r.models, key).toEqual(TTS_MODELS[key] ?? []);
      expect(r.keyEnv, key).toBe(TTS_KEY_ENV[key] ?? null);
      if (entry.implemented) expect(r.sampleRates, key).toEqual(TTS_PCM_RATES[key]);
    }
  });

  it('keeps the active defaults of the original catalog (nothing is selected by the registry itself)', () => {
    expect(registry.llm('groq_qwen_3_8_27b')).not.toBeNull();
    expect(registry.stt('nova-3')).not.toBeNull();
    expect(registry.tts('cartesia')).not.toBeNull();
  });
});

describe('the registry produces exactly what the original code produced', () => {
  it('the dashboard catalog is identical for each environment', () => {
    for (const name of ['none', 'reasoning', 'badEffort'] as const) expect(asBaseline(json(buildCatalog(ENVS[name]))), name).toEqual(baseline.catalog[name]);
  });

  it('every model request spec (body, base URL, credential, reasoning allowance, tool calling) is identical, and so are the errors', () => {
    const registry = builtinRegistry();
    for (const [name, env] of Object.entries(ENVS)) {
      for (const key of Object.keys(LLM_CATALOG)) {
        let got: unknown;
        try {
          got = buildLlmSpec(registry.llm(key)!, env);
        } catch (error) {
          got = { error: (error as Error).message };
        }
        expect(json(got), `${name}/${key}`).toEqual(baseline.specs[`${name}/${key}`]);
      }
    }
  });

  it('slug and alias resolution is identical, including case-insensitive and unknown names', () => {
    const registry = builtinRegistry();
    for (const [setting, expected] of Object.entries(baseline.resolve)) expect(registry.resolveLlmKey(setting), setting).toBe(expected);
  });

  it('price notes and cost estimates are identical for every selection', () => {
    for (const [name, expected] of Object.entries(baseline.prices as Record<string, string | null>)) {
      const [kind, key] = name.split('/') as ['stt' | 'llm' | 'tts', string];
      expect(priceNote(kind, key), name).toBe(expected);
    }
    const usage = { sttSeconds: 125, llmPromptTokens: 3456, llmCompletionTokens: 789, ttsChars: 4321 };
    for (const [name, expected] of Object.entries(baseline.costs as Record<string, number | null>)) {
      if (name === 'llmOnly') continue;
      const [llm, stt, tts] = name.split('|');
      expect(estimateCostUsd({ stt, llm, tts }, usage), name).toBe(expected);
    }
    expect(estimateCostUsd({ stt: 'nova-3', llm: 'openai_gpt_5_4', tts: 'cartesia' }, { sttSeconds: 0, llmPromptTokens: 1000, llmCompletionTokens: 500, ttsChars: 0 })).toBe(baseline.costs.llmOnly);
  });

  it('imported prices are marked as not re-verified, never as verified', () => {
    for (const price of builtinPricing().prices) {
      expect(price.status).toBe('imported-unverified');
      expect(price.verifiedAt).toBeNull();
      expect(price.sourceUrl).toBeNull();
    }
  });
});
