import {
  CARTESIA_VOICES,
  LLM_ALIASES,
  LLM_CATALOG,
  STT_CATALOG,
  STT_KEY_ENV,
  TTS_CATALOG,
  TTS_KEY_ENV,
  TTS_MODELS,
  TTS_PCM_RATES,
} from '../catalog.js';
import { PriceEntry, PricingFile } from './pricing-schema.js';
import { ModelEntry, ProviderEntry, RegistryFile } from './schema.js';

/**
 * The defaults: every entry of the original catalog (catalog.ts, which stays as the seed) as providers and one flat model list, with
 * the same ids, aliases, provider mappings and request parameters. Until the operator changes something, the registry IS this; the
 * first change writes registry.json containing it plus the change. Only the display labels that used to live in catalog-view.ts and
 * the price table that used to live in pricing.ts are written out here.
 */

const humanize = (slug: string) => slug.replace(/_/g, ' ');

// -------------------------------------------------------------------------------------------- providers

const provider = (id: string, name: string, credential: string | null, baseUrl: string | null = null, note?: string, authScheme?: 'bearer' | 'basic'): ProviderEntry => ({
  id,
  name,
  credential,
  baseUrl,
  enabled: true,
  ...(note ? { note } : {}),
  ...(authScheme ? { authScheme } : {}),
});

