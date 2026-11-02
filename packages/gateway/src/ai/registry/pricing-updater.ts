import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FetchLike } from '../providers/http.js';
import { PriceEntry, priceSchema, PRICING_SCHEMA_VERSION } from './pricing-schema.js';
import { PricingStore } from './pricing-store.js';
import { hostIsPrivate, Registry } from './registry.js';
import { RegistryStore } from './store.js';

/**
 * Pricing research and review. Official pricing pages are written for people, not programs, so this never "extracts" a price from
 * a page. What it does:
 *   - check: fetch each configured official source on the operator's request (never per call), keep when it was checked and a
 *     hash of its text, and say when a page changed since the last check, so someone looks at it;
 *   - propose: turn a reviewed JSON file (pasted, or served in the documented pricing-feed shape) into a proposal that shows
 *     exactly what would change;
 *   - approve: only an approved proposal changes active pricing, never a protected (negotiated or hand-entered) price unless the
 *     approver names it, and the previous price is kept in history.
 * Nothing here invents or guesses a price: an unknown price stays null.
 */

export const pricingFeedSchema = z.object({ schemaVersion: z.literal(PRICING_SCHEMA_VERSION), provider: z.string().max(80).optional(), prices: z.array(z.unknown()).max(500) }).strict();

export interface SourceCheck {
  providerId: string;
  url: string;
  format: 'html' | 'json' | 'manual';
  checkedAt: string;
  ok: boolean;
  httpStatus: number | null;
  bytes: number | null;
  contentHash: string | null;
  previousHash: string | null;
  /** true: the text differs from the previous check; false: same; null: there was no previous check or this one failed. */
  changed: boolean | null;
  error: string | null;
  /** A feed source that produced a proposal. */
  proposalId: string | null;
}

export type DiffKind = 'new' | 'changed' | 'unchanged';
export interface PriceDiff {
  priceId: string;
  kind: DiffKind;
  /** What differs (rates, currency, plan, source, dates, status ...). */
  fields: string[];
  /** The current price is protected (negotiated or hand-entered): approving does not apply this unless the approver names it. */
  protected: boolean;
  /** Why this change is not applied by a plain approval (null: it is). */
  blocked: string | null;
  before: PriceEntry | null;
  after: PriceEntry;
}

export interface Proposal {
  id: string;
  createdAt: string;
  origin: 'json-feed' | 'manual-import';
  sourceUrl: string | null;
  note: string | null;
  diffs: PriceDiff[];
  /** Entries that failed validation: shown to the reviewer, never applied. */
  rejectedEntries: Array<{ id: string | null; message: string }>;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  decisionNote: string | null;
  appliedIds: string[];
}

export interface HistoryItem {
  priceId: string;
  replacedAt: string;
  proposalId: string;
  entry: PriceEntry;
}

interface State {
  checks: Record<string, SourceCheck>;
  proposals: Proposal[];
  history: HistoryItem[];
}

const emptyState = (): State => ({ checks: {}, proposals: [], history: [] });
const MAX_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PROPOSALS = 50;
const MAX_HISTORY = 500;

export interface PricingUpdaterOptions {
  /** The model registry: a proposal may only name a provider and model that exist in it. */
  registry: RegistryStore;
  /** The prices: where an approved proposal is applied. Separate from the registry, so a price never blocks a model change. */
  pricing: PricingStore;
  /** Where checks, proposals and history are kept (pricing-state.json); null for memory only. */
  dir: string | null;
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** The shortest time between two checks of the same URL, so the sources are never hammered. */
  minCheckIntervalMs?: number;
}

export class PricingError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** The words of a page, for comparing one check with the next. Scripts, styles and tags are dropped. */
export function pageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RATE_FIELDS = (p: PriceEntry) => JSON.stringify(p.rates);

