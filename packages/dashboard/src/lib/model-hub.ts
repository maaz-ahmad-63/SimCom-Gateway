/**
 * The AI Model Hub's types and pure helpers. Everything the hub lists (providers, models, voices, prices, protocols) comes from
 * GET /api/ai/registry; nothing here is a list of models. The types mirror the gateway's response.
 */

export type Stage = 'llm' | 'stt' | 'tts';
export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export type EntryKind = 'provider' | 'model';

/** What a protocol can do (stated by the gateway's code, not claimed by JSON). */
export interface Facts {
  streaming: boolean;
  batch: boolean;
  functionCalling: boolean;
  structuredOutput: boolean;
  voiceSelection: boolean;
  languages: 'any' | string[];
  cancellation: boolean;
}

export interface CredentialRef {
  name: string;
  state: 'stored' | 'env' | 'missing';
}

export interface HubProvider {
  id: string;
  name: string;
  /** The NAME of the environment variable holding the key. Never the key. */
  credential: string | null;
  baseUrl?: string | null;
  /** How the key is presented to an OpenAI-compatible API (default Bearer). */
  authScheme?: 'bearer' | 'basic';
  enabled: boolean;
  note?: string;
  builtin: boolean;
  modified: boolean;
  credentialState: CredentialRef | null;
  models: number;
}

export interface HubPriceSummary {
  id: string;
  summary: string;
  plan: string;
  currency: string;
  status: string;
  protected: boolean;
  planSpecific: boolean;
  verifiedAt: string | null;
  effectiveFrom: string | null;
  sourceUrl: string | null;
}

export interface VoiceOption {
  name: string;
  id?: string;
  label?: string;
}

export interface HubModel {
  id: string;
  stage: Stage;
  provider: string;
  protocol: string | null;
  /** The provider's own model id (for text-to-speech, the default model). */
  model: string | null;
  label: string;
  enabled: boolean;
  aliases: string[];
  endpoint?: string | null;
  /** The protocol's own settings: request fields for chat, voices and sample rates for text-to-speech ... */
  options: Record<string, unknown>;
  unavailableReason?: string | null;
  builtin: boolean;
  modified: boolean;
  resolved: {
    implemented: boolean;
    disabled: boolean;
    unavailableReason: string | null;
    protocol: string | null;
    facts: Facts | null;
    /** Where it connects: the model's endpoint, the provider's base URL, or the protocol's own default. */
    endpoint: string | null;
    endpointIsDefault: boolean;
    credential: CredentialRef | null;
  } | null;
  price: HubPriceSummary | null;
}

export interface HubPriceEntry {
  id: string;
  providerId: string;
  modelKind: string;
  modelId: string;
  appliesTo?: string[];
  plan: string;
  currency: string;
  rates: Array<{ component: string; feature?: string; unit: string; price: number | null; tierMode?: string; tiers?: Array<{ upTo: number | null; price: number | null }> }>;
  sourceUrl: string | null;
  verifiedAt: string | null;
  effectiveFrom: string | null;
  status: string;
  protected: boolean;
  planSpecific: boolean;
  builtin: boolean;
  modified: boolean;
  summary: string;
}

export interface SourceCheck {
  providerId: string;
  url: string;
  format: string;
  checkedAt: string;
  ok: boolean;
  httpStatus: number | null;
  contentHash: string | null;
  changed: boolean | null;
  error: string | null;
  proposalId: string | null;
}

export interface HubProtocol {
  id: string;
  stage: Stage;
  title: string;
  summary: string;
  endpoint: { kind: 'base' | 'full'; scheme: 'https' | 'wss'; default: string | null };
  facts: Facts;
}

export interface HubView {
  schemaVersion: number;
  persisted: boolean;
  load: { ok: boolean; usingLastValid: boolean; at: string; issues: Array<{ collection: string; id: string | null; path: string; message: string }> };
  protocols: HubProtocol[];
  providers: HubProvider[];
  models: { llm: HubModel[]; stt: HubModel[]; tts: HubModel[] };
  defaults: { llm: string; stt: string; tts: string; voice: string } | null;
  pricing: {
    prices: HubPriceEntry[];
    sources: Array<{ providerId: string; url: string; format: string; check: SourceCheck | null }>;
    proposals: Array<{ id: string; createdAt: string; origin: string; sourceUrl: string | null; status: 'pending' | 'approved' | 'rejected'; counts: { new: number; changed: number; blocked: number; rejected: number } }>;
  };
}

export interface ValidationIssue {
  collection: string;
  id: string | null;
  path: string;
  message: string;
}

export interface TestResult {
  ok: boolean;
  status: string;
  detail: string;
  checkedAt: string;
  /** Present when a real request was made to the model. */
  request?: { httpStatus: number | null; firstTokenMs: number | null; totalMs: number; replyChars: number };
}

