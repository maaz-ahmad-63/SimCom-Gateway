import path from 'node:path';
import { DEFAULT_LLM_KEY, DEFAULT_STT_KEY, DEFAULT_TTS_KEY } from '../catalog.js';
import { setActiveRegistry } from './active.js';
import { defaultRegistry } from './defaults.js';
import { lastValidPath, readJsonFile, snapshotJson, writeJsonAtomic } from './files.js';
import { buildRegistry, builtinRegistry, parseRegistry, Registry, ValidationIssue } from './registry.js';
import { registryHeadSchema, RegistryFile, SCHEMA_VERSION, Stage } from './schema.js';

export interface Selection {
  llm: string;
  stt: string;
  tts: string;
  voice: string;
}

export interface LoadReport {
  ok: boolean;
  /** True when the file on disk was not valid and the last valid registry is still in use. */
  usingLastValid: boolean;
  issues: ValidationIssue[];
  at: string;
}

export interface MutationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface RegistryStoreOptions {
  /** The folder holding registry.json (and .last-valid). null: keep everything in memory (tests). */
  dir: string | null;
  /** The settings in force. A change that would break a usable selection is refused, so a save cannot take the agent down. */
  selection?: () => Selection | null;
  /** Called after a new registry became active (so the runtime can recompute its configuration). */
  onChange?: () => void;
  now?: () => Date;
}

export const REGISTRY_FILE = 'registry.json';

const stageKeys: Array<[Stage, string]> = [
  ['llm', DEFAULT_LLM_KEY],
  ['stt', DEFAULT_STT_KEY],
  ['tts', DEFAULT_TTS_KEY],
];

/**
 * The registry: one file, registry.json, holding the provider list and the flat model list. Until the first change the registry is the
 * built-in defaults (nothing is written at startup); the first change writes the whole list. Every change is validated as a whole
 * first; only a valid registry is written or installed, so a bad file, a bad import or a bad edit leaves the previous valid one in force.
 */
export class RegistryStore {
  private current: Registry = builtinRegistry();
  /** Nothing has been installed yet: the registry in use is just the defaults. */
  private pristine = true;
  private report: LoadReport = { ok: true, usingLastValid: false, issues: [], at: new Date(0).toISOString() };

  constructor(private readonly options: RegistryStoreOptions) {}

