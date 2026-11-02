import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetActiveRegistry } from '../../src/ai/registry/active.js';
import { describePrice, estimatePrice, rateCost } from '../../src/ai/registry/pricing-engine.js';
import { PricingError, PricingUpdater } from '../../src/ai/registry/pricing-updater.js';
import { PriceEntry, priceSchema } from '../../src/ai/registry/pricing-schema.js';
import { PricingStore } from '../../src/ai/registry/pricing-store.js';
import { RegistryStore } from '../../src/ai/registry/store.js';
import { buildCatalog } from '../../src/ai/catalog-view.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { estimateCostUsd, priceNote } from '../../src/ai/pricing.js';
import { aiEnv } from './helpers.js';

beforeEach(() => resetActiveRegistry());
afterEach(() => resetActiveRegistry());

const price = (over: Partial<PriceEntry> = {}): PriceEntry =>
  priceSchema.parse({
    id: 'price.test',
    providerId: 'groq',
    modelKind: 'llm',
    modelId: 'groq_gpt_oss_20b',
    plan: 'standard',
    currency: 'USD',
    rates: [
      { component: 'input_tokens', unit: 'per_million_tokens', price: 1 },
      { component: 'output_tokens', unit: 'per_million_tokens', price: 2 },
    ],
    sourceUrl: null,
    verifiedAt: null,
    effectiveFrom: null,
    status: 'unverified',
    ...over,
  });

describe('pricing definitions', () => {
  it('requires currency, billing unit, provider, model, plan, source, dates and status on every price', () => {
    const entry = price();
    for (const field of ['providerId', 'modelId', 'plan', 'currency', 'sourceUrl', 'verifiedAt', 'effectiveFrom', 'status'] as const) expect(field in entry, field).toBe(true);
    expect(entry.rates.every((r) => typeof r.unit === 'string')).toBe(true);
    expect(priceSchema.safeParse({ ...entry, currency: 'dollars' }).success).toBe(false);
    expect(priceSchema.safeParse({ ...entry, plan: undefined }).success).toBe(false);
  });

  it('a verified price must name its source and when it was verified; a negotiated one must be protected', () => {
    expect(priceSchema.safeParse({ ...price(), status: 'verified' }).success).toBe(false);
    expect(priceSchema.safeParse({ ...price(), status: 'verified', sourceUrl: 'https://example.com/pricing', verifiedAt: '2026-10-30' }).success).toBe(true);
    expect(priceSchema.safeParse({ ...price(), status: 'negotiated' }).success).toBe(false);
    expect(priceSchema.safeParse({ ...price(), status: 'negotiated', protected: true }).success).toBe(true);
  });

  it('rejects a unit that does not suit the component, and malformed tiers', () => {
    const bad = (rate: unknown) => priceSchema.safeParse({ ...price(), rates: [rate] }).success;
    expect(bad({ component: 'input_tokens', unit: 'per_minute', price: 1 })).toBe(false);
    expect(bad({ component: 'audio_duration', unit: 'per_million_tokens', price: 1 })).toBe(false);
    expect(bad({ component: 'feature', unit: 'per_minute', price: 1 })).toBe(false); // a feature needs a name
    expect(bad({ component: 'characters', unit: 'per_character', price: 1, tiers: [{ upTo: 10, price: 1 }, { upTo: null, price: 1 }] })).toBe(false); // no tierMode
    expect(bad({ component: 'characters', unit: 'per_character', price: 1, tierMode: 'graduated', tiers: [{ upTo: 10, price: 1 }] })).toBe(false); // last tier must be open
    expect(bad({ component: 'characters', unit: 'per_character', price: 1, tierMode: 'graduated', tiers: [{ upTo: 10, price: 1 }, { upTo: 5, price: 1 }, { upTo: null, price: 1 }] })).toBe(false); // not ascending
    expect(bad({ component: 'characters', unit: 'per_character', price: 1, tierMode: 'graduated', tiers: [{ upTo: 10, price: 1 }, { upTo: null, price: 0.5 }] })).toBe(true);
  });
});

