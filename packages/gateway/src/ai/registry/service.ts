import { FetchLike } from '../providers/http.js';
import { OpenAiCompatibleLlm } from '../providers/llm.js';
import { AiProviderError } from '../providers/types.js';
import { describePrice } from './pricing-engine.js';
import { PriceEntry } from './pricing-schema.js';
import { PricingStore } from './pricing-store.js';
import { PricingUpdater } from './pricing-updater.js';
import { PROTOCOLS, protocolById, Probe } from './protocols.js';
import { ModelEntry, ProviderEntry, Stage } from './schema.js';
import { MutationResult, RegistryStore, Selection } from './store.js';
import { buildLlmSpec, Registry, ResolvedLlm, ValidationIssue } from './registry.js';

export type CredentialState = 'stored' | 'env' | 'missing';

export interface RegistryServiceDeps {
  registry: RegistryStore;
  pricing: PricingStore;
  updater: PricingUpdater;
  /** The plaintext key, for a read-only test only. Never returned, never logged. */
  secret: (name: string) => string | undefined;
  /** Where a credential comes from, without its value. */
  credentialState: (name: string) => CredentialState;
  selection: () => Selection | null;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export type TestStatus = 'ok' | 'no-credential' | 'invalid-credential' | 'unreachable' | 'not-implemented' | 'disabled' | 'model-not-listed' | 'model-rejected' | 'unverified';
export interface TestResult {
  ok: boolean;
  status: TestStatus;
  detail: string;
  checkedAt: string;
  /** Set when a real request was made to the model: the HTTP outcome and timings (milliseconds). */
  request?: { httpStatus: number | null; firstTokenMs: number | null; totalMs: number; replyChars: number };
}

const TEST_TIMEOUT_MS = 8000;

/**
 * A read-only, unbilled listing request that shows whether a provider's key is accepted: the probe of the first working protocol a
 * model of that provider uses. Used for the Hub's tests and to validate a stored credential that is not one of the built-in names.
 */
export function probeForProvider(registry: Registry, providerId: string, key: string, cartesiaVersion?: string, modelKey?: { stage: Stage; id: string }): Probe | null {
  const provider = registry.provider(providerId);
  if (!provider) return null;
  for (const entry of registry.file.models) {
    if (entry.provider !== providerId || (modelKey && (entry.stage !== modelKey.stage || entry.id !== modelKey.id))) continue;
    const resolved = entry.stage === 'llm' ? registry.llm(entry.id) : entry.stage === 'stt' ? registry.stt(entry.id) : registry.tts(entry.id);
    const protocol = protocolById(entry.protocol);
    if (!resolved?.implemented || !protocol) continue;
    const probe = protocol.probe({ endpoint: resolved.endpoint ?? undefined, key, cartesiaVersion, authScheme: provider.authScheme });
    if (probe) return probe;
  }
  return null;
}

export class ModelRegistryService {
  constructor(private readonly deps: RegistryServiceDeps) {}

  private get registry(): Registry {
    return this.deps.registry.registry;
  }
  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  // ------------------------------------------------------------------------------------------ the dashboard's view

  private priceSummary(price: PriceEntry | null) {
    return price
      ? { id: price.id, summary: describePrice(price), plan: price.plan, currency: price.currency, status: price.status, protected: price.protected, planSpecific: price.planSpecific, verifiedAt: price.verifiedAt, effectiveFrom: price.effectiveFrom, sourceUrl: price.sourceUrl }
      : null;
  }

