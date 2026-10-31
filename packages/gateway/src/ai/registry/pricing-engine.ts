import { PriceEntry, PriceComponent, PriceUnit, Rate } from './pricing-schema.js';

/**
 * Cost estimation from registry prices. An unknown price (null) is unknown, never free: a component that was used and has no
 * known price makes the whole estimate null, so a partial sum is never presented as the total.
 */

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  /** Audio duration in seconds. */
  audioSeconds?: number;
  characters?: number;
  /** Add-on usage, in the units of the feature's own rate (for example minutes for a per_minute add-on). */
  features?: Record<string, number>;
}

export interface CostLine {
  component: PriceComponent;
  feature?: string;
  /** Quantity in the rate's own unit. */
  quantity: number;
  /** Null when this component's price is unknown. */
  cost: number | null;
}

export interface CostEstimate {
  /** Null when any used component has an unknown price. */
  total: number | null;
  currency: string;
  lines: CostLine[];
  /** The components that were used but have no known price. */
  unknown: string[];
}

const USAGE_FIELD: Record<Exclude<PriceComponent, 'feature'>, keyof Usage> = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cached_input_tokens: 'cachedInputTokens',
  audio_input_tokens: 'audioInputTokens',
  audio_output_tokens: 'audioOutputTokens',
  audio_duration: 'audioSeconds',
  characters: 'characters',
};

/** A base quantity (tokens, seconds, characters) in the rate's unit. */
export function inUnit(unit: PriceUnit, base: number): number {
  switch (unit) {
    case 'per_million_tokens':
    case 'per_million_characters':
      return base / 1e6;
    case 'per_thousand_tokens':
    case 'per_thousand_characters':
      return base / 1e3;
    case 'per_minute':
      return base / 60;
    case 'per_audio_hour':
      return base / 3600;
    default:
      return base; // per_second, per_character, per_request, per_month
  }
}

/** The cost of `quantity` units of one rate, or null when a price it needs is unknown. */
export function rateCost(rate: Rate, quantity: number): number | null {
  if (quantity <= 0) return 0;
  if (!rate.tiers) return rate.price === null ? null : quantity * rate.price;
  if (rate.tierMode === 'volume') {
    const tier = rate.tiers.find((t) => t.upTo === null || quantity <= t.upTo);
    return tier && tier.price !== null ? quantity * tier.price : null;
  }
  let remaining = quantity;
  let floor = 0;
  let total = 0;
  for (const tier of rate.tiers) {
    const size = tier.upTo === null ? remaining : Math.min(remaining, tier.upTo - floor);
    if (size > 0) {
      if (tier.price === null) return null;
      total += size * tier.price;
      remaining -= size;
    }
    if (tier.upTo !== null) floor = tier.upTo;
    if (remaining <= 0) break;
  }
  return total;
}

export function estimatePrice(price: PriceEntry, usage: Usage): CostEstimate {
  const lines: CostLine[] = [];
  const unknown: string[] = [];
  let total = 0;
  let known = true;
  const used = new Set<string>();
  for (const rate of price.rates) {
    const base = rate.component === 'feature' ? usage.features?.[rate.feature!] : (usage[USAGE_FIELD[rate.component]] as number | undefined);
    if (!base || base <= 0) continue;
    const quantity = rate.component === 'feature' ? base : inUnit(rate.unit, base);
    const cost = rateCost(rate, quantity);
    used.add(rate.component === 'feature' ? `feature:${rate.feature}` : rate.component);
    lines.push({ component: rate.component, ...(rate.feature ? { feature: rate.feature } : {}), quantity, cost });
    if (cost === null) {
      known = false;
      unknown.push(rate.feature ?? rate.component);
    } else total += cost;
  }
  // Usage with no rate at all for it is unknown too (a cached-token count with no cached-token price is not free).
  for (const [component, field] of Object.entries(USAGE_FIELD)) {
    const amount = usage[field as keyof Usage] as number | undefined;
    if (amount && amount > 0 && !used.has(component)) {
      known = false;
      unknown.push(component);
    }
  }
  for (const [feature, amount] of Object.entries(usage.features ?? {})) {
    if (amount > 0 && !used.has(`feature:${feature}`)) {
      known = false;
      unknown.push(feature);
    }
  }
  return { total: known ? total : null, currency: price.currency, lines, unknown };
}

const trim = (n: number) => String(n);

/** A short human description of a price, for the dashboard ("$0.8/1M input, $4/1M output tokens"). */
export function describePrice(price: PriceEntry): string {
  const symbol = price.currency === 'USD' ? '$' : `${price.currency} `;
  const one = (rate: Rate): string => {
    const label: Record<PriceUnit, string> = {
      per_million_tokens: '/1M',
      per_thousand_tokens: '/1K',
      per_second: '/s',
      per_minute: '/min',
      per_audio_hour: '/audio hour',
      per_character: '/character',
      per_thousand_characters: '/1K characters',
      per_million_characters: '/1M characters',
      per_request: '/request',
      per_month: '/month',
    };
    const what = rate.component === 'feature' ? rate.feature! : rate.component.replace(/_/g, ' ');
    const amount = rate.tiers ? 'tiered' : rate.price === null ? 'unknown' : `${symbol}${trim(rate.price)}`;
    return `${amount}${label[rate.unit]} ${what}`;
  };
  // The classic shapes read as before: "$0.8/1M input, $4/1M output tokens", "$0.0058/min", "$37.38/1M characters".
  const r = price.rates;
  let text: string;
  if (r.length === 2 && r[0].component === 'input_tokens' && r[1].component === 'output_tokens' && r.every((x) => x.unit === 'per_million_tokens' && !x.tiers && x.price !== null)) {
    text = `${symbol}${r[0].price}/1M input, ${symbol}${r[1].price}/1M output tokens`;
  } else if (r.length === 1 && r[0].component === 'audio_duration' && r[0].unit === 'per_minute' && !r[0].tiers && r[0].price !== null) {
    text = `${symbol}${r[0].price}/min`;
  } else if (r.length === 1 && r[0].component === 'characters' && r[0].unit === 'per_million_characters' && !r[0].tiers && r[0].price !== null) {
    text = `${symbol}${r[0].price}/1M characters`;
  } else {
    text = r.map(one).join(', ');
  }
  return `${text}${price.planSpecific ? ' (plan-specific)' : ''}`;
}
