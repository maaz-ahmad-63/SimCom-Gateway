import { OpenAiCompatibleSpec } from '../catalog.js';
import { defaultRegistry } from './defaults.js';
import { Facts, protocolById, Protocol, protocolsFor, suggestProtocols } from './protocols.js';
import { EnvValue, findSecretLike, ModelEntry, modelSchema, ProviderEntry, providerSchema, RegistryFile, Stage, VoiceOption } from './schema.js';

export interface ValidationIssue {
  collection: 'providers' | 'models' | 'document';
  id: string | null;
  path: string;
  message: string;
}

// ------------------------------------------------------------------------------------------ parsing

const idOf = (entry: unknown): string | null => (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : null);

function pathOf(index: number, path: Array<string | number>): string {
  return [`[${index}]`, ...path].join('.').replace('.[', '[');
}

/** Parse the two lists against the strict schemas (and each model's own protocol settings). Never throws: problems come back as issues. */
export function parseRegistry(raw: { providers: unknown[]; models: unknown[] }): { file: RegistryFile; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const file: RegistryFile = { providers: [], models: [] };
  const seenProviders = new Set<string>();
  raw.providers.forEach((entry, index) => {
    const secret = findSecretLike(entry);
    if (secret) return void issues.push({ collection: 'providers', id: idOf(entry), path: secret, message: 'looks like a secret value; a registry never holds keys (name the environment variable in credential instead)' });
    const parsed = providerSchema.safeParse(entry);
    if (!parsed.success) {
      for (const i of parsed.error.issues) issues.push({ collection: 'providers', id: idOf(entry), path: pathOf(index, i.path), message: i.message });
      return;
    }
    if (seenProviders.has(parsed.data.id)) return void issues.push({ collection: 'providers', id: parsed.data.id, path: `[${index}].id`, message: `duplicate provider id '${parsed.data.id}'` });
    seenProviders.add(parsed.data.id);
    file.providers.push(parsed.data);
  });
  const seenModels = new Set<string>();
  raw.models.forEach((entry, index) => {
    const secret = findSecretLike(entry);
    if (secret) return void issues.push({ collection: 'models', id: idOf(entry), path: secret, message: 'looks like a secret value; a registry never holds keys (name the environment variable in credential instead)' });
    const parsed = modelSchema.safeParse(entry);
    if (!parsed.success) {
      for (const i of parsed.error.issues) issues.push({ collection: 'models', id: idOf(entry), path: pathOf(index, i.path), message: i.message });
      return;
    }
    const model = parsed.data;
    const key = `${model.stage}/${model.id}`;
    if (seenModels.has(key)) return void issues.push({ collection: 'models', id: model.id, path: `[${index}].id`, message: `duplicate ${model.stage} model id '${model.id}'` });
    seenModels.add(key);
    // The protocol checks its own settings; unknown protocols are reported by the reference check below.
    const protocol = protocolById(model.protocol);
    if (protocol && protocol.stage === model.stage) {
      const options = protocol.options.safeParse(model.options);
      if (!options.success) {
        for (const i of options.error.issues) issues.push({ collection: 'models', id: model.id, path: pathOf(index, ['options', ...i.path]), message: i.message });
        return;
      }
      model.options = options.data;
    }
    file.models.push(model);
  });
  return { file, issues };
}