/** What the operator is told before a language-model test, which sends a real request that the provider bills. */
export const LLM_TEST_NOTICE = 'This sends one very short request to the model (about 16 tokens at most) using the key you stored, and the provider bills it. It does not touch a call.';

export interface PriceDiff {
  priceId: string;
  kind: 'new' | 'changed' | 'unchanged';
  fields: string[];
  protected: boolean;
  blocked: string | null;
  before: HubPriceEntry | null;
  after: HubPriceEntry;
}

export interface ProposalDetail {
  id: string;
  createdAt: string;
  origin: string;
  sourceUrl: string | null;
  note: string | null;
  diffs: PriceDiff[];
  rejectedEntries: Array<{ id: string | null; message: string }>;
  status: 'pending' | 'approved' | 'rejected';
  appliedIds: string[];
}

export const STAGE_LABEL: Record<Stage, string> = { llm: 'Language models', stt: 'Speech-to-text', tts: 'Text-to-speech' };

export const modelsOf = (view: HubView, stage: Stage): HubModel[] => view.models[stage];

/** The protocols a model of this stage can use (any provider can serve any of them: the provider only names a credential and an address). */
export const protocolOptions = (view: HubView, stage: Stage): HubProtocol[] => view.protocols.filter((p) => p.stage === stage);

/** Every provider can be chosen for a model; none is hidden because of its vendor or what it served before. */
export const providerOptions = (view: HubView): HubProvider[] => view.providers;

/** The key the AI settings use for a stage's default. */
export const defaultKeyOf = (view: HubView, stage: Stage): string | null => view.defaults?.[stage] ?? null;

export function modelStatus(m: HubModel): { tone: Tone; label: string } {
  const r = m.resolved;
  if (!r) return { tone: 'bad', label: 'broken reference' };
  if (!r.implemented) return { tone: 'neutral', label: 'no protocol' };
  if (!m.enabled || r.disabled) return { tone: 'neutral', label: 'off' };
  if (r.credential && r.credential.state === 'missing') return { tone: 'warn', label: `needs ${r.credential.name}` };
  return { tone: 'good', label: 'ready' };
}

export function credentialNote(c: CredentialRef | null): { tone: Tone; text: string } {
  if (!c) return { tone: 'neutral', text: 'no credential' };
  if (c.state === 'stored') return { tone: 'good', text: `${c.name}: stored (encrypted)` };
  if (c.state === 'env') return { tone: 'good', text: `${c.name}: from the environment` };
  return { tone: 'warn', text: `${c.name}: not set (add it under API Keys)` };
}

/** A short list of what a protocol can do, for badges. These are facts about the gateway's code, never a claim in the JSON. */
export function capabilityLabels(f: Facts): string[] {
  const out: string[] = [];
  out.push(f.streaming ? 'streaming' : 'no streaming');
  out.push(f.batch ? 'batch' : 'no batch');
  if (f.functionCalling) out.push('function calling');
  if (f.structuredOutput) out.push('structured output');
  if (f.voiceSelection) out.push('voice selection');
  out.push(f.languages === 'any' ? 'any language' : `${f.languages.length} language${f.languages.length === 1 ? '' : 's'}`);
  out.push(f.cancellation ? 'cancellable' : 'not cancellable');
  return out;
}

export function priceStatus(price: HubPriceSummary | null): { tone: Tone; label: string } {
  if (!price) return { tone: 'neutral', label: 'price unknown' };
  switch (price.status) {
    case 'verified':
      return { tone: 'good', label: price.verifiedAt ? `verified ${price.verifiedAt.slice(0, 10)}` : 'verified' };
    case 'negotiated':
      return { tone: 'good', label: 'negotiated' };
    case 'manual':
      return { tone: 'neutral', label: 'entered by hand' };
    case 'imported-unverified':
      return { tone: 'warn', label: 'imported, not re-verified' };
    default:
      return { tone: 'warn', label: 'unverified' };
  }
}

/** How the endpoint reads in the table. */
export function endpointNote(m: HubModel): string {
  const r = m.resolved;
  if (!r || !r.endpoint) return 'no endpoint needed';
  return r.endpointIsDefault ? `${r.endpoint} (the protocol's default)` : r.endpoint;
}

// ---- voices -------------------------------------------------------------------------------------------

export const voicesOf = (m: HubModel): VoiceOption[] => (Array.isArray(m.options.voices) ? (m.options.voices as VoiceOption[]) : []);

/** The options with one voice added (or replaced by name). */
export function withVoice(m: HubModel, voice: VoiceOption): Record<string, unknown> {
  const rest = voicesOf(m).filter((v) => v.name.toLowerCase() !== voice.name.toLowerCase());
  return { ...m.options, voices: [...rest, voice] };
}
export function withoutVoice(m: HubModel, name: string): Record<string, unknown> {
  return { ...m.options, voices: voicesOf(m).filter((v) => v.name !== name) };
}

// ---- entry templates and the JSON editor --------------------------------------------------------------