const PROVIDERS: ProviderEntry[] = [
  provider('groq', 'Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1'),
  provider('openai', 'OpenAI', 'OPENAI_API_KEY', 'https://api.openai.com/v1'),
  provider('gemini', 'Google Gemini (OpenAI-compatible endpoint)', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai'),
  provider('telnyx', 'Telnyx Inference', 'TELNYX_API_KEY', 'https://api.telnyx.com/v2/ai/openai'),
  provider('deepgram', 'Deepgram', STT_KEY_ENV.deepgram),
  provider('deepgram-flux', 'Deepgram Flux', STT_KEY_ENV['deepgram-flux']),
  provider('soniox', 'Soniox', STT_KEY_ENV.soniox),
  provider('cartesia', 'Cartesia', STT_KEY_ENV.cartesia),
  provider('assemblyai', 'AssemblyAI', null),
  // Inworld's OpenAI-compatible API (chat completions) is at this base URL, so an Inworld language model is just a model with the
  // openai-chat protocol. Its text-to-speech protocol has its own address, which this base URL does not change.
  provider('inworld', 'Inworld', TTS_KEY_ENV.inworld, 'https://api.inworld.ai/v1', undefined, 'basic'),
  provider('murf', 'Murf', TTS_KEY_ENV.murf_falcon_2),
  provider('elevenlabs', 'ElevenLabs', TTS_KEY_ENV.elevenlabs),
  provider('sarvam', 'Sarvam', null),
];

// -------------------------------------------------------------------------------------------- LLM models

const LLM_PROVIDER: Record<string, string> = { 'groq-qwen': 'groq', 'groq-reasoning': 'groq', openai: 'openai', gemini: 'gemini', telnyx: 'telnyx' };

/** The request parameters each family used to hard-code in openAiCompatibleSpec, as data. */
function llmOptions(family: string, model: string): Record<string, unknown> {
  const tools = family !== 'telnyx'; // not verified for Telnyx's hosted models: left off until it is confirmed on a real call
  switch (family) {
    case 'groq-qwen':
      return { body: { temperature: 0.4, reasoning_effort: 'none' }, tools, family };
    case 'groq-reasoning':
      return {
        body: {
          temperature: 0.15,
          reasoning_effort: { $env: 'AI_LLM_REASONING_EFFORT', default: 'low', oneOf: ['low', 'medium', 'high'], message: "AI_LLM_REASONING_EFFORT must be 'low', 'medium' or 'high'" },
        },
        reasoningTokenAllowance: { $env: 'AI_LLM_REASONING_TOKENS', default: 1024, integer: { min: 0, max: 8192 }, message: 'AI_LLM_REASONING_TOKENS must be a whole number from 0 to 8192' },
        tools,
        family,
      };
    case 'telnyx': {
      const body: Record<string, unknown> = {
        temperature: 0.3,
        region: 'AUS',
        mode: { $env: 'TELNYX_LLM_REGION_MODE', default: 'preferred', oneOf: ['preferred', 'strict'], message: 'TELNYX_LLM_REGION_MODE must be preferred or strict' },
      };
      if (model === 'moonshotai/Kimi-K3') body.reasoning_effort = 'none';
      else if (model !== 'meta-llama/Llama-3.3-70B-Instruct') {
        body.enable_thinking = false;
        body.reasoning_effort = 'none';
      }
      return { body, tools, family };
    }
    default:
      return { body: {}, tools, family };
  }
}

/**
 * Inworld Router (OpenAI-compatible chat completions at the inworld provider's base URL, Basic auth). Tool calling stays off until it is
 * confirmed through the router on a real call. Both ids answered HTTP 200 from https://api.inworld.ai/v1/chat/completions on 2026-11-07:
 *  - inworld/models/gemma-4-31b-it: Inworld's own hosted Gemma 4 31B, the model this product uses with Inworld. Its id and alias are the
 *    ones the Model Hub used for it, so a customer who added it by hand keeps that entry (and any selection of it).
 *  - openai/gpt-5.4: OpenAI GPT-5.4 routed through Inworld (the id Inworld's quickstart documents), kept because 0.1.4 shipped it and a
 *    customer may have it selected. It is labelled as OpenAI's model so it is never mistaken for Inworld's own.
 */
const INWORLD_LLMS: ModelEntry[] = [
  {
    id: 'inworld_gemma_4_31b',
    stage: 'llm',
    provider: 'inworld',
    protocol: 'openai-chat',
    model: 'inworld/models/gemma-4-31b-it',
    label: 'Inworld Gemma 4 31B',
    enabled: true,
    aliases: ['inworld_gemma_4_31b_it'],
    options: { body: {}, tools: false, family: 'inworld' },
  },
  {
    id: 'inworld_gpt_5_4',
    stage: 'llm',
    provider: 'inworld',
    protocol: 'openai-chat',
    model: 'openai/gpt-5.4',
    label: 'OpenAI GPT-5.4 (through Inworld Router)',
    enabled: true,
    aliases: [],
    options: { body: {}, tools: false, family: 'inworld' },
  },
];

function llmModels(): ModelEntry[] {
  return [...catalogLlmModels(), ...INWORLD_LLMS];
}

function catalogLlmModels(): ModelEntry[] {
  return Object.entries(LLM_CATALOG).map(([id, entry]) => ({
    id,
    stage: 'llm' as const,
    provider: LLM_PROVIDER[entry.family],
    protocol: 'openai-chat',
    model: entry.model,
    label: humanize(id),
    enabled: true,
    aliases: Object.entries(LLM_ALIASES)
      .filter(([, target]) => target === id)
      .map(([alias]) => alias),
    options: llmOptions(entry.family, entry.model),
  }));
}

// -------------------------------------------------------------------------------------------- STT models

const STT_PROVIDER: Record<string, string> = { deepgram: 'deepgram', 'deepgram-flux': 'deepgram-flux', groq: 'groq', assemblyai: 'assemblyai', soniox: 'soniox', cartesia: 'cartesia' };
const STT_PROTOCOL: Record<string, string | null> = { deepgram: 'deepgram-listen', 'deepgram-flux': 'deepgram-flux', groq: 'groq-whisper', assemblyai: null, soniox: 'soniox-stt', cartesia: 'cartesia-stt' };
const STT_LABELS: Record<string, string> = {
  'nova-3': 'Deepgram Nova-3',
  'nova-3-multi': 'Deepgram Nova-3 (multilingual)',
  groq_whisper: 'Groq Whisper large-v3-turbo',
  assemblyai: 'AssemblyAI',
  flux: 'Deepgram Flux',
  soniox: 'Soniox',
  'stt-rt-v5': 'Soniox stt-rt-v5',
  'ink-whisper': 'Cartesia Ink-Whisper',
};

function sttModels(): ModelEntry[] {
  return Object.entries(STT_CATALOG).map(([id, entry]) => ({
    id,
    stage: 'stt' as const,
    provider: STT_PROVIDER[entry.provider],
    protocol: STT_PROTOCOL[entry.provider],
    model: entry.model,
    label: STT_LABELS[id] ?? id,
    enabled: true,
    aliases: [],
    options: id === 'nova-3-multi' ? { language: 'multi' } : {},
    ...(entry.implemented ? {} : { unavailableReason: 'Not ported to the gateway yet' }),
  }));
}

// -------------------------------------------------------------------------------------------- TTS models and voices

const TTS_PROVIDER: Record<string, string> = {
  deepgram: 'deepgram',
  inworld: 'inworld',
  soniox: 'soniox',
  murf_falcon_2: 'murf',
  murf: 'murf',
  murf_falcon_2_hi: 'murf',
  cartesia: 'cartesia',
  sarvam: 'sarvam',
  elevenlabs: 'elevenlabs',
};
const TTS_PROTOCOL: Record<string, string | null> = {
  deepgram: 'deepgram-tts',
  inworld: 'inworld-tts',
  soniox: 'soniox-tts',
  murf_falcon_2: 'murf-tts',
  murf: 'murf-tts',
  murf_falcon_2_hi: 'murf-tts',
  cartesia: 'cartesia-tts',
  sarvam: null,
  elevenlabs: 'elevenlabs-tts',
};
const TTS_LABELS: Record<string, string> = {
  cartesia: 'Cartesia Sonic-3',
  deepgram: 'Deepgram Aura',
  elevenlabs: 'ElevenLabs',
  murf_falcon_2: 'Murf Falcon 2.1',
  murf_falcon_2_hi: 'Murf Falcon 2.1 (Hindi voices)',
  inworld: 'Inworld TTS',
  soniox: 'Soniox TTS',
};
const DEEPGRAM_TTS_RATES = [8000, 16000, 24000, 32000, 48000];
const DEEPGRAM_AURA_VOICES = [
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
  'aura-athena-en',
  'aura-hera-en',
  'aura-orion-en',
  'aura-arcas-en',
  'aura-perseus-en',
  'aura-angus-en',
  'aura-orpheus-en',
  'aura-helios-en',
  'aura-zeus-en',
];

function ttsModels(): ModelEntry[] {
  return Object.entries(TTS_CATALOG).map(([id, entry]) => {
    const models = TTS_MODELS[id] ?? [];
    const voices =
      id === 'cartesia'
        ? Object.entries(CARTESIA_VOICES).map(([name, uuid]) => ({ name, id: uuid, label: humanize(name) }))
        : id === 'deepgram'
          ? DEEPGRAM_AURA_VOICES.map((name) => ({ name, label: name }))
          : [];
    const options: Record<string, unknown> = {
      voice: entry.defaultVoice,
      sampleRates: entry.implemented ? (TTS_PCM_RATES[id] ?? DEEPGRAM_TTS_RATES) : [],
      voices,
    };
    // Deepgram Aura chooses its model by voice, so it has no model list; every other protocol lists the extra models it offers.
    if (TTS_PROTOCOL[id] !== 'deepgram-tts') options.models = models.slice(1);
    return {
      id,
      stage: 'tts' as const,
      provider: TTS_PROVIDER[id],
      protocol: TTS_PROTOCOL[id],
      model: models[0] ?? null,
      label: TTS_LABELS[id] ?? humanize(id),
      enabled: true,
      aliases: [],
      options,
      ...(entry.implemented ? {} : { unavailableReason: id === 'murf' ? "Murf's older Gen 2 synthesis has no documented endpoint here; use the Murf Falcon entries" : 'Not ported to the gateway yet' }),
    };
  });
}

// -------------------------------------------------------------------------------------------- pricing (was pricing.ts)

const IMPORTED_NOTE = 'Imported from the source project price catalog (rate_verified_at 2026-10-15/16); not re-verified here, and some rates are plan-specific.';

const LLM_PRICES: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  openai_gpt_4_1_mini: { inputPer1M: 0.4, outputPer1M: 1.6 },
  openai_gpt_5_2: { inputPer1M: 1.75, outputPer1M: 14 },
  openai_gpt_5_4: { inputPer1M: 2.5, outputPer1M: 15 },
  openai_gpt_5_4_mini: { inputPer1M: 0.75, outputPer1M: 4.5 },
  groq_qwen_3_8_27b: { inputPer1M: 0.8, outputPer1M: 4 },
  groq_gpt_oss_120b: { inputPer1M: 0.15, outputPer1M: 0.6 },
  groq_gpt_oss_20b: { inputPer1M: 0.075, outputPer1M: 0.3 },
  telnyx_kimi_k3: { inputPer1M: 2.7, outputPer1M: 13.5 },
  telnyx_kimi_k2_6: { inputPer1M: 0.665, outputPer1M: 4 },
  telnyx_deepseek_v4_flash_0731: { inputPer1M: 0.13, outputPer1M: 0.26 },
};
/** Slugs that share a provider model (and so a price) with another slug. */
const PRICE_SHARED: Record<string, string[]> = { groq_qwen_3_8_27b: ['groq_llama_3_3', 'groq_qwen_3_6_27b'] };

