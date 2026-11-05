import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createLogger } from '../core/logger.js';
import { readJsonFile, writeJsonAtomic } from '../ai/registry/files.js';
import { assetIdSchema } from './config.js';
import { IvrError } from './errors.js';
import { parsePcmWav } from './wav.js';

/**
 * Prerecorded announcements. A WAV file is stored under the SHA-256 of its bytes, so the same audio is stored once and an id can
 * never come to mean different audio later (which is what lets a call keep working from a snapshot while the operator edits).
 *
 *   <dir>/<id>.wav    the file exactly as uploaded (nothing is resampled, converted or trimmed)
 *   <dir>/<id>.json   its metadata; an asset exists only when BOTH are present
 *
 * `dir: null` keeps assets in memory only, so tests that use an in-memory database need no folder. A folder that does not exist yet
 * is created on the first write and reads from it simply find nothing.
 */

export const IVR_ASSET_LIMITS = {
  /** Refused before parsing, so a huge upload never gets read into a parser. */
  maxBytes: 4 * 1024 * 1024,
  maxDurationMs: 120_000,
  minDurationMs: 100,
  nameMaxChars: 80,
} as const;

const metaSchema = z
  .object({
    id: assetIdSchema,
    name: z.string().min(1).max(IVR_ASSET_LIMITS.nameMaxChars),
    bytes: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    sampleRate: z.number().int().positive(),
    channels: z.literal(1),
    bitsPerSample: z.literal(16),
    createdAt: z.string(),
  })
  .strict();

export type IvrAssetMeta = z.infer<typeof metaSchema>;

export interface IvrAssetStoreOptions {
  dir: string | null;
  /** The sample rate the gateway's audio path runs at (8000 on this hardware). Read on every use, never cached. */
  sampleRate: () => number;
  now?: () => Date;
}

export interface AddedAsset {
  asset: IvrAssetMeta;
  /** True when this exact audio was already stored; the existing record (and its name) is kept. */
  duplicate: boolean;
}

/** Why a file is not acceptable, as the sentences an operator can act on. Empty means acceptable. */
export function checkWav(wav: Buffer, expectedRate: number): { issues: string[]; meta?: { sampleRate: number; durationMs: number; dataBytes: number } } {
  if (wav.length > IVR_ASSET_LIMITS.maxBytes) {
    return { issues: [`the file is ${(wav.length / 1024 / 1024).toFixed(1)} MB; the limit is ${IVR_ASSET_LIMITS.maxBytes / 1024 / 1024} MB`] };
  }
  let parsed;
  try {
    parsed = parsePcmWav(wav);
  } catch (error) {
    return {
      issues: [`this is not a PCM WAV file (${(error as Error).message}); export it as an uncompressed 16-bit PCM WAV`],
    };
  }
  const issues: string[] = [];
  if (parsed.channels !== 1) issues.push(`it must be mono, but it has ${parsed.channels} channels`);
  if (parsed.bitsPerSample !== 16) issues.push(`it must be 16-bit, but it is ${parsed.bitsPerSample}-bit`);
  if (parsed.sampleRate !== expectedRate) {
    issues.push(`it must be ${expectedRate} Hz to match the gateway's audio path, but it is ${parsed.sampleRate} Hz; the gateway never resamples, so convert it before uploading`);
  }
  if (parsed.dataBytes % 2 !== 0) issues.push('its audio data is not a whole number of 16-bit samples');
  const durationMs = parsed.sampleRate > 0 && parsed.channels > 0 && parsed.bitsPerSample > 0
    ? Math.round((parsed.dataBytes / ((parsed.bitsPerSample / 8) * parsed.channels) / parsed.sampleRate) * 1000)
    : 0;
  if (durationMs < IVR_ASSET_LIMITS.minDurationMs) issues.push(`it is too short (${durationMs} ms); the minimum is ${IVR_ASSET_LIMITS.minDurationMs} ms`);
  if (durationMs > IVR_ASSET_LIMITS.maxDurationMs) {
    issues.push(`it is ${(durationMs / 1000).toFixed(1)} s long; the limit is ${IVR_ASSET_LIMITS.maxDurationMs / 1000} s`);
  }
  return { issues, meta: { sampleRate: parsed.sampleRate, durationMs, dataBytes: parsed.dataBytes } };
}

