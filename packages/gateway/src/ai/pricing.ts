import { activePricing, activeRegistry } from './registry/active.js';
import { describePrice, estimatePrice } from './registry/pricing-engine.js';
import { PriceEntry } from './registry/pricing-schema.js';

/**
 * Estimates from the registry's prices. The built-in prices are the table that used to live here (copied from the source project's
 * config/model_pricing_catalog.json, rate_verified_at 2026-10-15/16) and are marked imported-unverified: they were not re-verified,
 * several are plan-specific, and the providers' invoices are the authority. A price edited or approved on the AI Model Hub is used
 * from then on. Where a price is unknown the estimate is null, never a guess and never zero.
 */
export const PRICING_NOTE =
  'Estimate from the source project price catalog (not re-verified, some rates are plan-specific). Provider invoices are authoritative.';

interface LlmPrice {
  inputPer1M: number;
  outputPer1M: number;
}

type Kind = 'stt' | 'llm' | 'tts';

const priceOf = (kind: Kind, key: string): PriceEntry | null => activePricing().priceFor(kind, key);

const known = (rate: { price: number | null; tiers?: unknown } | undefined): number | null => (rate && !rate.tiers && rate.price !== null ? rate.price : null);

export function llmPrice(key: string): LlmPrice | null {
  const price = priceOf('llm', key);
  if (!price || price.currency !== 'USD') return null;
  const input = known(price.rates.find((r) => r.component === 'input_tokens' && r.unit === 'per_million_tokens'));
  const output = known(price.rates.find((r) => r.component === 'output_tokens' && r.unit === 'per_million_tokens'));
  return input === null || output === null ? null : { inputPer1M: input, outputPer1M: output };
}

export function sttPricePerMinute(key: string): { price: number; planSpecific: boolean } | null {
  const price = priceOf('stt', key);
  const rate = price?.rates.find((r) => r.component === 'audio_duration' && r.unit === 'per_minute');
  const value = known(rate);
  return price && value !== null && price.currency === 'USD' ? { price: value, planSpecific: price.planSpecific } : null;
}

export function ttsPricePer1MChars(key: string): { price: number; planSpecific: boolean } | null {
  const price = priceOf('tts', key);
  const rate = price?.rates.find((r) => r.component === 'characters' && r.unit === 'per_million_characters');
  const value = known(rate);
  return price && value !== null && price.currency === 'USD' ? { price: value, planSpecific: price.planSpecific } : null;
}

export function priceNote(kind: Kind, key: string): string | null {
  const price = priceOf(kind, key);
  if (price) return describePrice(price);
  return activeRegistry().isDefaultModel(kind, key) ? 'no price in the source catalog' : 'price unknown';
}

export interface UsageForCost {
  sttSeconds: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  ttsChars: number;
}

/**
 * Estimated USD for a usage total under one provider selection. Null when ANY component that has
 * non-zero usage has no known price (or is not priced in USD), so a partial sum is never presented as the total.
 */
export function estimateCostUsd(selection: { stt: string; llm: string; tts: string }, usage: UsageForCost): number | null {
  let total = 0;
  const add = (kind: Kind, key: string, amount: Parameters<typeof estimatePrice>[1]): boolean => {
    const price = priceOf(kind, key);
    if (!price || price.currency !== 'USD') return false;
    const estimate = estimatePrice(price, amount);
    if (estimate.total === null) return false;
    total += estimate.total;
    return true;
  };
  if (usage.sttSeconds > 0 && !add('stt', selection.stt, { audioSeconds: usage.sttSeconds })) return null;
  if ((usage.llmPromptTokens > 0 || usage.llmCompletionTokens > 0) && !add('llm', selection.llm, { inputTokens: usage.llmPromptTokens, outputTokens: usage.llmCompletionTokens })) return null;
  if (usage.ttsChars > 0 && !add('tts', selection.tts, { characters: usage.ttsChars })) return null;
  return Math.round(total * 1e6) / 1e6;
}