function importedPrice(base: Pick<PriceEntry, 'id' | 'providerId' | 'modelKind' | 'modelId' | 'rates'> & { planSpecific?: boolean; appliesTo?: string[] }): PriceEntry {
  return {
    plan: base.planSpecific ? 'plan-specific' : 'standard',
    currency: 'USD',
    sourceUrl: null,
    verifiedAt: null,
    effectiveFrom: null,
    status: 'imported-unverified',
    protected: false,
    planSpecific: base.planSpecific ?? false,
    notes: IMPORTED_NOTE,
    ...base,
  };
}

function prices(): PriceEntry[] {
  const out: PriceEntry[] = [];
  for (const [id, p] of Object.entries(LLM_PRICES)) {
    out.push(
      importedPrice({
        id: `price.llm.${id}`,
        providerId: LLM_PROVIDER[LLM_CATALOG[id].family],
        modelKind: 'llm',
        modelId: id,
        ...(PRICE_SHARED[id] ? { appliesTo: PRICE_SHARED[id] } : {}),
        rates: [
          { component: 'input_tokens', unit: 'per_million_tokens', price: p.inputPer1M },
          { component: 'output_tokens', unit: 'per_million_tokens', price: p.outputPer1M },
        ],
      })
    );
  }
  out.push(importedPrice({ id: 'price.stt.groq_whisper', providerId: 'groq', modelKind: 'stt', modelId: 'groq_whisper', rates: [{ component: 'audio_duration', unit: 'per_minute', price: 0.00185 }] }));
  out.push(importedPrice({ id: 'price.stt.nova-3-multi', providerId: 'deepgram', modelKind: 'stt', modelId: 'nova-3-multi', planSpecific: true, rates: [{ component: 'audio_duration', unit: 'per_minute', price: 0.0058 }] }));
  out.push(importedPrice({ id: 'price.tts.cartesia', providerId: 'cartesia', modelKind: 'tts', modelId: 'cartesia', planSpecific: true, rates: [{ component: 'characters', unit: 'per_million_characters', price: 37.38 }] }));
  out.push(importedPrice({ id: 'price.tts.deepgram', providerId: 'deepgram', modelKind: 'tts', modelId: 'deepgram', rates: [{ component: 'characters', unit: 'per_million_characters', price: 30 }] }));
  return out;
}