  /**
   * Everything the Model Hub shows, from the live registry. No credential value is in it: a provider carries only the credential's
   * name and whether it is stored, in the environment or missing.
   */
  view() {
    const reg = this.registry;
    const pricing = this.deps.pricing.pricing;
    const credential = (name: string | null) => (name ? { name, state: this.deps.credentialState(name) } : null);
    const model = (entry: ModelEntry) => {
      const r = entry.stage === 'llm' ? reg.llm(entry.id) : entry.stage === 'stt' ? reg.stt(entry.id) : reg.tts(entry.id);
      const protocol = protocolById(entry.protocol);
      return {
        ...entry,
        builtin: reg.isDefaultModel(entry.stage, entry.id),
        modified: reg.modifiedModel(entry.stage, entry.id),
        resolved: r && {
          implemented: r.implemented,
          disabled: r.disabled,
          unavailableReason: r.unavailableReason,
          protocol: r.protocol,
          facts: r.facts,
          endpoint: r.endpoint ?? protocol?.endpoint.default ?? null,
          endpointIsDefault: r.endpoint === null,
          credential: credential(r.keyEnv),
        },
        price: this.priceSummary(pricing.priceFor(entry.stage, entry.id)),
      };
    };
    const models = reg.file.models.map(model);
    const load = this.deps.registry.lastLoad;
    return {
      schemaVersion: 2,
      persisted: this.deps.registry.persisted,
      load: { ok: load.ok, usingLastValid: load.usingLastValid, at: load.at, issues: load.issues },
      protocols: PROTOCOLS.map((p) => ({ id: p.id, stage: p.stage, title: p.title, summary: p.summary, endpoint: p.endpoint, facts: p.facts })),
      providers: reg.file.providers.map((p) => ({
        ...p,
        builtin: reg.isDefaultProvider(p.id),
        modified: reg.modifiedProvider(p.id),
        credentialState: credential(p.credential),
        models: reg.file.models.filter((m) => m.provider === p.id).length,
      })),
      models: { llm: models.filter((m) => m.stage === 'llm'), stt: models.filter((m) => m.stage === 'stt'), tts: models.filter((m) => m.stage === 'tts') },
      defaults: this.deps.selection(),
      pricing: {
        prices: pricing.prices.map((p) => ({ ...p, builtin: pricing.isDefault(p.id), modified: pricing.modified(p.id), summary: describePrice(p) })),
        sources: this.deps.updater.sources().map((s) => ({ ...s, check: this.deps.updater.checks().find((c) => c.url === s.url) ?? null })),
        proposals: this.deps.updater.proposals().map((p) => ({
          id: p.id,
          createdAt: p.createdAt,
          origin: p.origin,
          sourceUrl: p.sourceUrl,
          status: p.status,
          counts: { new: p.diffs.filter((d) => d.kind === 'new').length, changed: p.diffs.filter((d) => d.kind === 'changed').length, blocked: p.diffs.filter((d) => d.blocked).length, rejected: p.rejectedEntries.length },
        })),
      },
    };
  }

  // ------------------------------------------------------------------------------------------ changes

  private candidate(kind: 'provider' | 'model', entry: unknown): { providers: unknown[]; models: unknown[] } {
    const base = this.deps.registry.file();
    const doc = kind === 'provider' ? { providers: [entry] } : { models: [entry] };
    return this.deps.registry.mergeInto(base, doc);
  }

  /** Validate one entry exactly as saving would, without saving it. */
  validateEntry(kind: 'provider' | 'model', entry: unknown): { ok: boolean; issues: ValidationIssue[] } {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return { ok: false, issues: [{ collection: kind === 'provider' ? 'providers' : 'models', id: null, path: 'id', message: 'an entry needs an id' }] };
    const result = this.deps.registry.check(this.candidate(kind, entry));
    return { ok: result.ok, issues: result.issues };
  }

  validateDocument(doc: { providers?: unknown[]; models?: unknown[] }): { ok: boolean; issues: ValidationIssue[] } {
    const result = this.deps.registry.check(this.deps.registry.mergeInto(this.deps.registry.file(), doc));
    return { ok: result.ok, issues: result.issues };
  }

  createProvider(entry: unknown): MutationResult {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && this.registry.provider(id)) return { ok: false, issues: [{ collection: 'providers', id, path: 'id', message: `provider '${id}' already exists; edit it instead` }] };
    return this.deps.registry.upsertProvider(entry);
  }

  createModel(entry: unknown): MutationResult {
    const { id, stage } = (entry ?? {}) as { id?: unknown; stage?: unknown };
    if (typeof id === 'string' && (stage === 'llm' || stage === 'stt' || stage === 'tts') && this.registry.model(stage, id)) {
      return { ok: false, issues: [{ collection: 'models', id, path: 'id', message: `${stage} model '${id}' already exists; edit it instead` }] };
    }
    return this.deps.registry.upsertModel(entry);
  }

  /** Change fields of an existing provider (the whole result is validated). */
  updateProvider(id: string, patch: Record<string, unknown>): MutationResult {
    const current = this.registry.provider(id);
    if (!current) return { ok: false, issues: [{ collection: 'providers', id, path: 'id', message: `no provider '${id}'` }] };
    if ('id' in patch && patch.id !== id) return { ok: false, issues: [{ collection: 'providers', id, path: 'id', message: 'an id cannot be changed (it is the stable reference)' }] };
    return this.deps.registry.upsertProvider({ ...current, ...patch, id });
  }

