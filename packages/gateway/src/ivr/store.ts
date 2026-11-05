import type { z } from 'zod';
import { createLogger } from '../core/logger.js';
import type { SettingsBackend } from '../ai/settings.js';
import { IvrAssetStore } from './assets.js';
import {
  defaultIvrConfig,
  IvrConfig,
  ivrConfigSchema,
  PublishedIvr,
  referencedAssetIds,
  StoredDraft,
  storedDraftSchema,
  storedPublishedSchema,
  zodIssues,
} from './config.js';
import { IvrError } from './errors.js';
import { IvrValidation, validateIvrConfig } from './validation.js';

/** Where the IVR lives in the gateway's settings table (the same `gateway_settings` the AI settings use). */
export const IVR_KEYS = {
  enabled: 'ivr.enabled',
  draft: 'ivr.draft',
  published: 'ivr.published',
  version: 'ivr.version',
} as const;

export interface IvrStatus {
  enabled: boolean;
  /** The version of the published configuration, or 0 when nothing was published yet. */
  publishedVersion: number;
  publishedAt: string | null;
  hasSavedDraft: boolean;
  /** The saved draft differs from the published configuration (or there is a draft and nothing published). */
  unpublishedChanges: boolean;
  /** Stored documents that could not be read, so a damaged record is reported instead of quietly replaced by defaults. */
  problems: string[];
}

type DeepReadonly<T> = T extends Buffer ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/**
 * Everything one call needs, frozen at the moment the call took it: the published configuration, and the audio of every announcement
 * it uses, copied. Later edits, a new publish or a deleted asset cannot change a call that already has its snapshot.
 */
export interface IvrSnapshot {
  readonly version: number;
  readonly publishedAt: string;
  readonly takenAt: string;
  readonly sampleRate: number;
  readonly config: DeepReadonly<IvrConfig>;
  /** The samples (16-bit little-endian mono PCM) of an asset the configuration uses; undefined for any other id. A private copy. */
  pcm(assetId: string): Buffer | undefined;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as DeepReadonly<T>;
}

export interface IvrStoreOptions {
  backend: SettingsBackend;
  assets: IvrAssetStore;
  now?: () => Date;
}

/**
 * The IVR's saved state: an on/off switch (OFF until someone turns it on), a draft that may be half finished, a published
 * configuration that is always complete, and a version counter. Publishing is the only way a configuration reaches calls, and an
 * invalid one cannot be published.
 */
export class IvrStore {
  private readonly logger = createLogger('IvrStore');
  private readonly now: () => Date;

  constructor(private readonly options: IvrStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get backend(): SettingsBackend {
    return this.options.backend;
  }

  // ---- reading ---------------------------------------------------------------------------------------------------

  /** The raw switch: true only after someone enabled it. A damaged or missing value is "off". */
  isEnabled(): boolean {
    return this.backend.getSetting(IVR_KEYS.enabled) === 'true';
  }

  /** The published configuration, or null when there is none (or the stored one is damaged; see `status().problems`). */
  getPublished(): PublishedIvr | null {
    return this.readDocument(IVR_KEYS.published, storedPublishedSchema);
  }

  /** What the dashboard edits: the saved draft, else the published configuration, else an empty one. */
  getDraft(): IvrConfig {
    return this.readDocument(IVR_KEYS.draft, storedDraftSchema)?.config ?? this.getPublished()?.config ?? defaultIvrConfig();
  }

  /** The last version number issued. It never goes down; deleting the published configuration does not reuse a number. */
  version(): number {
    const counter = Number(this.backend.getSetting(IVR_KEYS.version));
    return Math.max(Number.isInteger(counter) && counter > 0 ? counter : 0, this.getPublished()?.version ?? 0);
  }

  status(): IvrStatus {
    const draft = this.readDocument(IVR_KEYS.draft, storedDraftSchema);
    const published = this.getPublished();
    return {
      enabled: this.isEnabled(),
      publishedVersion: published?.version ?? 0,
      publishedAt: published?.publishedAt ?? null,
      hasSavedDraft: draft !== null,
      unpublishedChanges: draft !== null && JSON.stringify(draft.config) !== JSON.stringify(published?.config ?? null),
      problems: this.problems(),
    };
  }

  // ---- changing --------------------------------------------------------------------------------------------------

  /** Save the draft. It must match the model (types, ranges, allowed actions) but may be incomplete; completeness is checked at publish. */
  saveDraft(input: unknown): IvrConfig {
    const parsed = ivrConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new IvrError('invalid_config', 'The configuration is not valid.', 422, zodIssues(parsed.error));
    }
    const doc: StoredDraft = { savedAt: this.now().toISOString(), config: parsed.data };
    this.backend.setSetting(IVR_KEYS.draft, JSON.stringify(doc));
    return parsed.data;
  }

  /** Throw the saved draft away: the dashboard goes back to editing the published configuration. */
  discardDraft(): void {
    this.backend.deleteSetting(IVR_KEYS.draft);
  }

  /** Check a configuration (the saved draft by default) the way publishing would, without changing anything. */
  validate(config?: unknown): IvrValidation {
    return validateIvrConfig(config === undefined ? this.getDraft() : config, this.options.assets);
  }

