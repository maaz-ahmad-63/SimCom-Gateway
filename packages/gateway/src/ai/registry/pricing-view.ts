import { defaultPricing } from './defaults.js';
import { PriceEntry, priceSchema, PricingFile, pricingSourceSchema } from './pricing-schema.js';
import { hostIsPrivate, ValidationIssue } from './registry.js';
import { findSecretLike } from './schema.js';

/** Prices and the pricing sources, as one immutable view. A model needs no entry here: with none, its price is simply unknown. */
export class Pricing {
  private readonly byId: Map<string, PriceEntry>;
  private readonly byModel = new Map<string, PriceEntry>();

  constructor(
    readonly file: PricingFile,
    private readonly defaults: PricingFile = file
  ) {
    this.byId = new Map(file.prices.map((p) => [p.id, p]));
    for (const p of file.prices) {
      for (const id of [p.modelId, ...(p.appliesTo ?? [])]) if (!this.byModel.has(`${p.modelKind}/${id}`)) this.byModel.set(`${p.modelKind}/${id}`, p);
    }
  }

  get prices(): PriceEntry[] {
    return this.file.prices;
  }
  get sources() {
    return this.file.sources;
  }
  price(id: string): PriceEntry | null {
    return this.byId.get(id) ?? null;
  }
  /** The price for a model of a stage, or null (unknown: never assumed free). */
  priceFor(kind: 'llm' | 'stt' | 'tts', modelId: string): PriceEntry | null {
    return this.byModel.get(`${kind}/${modelId}`) ?? null;
  }
  isDefault(id: string): boolean {
    return this.defaults.prices.some((p) => p.id === id);
  }
  modified(id: string): boolean {
    const d = this.defaults.prices.find((p) => p.id === id);
    const c = this.byId.get(id);
    return !!d && !!c && JSON.stringify(d) !== JSON.stringify(c);
  }
}

export const builtinPricing = (): Pricing => {
  const file = defaultPricing();
  return new Pricing(file, file);
};

/** Parse a pricing document against the strict schemas. Never throws. */
export function parsePricing(raw: { prices: unknown[]; sources: unknown[] }): { file: PricingFile; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const file: PricingFile = { prices: [], sources: [] };
  const seen = new Set<string>();
  const label = (i: number, p: Array<string | number>) => [`[${i}]`, ...p].join('.').replace('.[', '[');
  raw.prices.forEach((entry, i) => {
    const id = (entry as { id?: unknown } | null)?.id;
    const secret = findSecretLike(entry);
    if (secret) return void issues.push({ collection: 'document', id: typeof id === 'string' ? id : null, path: `prices.${secret}`, message: 'looks like a secret value' });
    const parsed = priceSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push({ collection: 'document', id: typeof id === 'string' ? id : null, path: `prices${label(i, issue.path)}`, message: issue.message });
      return;
    }
    if (seen.has(parsed.data.id)) return void issues.push({ collection: 'document', id: parsed.data.id, path: `prices[${i}].id`, message: `duplicate price id '${parsed.data.id}'` });
    seen.add(parsed.data.id);
    file.prices.push(parsed.data);
  });
  raw.sources.forEach((entry, i) => {
    const parsed = pricingSourceSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) issues.push({ collection: 'document', id: null, path: `sources${label(i, issue.path)}`, message: issue.message });
      return;
    }
    if (hostIsPrivate(new URL(parsed.data.url).hostname)) return void issues.push({ collection: 'document', id: null, path: `sources[${i}].url`, message: 'a local or private address is not allowed' });
    file.sources.push(parsed.data);
  });
  return { file, issues };
}