  /** Change fields of an existing model. `options` is replaced as a whole when given (it is the protocol's own settings). */
  updateModel(stage: Stage, id: string, patch: Record<string, unknown>): MutationResult {
    const current = this.registry.model(stage, id);
    if (!current) return { ok: false, issues: [{ collection: 'models', id, path: 'id', message: `no ${stage} model '${id}'` }] };
    if (('id' in patch && patch.id !== id) || ('stage' in patch && patch.stage !== stage)) return { ok: false, issues: [{ collection: 'models', id, path: 'id', message: 'an id and a stage cannot be changed (they are the stable reference)' }] };
    return this.deps.registry.upsertModel({ ...current, ...patch, id, stage });
  }

  removeProvider(id: string): MutationResult {
    return this.deps.registry.removeProvider(id);
  }
  removeModel(stage: Stage, id: string): MutationResult {
    return this.deps.registry.removeModel(stage, id);
  }
  importDocument(doc: { providers?: unknown[]; models?: unknown[] }): MutationResult {
    return this.deps.registry.importDocument(doc);
  }
  restoreDefaults(ids?: Parameters<RegistryStore['restoreDefaults']>[0]): MutationResult {
    return this.deps.registry.restoreDefaults(ids);
  }

  // ------------------------------------------------------------------------------------------ connection tests