/** Official pricing pages, checked on request. All are HTML written for people, so nothing is extracted from them. */
const SOURCES: PricingFile['sources'] = [
  {
    providerId: 'openai',
    url: 'https://developers.openai.com/api/docs/pricing',
    format: 'html',
    confirmedAt: '2026-10-30',
    note: 'openai.com/api/pricing and platform.openai.com/docs/pricing redirect or refuse automated requests (HTTP 403); this is the page they lead to.',
  },
  { providerId: 'groq', url: 'https://groq.com/pricing', format: 'html', confirmedAt: null, note: 'Redirected to the home page when checked on 2026-10-30. Set the current pricing URL here when Groq publishes one.' },
  { providerId: 'gemini', url: 'https://ai.google.dev/gemini-api/docs/pricing', format: 'html', confirmedAt: '2026-10-30' },
  { providerId: 'telnyx', url: 'https://telnyx.com/pricing/inference-api', format: 'html', confirmedAt: '2026-10-30' },
  { providerId: 'deepgram', url: 'https://deepgram.com/pricing', format: 'html', confirmedAt: '2026-10-30' },
  { providerId: 'soniox', url: 'https://soniox.com/pricing', format: 'html', confirmedAt: null, note: 'The page content looked right on 2026-10-30, but the response did not confirm it is Soniox-owned; confirm before relying on it.' },
  { providerId: 'inworld', url: 'https://inworld.ai/pricing', format: 'html', confirmedAt: '2026-10-30' },
  { providerId: 'cartesia', url: 'https://cartesia.ai/pricing', format: 'html', confirmedAt: '2026-10-30' },
];

// -------------------------------------------------------------------------------------------- the defaults

let cached: { registry: RegistryFile; pricing: PricingFile } | null = null;
function build() {
  cached ??= { registry: { providers: PROVIDERS, models: [...llmModels(), ...sttModels(), ...ttsModels()] }, pricing: { prices: prices(), sources: SOURCES } };
  return cached;
}

/** A fresh deep copy each call, so a caller can never alter the defaults. */
export const defaultRegistry = (): RegistryFile => structuredClone(build().registry);
export const defaultPricing = (): PricingFile => structuredClone(build().pricing);