describe('cost estimation', () => {
  it('prices LLM input, output, cached-input and audio tokens, per million and per thousand', () => {
    const p = price({
      rates: [
        { component: 'input_tokens', unit: 'per_million_tokens', price: 2 },
        { component: 'output_tokens', unit: 'per_million_tokens', price: 8 },
        { component: 'cached_input_tokens', unit: 'per_million_tokens', price: 0.5 },
        { component: 'audio_input_tokens', unit: 'per_thousand_tokens', price: 0.01 },
        { component: 'audio_output_tokens', unit: 'per_thousand_tokens', price: 0.02 },
      ],
    });
    const e = estimatePrice(p, { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 2_000_000, audioInputTokens: 1000, audioOutputTokens: 500 });
    expect(e.total).toBeCloseTo(2 + 4 + 1 + 0.01 + 0.01, 10);
    expect(e.unknown).toEqual([]);
  });

  it('prices speech-to-text per second, per minute and per audio hour from the same duration', () => {
    const seconds = 5400; // 90 minutes
    const cost = (unit: 'per_second' | 'per_minute' | 'per_audio_hour', rate: number) => estimatePrice(price({ modelKind: 'stt', rates: [{ component: 'audio_duration', unit, price: rate }] }), { audioSeconds: seconds }).total;
    expect(cost('per_second', 0.0001)).toBeCloseTo(0.54, 10);
    expect(cost('per_minute', 0.006)).toBeCloseTo(0.54, 10);
    expect(cost('per_audio_hour', 0.36)).toBeCloseTo(0.54, 10);
  });

  it('prices text-to-speech per character, per thousand and per million characters', () => {
    const cost = (unit: 'per_character' | 'per_thousand_characters' | 'per_million_characters', rate: number) => estimatePrice(price({ modelKind: 'tts', rates: [{ component: 'characters', unit, price: rate }] }), { characters: 50_000 }).total;
    expect(cost('per_character', 0.00003)).toBeCloseTo(1.5, 10);
    expect(cost('per_thousand_characters', 0.03)).toBeCloseTo(1.5, 10);
    expect(cost('per_million_characters', 30)).toBeCloseTo(1.5, 10);
  });

  it('an unknown price is null, never free: the total is unknown and the component is named', () => {
    const p = price({ rates: [{ component: 'input_tokens', unit: 'per_million_tokens', price: 1 }, { component: 'output_tokens', unit: 'per_million_tokens', price: null }] });
    const e = estimatePrice(p, { inputTokens: 1_000_000, outputTokens: 1000 });
    expect(e.total).toBeNull();
    expect(e.unknown).toEqual(['output_tokens']);
    expect(e.lines.find((l) => l.component === 'output_tokens')!.cost).toBeNull();
    // a component with no usage does not make the estimate unknown
    expect(estimatePrice(p, { inputTokens: 1_000_000 }).total).toBe(1);
    // usage with no rate at all for it is unknown too, not zero
    expect(estimatePrice(p, { inputTokens: 10, cachedInputTokens: 10 }).total).toBeNull();
    expect(rateCost({ component: 'characters', unit: 'per_character', price: null }, 5)).toBeNull();
    expect(rateCost({ component: 'characters', unit: 'per_character', price: null }, 0)).toBe(0);
    expect(describePrice(p)).toMatch(/unknown/);
  });

  it('graduated tiers price each slice, volume tiers price everything at the tier reached, and an unknown tier makes it null', () => {
    const rate = (mode: 'graduated' | 'volume', last: number | null) => ({ component: 'characters' as const, unit: 'per_million_characters' as const, price: null, tierMode: mode, tiers: [{ upTo: 10, price: 30 }, { upTo: 100, price: 20 }, { upTo: null, price: last }] });
    expect(rateCost(rate('graduated', 10), 150)).toBe(10 * 30 + 90 * 20 + 50 * 10);
    expect(rateCost(rate('graduated', 10), 5)).toBe(150);
    expect(rateCost(rate('volume', 10), 150)).toBe(150 * 10);
    expect(rateCost(rate('volume', 10), 50)).toBe(50 * 20);
    expect(rateCost(rate('graduated', null), 150)).toBeNull();
    expect(rateCost(rate('graduated', null), 50)).toBe(10 * 30 + 40 * 20); // the unknown tier is not reached
  });

  it('prices optional add-ons only when used, in the add-on’s own unit, and treats an unpriced add-on as unknown', () => {
    const p = price({ modelKind: 'stt', rates: [{ component: 'audio_duration', unit: 'per_minute', price: 0.01 }, { component: 'feature', feature: 'diarization', unit: 'per_minute', price: 0.002 }] });
    expect(estimatePrice(p, { audioSeconds: 600 }).total).toBeCloseTo(0.1, 10);
    expect(estimatePrice(p, { audioSeconds: 600, features: { diarization: 10 } }).total).toBeCloseTo(0.12, 10);
    expect(estimatePrice(p, { audioSeconds: 600, features: { redaction: 10 } }).total).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------- updater

const SOURCE = 'https://pricing.example.com/groq';
const PRICE_ID = 'price.llm.groq_gpt_oss_20b';
function setup(options: { dir?: string | null; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; now?: () => Date; minCheckIntervalMs?: number } = {}) {
  const dir = options.dir ?? null;
  const registry = new RegistryStore({ dir });
  registry.load();
  const pricing = new PricingStore({ dir });
  pricing.load();
  const updater = new PricingUpdater({ registry, pricing, dir, fetchImpl: options.fetchImpl, now: options.now, minCheckIntervalMs: options.minCheckIntervalMs });
  return { registry, pricing, updater, price: (id: string) => pricing.pricing.price(id) };
}
/** Replace or add one price directly (what an operator editing pricing.json would do). */
function put(pricing: PricingStore, entry: unknown) {
  const file = pricing.mutableFile();
  const id = (entry as { id: string }).id;
  const at = (file.prices as Array<{ id: string }>).findIndex((p) => p.id === id);
  if (at >= 0) file.prices[at] = entry;
  else file.prices.push(entry);
  const result = pricing.apply(file);
  expect(result.ok, JSON.stringify(result.issues)).toBe(true);
}
const entry = (over: Record<string, unknown> = {}) => ({
  id: PRICE_ID,
  providerId: 'groq',
  modelKind: 'llm',
  modelId: 'groq_gpt_oss_20b',
  plan: 'standard',
  currency: 'USD',
  rates: [
    { component: 'input_tokens', unit: 'per_million_tokens', price: 0.08 },
    { component: 'output_tokens', unit: 'per_million_tokens', price: 0.32 },
  ],
  sourceUrl: SOURCE,
  verifiedAt: '2026-10-30',
  effectiveFrom: '2026-10-01',
  status: 'verified',
  ...over,
});

describe('pricing is separate and optional', () => {
  it('a model works with no price at all: its price is unknown, the estimate is null, nothing else changes', () => {
    const { pricing } = setup();
    const empty = pricing.apply({ prices: [], sources: [] });
    expect(empty.ok).toBe(true);
    expect(priceNote('llm', 'groq_qwen_3_8_27b')).toBe('no price in the source catalog');
    expect(estimateCostUsd({ stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'cartesia' }, { sttSeconds: 0, llmPromptTokens: 1000, llmCompletionTokens: 10, ttsChars: 0 })).toBeNull();
    const env = aiEnv({});
    expect(loadAiConfig(env).errors).toEqual([]);
    expect(createProviders(loadAiConfig(env).config, { env }).llm.name).toBe('groq');
    expect(buildCatalog({}).llm.every((m) => m.implemented || m.unavailableReason)).toBe(true);
  });

  it('prices are found by model id, including a second slug that shares the same provider model', () => {
    const { pricing } = setup();
    expect(pricing.pricing.priceFor('llm', 'groq_qwen_3_8_27b')!.id).toBe('price.llm.groq_qwen_3_8_27b');
    expect(pricing.pricing.priceFor('llm', 'groq_llama_3_3')!.id).toBe('price.llm.groq_qwen_3_8_27b'); // appliesTo
    expect(pricing.pricing.priceFor('llm', 'telnyx_kimi_k3')!.rates[0].price).toBe(2.7);
    expect(pricing.pricing.priceFor('llm', 'gemini_3_flash')).toBeNull(); // no price recorded: unknown, never free
    expect(pricing.pricing.priceFor('stt', 'nova-3')).toBeNull();
  });

  it('a damaged pricing file never affects which models can run, and a damaged registry file never affects prices', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-sep-'));
    try {
      fs.writeFileSync(path.join(dir, 'pricing.json'), '{ nope', 'utf8');
      const a = setup({ dir });
      expect(a.pricing.lastLoad.ok).toBe(false);
      expect(a.registry.lastLoad.ok).toBe(true);
      expect(a.registry.registry.llmKeys().length).toBeGreaterThan(10);
      expect(a.price('price.llm.telnyx_kimi_k3')).not.toBeNull(); // the defaults stay in force
      fs.rmSync(path.join(dir, 'pricing.json'));
      fs.writeFileSync(path.join(dir, 'registry.json'), '{ nope', 'utf8');
      const b = setup({ dir });
      expect(b.registry.lastLoad.ok).toBe(false);
      expect(b.pricing.lastLoad.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an approved price is stored in pricing.json only; registry.json is not written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-files-'));
    try {
      const { updater } = setup({ dir });
      const proposal = updater.proposeFromJson([entry()], 'manual-import', null, null);
      updater.approve(proposal.id);
      expect(fs.existsSync(path.join(dir, 'pricing.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'registry.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removing a model leaves its price as a harmless orphan; a price for a model that does not exist is refused in a proposal', () => {
    const { registry, pricing, updater } = setup();
    registry.upsertModel({ id: 'tmp_model', stage: 'llm', provider: 'groq', protocol: 'openai-chat', model: 'm', label: 'Tmp' });
    put(pricing, entry({ id: 'price.llm.tmp_model', modelId: 'tmp_model', status: 'unverified', sourceUrl: null, verifiedAt: null }));
    expect(registry.removeModel('llm', 'tmp_model').ok).toBe(true);
    expect(pricing.pricing.price('price.llm.tmp_model')).not.toBeNull();
    const proposal = updater.propose([entry({ id: 'price.llm.ghost', modelId: 'no_such_model' })], 'manual-import', null, null);
    expect(proposal.rejectedEntries[0].message).toMatch(/unknown llm 'no_such_model'/);
  });

  it('prices that are invalid are rejected as a whole and the previous prices stay', () => {
    const { pricing } = setup();
    const file = pricing.mutableFile();
    (file.prices as unknown[]).push({ ...entry({ id: 'price.bad' }), rates: [] });
    const result = pricing.apply(file);
    expect(result.ok).toBe(false);
    expect(pricing.pricing.price('price.bad')).toBeNull();
    expect(pricing.pricing.price('price.llm.telnyx_kimi_k3')).not.toBeNull();
  });
});

describe('pricing proposals: reviewed before they are applied', () => {
  it('shows what would change and applies nothing until it is approved', () => {
    const { pricing, updater } = setup();
    const before = JSON.stringify(pricing.pricing.price(PRICE_ID));
    const proposal = updater.proposeFromJson({ schemaVersion: 2, prices: [entry()] }, 'manual-import', null, 'reviewed by me');
    expect(proposal.status).toBe('pending');
    expect(proposal.diffs).toHaveLength(1);
    expect(proposal.diffs[0]).toMatchObject({ kind: 'changed', fields: expect.arrayContaining(['rates', 'sourceUrl', 'status']), blocked: null });
    expect(JSON.stringify(pricing.pricing.price(PRICE_ID))).toBe(before); // still the old price
    const result = updater.approve(proposal.id);
    expect(result.applied).toEqual([PRICE_ID]);
    const now = pricing.pricing.price(PRICE_ID)!;
    expect(now.rates[0].price).toBe(0.08);
    expect(now.status).toBe('verified');
    expect(pricing.pricing.modified(PRICE_ID)).toBe(true);
    expect(updater.history()[0]).toMatchObject({ priceId: PRICE_ID, proposalId: proposal.id });
    expect(updater.history()[0].entry.rates[0].price).toBe(0.075);
  });

  it('classifies new, changed and unchanged prices, and refuses entries that are invalid or refer to nothing, without applying them', () => {
    const { pricing, updater } = setup();
    const unchanged = JSON.parse(JSON.stringify(pricing.pricing.price('price.llm.groq_gpt_oss_120b')));
    const proposal = updater.propose(
      [unchanged, entry({ id: 'price.llm.new_one', modelId: 'groq_qwen_3_8_27b' }), { ...entry({ id: 'price.bad' }), rates: [] }, entry({ id: 'price.ghost', modelId: 'no_such_model' }), entry({ id: 'price.llm.new_one' })],
      'manual-import',
      null,
      null
    );
    expect(proposal.diffs.map((d) => [d.priceId, d.kind])).toEqual([
      ['price.llm.groq_gpt_oss_120b', 'unchanged'],
      ['price.llm.new_one', 'new'],
    ]);
    expect(proposal.rejectedEntries.map((r) => r.id)).toEqual(['price.bad', 'price.ghost', 'price.llm.new_one']);
    expect(updater.approve(proposal.id).applied).toEqual(['price.llm.new_one']);
    expect(pricing.pricing.price('price.llm.new_one')).not.toBeNull();
    expect(pricing.pricing.price('price.ghost')).toBeNull();
  });

  it('never silently overwrites a negotiated or hand-entered price; the approver must name it', () => {
    const { pricing, updater } = setup();
    put(pricing, entry({ status: 'negotiated', protected: true, plan: 'enterprise', sourceUrl: null, verifiedAt: null }));
    const proposal = updater.propose([entry({ plan: 'enterprise' })], 'manual-import', null, null);
    expect(proposal.diffs[0]).toMatchObject({ protected: true, blocked: expect.stringMatching(/negotiated or hand-entered/) });
    const plain = updater.approve(proposal.id);
    expect(plain.applied).toEqual([]);
    expect(plain.skipped[0]).toMatchObject({ id: PRICE_ID, reason: expect.stringMatching(/protected/) });
    expect(pricing.pricing.price(PRICE_ID)!.status).toBe('negotiated');
    const second = updater.propose([entry({ plan: 'enterprise' })], 'manual-import', null, null);
    expect(updater.approve(second.id, { overrideIds: [PRICE_ID] }).applied).toEqual([PRICE_ID]);
    expect(updater.history()[0].entry.status).toBe('negotiated');
  });

  it('does not turn a known price into an unknown one unless that is explicitly named', () => {
    const { pricing, updater } = setup();
    const unknown = entry({ rates: [{ component: 'input_tokens', unit: 'per_million_tokens', price: null }, { component: 'output_tokens', unit: 'per_million_tokens', price: null }], status: 'unverified', sourceUrl: null, verifiedAt: null });
    const proposal = updater.propose([unknown], 'manual-import', null, null);
    expect(proposal.diffs[0].blocked).toMatch(/known price unknown/);
    expect(updater.approve(proposal.id).applied).toEqual([]);
    expect(pricing.pricing.price(PRICE_ID)!.rates[0].price).toBe(0.075);
  });

  it('skips a price that changed after the proposal was made (stale), can reject, and applies only the selected prices', () => {
    const { pricing, updater } = setup();
    const a = updater.propose([entry()], 'manual-import', null, null);
    const b = updater.propose([entry({ rates: [{ component: 'input_tokens', unit: 'per_million_tokens', price: 0.09 }, { component: 'output_tokens', unit: 'per_million_tokens', price: 0.4 }] })], 'manual-import', null, null);
    expect(updater.approve(a.id).applied).toHaveLength(1);
    const stale = updater.approve(b.id);
    expect(stale.applied).toEqual([]);
    expect(stale.skipped[0].reason).toMatch(/changed after this proposal/);
    const c = updater.propose([entry({ plan: 'other' })], 'manual-import', null, null);
    expect(updater.reject(c.id, 'not right').status).toBe('rejected');
    expect(() => updater.approve(c.id)).toThrow(PricingError);
    const d = updater.propose([entry({ plan: 'p2' }), entry({ id: 'price.llm.groq_gpt_oss_120b', modelId: 'groq_gpt_oss_120b', plan: 'p2' })], 'manual-import', null, null);
    const only = updater.approve(d.id, { onlyIds: ['price.llm.groq_gpt_oss_120b'] });
    expect(only.applied).toEqual(['price.llm.groq_gpt_oss_120b']);
    expect(only.skipped).toEqual([{ id: PRICE_ID, reason: 'not selected' }]);
    expect(pricing.pricing.price(PRICE_ID)!.plan).toBe('standard');
  });

  it('proposals, checks and history survive a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-'));
    try {
      const first = setup({ dir });
      first.updater.approve(first.updater.propose([entry()], 'manual-import', null, null).id);
      const second = setup({ dir });
      expect(second.updater.proposals()[0].status).toBe('approved');
      expect(second.updater.history()).toHaveLength(1);
      expect(second.price(PRICE_ID)!.rates[0].price).toBe(0.08); // from pricing.json
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checking the official sources', () => {
  const page = (text: string, status = 200) => new Response(`<html><script>var x=1</script><body>${text}</body></html>`, { status });
  function withSource(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, now = () => new Date('2026-10-30T10:00:00Z'), format: 'html' | 'json' = 'html', url = SOURCE) {
    const ctx = setup({ fetchImpl, now, minCheckIntervalMs: 60_000 });
    const file = ctx.pricing.mutableFile();
    file.sources = [{ providerId: 'groq', url, format }];
    expect(ctx.pricing.apply(file).ok).toBe(true);
    return ctx;
  }

  it('is never run by loading a registry or estimating a cost: only an explicit check fetches', async () => {
    let calls = 0;
    const { updater } = withSource(async () => (calls++, page('a')));
    updater.sources();
    estimateCostUsd({ stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'cartesia' }, { sttSeconds: 1, llmPromptTokens: 1, llmCompletionTokens: 1, ttsChars: 1 });
    expect(calls).toBe(0);
    await updater.check({ providerIds: ['groq'] });
    expect(calls).toBe(1);
  });

  it('records when a source was checked and what its text hashed to, and notices when the page changed', async () => {
    let text = 'price 1';
    let clock = new Date('2026-10-30T10:00:00Z');
    const { updater } = withSource(async () => page(text), () => clock);
    const first = (await updater.check({ providerIds: ['groq'] }))[0];
    expect(first).toMatchObject({ ok: true, url: SOURCE, checkedAt: '2026-10-30T10:00:00.000Z', changed: null });
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    clock = new Date('2026-10-30T10:05:00Z');
    expect((await updater.check({ providerIds: ['groq'] }))[0].changed).toBe(false);
    text = 'price 2';
    clock = new Date('2026-10-30T10:10:00Z');
    const third = (await updater.check({ providerIds: ['groq'] }))[0];
    expect(third.changed).toBe(true);
    expect(third.previousHash).toBe(first.contentHash);
    expect(updater.proposals()).toEqual([]); // a changed page creates no price: a person has to review it
  });

  it('does not fetch the same source again within the minimum interval', async () => {
    let calls = 0;
    const { updater } = withSource(async () => (calls++, page('x')));
    await updater.check({ providerIds: ['groq'] });
    await updater.check({ providerIds: ['groq'] });
    expect(calls).toBe(1);
    await updater.check({ providerIds: ['groq'], force: true });
    expect(calls).toBe(2);
  });

  it('reports a refused request, a redirect (not followed) and an unreachable site plainly', async () => {
    const blocked = withSource(async () => new Response('no', { status: 403 }));
    expect((await blocked.updater.check({ force: true, providerIds: ['groq'] }))[0].error).toMatch(/refused an automated request.*manual import/);
    const redirected = withSource(async () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example.org/pricing' } }));
    expect((await redirected.updater.check({ force: true, providerIds: ['groq'] }))[0]).toMatchObject({ ok: false, httpStatus: 301, error: expect.stringMatching(/redirected to elsewhere\.example\.org/) });
    const down = withSource(async () => {
      throw new Error('ECONNRESET');
    });
    expect((await down.updater.check({ force: true, providerIds: ['groq'] }))[0]).toMatchObject({ ok: false, error: 'could not be reached' });
  });

  it('asks the site not to redirect and sends no credentials', async () => {
    const seen: RequestInit[] = [];
    const { updater } = withSource(async (_url, init) => (seen.push(init!), page('x')));
    await updater.check({ force: true, providerIds: ['groq'] });
    expect(seen[0].redirect).toBe('manual');
    expect(JSON.stringify(seen[0].headers)).not.toMatch(/authorization|api[-_]?key/i);
  });

  it('turns a feed in the documented JSON shape into a proposal, never into active prices', async () => {
    const feed = JSON.stringify({ schemaVersion: 2, prices: [entry()] });
    const ctx = withSource(async () => new Response(feed, { status: 200 }), undefined, 'json', 'https://feeds.example.com/prices.json');
    const check = (await ctx.updater.check({ providerIds: ['groq'], force: true }))[0];
    expect(check.proposalId).toBeTruthy();
    expect(ctx.updater.proposal(check.proposalId!)!.status).toBe('pending');
    expect(ctx.price(PRICE_ID)!.rates[0].price).toBe(0.075); // unchanged until approved
  });

  it('refuses a source on a local or private address', () => {
    const ctx = setup();
    const file = ctx.pricing.mutableFile();
    file.sources = [{ providerId: 'groq', url: 'https://127.0.0.1/pricing', format: 'html' }];
    const result = ctx.pricing.apply(file);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.issues)).toMatch(/local or private/);
  });

  it('lists the first eight vendors’ official pricing sources, none of them machine-readable', () => {
    const { updater } = setup();
    const sources = updater.sources();
    const hosts = sources.map((s) => new URL(s.url).hostname);
    for (const host of ['developers.openai.com', 'groq.com', 'ai.google.dev', 'telnyx.com', 'deepgram.com', 'soniox.com', 'inworld.ai', 'cartesia.ai']) expect(hosts, host).toContain(host);
    expect(sources.every((s) => s.format === 'html')).toBe(true);
  });
});