// ------------------------------------------------------------------------------------------ validation

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;
export function hostIsPrivate(host: string): boolean {
  if (PRIVATE_HOST.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host.includes(':') || host.startsWith('[');
}

/** Where a model connects, when the registry says: its own endpoint, or its provider's base URL for a base-URL protocol. */
function endpointOf(model: ModelEntry, provider: ProviderEntry | undefined, protocol: Protocol | undefined): string | null {
  if (model.endpoint) return model.endpoint;
  if (protocol?.endpoint.kind === 'base' && provider?.baseUrl) return provider.baseUrl;
  return null;
}

/** Everything the schema cannot see: references, protocol and stage, endpoints, names that must be unique. */
export function validateReferences(file: RegistryFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (collection: ValidationIssue['collection'], id: string, path: string, message: string) => issues.push({ collection, id, path, message });
  const providers = new Map(file.providers.map((p) => [p.id, p]));

  for (const p of file.providers) {
    if (p.baseUrl && hostIsPrivate(new URL(p.baseUrl).hostname)) add('providers', p.id, 'baseUrl', 'the API key is sent to this URL, so a local or private address is not allowed');
  }

  const llmNames = new Map<string, string>(); // ids and aliases of language models share one case-insensitive namespace
  const claim = (name: string, owner: string, path: string) => {
    const k = name.toLowerCase();
    const existing = llmNames.get(k);
    if (existing && existing !== owner) add('models', owner, path, `'${name}' is already used by '${existing}'`);
    else llmNames.set(k, owner);
  };

  for (const m of file.models) {
    const provider = providers.get(m.provider);
    if (!provider) add('models', m.id, 'provider', `unknown provider '${m.provider}'`);
    if (m.stage === 'llm') {
      claim(m.id, m.id, 'id');
      m.aliases.forEach((alias, i) => claim(alias, m.id, `aliases[${i}]`));
    } else if (m.aliases.length > 0) add('models', m.id, 'aliases', 'only language models have aliases');

    if (m.protocol === null) {
      if (!m.unavailableReason) add('models', m.id, 'unavailableReason', 'a model with no protocol must say why in unavailableReason');
      continue;
    }
    const protocol = protocolById(m.protocol);
    if (!protocol) {
      const options = suggestProtocols(m.stage, m.protocol);
      add('models', m.id, 'protocol', `no protocol '${m.protocol}'. ${m.stage} protocols: ${options.join(', ')}. A different wire format needs a protocol added to the gateway's code; a different model on one of these is configuration only`);
      continue;
    }
    if (protocol.stage !== m.stage) {
      add('models', m.id, 'protocol', `'${m.protocol}' is a ${protocol.stage} protocol, not ${m.stage}. ${m.stage} protocols: ${protocolsFor(m.stage).map((p) => p.id).join(', ')}`);
      continue;
    }
    const usable = !m.unavailableReason;
    if (usable && provider && !provider.credential) add('models', m.id, 'provider', `provider '${provider.id}' has no credential, and '${m.protocol}' needs an API key`);
    if (usable && m.stage !== 'tts' && !m.model) add('models', m.id, 'model', "the provider's model id is required");
    if (usable && m.stage === 'tts' && (m.options.sampleRates as number[] | undefined)?.length === 0) add('models', m.id, 'options.sampleRates', 'list the raw sample rates the provider documents (the gateway rate must be one of them)');
    const endpoint = endpointOf(m, provider, protocol);
    if (endpoint) {
      const url = new URL(endpoint);
      const scheme = url.protocol.replace(':', '');
      if (scheme !== protocol.endpoint.scheme) add('models', m.id, 'endpoint', `'${m.protocol}' connects over ${protocol.endpoint.scheme}; the endpoint must be a ${protocol.endpoint.scheme}:// URL`);
      if (hostIsPrivate(url.hostname)) add('models', m.id, 'endpoint', 'the API key is sent to this URL, so a local or private address is not allowed');
    } else if (usable && protocol.endpoint.default === null) {
      add('models', m.id, 'endpoint', `'${m.protocol}' needs a base URL: set baseUrl on provider '${m.provider}' or endpoint on this model`);
    }
  }
  return issues;
}

// ------------------------------------------------------------------------------------------ resolved views

export interface ResolvedBase {
  key: string;
  stage: Stage;
  label: string;
  provider: ProviderEntry;
  providerId: string;
  /** The provider's id, which is also the name call logs have always used (groq, telnyx, deepgram ...). */
  vendor: string;
  protocol: string | null;
  entry: ModelEntry;
  model: string | null;
  /** A protocol implements it and nothing marks it unavailable. */
  implemented: boolean;
  /** Implemented, but switched off (the model or its provider). */
  disabled: boolean;
  unavailableReason: string | null;
  /** The variable that holds the key. */
  keyEnv: string | null;
  /** Where it connects when the registry says (null: the protocol's own default). */
  endpoint: string | null;
  /** What the protocol can do (null with no protocol). */
  facts: Facts | null;
}
export interface ResolvedLlm extends ResolvedBase {
  family: string | null;
  tools: boolean;
}
export interface ResolvedStt extends ResolvedBase {
  params: { language?: 'multi' };
}
export interface ResolvedTts extends ResolvedBase {
  defaultVoice: string;
  /** The provider model ids that can be chosen (the first is the default). */
  models: string[];
  sampleRates: number[];
  providerName: string;
  voices: VoiceOption[];
}

function base(model: ModelEntry, provider: ProviderEntry): ResolvedBase {
  const protocol = protocolById(model.protocol);
  const implemented = protocol !== undefined && protocol.stage === model.stage && !model.unavailableReason;
  const tools = model.stage === 'llm' ? model.options.tools !== false : false;
  return {
    key: model.id,
    stage: model.stage,
    label: model.label,
    provider,
    providerId: provider.id,
    vendor: provider.id,
    protocol: model.protocol,
    entry: model,
    model: model.model,
    implemented,
    disabled: implemented && (!model.enabled || !provider.enabled),
    unavailableReason: implemented ? null : (model.unavailableReason ?? 'Not ported to the gateway yet'),
    keyEnv: provider.credential,
    endpoint: endpointOf(model, provider, protocol),
    facts: protocol ? { ...protocol.facts, functionCalling: protocol.facts.functionCalling && tools } : null,
  };
}

export class Registry {
  private readonly providerById: Map<string, ProviderEntry>;
  private readonly byStage: Record<Stage, Map<string, ModelEntry>>;
  private readonly llmAliases = new Map<string, string>();
  private readonly llmLower = new Map<string, string>();
  private readonly defaults: { providers: Map<string, string>; models: Map<string, string> };

  constructor(
    readonly file: RegistryFile,
    defaults: RegistryFile = file
  ) {
    this.providerById = new Map(file.providers.map((p) => [p.id, p]));
    this.byStage = { llm: new Map(), stt: new Map(), tts: new Map() };
    for (const m of file.models) this.byStage[m.stage].set(m.id, m);
    for (const m of this.byStage.llm.values()) {
      for (const alias of m.aliases) this.llmAliases.set(alias, m.id);
      this.llmLower.set(m.id.toLowerCase(), m.id);
    }
    this.defaults = {
      providers: new Map(defaults.providers.map((p) => [p.id, JSON.stringify(p)])),
      models: new Map(defaults.models.map((m) => [`${m.stage}/${m.id}`, JSON.stringify(m)])),
    };
  }

  // ---- what came with the gateway, and what has been changed -------------------------------------------
  isDefaultProvider(id: string): boolean {
    return this.defaults.providers.has(id);
  }
  isDefaultModel(stage: Stage, id: string): boolean {
    return this.defaults.models.has(`${stage}/${id}`);
  }
  modifiedProvider(id: string): boolean {
    const p = this.providerById.get(id);
    return !!p && this.defaults.providers.has(id) && this.defaults.providers.get(id) !== JSON.stringify(p);
  }
  modifiedModel(stage: Stage, id: string): boolean {
    const m = this.byStage[stage].get(id);
    return !!m && this.defaults.models.has(`${stage}/${id}`) && this.defaults.models.get(`${stage}/${id}`) !== JSON.stringify(m);
  }

  // ---- lookups -----------------------------------------------------------------------------------------
  provider(id: string): ProviderEntry | undefined {
    return this.providerById.get(id);
  }
  model(stage: Stage, id: string): ModelEntry | undefined {
    return this.byStage[stage].get(id);
  }

  /** A slug or alias (case-insensitive) to a language model id. */
  resolveLlmKey(setting: string): string | null {
    const requested = setting.trim();
    if (this.byStage.llm.has(requested)) return requested;
    const alias = this.llmAliases.get(requested);
    if (alias) return alias;
    const lower = requested.toLowerCase();
    for (const [a, target] of this.llmAliases) if (a.toLowerCase() === lower) return target;
    return this.llmLower.get(lower) ?? null;
  }

  llmKeys = (): string[] => [...this.byStage.llm.keys()];
  sttKeys = (): string[] => [...this.byStage.stt.keys()];
  ttsKeys = (): string[] => [...this.byStage.tts.keys()];

  private resolve(stage: Stage, key: string): ResolvedBase | null {
    const entry = this.byStage[stage].get(key);
    const provider = entry && this.providerById.get(entry.provider);
    return entry && provider ? base(entry, provider) : null;
  }

  llm(key: string): ResolvedLlm | null {
    const r = this.resolve('llm', key);
    return r ? { ...r, family: (r.entry.options.family as string | null | undefined) ?? null, tools: r.entry.options.tools !== false } : null;
  }
  stt(key: string): ResolvedStt | null {
    const r = this.resolve('stt', key);
    return r ? { ...r, params: { language: r.entry.options.language as 'multi' | undefined } } : null;
  }
  tts(key: string): ResolvedTts | null {
    const r = this.resolve('tts', key);
    if (!r) return null;
    const o = r.entry.options as { voice?: string; models?: string[]; sampleRates?: number[]; voices?: VoiceOption[] };
    const models = [...(r.model ? [r.model] : []), ...(o.models ?? []).filter((m) => m !== r.model)];
    return { ...r, defaultVoice: o.voice ?? '', models, sampleRates: o.sampleRates ?? [], providerName: r.provider.name, voices: o.voices ?? [] };
  }

  /** Every credential name the providers refer to (the encrypted store accepts exactly these plus the built-in ones, nothing else). */
  credentialNames(): Array<{ name: string; label: string }> {
    const out = new Map<string, string>();
    for (const p of this.file.providers) if (p.credential && !out.has(p.credential)) out.set(p.credential, p.name);
    return [...out].map(([name, label]) => ({ name, label }));
  }
}

/** The registry for a file, or the problems that stop it. */
export function buildRegistry(file: RegistryFile, defaults: RegistryFile = defaultRegistry()): { registry: Registry | null; issues: ValidationIssue[] } {
  const issues = validateReferences(file);
  return { registry: issues.length ? null : new Registry(file, defaults), issues };
}

/** The registry exactly as the gateway ships it: the original catalog. */
export function builtinRegistry(): Registry {
  const file = defaultRegistry();
  return new Registry(file, file);
}

// ------------------------------------------------------------------------------------------ LLM request spec

function envInteger(env: Record<string, string | undefined>, spec: EnvValue): number {
  const raw = (env[spec.$env] ?? '').trim();
  if (raw === '') return Number(spec.default);
  const value = Number(raw);
  const { min, max } = spec.integer!;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(spec.message ?? `${spec.$env} must be a whole number from ${min} to ${max}`);
  return value;
}

function envText(env: Record<string, string | undefined>, spec: EnvValue): string {
  const fallback = String(spec.default);
  const value = (env[spec.$env] ?? fallback).trim().toLowerCase() || fallback;
  if (spec.oneOf && !spec.oneOf.includes(value)) throw new Error(spec.message ?? `${spec.$env} must be one of ${spec.oneOf.join(', ')}`);
  return value;
}

const isEnvValue = (v: unknown): v is EnvValue => !!v && typeof v === 'object' && '$env' in (v as object);

/**
 * The request description the OpenAI-compatible client needs, built from registry data. Equal to what the original
 * openAiCompatibleSpec(family) returned for every built-in model (the tests compare them). Throws a plain Error naming a bad
 * environment variable; returns null when nothing implements the model.
 */
export function buildLlmSpec(resolved: ResolvedLlm, env: Record<string, string | undefined>): OpenAiCompatibleSpec | null {
  if (!resolved.implemented || resolved.protocol !== 'openai-chat' || !resolved.endpoint || !resolved.keyEnv || !resolved.model) return null;
  const options = resolved.entry.options as { body?: Record<string, unknown>; reasoningTokenAllowance?: number | EnvValue };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options.body ?? {})) body[k] = isEnvValue(v) ? (v.integer ? envInteger(env, v) : envText(env, v)) : v;
  const spec: OpenAiCompatibleSpec = {
    provider: resolved.providerId,
    baseUrl: resolved.endpoint,
    apiKeyEnv: resolved.keyEnv,
    model: resolved.model,
    body,
    toolCalling: resolved.tools,
  };
  if (resolved.provider.authScheme === 'basic') spec.authScheme = 'basic';
  const allowance = options.reasoningTokenAllowance;
  if (allowance !== undefined) spec.reasoningTokenAllowance = isEnvValue(allowance) ? envInteger(env, allowance) : allowance;
  return spec;
}