/** Temp file in the same folder, then rename: a reader sees the old file or the new one, never half of one. (files.ts has this for JSON.) */
function writeFileAtomic(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class IvrAssetStore {
  private readonly logger = createLogger('IvrAssets');
  private readonly memory = new Map<string, { meta: IvrAssetMeta; wav: Buffer }>();
  /** Folder mode: the metadata found on disk, loaded on first use and kept in step by add and remove. */
  private index: Map<string, IvrAssetMeta> | null = null;
  private readonly now: () => Date;
  /** Sidecar files that could not be used, so the dashboard can say so instead of an asset silently vanishing. */
  readonly problems: string[] = [];

  constructor(private readonly options: IvrAssetStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The sample rate assets must have right now. */
  get expectedSampleRate(): number {
    return this.options.sampleRate();
  }

  get persistent(): boolean {
    return this.options.dir !== null;
  }

  /** Validate and store a WAV file. Throws IvrError('invalid_asset') listing every problem found. */
  add(wav: Buffer, name: string): AddedAsset {
    const cleanName = name.replace(/[\u0000-\u001f]/g, '').trim();
    if (!cleanName) throw new IvrError('invalid_asset', 'Give the audio file a name.', 422, [{ path: 'name', message: 'a name is required' }]);
    if (cleanName.length > IVR_ASSET_LIMITS.nameMaxChars) {
      throw new IvrError('invalid_asset', `The name is too long (the limit is ${IVR_ASSET_LIMITS.nameMaxChars} characters).`, 422, [{ path: 'name', message: 'name too long' }]);
    }
    const { issues, meta } = checkWav(wav, this.expectedSampleRate);
    if (issues.length > 0 || !meta) {
      throw new IvrError(
        'invalid_asset',
        `This audio file cannot be used: ${issues.join('; ')}.`,
        wav.length > IVR_ASSET_LIMITS.maxBytes ? 413 : 422,
        issues.map((message) => ({ path: 'file', message }))
      );
    }
    const id = createHash('sha256').update(wav).digest('hex');
    const existing = this.get(id);
    if (existing && this.fileIntact(id)) return { asset: existing, duplicate: true };

    const asset: IvrAssetMeta = {
      id,
      name: cleanName,
      bytes: wav.length,
      durationMs: meta.durationMs,
      sampleRate: meta.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      createdAt: this.now().toISOString(),
    };
    const dir = this.options.dir;
    if (dir === null) {
      this.memory.set(id, { meta: asset, wav: Buffer.from(wav) });
    } else {
      try {
        // The audio first, the record second: a crash in between leaves an unlisted file, and uploading again completes it.
        writeFileAtomic(this.wavPath(dir, id), wav);
        writeJsonAtomic(this.metaPath(dir, id), asset);
      } catch (error) {
        throw new IvrError('storage_error', `The audio file could not be saved: ${(error as Error).message}`, 500);
      }
      this.loadIndex().set(id, asset);
    }
    return { asset, duplicate: false };
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }

  get(id: string): IvrAssetMeta | null {
    if (!assetIdSchema.safeParse(id).success) return null; // never build a path from anything but a hash
    if (this.options.dir === null) return this.memory.get(id)?.meta ?? null;
    return this.loadIndex().get(id) ?? null;
  }

  list(): IvrAssetMeta[] {
    const all = this.options.dir === null ? [...this.memory.values()].map((m) => m.meta) : [...this.loadIndex().values()];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  }

  /**
   * The stored file, checked against its id. A file that no longer matches its hash (damaged, or edited by hand) is refused
   * rather than played. Returns null when the asset does not exist.
   */
  readWav(id: string): Buffer | null {
    const meta = this.get(id);
    if (!meta) return null;
    const dir = this.options.dir;
    if (dir === null) return Buffer.from(this.memory.get(id)!.wav);
    let wav: Buffer;
    try {
      wav = fs.readFileSync(this.wavPath(dir, id));
    } catch {
      return null;
    }
    if (createHash('sha256').update(wav).digest('hex') !== id) {
      throw new IvrError('asset_unavailable', `The stored audio file "${meta.name}" is damaged (it no longer matches its fingerprint). Upload it again.`, 409);
    }
    return wav;
  }

  /** The samples of an asset (16-bit little-endian mono PCM at the gateway's rate), without the WAV header. */
  readPcm(id: string): Buffer | null {
    const wav = this.readWav(id);
    return wav ? Buffer.from(parsePcmWav(wav).data) : null;
  }

  remove(id: string): boolean {
    const meta = this.get(id);
    if (!meta) return false;
    const dir = this.options.dir;
    if (dir === null) return this.memory.delete(id);
    // The record first: from this moment the asset is not listed, even if deleting the audio fails.
    for (const file of [this.metaPath(dir, id), this.wavPath(dir, id)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        throw new IvrError('storage_error', `The audio file could not be deleted: ${(error as Error).message}`, 500);
      }
    }
    this.loadIndex().delete(id);
    return true;
  }

  private wavPath(dir: string, id: string): string {
    return path.join(dir, `${id}.wav`);
  }
  private metaPath(dir: string, id: string): string {
    return path.join(dir, `${id}.json`);
  }

  private fileIntact(id: string): boolean {
    const dir = this.options.dir;
    if (dir === null) return true;
    return fs.existsSync(this.wavPath(dir, id));
  }

  /** Folder mode: scan once. A record whose audio is missing, or whose content is not a valid record, is not an asset. */
  private loadIndex(): Map<string, IvrAssetMeta> {
    if (this.index) return this.index;
    const index = new Map<string, IvrAssetMeta>();
    const dir = this.options.dir;
    let names: string[] = [];
    try {
      names = dir ? fs.readdirSync(dir) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.problems.push(`The audio folder cannot be read: ${(error as Error).message}`);
        this.logger.warn(`IVR audio folder cannot be read: ${(error as Error).message}`);
      }
    }
    for (const name of names) {
      const match = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!match || !dir) continue;
      const read = readJsonFile(path.join(dir, name));
      const parsed = read.kind === 'ok' ? metaSchema.safeParse(read.value) : null;
      if (!parsed?.success || parsed.data.id !== match[1]) {
        this.problems.push(`The audio record ${name} is not valid and was ignored.`);
        this.logger.warn(`IVR audio record ${name} is not valid and was ignored`);
        continue;
      }
      if (!fs.existsSync(this.wavPath(dir, parsed.data.id))) continue; // an orphaned record: not an asset
      index.set(parsed.data.id, parsed.data);
    }
    this.index = index;
    return index;
  }
}