  private async probe(provider: ProviderEntry, probe: Probe | null): Promise<{ result: TestResult; models: string[] | null }> {
    const at = this.now();
    const fail = (status: TestStatus, detail: string): { result: TestResult; models: null } => ({ result: { ok: false, status, detail, checkedAt: at }, models: null });
    if (!provider.enabled) return fail('disabled', 'The provider is switched off in the registry');
    if (!provider.credential) return fail('no-credential', 'The provider names no credential');
    const key = this.deps.secret(provider.credential);
    if (!key) return fail('no-credential', `${provider.credential} is not set (store it on the AI page or in the environment)`);
    if (!probe) return fail('not-implemented', 'No read-only check exists for this provider’s protocols');
    const withKey = probe;
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? ((url, init) => fetch(url, init));
    try {
      const response = await fetchImpl(withKey.url, { method: 'GET', headers: withKey.headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        return fail('invalid-credential', `${provider.name} rejected the key (HTTP ${response.status})`);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return fail('unreachable', `${provider.name} answered HTTP ${response.status}; the key could not be confirmed either way`);
      }
      let models: string[] | null = null;
      if (withKey.lists) {
        try {
          const body = (await response.json()) as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> };
          const list = body.data ?? body.models;
          if (Array.isArray(list)) models = list.map((m) => String(m?.id ?? '')).filter(Boolean);
        } catch {
          models = null;
        }
      } else void response.body?.cancel().catch(() => {});
      return { result: { ok: true, status: 'ok', detail: `${provider.name} accepted the key (HTTP ${response.status})`, checkedAt: at }, models };
    } catch (error) {
      const why = (error as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      return fail('unreachable', `${provider.name} ${why}; the key could not be checked`);
    }
  }

  /** Read-only: lists the provider's models or voices with the key. Nothing is generated, so nothing is billed. */
  async testProvider(id: string): Promise<TestResult> {
    const provider = this.registry.provider(id);
    if (!provider) return { ok: false, status: 'not-implemented', detail: `No provider '${id}'`, checkedAt: this.now() };
    if (!this.registry.file.models.some((m) => m.provider === id && m.protocol !== null)) return { ok: false, status: 'not-implemented', detail: 'No model of this provider has a protocol that is implemented yet', checkedAt: this.now() };
    const key = provider.credential ? this.deps.secret(provider.credential) : undefined;
    return (await this.probe(provider, key ? probeForProvider(this.registry, id, key) : null)).result;
  }

  /**
   * One very short real request to a language model, through the same client a call uses (same URL, key presentation, request
   * fields and streaming), with a small token limit, a timeout and no retry (a retry would bill twice). Reports the HTTP outcome and
   * the time to the first token and to the whole reply. Billed, so callers must have been told.
   */
  private async generateLlm(resolved: ResolvedLlm): Promise<TestResult> {
    const at = this.now();
    const fail = (status: TestStatus, detail: string, request?: TestResult['request']): TestResult => ({ ok: false, status, detail, checkedAt: at, ...(request ? { request } : {}) });
    if (!resolved.keyEnv) return fail('no-credential', 'The provider names no credential');
    const key = this.deps.secret(resolved.keyEnv);
    if (!key) return fail('no-credential', `${resolved.keyEnv} is not set (store it on the AI page or in the environment)`);
    let spec;
    try {
      spec = buildLlmSpec(resolved, {});
    } catch (error) {
      return fail('not-implemented', (error as Error).message);
    }
    if (!spec) return fail('not-implemented', resolved.unavailableReason ?? 'Not implemented');
    const llm = new OpenAiCompatibleLlm({
      spec,
      apiKey: key,
      fetchImpl: this.deps.fetchImpl ?? ((url, init) => fetch(url, init)),
      firstTokenTimeoutMs: 15_000,
      totalTimeoutMs: 25_000,
      maxRetries: 0,
      maxTokens: 16,
    });
    const scrub = (text: string) => text.split(key).join('[redacted]');
    const started = performance.now();
    let first: number | null = null;
    let text = '';
    try {
      for await (const chunk of llm.stream({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }] }, AbortSignal.timeout(30_000))) {
        if (chunk.delta) {
          first ??= performance.now() - started;
          text += chunk.delta;
        }
      }
    } catch (error) {
      const totalMs = Math.round(performance.now() - started);
      const httpStatus = error instanceof AiProviderError && typeof error.details.status === 'number' ? error.details.status : null;
      const message = scrub(error instanceof Error ? error.message : 'the request failed');
      const request = { httpStatus, firstTokenMs: first === null ? null : Math.round(first), totalMs, replyChars: text.length };
      if (httpStatus === 401 || httpStatus === 403) return fail('invalid-credential', `${resolved.provider.name} rejected the key (HTTP ${httpStatus}): ${message}`, request);
      if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) return fail('model-rejected', `${resolved.provider.name} refused the request (HTTP ${httpStatus}): ${message}`, request);
      return fail('unreachable', `${resolved.provider.name}: ${message}`, request);
    }
    const request = { httpStatus: 200, firstTokenMs: first === null ? null : Math.round(first), totalMs: Math.round(performance.now() - started), replyChars: text.length };
    if (text.trim() === '') return fail('model-rejected', `${resolved.provider.name} answered HTTP 200 but the model returned no text`, request);
    return { ok: true, status: 'ok', detail: `${resolved.provider.name} answered HTTP 200 for '${resolved.model}': first token ${request.firstTokenMs} ms, complete in ${request.totalMs} ms (${request.replyChars} characters)`, checkedAt: at, request };
  }

  /**
   * Test a model. A language model gets a real (tiny, billed) request when `generate` is set; with it unset, and for speech models,
   * the check is read-only: the key is tried with the provider's listing request and, where it lists models, the id is looked for.
   */
  async testModel(stage: Stage, id: string, options: { generate?: boolean } = {}): Promise<TestResult> {
    const resolved = stage === 'llm' ? this.registry.llm(id) : stage === 'stt' ? this.registry.stt(id) : this.registry.tts(id);
    if (!resolved) return { ok: false, status: 'not-implemented', detail: `No ${stage} model '${id}'`, checkedAt: this.now() };
    if (!resolved.implemented) return { ok: false, status: 'not-implemented', detail: resolved.unavailableReason ?? 'Not implemented', checkedAt: this.now() };
    if (resolved.disabled) return { ok: false, status: 'disabled', detail: 'The model is switched off in the registry', checkedAt: this.now() };
    if (stage === 'llm' && options.generate) return this.generateLlm(resolved as ResolvedLlm);
    const key = resolved.keyEnv ? this.deps.secret(resolved.keyEnv) : undefined;
    const probe = key ? probeForProvider(this.registry, resolved.providerId, key, undefined, { stage, id }) : null;
    const { result, models } = await this.probe(resolved.provider, probe);
    if (!result.ok) return result;
    const modelId = resolved.model ?? (stage === 'tts' ? (resolved as { models: string[] }).models[0] : null) ?? null;
    if (!modelId) return { ...result, status: 'unverified', detail: `${result.detail}. This entry has no model id to look for.` };
    if (!models) return { ...result, status: 'unverified', detail: `${result.detail}. This provider does not list its models for a key, so the model id was not checked.` };
    const bare = (s: string) => s.replace(/^models\//, '');
    if (models.some((m) => bare(m) === bare(modelId))) return { ...result, detail: `${result.detail}; the model '${modelId}' is listed` };
    return { ok: false, status: 'model-not-listed', detail: `${result.detail}, but '${modelId}' is not in its model list (some providers list only part of what they serve)`, checkedAt: this.now() };
  }
}
