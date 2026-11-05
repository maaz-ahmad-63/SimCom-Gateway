import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWav } from '../../src/recording/wav.js';
import { IvrAssetStore } from '../../src/ivr/assets.js';
import { parsePcmWav } from '../../src/ivr/wav.js';
import { sha256, wav } from './helpers.js';

/** Build a WAV from explicit chunks, the way an audio editor would. Each body is padded to an even length, as the format requires. */
const chunk = (id: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const fmt = (rate = 8000, channels = 1, bits = 16, tag = 1): Buffer => {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(tag, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE((rate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
};
const riff = (...chunks: Buffer[]): Buffer => {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const pcmOf = (ms: number, tone = 440): Buffer => wav({ ms, tone }).subarray(44);
const info = (text: string) => chunk('LIST', Buffer.concat([Buffer.from('INFO'), chunk('ISFT', Buffer.from(text))]));

describe('parsePcmWav: extra chunks are skipped, the samples are never touched', () => {
  it('a plain file is read by the existing strict parser, with the same result', () => {
    const file = wav({ ms: 300 });
    expect(parsePcmWav(file)).toEqual(parseWav(file));
  });

  it('LIST between fmt and data: the samples are byte-for-byte the file\'s own', () => {
    const pcm = pcmOf(400);
    const file = riff(chunk('fmt ', fmt()), info('Audacity'), chunk('data', pcm));
    expect(() => parseWav(file)).toThrow(); // the strict reader refuses it, which is why the fallback exists
    const parsed = parsePcmWav(file);
    expect(parsed).toMatchObject({ sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: pcm.length });
    expect(Buffer.from(parsed.data).equals(pcm)).toBe(true);
  });

  it('LIST after the data (a common place for tags) is accepted', () => {
    const pcm = pcmOf(250, 500);
    const parsed = parsePcmWav(riff(chunk('fmt ', fmt()), chunk('data', pcm), info('tagged later')));
    expect(Buffer.from(parsed.data).equals(pcm)).toBe(true);
  });

  it('several extra chunks on both sides, and an odd-sized chunk with its pad byte, are handled', () => {
    const pcm = pcmOf(300, 600);
    const odd = chunk('bext', Buffer.from('odd')); // 3 bytes + 1 pad
    const file = riff(chunk('fact', Buffer.alloc(4)), chunk('fmt ', fmt()), odd, info('x'), chunk('data', pcm), chunk('id3 ', Buffer.from('12345')));
    expect(Buffer.from(parsePcmWav(file).data).equals(pcm)).toBe(true);
  });

  it('a data chunk of odd length still has its pad byte skipped before the next chunk', () => {
    const pcm = Buffer.concat([pcmOf(100), Buffer.from([7])]); // 1 odd byte; the format check, not the parser, objects to that
    const parsed = parsePcmWav(riff(chunk('fmt ', fmt()), chunk('data', pcm), info('after')));
    expect(parsed.dataBytes).toBe(pcm.length);
  });
});

describe('parsePcmWav: structure problems are refused', () => {
  const good = () => [chunk('fmt ', fmt()), info('x'), chunk('data', pcmOf(100))];
  const refuses = (file: Buffer, message: RegExp) => expect(() => parsePcmWav(file)).toThrow(message);

  it('not a RIFF/WAVE file', () => {
    refuses(Buffer.from('not a wav file at all, but long enough to be looked at by the parser'), /not a RIFF\/WAVE/);
    refuses(Buffer.alloc(4), /not a RIFF\/WAVE/);
  });

  it('a file cut off before its declared end', () => {
    const file = riff(...good());
    refuses(file.subarray(0, file.length - 40), /shorter than its header says/);
  });

  it('bytes after the end of the WAV', () => {
    refuses(Buffer.concat([riff(...good()), Buffer.from('trailing junk')]), /extra bytes after the end/);
  });

  it('a chunk that claims to run past the end', () => {
    const bad = chunk('LIST', Buffer.from('INFO'));
    bad.writeUInt32LE(100_000, 4);
    refuses(riff(chunk('fmt ', fmt()), bad, chunk('data', pcmOf(100))), /"LIST" chunk runs past the end/);
  });

  it('a data chunk before fmt, two data chunks, no data, no fmt', () => {
    refuses(riff(chunk('data', pcmOf(100)), chunk('fmt ', fmt())), /comes before the "fmt "/);
    refuses(riff(chunk('fmt ', fmt()), chunk('data', pcmOf(100)), chunk('data', pcmOf(100))), /more than one "data"/);
    refuses(riff(chunk('fmt ', fmt()), info('x')), /data chunk not found/);
    refuses(riff(chunk('data', pcmOf(100))), /comes before the "fmt "/);
    refuses(riff(info('x')), /no "fmt " chunk/);
  });

  it('a fmt chunk that is too small', () => {
    refuses(riff(chunk('fmt ', Buffer.alloc(8)), chunk('data', pcmOf(100))), /"fmt " chunk is too small/);
  });

  it('anything but plain PCM: float, A-law and the "extensible" tag are all refused (the format rules did not change)', () => {
    for (const tag of [3, 6, 0xfffe]) refuses(riff(chunk('fmt ', fmt(8000, 1, 16, tag)), info('x'), chunk('data', pcmOf(100))), /not PCM/);
  });

  it('a few stray bytes that belong to no chunk', () => {
    const file = Buffer.concat([riff(...good()), Buffer.alloc(0)]);
    const bad = Buffer.from(file);
    bad.writeUInt32LE(bad.readUInt32LE(4) + 5, 4);
    refuses(Buffer.concat([bad, Buffer.from([1, 2, 3, 4, 5])]), /belong to no chunk/);
  });
});

describe('through the asset store: stored as sent, validated as before', () => {
  const store = () => new IvrAssetStore({ dir: null, sampleRate: () => 8000 });

  it('a tagged file is accepted, its id is the fingerprint of the file as uploaded, and the samples come back untouched', () => {
    const pcm = pcmOf(600, 321);
    const file = riff(chunk('fmt ', fmt()), info('Adobe Audition'), chunk('data', pcm));
    const s = store();
    const { asset } = s.add(file, 'tagged');
    expect(asset).toMatchObject({ id: sha256(file), bytes: file.length, durationMs: 600, sampleRate: 8000, channels: 1, bitsPerSample: 16 });
    expect(s.readWav(asset.id)!.equals(file)).toBe(true); // the whole file, tags included: nothing was rewritten
    expect(s.readPcm(asset.id)!.equals(pcm)).toBe(true);
  });

  it('in a folder, the file on disk is the upload byte for byte', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-wav-'));
    try {
      const file = riff(chunk('fmt ', fmt()), chunk('data', pcmOf(300, 99)), info('after'));
      const s = new IvrAssetStore({ dir: path.join(base, 'ivr'), sampleRate: () => 8000 });
      const { asset } = s.add(file, 'on disk');
      expect(fs.readFileSync(path.join(base, 'ivr', `${asset.id}.wav`)).equals(file)).toBe(true);
      expect(new IvrAssetStore({ dir: path.join(base, 'ivr'), sampleRate: () => 8000 }).readPcm(asset.id)!.equals(pcmOf(300, 99))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('the format rules still apply to a tagged file: stereo, 8-bit and another rate are refused', () => {
    const s = store();
    const tagged = (rate: number, channels: number, bits: number) => riff(chunk('fmt ', fmt(rate, channels, bits)), info('x'), chunk('data', Buffer.alloc(16000)));
    expect(() => s.add(tagged(8000, 2, 16), 'x')).toThrow(/mono/);
    expect(() => s.add(tagged(8000, 1, 8), 'x')).toThrow(/16-bit/);
    expect(() => s.add(tagged(44100, 1, 16), 'x')).toThrow(/never resamples/);
  });

  it('duration limits still apply to a tagged file', () => {
    const s = store();
    expect(() => s.add(riff(chunk('fmt ', fmt()), info('x'), chunk('data', Buffer.alloc(16))), 'x')).toThrow(/too short/);
    expect(() => s.add(riff(chunk('fmt ', fmt()), info('x'), chunk('data', Buffer.alloc(16_000 * 121))), 'x')).toThrow(/limit is 120 s/);
  });
});
