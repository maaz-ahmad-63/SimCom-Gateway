import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IVR_ASSET_LIMITS, IvrAssetStore } from '../../src/ivr/assets.js';
import { IvrError } from '../../src/ivr/errors.js';
import { sha256, wav, wavWithListChunk } from './helpers.js';

const issuesOf = (fn: () => unknown): { code: string; status: number; issues: string[]; message: string } => {
  try {
    fn();
  } catch (error) {
    const e = error as IvrError;
    return { code: e.code, status: e.status, issues: e.issues.map((i) => i.message), message: e.message };
  }
  throw new Error('expected an IvrError');
};

describe('WAV validation (nothing is resampled or converted: unsuitable audio is refused)', () => {
  const store = new IvrAssetStore({ dir: null, sampleRate: () => 8000 });

  it('accepts a 16-bit mono PCM WAV at the gateway rate and records what it is', () => {
    const file = wav({ ms: 1500 });
    const { asset, duplicate } = store.add(file, 'welcome');
    expect(duplicate).toBe(false);
    expect(asset).toMatchObject({ name: 'welcome', sampleRate: 8000, channels: 1, bitsPerSample: 16, durationMs: 1500, bytes: file.length });
    expect(asset.id).toBe(sha256(file));
  });

  it('refuses stereo with a clear reason', () => {
    const e = issuesOf(() => store.add(wav({ channels: 2 }), 'x'));
    expect(e.code).toBe('invalid_asset');
    expect(e.issues).toEqual([expect.stringContaining('must be mono, but it has 2 channels')]);
  });

  it('refuses 8-bit audio', () => {
    expect(issuesOf(() => store.add(wav({ bits: 8 }), 'x')).issues).toEqual([expect.stringContaining('must be 16-bit, but it is 8-bit')]);
  });

  it('refuses a different sample rate and says the gateway will not resample', () => {
    const e = issuesOf(() => store.add(wav({ rate: 16000 }), 'x'));
    expect(e.issues).toEqual([expect.stringMatching(/must be 8000 Hz.*is 16000 Hz.*never resamples/)]);
  });

  it('reports every problem at once, not just the first', () => {
    const e = issuesOf(() => store.add(wav({ rate: 44100, channels: 2 }), 'x'));
    expect(e.issues).toHaveLength(2);
    expect(e.message).toContain('mono');
    expect(e.message).toContain('44100 Hz');
  });

  it('refuses audio that is too short or too long', () => {
    expect(issuesOf(() => store.add(wav({ ms: 50 }), 'x')).issues).toEqual([expect.stringContaining('too short')]);
    expect(issuesOf(() => store.add(wav({ dataBytes: 0 }), 'x')).issues).toEqual([expect.stringContaining('too short')]);
    expect(issuesOf(() => store.add(wav({ ms: 121_000 }), 'x')).issues).toEqual([expect.stringContaining('limit is 120 s')]);
    expect(store.add(wav({ ms: 120_000 }), 'at the limit').asset.durationMs).toBe(120_000);
  });

  it('refuses a file over the size limit before parsing it, with a 413', () => {
    const big = Buffer.alloc(IVR_ASSET_LIMITS.maxBytes + 1);
    const e = issuesOf(() => store.add(big, 'x'));
    expect(e.status).toBe(413);
    expect(e.issues).toEqual([expect.stringContaining('the limit is 4 MB')]);
  });

  it('refuses something that is not a WAV at all, saying how to export one', () => {
    for (const bad of [Buffer.from('this is not audio at all, just some text that is long enough to have a header'), Buffer.alloc(10)]) {
      const e = issuesOf(() => store.add(bad, 'x'));
      expect(e.code).toBe('invalid_asset');
      expect(e.issues[0]).toMatch(/not a PCM WAV file.*uncompressed 16-bit PCM WAV/);
    }
  });

  it('accepts a WAV with extra metadata chunks such as LIST (see ivr-wav.test.ts for the details)', () => {
    expect(store.add(wavWithListChunk(), 'tagged').asset.durationMs).toBe(500);
  });

  it('refuses audio data that is not a whole number of samples', () => {
    expect(issuesOf(() => store.add(wav({ dataBytes: 8001 }), 'x')).issues).toEqual([expect.stringContaining('whole number of 16-bit samples')]);
  });

  it('the required rate is the gateway rate read at the time: a 16 kHz gateway takes 16 kHz and refuses 8 kHz', () => {
    const wide = new IvrAssetStore({ dir: null, sampleRate: () => 16000 });
    expect(wide.add(wav({ rate: 16000 }), 'ok').asset.sampleRate).toBe(16000);
    expect(issuesOf(() => wide.add(wav({ rate: 8000 }), 'x')).issues[0]).toContain('must be 16000 Hz');
  });

  it('names: required, trimmed, control characters removed, length limited', () => {
    expect(issuesOf(() => store.add(wav({ tone: 1 }), '   ')).code).toBe('invalid_asset');
    expect(issuesOf(() => store.add(wav({ tone: 1 }), 'x'.repeat(81))).message).toContain('too long');
    expect(store.add(wav({ tone: 2 }), '  Hello\u0000\u001f world  ').asset.name).toBe('Hello world');
  });
});