/** A starting point for a new entry. Ids and choices are the operator's; nothing here is a model list. */
export function entryTemplate(kind: EntryKind, stage: Stage | null, view: HubView): Record<string, unknown> {
  if (kind === 'provider') return { id: '', name: '', credential: '', baseUrl: 'https://', enabled: true };
  const s: Stage = stage ?? 'llm';
  const options: Record<Stage, Record<string, unknown>> = {
    llm: { body: {}, tools: false },
    stt: {},
    tts: { voice: '', sampleRates: [8000, 16000], voices: [] },
  };
  return {
    id: '',
    stage: s,
    provider: view.providers[0]?.id ?? '',
    protocol: view.protocols.find((p) => p.stage === s)?.id ?? '',
    model: '',
    label: '',
    enabled: true,
    options: options[s],
  };
}

/** The editable copy of a stored entry: everything the gateway returned except what it derived. */
export function editableEntry(item: Record<string, unknown>): Record<string, unknown> {
  const derived = new Set(['builtin', 'modified', 'resolved', 'price', 'credentialState', 'models']);
  return Object.fromEntries(Object.entries(item).filter(([k]) => !derived.has(k)));
}

export function parseJsonObject(text: string): { value: Record<string, unknown> | null; error: string | null } {
  if (text.trim() === '') return { value: null, error: 'Enter the entry as JSON' };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null, error: 'The entry must be a JSON object' };
    return { value: parsed as Record<string, unknown>, error: null };
  } catch (e) {
    return { value: null, error: `Not valid JSON: ${(e as Error).message}` };
  }
}

/** Set one top-level field of the JSON text; returns the text unchanged when it does not parse (the editor shows why). */
export function setJsonField(text: string, field: string, value: unknown): string {
  const { value: obj } = parseJsonObject(text);
  if (!obj) return text;
  const next = { ...obj };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return JSON.stringify(next, null, 2);
}

export function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((i) => `${i.id ? `${i.id}: ` : ''}${i.path && i.path !== '$' ? `${i.path}: ` : ''}${i.message}`);
}

/** Why a model cannot be made the default right now, or null when it can. */
export function defaultBlocker(m: HubModel, current: string | null): string | null {
  if (m.id === current) return 'already the default';
  if (!m.resolved || !m.resolved.implemented) return m.resolved?.unavailableReason ?? 'no protocol implements it';
  if (!m.enabled || m.resolved.disabled) return 'switched off';
  return null;
}

/** What can be done to an entry: default entries are never deleted, only switched off or reset; your own can be deleted. */
export function removeAction(e: { builtin: boolean; modified: boolean }): { label: string; confirm: string; reset: boolean } | null {
  if (!e.builtin) return { label: 'Delete', confirm: 'Delete this entry? Anything that refers to it must be changed first.', reset: false };
  if (e.modified) return { label: 'Reset to default', confirm: 'Discard your changes and restore the default definition?', reset: true };
  return null;
}

// ---- pricing review ---------------------------------------------------------------------------------

export function describeRates(p: Pick<HubPriceEntry, 'rates' | 'currency'> | null): string {
  if (!p) return '(none)';
  return p.rates
    .map((r) => {
      const what = r.component === 'feature' ? (r.feature ?? 'feature') : r.component.replace(/_/g, ' ');
      const amount = r.tiers ? 'tiered' : r.price === null ? 'unknown' : `${p.currency} ${r.price}`;
      return `${what}: ${amount} ${r.unit.replace(/_/g, ' ')}`;
    })
    .join('; ');
}

export interface DiffRow {
  priceId: string;
  kind: PriceDiff['kind'];
  before: string;
  after: string;
  changed: string;
  /** Applied by a plain approval. */
  applicable: boolean;
  /** Needs the approver to name it explicitly. */
  needsOverride: boolean;
  reason: string | null;
}

export function diffRows(diffs: PriceDiff[]): DiffRow[] {
  return diffs.map((d) => ({
    priceId: d.priceId,
    kind: d.kind,
    before: d.before ? `${describeRates(d.before)} (${d.before.status})` : '—',
    after: `${describeRates(d.after)} (${d.after.status})`,
    changed: d.fields.join(', ') || 'nothing',
    applicable: d.kind !== 'unchanged' && !d.blocked,
    needsOverride: d.kind !== 'unchanged' && d.blocked !== null,
    reason: d.blocked,
  }));
}

export function sourceCheckNote(check: SourceCheck | null): { tone: Tone; text: string } {
  if (!check) return { tone: 'neutral', text: 'never checked' };
  if (!check.ok) return { tone: 'bad', text: `check failed: ${check.error ?? `HTTP ${check.httpStatus}`}` };
  if (check.changed === true) return { tone: 'warn', text: 'the page changed since the last check: review it and import any new prices' };
  if (check.changed === false) return { tone: 'good', text: 'unchanged since the last check' };
  return { tone: 'neutral', text: 'checked once; nothing to compare with yet' };
}