  get registry(): Registry {
    return this.current;
  }
  get lastLoad(): LoadReport {
    return this.report;
  }
  get persisted(): boolean {
    return this.options.dir !== null;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private install(registry: Registry): void {
    this.pristine = false;
    this.current = registry;
    setActiveRegistry(registry);
  }

  /** The current list, copied: a starting point for a change. */
  file(): RegistryFile {
    return structuredClone(this.current.file);
  }

  // ------------------------------------------------------------------------------------------ loading

  private tryFile(file: string): { registry: Registry | null; issues: ValidationIssue[] } {
    const read = readJsonFile(file);
    if (read.kind === 'missing') return { registry: builtinRegistry(), issues: [] };
    if (read.kind === 'error') return { registry: null, issues: [{ collection: 'document', id: null, path: path.basename(file), message: read.message }] };
    const head = registryHeadSchema.safeParse(read.value);
    if (!head.success) return { registry: null, issues: [{ collection: 'document', id: null, path: path.basename(file), message: `must be { "schemaVersion": ${SCHEMA_VERSION}, "providers": [...], "models": [...] }` }] };
    const parsed = parseRegistry({ providers: head.data.providers, models: head.data.models });
    if (parsed.issues.length) return { registry: null, issues: parsed.issues };
    const built = buildRegistry(parsed.file);
    return { registry: built.registry, issues: this.requiredDefaults(parsed.file, built.issues) };
  }

  /** The default selection of each stage must stay in the list (the gateway falls back to it). */
  private requiredDefaults(file: RegistryFile, issues: ValidationIssue[]): ValidationIssue[] {
    const out = [...issues];
    for (const [stage, key] of stageKeys) {
      if (!file.models.some((m) => m.stage === stage && m.id === key)) out.push({ collection: 'models', id: key, path: '$', message: `the default ${stage} model '${key}' must stay in the registry (switch it off instead of removing it)` });
    }
    return out;
  }

  /**
   * Read registry.json and install it if it is valid. If not, the registry already in use stays (and, at startup, the copy from the
   * last successful save is tried before falling back to the defaults).
   */
  load(): LoadReport {
    const at = this.now();
    const dir = this.options.dir;
    if (!dir) {
      this.install(builtinRegistry());
      return (this.report = { ok: true, usingLastValid: false, issues: [], at });
    }
    const first = this.tryFile(path.join(dir, REGISTRY_FILE));
    if (first.registry && first.issues.length === 0) {
      this.install(first.registry);
      return (this.report = { ok: true, usingLastValid: false, issues: [], at });
    }
    // Invalid. Keep what is in use; at the very first load nothing user-made is in use yet, so try the last good copy.
    if (this.pristine) {
      const backup = this.tryFile(lastValidPath(dir, REGISTRY_FILE));
      if (backup.registry && backup.issues.length === 0) this.install(backup.registry);
    }
    return (this.report = { ok: false, usingLastValid: true, issues: first.issues, at });
  }

  // ------------------------------------------------------------------------------------------ validation and changes

  /** Would this list be accepted? No change is made. */
  check(file: { providers: unknown[]; models: unknown[] }): MutationResult & { registry: Registry | null; file: RegistryFile | null } {
    const parsed = parseRegistry(file);
    if (parsed.issues.length) return { ok: false, issues: parsed.issues, registry: null, file: null };
    const built = buildRegistry(parsed.file);
    const issues = this.requiredDefaults(parsed.file, built.issues);
    if (built.registry && issues.length === 0) issues.push(...this.selectionProblems(built.registry));
    return { ok: issues.length === 0, issues, registry: issues.length === 0 ? built.registry : null, file: issues.length === 0 ? parsed.file : null };
  }

  /** A change must not take away the model, voice or sample rate a usable selection is using right now. */
  private selectionProblems(next: Registry): ValidationIssue[] {
    const sel = this.options.selection?.();
    if (!sel) return [];
    const out: ValidationIssue[] = [];
    const was = this.current;
    const usable = (r: { implemented: boolean; disabled: boolean } | null) => r !== null && r.implemented && !r.disabled;
    const llmKey = was.resolveLlmKey(sel.llm);
    if (llmKey && usable(was.llm(llmKey))) {
      const nextKey = next.resolveLlmKey(sel.llm);
      if (!nextKey || !usable(next.llm(nextKey))) out.push({ collection: 'models', id: llmKey, path: '$', message: `'${llmKey}' is the selected language model; choose another one before removing or disabling it` });
    }
    if (usable(was.stt(sel.stt)) && !usable(next.stt(sel.stt))) out.push({ collection: 'models', id: sel.stt, path: '$', message: `'${sel.stt}' is the selected speech-to-text model; choose another one before removing or disabling it` });
    if (usable(was.tts(sel.tts))) {
      const t = next.tts(sel.tts);
      const had = (r: Registry) => r.tts(sel.tts)?.voices.some((v) => v.name.toLowerCase() === sel.voice.toLowerCase());
      if (!usable(t)) out.push({ collection: 'models', id: sel.tts, path: '$', message: `'${sel.tts}' is the selected text-to-speech model; choose another one before removing or disabling it` });
      else if (t && t.voices.length > 0 && had(was) && !had(next)) out.push({ collection: 'models', id: sel.tts, path: 'options.voices', message: `the voice '${sel.voice}' is in use; choose another voice before removing it` });
    }
    return out;
  }

  /** Validate, write and install. Nothing changes unless the whole result is valid. */
  apply(next: { providers: unknown[]; models: unknown[] }): MutationResult {
    const checked = this.check(next);
    if (!checked.ok || !checked.registry || !checked.file) return { ok: false, issues: checked.issues };
    const dir = this.options.dir;
    if (dir) {
      const document = { schemaVersion: SCHEMA_VERSION, providers: checked.file.providers, models: checked.file.models };
      try {
        writeJsonAtomic(path.join(dir, REGISTRY_FILE), document);
      } catch (error) {
        return { ok: false, issues: [{ collection: 'document', id: null, path: REGISTRY_FILE, message: `could not be saved: ${(error as Error).message}` }] };
      }
      snapshotJson(dir, REGISTRY_FILE, document);
    }
    this.install(checked.registry);
    this.report = { ok: true, usingLastValid: false, issues: [], at: this.now() };
    this.options.onChange?.();
    return { ok: true, issues: [] };
  }

  upsertProvider(entry: unknown): MutationResult {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return { ok: false, issues: [{ collection: 'providers', id: null, path: 'id', message: 'an entry needs an id' }] };
    const next = this.file();
    const at = next.providers.findIndex((p) => p.id === id);
    if (at >= 0) next.providers[at] = entry as never;
    else next.providers.push(entry as never);
    return this.apply(next);
  }

  upsertModel(entry: unknown): MutationResult {
    const { id, stage } = (entry ?? {}) as { id?: unknown; stage?: unknown };
    if (typeof id !== 'string' || typeof stage !== 'string') return { ok: false, issues: [{ collection: 'models', id: typeof id === 'string' ? id : null, path: 'id', message: 'a model needs an id and a stage' }] };
    const next = this.file();
    const at = next.models.findIndex((m) => m.id === id && m.stage === stage);
    if (at >= 0) next.models[at] = entry as never;
    else next.models.push(entry as never);
    return this.apply(next);
  }

  /** Entries that came with the gateway are never deleted (switch them off, or reset them); your own can be. */
  removeProvider(id: string): MutationResult {
    const next = this.file();
    const at = next.providers.findIndex((p) => p.id === id);
    if (at < 0) return { ok: false, issues: [{ collection: 'providers', id, path: 'id', message: `no provider '${id}'` }] };
    if (this.current.isDefaultProvider(id)) return { ok: false, issues: [{ collection: 'providers', id, path: 'id', message: 'part of the gateway’s defaults and cannot be deleted; switch it off instead, or reset it to the default' }] };
    next.providers.splice(at, 1);
    return this.apply(next);
  }

  removeModel(stage: Stage, id: string): MutationResult {
    const next = this.file();
    const at = next.models.findIndex((m) => m.id === id && m.stage === stage);
    if (at < 0) return { ok: false, issues: [{ collection: 'models', id, path: 'id', message: `no ${stage} model '${id}'` }] };
    if (this.current.isDefaultModel(stage, id)) return { ok: false, issues: [{ collection: 'models', id, path: 'id', message: 'part of the gateway’s defaults and cannot be deleted; switch it off instead, or reset it to the default' }] };
    next.models.splice(at, 1);
    return this.apply(next);
  }

  /**
   * Import a registry document: its providers and models are added, or replace entries with the same id. Nothing is removed. If any
   * entry is invalid nothing is imported.
   */
  importDocument(doc: { providers?: unknown[]; models?: unknown[] }): MutationResult {
    if ((doc.providers !== undefined && !Array.isArray(doc.providers)) || (doc.models !== undefined && !Array.isArray(doc.models))) {
      return { ok: false, issues: [{ collection: 'document', id: null, path: '$', message: 'providers and models must be arrays' }] };
    }
    return this.apply(this.mergeInto(this.file(), doc));
  }

  /** The list with a document merged in (no change is made to the store). */
  mergeInto(base: RegistryFile, doc: { providers?: unknown[]; models?: unknown[] }): { providers: unknown[]; models: unknown[] } {
    const providers: unknown[] = [...base.providers];
    for (const entry of doc.providers ?? []) {
      const at = providers.findIndex((p) => (p as { id: string }).id === (entry as { id?: unknown })?.id);
      if (at >= 0) providers[at] = entry;
      else providers.push(entry);
    }
    const models: unknown[] = [...base.models];
    for (const entry of doc.models ?? []) {
      const e = entry as { id?: unknown; stage?: unknown };
      const at = models.findIndex((m) => (m as { id: string; stage: string }).id === e?.id && (m as { stage: string }).stage === e?.stage);
      if (at >= 0) models[at] = entry;
      else models.push(entry);
    }
    return { providers, models };
  }

  /**
   * Put default entries back: with no ids, the defaults missing from the list are added (for example models a newer gateway ships);
   * with ids, those entries are reset to their default definition. Your own entries are never touched.
   */
  restoreDefaults(ids?: Array<{ kind: 'provider'; id: string } | { kind: 'model'; stage: Stage; id: string }>): MutationResult {
    const defaults = defaultRegistry();
    const current = this.file();
    const wantProvider = (id: string) => (ids ? ids.some((x) => x.kind === 'provider' && x.id === id) : !current.providers.some((p) => p.id === id));
    const wantModel = (stage: Stage, id: string) => (ids ? ids.some((x) => x.kind === 'model' && x.stage === stage && x.id === id) : !current.models.some((m) => m.stage === stage && m.id === id));
    return this.apply(
      this.mergeInto(current, {
        providers: defaults.providers.filter((p) => wantProvider(p.id)),
        models: defaults.models.filter((m) => wantModel(m.stage, m.id)),
      })
    );
  }

  /** The complete registry (what a fresh gateway importing it would reproduce). No credential value is ever in it. */
  exportDocument(): { schemaVersion: number } & RegistryFile {
    return { schemaVersion: SCHEMA_VERSION, ...structuredClone(this.current.file) };
  }
}
