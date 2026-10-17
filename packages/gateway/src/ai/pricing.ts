import { LLM_CATALOG } from './catalog.js';

/**
 * Price table copied from the source project's config/model_pricing_catalog.json (rate_verified_at
 * 2026-10-15/16). These are ESTIMATE inputs only: they were not re-verified here, several are
 * plan-specific, and the providers' invoices are the authority. Where a price is unknown the
 * estimate is null, never a guess.
 */
export const PRICING_NOTE =
  'Estimate from the source project price catalog (not re-verified, some rates are plan-specific). Provider invoices are authoritative.';

interface LlmPrice {
  inputPer1M: number;
  outputPer1M: number;
}

const LLM_PRICES: Record<string, LlmPrice> = {
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

/** Source slugs that share a model with another slug. */
const LLM_PRICE_ALIAS: Record<string, string> = {
  groq_llama_3_3: 'groq_qwen_3_8_27b',
  groq_qwen_3_6_27b: 'groq_qwen_3_8_27b',
};

const STT_PRICES_PER_MINUTE: Record<string, { price: number; planSpecific: boolean }> = {
  groq_whisper: { price: 0.00185, planSpecific: false },
  'nova-3-multi': { price: 0.0058, planSpecific: true },
  // The source lists only the multilingual Nova-3 rate; the monolingual rate is not in the catalog.
};

const TTS_PRICES_PER_1M_CHARS: Record<string, { price: number; planSpecific: boolean }> = {
  cartesia: { price: 37.38, planSpecific: true },
  deepgram: { price: 30, planSpecific: false },
};

export function llmPrice(key: string): LlmPrice | null {
  const slug = LLM_PRICE_ALIAS[key] ?? key;
  return slug in LLM_CATALOG ? (LLM_PRICES[slug] ?? null) : null;
}

export function sttPricePerMinute(key: string): { price: number; planSpecific: boolean } | null {
  return STT_PRICES_PER_MINUTE[key] ?? null;
}

export function ttsPricePer1MChars(key: string): { price: number; planSpecific: boolean } | null {
  return TTS_PRICES_PER_1M_CHARS[key] ?? null;
}

export function priceNote(kind: 'stt' | 'llm' | 'tts', key: string): string | null {
  if (kind === 'llm') {
    const p = llmPrice(key);
    return p ? `$${p.inputPer1M}/1M input, $${p.outputPer1M}/1M output tokens` : 'no price in the source catalog';
  }
  if (kind === 'stt') {
    const p = sttPricePerMinute(key);
    return p ? `$${p.price}/min${p.planSpecific ? ' (plan-specific)' : ''}` : 'no price in the source catalog';
  }
  const p = ttsPricePer1MChars(key);
  return p ? `$${p.price}/1M characters${p.planSpecific ? ' (plan-specific)' : ''}` : 'no price in the source catalog';
}

export interface UsageForCost {
  sttSeconds: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  ttsChars: number;
}

/**
 * Estimated USD for a usage total under one provider selection. Null when ANY component that has
 * non-zero usage has no known price, so a partial sum is never presented as the total.
 */
export function estimateCostUsd(
  selection: { stt: string; llm: string; tts: string },
  usage: UsageForCost
): number | null {
  let total = 0;
  if (usage.sttSeconds > 0) {
    const p = sttPricePerMinute(selection.stt);
    if (!p) return null;
    total += (usage.sttSeconds / 60) * p.price;
  }
  if (usage.llmPromptTokens > 0 || usage.llmCompletionTokens > 0) {
    const p = llmPrice(selection.llm);
    if (!p) return null;
    total += (usage.llmPromptTokens / 1e6) * p.inputPer1M + (usage.llmCompletionTokens / 1e6) * p.outputPer1M;
  }
  if (usage.ttsChars > 0) {
    const p = ttsPricePer1MChars(selection.tts);
    if (!p) return null;
    total += (usage.ttsChars / 1e6) * p.price;
  }
  return Math.round(total * 1e6) / 1e6;
}
