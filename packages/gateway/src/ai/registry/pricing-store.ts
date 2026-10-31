import path from 'node:path';
import { setActivePricing } from './active.js';
import { defaultPricing } from './defaults.js';
import { lastValidPath, readJsonFile, snapshotJson, writeJsonAtomic } from './files.js';
import { PricingFile, pricingFileHeadSchema, PRICING_SCHEMA_VERSION } from './pricing-schema.js';
import { builtinPricing, parsePricing, Pricing } from './pricing-view.js';
import { ValidationIssue } from './registry.js';

export const PRICING_FILE = 'pricing.json';

export interface PricingStoreOptions {
  dir: string | null;
  now?: () => Date;
}

/**
 * pricing.json: the prices and sources. Same rules as the registry: until the first change it is the defaults; a change is validated
 * as a whole, written atomically and kept as a last-good copy; an invalid file leaves the previous prices in force. Pricing is separate
 * from the model registry, so a price problem can never block a model change (and the reverse).
 */
export class PricingStore {
  private current: Pricing = builtinPricing();
  private pristine = true;
  private report: { ok: boolean; issues: ValidationIssue[]; at: string } = { ok: true, issues: [], at: new Date(0).toISOString() };

  constructor(private readonly options: PricingStoreOptions) {}

  get pricing(): Pricing {
    return this.current;
  }
  get lastLoad() {
    return this.report;
  }

  private install(pricing: Pricing): void {
    this.pristine = false;
    this.current = pricing;
    setActivePricing(pricing);
  }

  file(): PricingFile {
    return structuredClone(this.current.file);
  }

  private tryFile(file: string): { pricing: Pricing | null; issues: ValidationIssue[] } {
    const read = readJsonFile(file);
    if (read.kind === 'missing') return { pricing: builtinPricing(), issues: [] };
    const name = path.basename(file);
    if (read.kind === 'error') return { pricing: null, issues: [{ collection: 'document', id: null, path: name, message: read.message }] };
    const head = pricingFileHeadSchema.safeParse(read.value);
    if (!head.success) return { pricing: null, issues: [{ collection: 'document', id: null, path: name, message: `must be { "schemaVersion": ${PRICING_SCHEMA_VERSION}, "prices": [...], "sources": [...] }` }] };
    const parsed = parsePricing({ prices: head.data.prices, sources: head.data.sources });
    return parsed.issues.length ? { pricing: null, issues: parsed.issues } : { pricing: new Pricing(parsed.file, defaultPricing()), issues: [] };
  }

  load(): { ok: boolean; issues: ValidationIssue[]; at: string } {
    const at = (this.options.now?.() ?? new Date()).toISOString();
    const dir = this.options.dir;
    if (!dir) {
      this.install(builtinPricing());
      return (this.report = { ok: true, issues: [], at });
    }
    const first = this.tryFile(path.join(dir, PRICING_FILE));
    if (first.pricing) {
      this.install(first.pricing);
      return (this.report = { ok: true, issues: [], at });
    }
    if (this.pristine) {
      const backup = this.tryFile(lastValidPath(dir, PRICING_FILE));
      if (backup.pricing) this.install(backup.pricing);
    }
    return (this.report = { ok: false, issues: first.issues, at });
  }

  check(next: { prices: unknown[]; sources: unknown[] }): { ok: boolean; issues: ValidationIssue[]; pricing: Pricing | null } {
    const parsed = parsePricing(next);
    return parsed.issues.length ? { ok: false, issues: parsed.issues, pricing: null } : { ok: true, issues: [], pricing: new Pricing(parsed.file, defaultPricing()) };
  }

  /** Validate, write and install. Nothing changes unless the whole result is valid. */
  apply(next: { prices: unknown[]; sources: unknown[] }): { ok: boolean; issues: ValidationIssue[] } {
    const checked = this.check(next);
    if (!checked.ok || !checked.pricing) return { ok: false, issues: checked.issues };
    const dir = this.options.dir;
    if (dir) {
      const document = { schemaVersion: PRICING_SCHEMA_VERSION, prices: checked.pricing.file.prices, sources: checked.pricing.file.sources };
      try {
        writeJsonAtomic(path.join(dir, PRICING_FILE), document);
      } catch (error) {
        return { ok: false, issues: [{ collection: 'document', id: null, path: PRICING_FILE, message: `could not be saved: ${(error as Error).message}` }] };
      }
      snapshotJson(dir, PRICING_FILE, document);
    }
    this.install(checked.pricing);
    return { ok: true, issues: [] };
  }

  /** The prices (and sources) as a starting point for a change. */
  mutableFile(): { prices: unknown[]; sources: unknown[] } {
    return this.file();
  }
}