  /** Publish the saved draft. Refused, and nothing changes, unless it is complete and every audio file it uses is available. */
  publish(): PublishedIvr {
    const draft = this.readDocument(IVR_KEYS.draft, storedDraftSchema);
    if (!draft) throw new IvrError('invalid_config', 'There is no saved draft to publish. Save the configuration first.', 409);
    const validation = validateIvrConfig(draft.config, this.options.assets);
    if (!validation.ok) {
      throw new IvrError('invalid_config', `The configuration cannot be published: ${validation.errors.length} problem${validation.errors.length === 1 ? '' : 's'} to fix.`, 422, validation.errors);
    }
    // Every referenced asset must also still be a format the gateway accepts today (the sample rate could have been changed since).
    const rate = this.options.assets.expectedSampleRate;
    const stale = referencedAssetIds(draft.config).filter((id) => this.options.assets.get(id)?.sampleRate !== rate);
    if (stale.length > 0) {
      throw new IvrError(
        'invalid_config',
        `The configuration cannot be published: some audio is not ${rate} Hz, which is what the gateway now uses.`,
        422,
        stale.map((id) => ({ path: 'assets', message: `"${this.options.assets.get(id)?.name ?? id}" must be uploaded again at ${rate} Hz` }))
      );
    }
    const published: PublishedIvr = { version: this.version() + 1, publishedAt: this.now().toISOString(), config: draft.config };
    // The published record carries its own version, so if the process stops between the two writes the counter is simply behind
    // and version() still answers correctly.
    this.backend.setSetting(IVR_KEYS.published, JSON.stringify(published));
    this.backend.setSetting(IVR_KEYS.version, String(published.version));
    return published;
  }

  /** Turn the IVR on or off. Off by default; it can only be turned on once something has been published. */
  setEnabled(enabled: boolean): boolean {
    if (enabled && !this.getPublished()) {
      throw new IvrError('not_published', 'Publish a configuration before turning the IVR on.', 409);
    }
    this.backend.setSetting(IVR_KEYS.enabled, enabled ? 'true' : 'false');
    return enabled;
  }

  /** Delete an audio file. Refused while the draft or the published configuration still uses it. */
  removeAsset(id: string): boolean {
    if (!this.options.assets.get(id)) throw new IvrError('asset_not_found', 'That audio file does not exist.', 404);
    const users: string[] = [];
    const draft = this.readDocument(IVR_KEYS.draft, storedDraftSchema);
    if (draft && referencedAssetIds(draft.config).includes(id)) users.push('the draft');
    const published = this.getPublished();
    if (published && referencedAssetIds(published.config).includes(id)) users.push(`the published configuration (version ${published.version})`);
    if (users.length > 0) {
      throw new IvrError('asset_in_use', `This audio file is still used by ${users.join(' and ')}. Remove it there first.`, 409);
    }
    return this.options.assets.remove(id);
  }

  // ---- for the runtime -------------------------------------------------------------------------------------------

  /**
   * What a call that the IVR takes is given: null when the IVR is off or nothing is published (the call is handled exactly as it was
   * before the IVR existed). Throws IvrError('asset_unavailable') when the published configuration cannot be played right now
   * (an audio file is missing, damaged, or not at the gateway's rate); the runtime treats that as a failure and falls back.
   */
  snapshot(): IvrSnapshot | null {
    if (!this.isEnabled()) return null;
    const published = this.getPublished();
    if (!published) return null;
    const rate = this.options.assets.expectedSampleRate;
    const audio = new Map<string, Buffer>();
    for (const id of referencedAssetIds(published.config)) {
      const meta = this.options.assets.get(id);
      if (!meta) throw new IvrError('asset_unavailable', `An audio file used by the published IVR is missing (${id.slice(0, 8)}…).`, 409);
      if (meta.sampleRate !== rate) {
        throw new IvrError('asset_unavailable', `The audio file "${meta.name}" is ${meta.sampleRate} Hz but the gateway now uses ${rate} Hz.`, 409);
      }
      const pcm = this.options.assets.readPcm(id);
      if (!pcm) throw new IvrError('asset_unavailable', `The audio file "${meta.name}" cannot be read.`, 409);
      audio.set(id, pcm);
    }
    // A deep copy, so nothing a caller holds is shared with what the store reads next time.
    const config = deepFreeze(JSON.parse(JSON.stringify(published.config)) as IvrConfig);
    return Object.freeze({
      version: published.version,
      publishedAt: published.publishedAt,
      takenAt: this.now().toISOString(),
      sampleRate: rate,
      config,
      pcm: (assetId: string) => audio.get(assetId),
    });
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  /** Stored documents that exist but cannot be read: reported, never silently replaced. */
  problems(): string[] {
    const out = [...this.options.assets.problems];
    const documents: Array<[string, z.ZodTypeAny]> = [
      [IVR_KEYS.draft, storedDraftSchema],
      [IVR_KEYS.published, storedPublishedSchema],
    ];
    for (const [key, schema] of documents) {
      const raw = this.backend.getSetting(key);
      if (raw === null) continue;
      if (!this.parse<unknown>(raw, schema)) out.push(`The stored IVR ${key.replace('ivr.', '')} cannot be read and is being ignored.`);
    }
    return out;
  }

  private readDocument<T>(key: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
    const raw = this.backend.getSetting(key);
    if (raw === null) return null;
    const parsed = this.parse(raw, schema);
    if (!parsed) this.logger.warn(`The stored IVR ${key} cannot be read and is being ignored`);
    return parsed;
  }

  private parse<T>(raw: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
    try {
      const result = schema.safeParse(JSON.parse(raw));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