export function diffFields(before: PriceEntry, after: PriceEntry): string[] {
  const fields: string[] = [];
  if (RATE_FIELDS(before) !== RATE_FIELDS(after)) fields.push('rates');
  for (const key of ['currency', 'plan', 'sourceUrl', 'verifiedAt', 'effectiveFrom', 'status', 'protected', 'planSpecific', 'providerId', 'modelKind', 'modelId'] as const) {
    if (before[key] !== after[key]) fields.push(key);
  }
  return fields;
}

const isProtected = (p: PriceEntry) => p.protected || p.status === 'negotiated' || p.status === 'manual';
const hasKnown = (p: PriceEntry) => p.rates.some((r) => r.price !== null || r.tiers?.some((t) => t.price !== null));

export class PricingUpdater {
  private state: State = emptyState();
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: PricingUpdaterOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.load();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  // ------------------------------------------------------------------------------------------ state file

  private file(): string | null {
    return this.options.dir ? path.join(this.options.dir, 'pricing-state.json') : null;
  }

  private load(): void {
    const file = this.file();
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<State>;
      this.state = { checks: parsed.checks ?? {}, proposals: parsed.proposals ?? [], history: parsed.history ?? [] };
    } catch {
      this.state = emptyState(); // missing or damaged: starts empty; no price is ever taken from this file
    }
  }

  private save(): void {
    const file = this.file();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.state.proposals = this.state.proposals.slice(-MAX_PROPOSALS);
    this.state.history = this.state.history.slice(-MAX_HISTORY);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  checks(): SourceCheck[] {
    return Object.values(this.state.checks);
  }
  proposals(): Proposal[] {
    return [...this.state.proposals].reverse();
  }
  proposal(id: string): Proposal | undefined {
    return this.state.proposals.find((p) => p.id === id);
  }
  history(): HistoryItem[] {
    return [...this.state.history].reverse();
  }

  // ------------------------------------------------------------------------------------------ checking sources

  /** The distinct official sources of the registry's providers. */
  sources(): Array<{ providerId: string; url: string; format: 'html' | 'json' | 'manual' }> {
    const seen = new Set<string>();
    const out: Array<{ providerId: string; url: string; format: 'html' | 'json' | 'manual' }> = [];
    for (const source of this.options.pricing.pricing.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      out.push({ providerId: source.providerId, url: source.url, format: source.format });
    }
    return out;
  }

  /**
   * Fetch the sources, on the operator's request. A redirect is reported, never followed (a source must not send the request
   * somewhere else), and a local or private address is refused.
   */
  async check(options: { providerIds?: string[]; force?: boolean } = {}): Promise<SourceCheck[]> {
    const minInterval = this.options.minCheckIntervalMs ?? 10 * 60_000;
    const wanted = this.sources().filter((s) => !options.providerIds || options.providerIds.includes(s.providerId));
    const results: SourceCheck[] = [];
    for (const source of wanted) {
      const previous = this.state.checks[source.url];
      if (!options.force && previous && this.now().getTime() - Date.parse(previous.checkedAt) < minInterval) {
        results.push(previous); // checked a moment ago: the same answer, no new request
        continue;
      }
      if (source.format === 'manual') continue;
      const result = await this.fetchOne(source, previous ?? null);
      this.state.checks[source.url] = result;
      results.push(result);
    }
    this.save();
    return results;
  }

  private async fetchOne(source: { providerId: string; url: string; format: 'html' | 'json' | 'manual' }, previous: SourceCheck | null): Promise<SourceCheck> {
    const base: SourceCheck = { providerId: source.providerId, url: source.url, format: source.format, checkedAt: this.now().toISOString(), ok: false, httpStatus: null, bytes: null, contentHash: null, previousHash: previous?.contentHash ?? null, changed: null, error: null, proposalId: null };
    let host: string;
    try {
      host = new URL(source.url).hostname;
    } catch {
      return { ...base, error: 'not a valid URL' };
    }
    if (hostIsPrivate(host)) return { ...base, error: 'a local or private address is not fetched' };
    try {
      const response = await this.fetchImpl(source.url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: source.format === 'json' ? 'application/json' : 'text/html,text/plain', 'User-Agent': 'ai-caller-gateway-pricing-check' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const target = response.headers.get('location');
        void response.body?.cancel().catch(() => {});
        return { ...base, httpStatus: response.status, error: `redirected${target ? ` to ${new URL(target, source.url).hostname}` : ''}: update the source URL in the provider's pricingSources` };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { ...base, httpStatus: response.status, error: response.status === 403 ? 'the site refused an automated request (HTTP 403): use a reviewed manual import for this provider' : `HTTP ${response.status}` };
      }
      const text = await readLimited(response, MAX_BYTES);
      if (text === null) return { ...base, httpStatus: response.status, error: `the page is larger than ${MAX_BYTES} bytes` };
      const normalised = source.format === 'json' ? text.trim() : pageText(text);
      const contentHash = sha256(normalised);
      const result: SourceCheck = { ...base, ok: true, httpStatus: response.status, bytes: text.length, contentHash, changed: previous?.contentHash ? previous.contentHash !== contentHash : null };
      if (source.format === 'json') {
        try {
          const proposal = this.proposeFromJson(JSON.parse(text), 'json-feed', source.url, `feed checked ${base.checkedAt}`);
          result.proposalId = proposal.id;
        } catch (error) {
          result.ok = false;
          result.error = `the feed is not usable: ${(error as Error).message}`;
        }
      }
      return result;
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      return { ...base, error: reason };
    }
  }

  // ------------------------------------------------------------------------------------------ proposals

  /** A reviewed JSON file, as { schemaVersion, entries: [PriceEntry...] }, or a bare array of entries. */
  proposeFromJson(json: unknown, origin: Proposal['origin'], sourceUrl: string | null, note: string | null): Proposal {
    const entries = Array.isArray(json) ? json : pricingFeedSchema.safeParse(json).success ? (json as { prices: unknown[] }).prices : null;
    if (!entries) throw new PricingError(`expected { "schemaVersion": ${PRICING_SCHEMA_VERSION}, "prices": [...] } or an array of price entries`);
    if (entries.length === 0) throw new PricingError('there are no price entries to review');
    return this.propose(entries, origin, sourceUrl, note);
  }

  propose(entries: unknown[], origin: Proposal['origin'], sourceUrl: string | null, note: string | null): Proposal {
    const registry = this.options.registry.registry;
    const pricing = this.options.pricing.pricing;
    const rejectedEntries: Proposal['rejectedEntries'] = [];
    const diffs: PriceDiff[] = [];
    const seen = new Set<string>();
    for (const raw of entries) {
      const id = (raw as { id?: unknown } | null)?.id;
      const parsed = priceSchema.safeParse(raw);
      if (!parsed.success) {
        rejectedEntries.push({ id: typeof id === 'string' ? id : null, message: parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ') });
        continue;
      }
      const after = parsed.data;
      if (seen.has(after.id)) {
        rejectedEntries.push({ id: after.id, message: 'duplicate id in this proposal' });
        continue;
      }
      seen.add(after.id);
      const problem = this.referenceProblem(registry, after);
      if (problem) {
        rejectedEntries.push({ id: after.id, message: problem });
        continue;
      }
      diffs.push(this.diffOne(pricing.price(after.id), after));
    }
    const proposal: Proposal = {
      id: crypto.randomUUID(),
      createdAt: this.now().toISOString(),
      origin,
      sourceUrl,
      note,
      diffs,
      rejectedEntries,
      status: 'pending',
      decidedAt: null,
      decisionNote: null,
      appliedIds: [],
    };
    this.state.proposals.push(proposal);
    this.save();
    return proposal;
  }

  private referenceProblem(registry: Registry, price: PriceEntry): string | null {
    if (!registry.provider(price.providerId)) return `unknown provider '${price.providerId}'`;
    const known = price.modelKind === 'provider' ? registry.provider(price.modelId) : registry.model(price.modelKind, price.modelId);
    return known ? null : `unknown ${price.modelKind} '${price.modelId}'`;
  }

  private diffOne(before: PriceEntry | null, after: PriceEntry): PriceDiff {
    if (!before) return { priceId: after.id, kind: 'new', fields: ['rates'], protected: false, blocked: null, before: null, after };
    const fields = diffFields(before, after);
    const prot = isProtected(before);
    let blocked: string | null = null;
    if (fields.length > 0) {
      if (prot) blocked = 'the current price is negotiated or hand-entered (protected)';
      else if (hasKnown(before) && !hasKnown(after)) blocked = 'this would make a known price unknown';
    }
    return { priceId: after.id, kind: fields.length === 0 ? 'unchanged' : 'changed', fields, protected: prot, blocked, before, after };
  }

  // ------------------------------------------------------------------------------------------ decisions

  reject(id: string, note: string | null = null): Proposal {
    const proposal = this.mustPending(id);
    proposal.status = 'rejected';
    proposal.decidedAt = this.now().toISOString();
    proposal.decisionNote = note;
    this.save();
    return proposal;
  }

  private mustPending(id: string): Proposal {
    const proposal = this.proposal(id);
    if (!proposal) throw new PricingError('no such proposal', 404);
    if (proposal.status !== 'pending') throw new PricingError(`this proposal was already ${proposal.status}`, 409);
    return proposal;
  }

  /**
   * Apply an approved proposal. The changes are compared with the CURRENT prices again, so a price edited since the proposal was
   * made is not overwritten with stale data. Protected prices and price-erasing changes are applied only when named in
   * `overrideIds`. The replaced entries are kept in history. All-or-nothing: if the resulting registry is invalid nothing changes.
   */
  approve(id: string, options: { overrideIds?: string[]; onlyIds?: string[]; note?: string | null } = {}): { applied: string[]; skipped: Array<{ id: string; reason: string }>; proposal: Proposal } {
    const proposal = this.mustPending(id);
    const overrides = new Set(options.overrideIds ?? []);
    const pricingStore = this.options.pricing;
    const next = pricingStore.mutableFile();
    const pricing = next.prices as PriceEntry[];
    const applied: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const replaced: PriceEntry[] = [];
    for (const diff of proposal.diffs) {
      if (diff.kind === 'unchanged') continue;
      if (options.onlyIds && !options.onlyIds.includes(diff.priceId)) {
        skipped.push({ id: diff.priceId, reason: 'not selected' });
        continue;
      }
      const current = pricingStore.pricing.price(diff.priceId);
      // Stale: what is active now is not what the reviewer saw.
      if (JSON.stringify(current) !== JSON.stringify(diff.before)) {
        skipped.push({ id: diff.priceId, reason: 'the price changed after this proposal was made; re-run the check or import again' });
        continue;
      }
      const fresh = this.diffOne(current, diff.after);
      if (fresh.blocked && !overrides.has(diff.priceId)) {
        skipped.push({ id: diff.priceId, reason: fresh.blocked });
        continue;
      }
      if (current) replaced.push(current);
      const at = pricing.findIndex((p) => p.id === diff.priceId);
      if (at >= 0) pricing[at] = diff.after;
      else pricing.push(diff.after);
      applied.push(diff.priceId);
    }
    if (applied.length > 0) {
      const result = pricingStore.apply(next);
      if (!result.ok) throw new PricingError(`the prices were not applied: ${result.issues.map((i) => `${i.id ?? i.collection}: ${i.message}`).join('; ')}`, 422);
      const at = this.now().toISOString();
      for (const entry of replaced) this.state.history.push({ priceId: entry.id, replacedAt: at, proposalId: proposal.id, entry });
    }
    proposal.status = 'approved';
    proposal.decidedAt = this.now().toISOString();
    proposal.decisionNote = options.note ?? null;
    proposal.appliedIds = applied;
    this.save();
    return { applied, skipped, proposal };
  }
}

async function readLimited(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