describe('content-addressed storage in a folder', () => {
  let dir: string;
  beforeEach(() => void (dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-assets-')), 'ivr')));
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const open = (rate = 8000) => new IvrAssetStore({ dir, sampleRate: () => rate });

  it('a folder that does not exist yet is not an error: nothing is listed and nothing is created until the first write', () => {
    const store = open();
    expect(fs.existsSync(dir)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.get('a'.repeat(64))).toBeNull();
    expect(store.readWav('a'.repeat(64))).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    store.add(wav(), 'first');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('stores the file untouched as <sha256>.wav beside a <sha256>.json record, and leaves no temporary files', () => {
    const store = open();
    const file = wav({ ms: 700 });
    const { asset } = store.add(file, 'greeting');
    expect(asset.id).toBe(sha256(file));
    expect(fs.readdirSync(dir).sort()).toEqual([`${asset.id}.json`, `${asset.id}.wav`].sort());
    expect(fs.readFileSync(path.join(dir, `${asset.id}.wav`)).equals(file)).toBe(true); // byte for byte: no conversion
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${asset.id}.json`), 'utf8'))).toMatchObject({ id: asset.id, name: 'greeting', durationMs: 700 });
  });

  it('the same audio is stored once: a second upload returns the existing record and keeps its name', () => {
    const store = open();
    const file = wav({ tone: 123 });
    const first = store.add(file, 'original name');
    const second = store.add(Buffer.from(file), 'a different name');
    expect(second.duplicate).toBe(true);
    expect(second.asset).toEqual(first.asset);
    expect(second.asset.name).toBe('original name');
    expect(fs.readdirSync(dir)).toHaveLength(2);
    expect(store.list()).toHaveLength(1);
  });

  it('different audio gets a different id, even with the same name', () => {
    const store = open();
    const a = store.add(wav({ tone: 200 }), 'same').asset;
    const b = store.add(wav({ tone: 201 }), 'same').asset;
    expect(a.id).not.toBe(b.id);
    expect(store.list().map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('persists: a new store on the same folder finds the same assets and the same samples', () => {
    const file = wav({ ms: 400, tone: 777 });
    const id = open().add(file, 'kept').asset.id;
    const again = open();
    expect(again.has(id)).toBe(true);
    expect(again.list()).toEqual([expect.objectContaining({ id, name: 'kept' })]);
    expect(again.readWav(id)!.equals(file)).toBe(true);
    expect(again.readPcm(id)!.equals(file.subarray(44))).toBe(true);
  });

  it('is crash-safe: an audio file without its record is not an asset, a leftover temp file is ignored, and uploading again completes it', () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = wav({ tone: 900 });
    const id = sha256(file);
    fs.writeFileSync(path.join(dir, `${id}.wav`), file); // the crash happened after the audio, before the record
    fs.writeFileSync(path.join(dir, `${id}.wav.1234.tmp`), 'half a file');
    const store = open();
    expect(store.list()).toEqual([]);
    expect(store.has(id)).toBe(false);
    const { asset, duplicate } = store.add(file, 'completed');
    expect(duplicate).toBe(false);
    expect(open().get(id)).toEqual(asset);
  });

  it('a record whose audio is missing is not an asset, and a damaged record is ignored and reported', () => {
    fs.mkdirSync(dir, { recursive: true });
    const store0 = open();
    const kept = store0.add(wav({ tone: 51 }), 'kept').asset;
    const lost = store0.add(wav({ tone: 52 }), 'lost').asset;
    fs.rmSync(path.join(dir, `${lost.id}.wav`));
    fs.writeFileSync(path.join(dir, `${'c'.repeat(64)}.json`), '{ not json');
    fs.writeFileSync(path.join(dir, `${'d'.repeat(64)}.json`), JSON.stringify({ id: 'e'.repeat(64), name: 'x' }));
    const store = open();
    expect(store.list().map((a) => a.id)).toEqual([kept.id]);
    expect(store.problems).toHaveLength(2);
  });

  it('refuses to play a file that no longer matches its fingerprint', () => {
    const store = open();
    const { id } = store.add(wav({ tone: 61 }), 'x').asset;
    fs.appendFileSync(path.join(dir, `${id}.wav`), Buffer.from([1, 2]));
    const e = issuesOf(() => store.readWav(id));
    expect(e.code).toBe('asset_unavailable');
    expect(e.message).toContain('damaged');
  });

  it('removing deletes the record and the audio; removing something that is not there says so', () => {
    const store = open();
    const { id } = store.add(wav({ tone: 71 }), 'x').asset;
    expect(store.remove(id)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(store.has(id)).toBe(false);
    expect(store.remove(id)).toBe(false);
  });

  it('an id is never turned into a path unless it is a hash', () => {
    const store = open();
    for (const id of ['../x', '..\\..\\windows', 'a/b', '', 'short', 'A'.repeat(64), `${'a'.repeat(63)}/`]) {
      expect(store.get(id), id).toBeNull();
      expect(store.has(id)).toBe(false);
      expect(store.readWav(id)).toBeNull();
      expect(store.remove(id)).toBe(false);
    }
  });
});

describe('in-memory mode (no folder: used with an in-memory database)', () => {
  it('works completely without touching the disk, and a read cannot change what is stored', () => {
    const store = new IvrAssetStore({ dir: null, sampleRate: () => 8000 });
    expect(store.persistent).toBe(false);
    const file = wav({ ms: 300, tone: 5 });
    const { asset } = store.add(file, 'mem');
    expect(store.list()).toEqual([asset]);
    expect(store.add(file, 'again').duplicate).toBe(true);
    const copy = store.readWav(asset.id)!;
    copy.fill(0);
    expect(store.readWav(asset.id)!.equals(file)).toBe(true);
    expect(store.readPcm(asset.id)!.equals(file.subarray(44))).toBe(true);
    expect(store.remove(asset.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });
});
