import { z } from 'zod';
import { idSchema } from './schema.js';

/**
 * Pricing is its own optional file (pricing.json), kept apart from the model registry: a model works with no price at all, and a
 * price problem never blocks a model change. An unknown price is null, never zero.
 */

export const PRICING_SCHEMA_VERSION = 2;

const httpsUrl = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'must be an https URL without embedded credentials');
const isoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v), 'must be an ISO date or timestamp');

export const PRICE_UNITS = [
  'per_million_tokens',
  'per_thousand_tokens',
  'per_second',
  'per_minute',
  'per_audio_hour',
  'per_character',
  'per_thousand_characters',
  'per_million_characters',
  'per_request',
  'per_month',
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const PRICE_COMPONENTS = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'audio_input_tokens', 'audio_output_tokens', 'audio_duration', 'characters', 'feature'] as const;
export type PriceComponent = (typeof PRICE_COMPONENTS)[number];

/** A price that may be unknown. null is "not known"; it is never zero and never free. */
const money = z.number().min(0).finite().nullable();

export const tierSchema = z.object({ upTo: z.number().positive().nullable(), price: money }).strict();

export const rateSchema = z
  .object({
    component: z.enum(PRICE_COMPONENTS),
    /** Names an add-on when component is "feature" (for example "diarization"). */
    feature: z.string().min(1).max(80).optional(),
    unit: z.enum(PRICE_UNITS),
    /** The price per unit; null when unknown. With tiers it is the base rate used when no tier matches. */
    price: money,
    /** graduated: each tier prices only the units inside it; volume: the tier reached prices every unit. */
    tierMode: z.enum(['graduated', 'volume']).optional(),
    /** Ordered ascending by upTo; the last tier's upTo is null (no limit). Units are the rate's own unit. */
    tiers: z.array(tierSchema).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((rate, ctx) => {
    if (rate.component === 'feature' && !rate.feature) ctx.addIssue({ code: 'custom', message: 'a feature rate needs a feature name', path: ['feature'] });
    if (rate.component !== 'feature' && rate.feature) ctx.addIssue({ code: 'custom', message: 'only a feature rate has a feature name', path: ['feature'] });
    if (rate.tiers) {
      if (!rate.tierMode) ctx.addIssue({ code: 'custom', message: 'tiers need a tierMode (graduated or volume)', path: ['tierMode'] });
      let last = 0;
      rate.tiers.forEach((tier, i) => {
        const final = i === rate.tiers!.length - 1;
        if (final && tier.upTo !== null) ctx.addIssue({ code: 'custom', message: 'the last tier must have upTo null', path: ['tiers', i, 'upTo'] });
        if (!final && tier.upTo === null) ctx.addIssue({ code: 'custom', message: 'only the last tier may have upTo null', path: ['tiers', i, 'upTo'] });
        if (tier.upTo !== null) {
          if (tier.upTo <= last) ctx.addIssue({ code: 'custom', message: 'tiers must be in ascending order', path: ['tiers', i, 'upTo'] });
          last = tier.upTo;
        }
      });
    }
    const unitOk: Record<string, readonly string[]> = {
      input_tokens: ['per_million_tokens', 'per_thousand_tokens'],
      output_tokens: ['per_million_tokens', 'per_thousand_tokens'],
      cached_input_tokens: ['per_million_tokens', 'per_thousand_tokens'],
      audio_input_tokens: ['per_million_tokens', 'per_thousand_tokens'],
      audio_output_tokens: ['per_million_tokens', 'per_thousand_tokens'],
      audio_duration: ['per_second', 'per_minute', 'per_audio_hour'],
      characters: ['per_character', 'per_thousand_characters', 'per_million_characters'],
    };
    const allowed = unitOk[rate.component];
    if (allowed && !allowed.includes(rate.unit)) ctx.addIssue({ code: 'custom', message: `${rate.component} cannot be priced ${rate.unit} (use ${allowed.join(', ')})`, path: ['unit'] });
  });
export type Rate = z.infer<typeof rateSchema>;

export const VERIFICATION_STATUSES = ['verified', 'imported-unverified', 'unverified', 'manual', 'negotiated'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const priceSchema = z
  .object({
    id: idSchema,
    providerId: idSchema,
    modelKind: z.enum(['llm', 'stt', 'tts', 'provider']),
    /** The model id this price is for (or the provider id for a provider-level add-on). */
    modelId: idSchema,
    /** More model ids of the same kind that cost the same (two slugs that point at one provider model). */
    appliesTo: z.array(idSchema).max(20).optional(),
    plan: z.string().min(1).max(80),
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code such as USD'),
    rates: z.array(rateSchema).min(1).max(20),
    sourceUrl: httpsUrl.nullable(),
    /** When someone compared this price with the source. */
    verifiedAt: isoInstant.nullable(),
    effectiveFrom: isoInstant.nullable(),
    status: z.enum(VERIFICATION_STATUSES),
    /** An account-specific or hand-entered price: automatic updates never replace it without an explicit per-price override. */
    protected: z.boolean().default(false),
    /** True when the figure depends on the account's plan or volume. */
    planSpecific: z.boolean().default(false),
    notes: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status === 'verified') {
      if (!p.sourceUrl) ctx.addIssue({ code: 'custom', message: 'a verified price needs its source URL', path: ['sourceUrl'] });
      if (!p.verifiedAt) ctx.addIssue({ code: 'custom', message: 'a verified price needs the date it was verified', path: ['verifiedAt'] });
    }
    if (p.status === 'negotiated' && !p.protected) ctx.addIssue({ code: 'custom', message: 'a negotiated price must be protected', path: ['protected'] });
  });
export type PriceEntry = z.infer<typeof priceSchema>;

/** An official pricing page the operator can check on request. */
export const pricingSourceSchema = z
  .object({
    providerId: idSchema,
    url: httpsUrl,
    label: z.string().max(80).optional(),
    /** html: a page a person reads (change detection only); json: a feed in the documented shape; manual: reviewed JSON import only. */
    format: z.enum(['html', 'json', 'manual']),
    /** When someone last confirmed this URL is the provider's own pricing page; null when it was not confirmed. */
    confirmedAt: isoInstant.nullable().optional(),
    note: z.string().max(300).optional(),
  })
  .strict();
export type PricingSource = z.infer<typeof pricingSourceSchema>;

export interface PricingFile {
  prices: PriceEntry[];
  sources: PricingSource[];
}

export const pricingFileHeadSchema = z.object({ schemaVersion: z.literal(PRICING_SCHEMA_VERSION), prices: z.array(z.unknown()).default([]), sources: z.array(z.unknown()).default([]) }).strict();
