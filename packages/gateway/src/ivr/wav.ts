import { ParsedWav, parseWav } from '../recording/wav.js';

/**
 * Reads a PCM WAV file, including ones with extra chunks (LIST/INFO tags, `fact`, `bext`, and so on) that audio editors add.
 *
 * The existing strict `parseWav` is tried first, so a plain 44-byte-header file is read by exactly the same code as before. Only when
 * that refuses does this walk the file's chunks. It never changes anything: the returned samples are a window onto the file's own
 * `data` chunk, byte for byte. The caller still checks that the format is the one the gateway uses (PCM, mono, 16-bit, its sample
 * rate); this only finds where the audio is.
 *
 * Strict where it matters: a chunk that runs past the end of the file, a file shorter than its header says, more than one `data`
 * chunk, a `data` chunk before the `fmt ` chunk, or bytes that belong to no chunk are all refused.
 */
export function parsePcmWav(buf: Buffer): ParsedWav {
  try {
    return parseWav(buf);
  } catch (strict) {
    return walkChunks(buf, strict as Error);
  }
}

function walkChunks(buf: Buffer, strict: Error): ParsedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  const end = 8 + buf.readUInt32LE(4);
  if (end > buf.length) throw new Error('the file is shorter than its header says (it looks cut off)');
  if (buf.length - end > 1) throw new Error('the file has extra bytes after the end of the WAV data');

  let format: { tag: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: { start: number; bytes: number } | null = null;
  let pos = 12;
  while (pos + 8 <= end) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (body + size > end) throw new Error(`the "${id}" chunk runs past the end of the file`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('the "fmt " chunk is too small');
      format = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format) throw new Error('the audio comes before the "fmt " chunk');
      if (data) throw new Error('the file has more than one "data" chunk');
      data = { start: body, bytes: size };
    }
    pos = body + size + (size % 2); // chunks are padded to an even length
  }
  if (end - pos > 1) throw new Error('some bytes at the end belong to no chunk');
  if (!format) throw new Error(`no "fmt " chunk (${strict.message})`);
  if (format.tag !== 1) throw new Error('not PCM');
  if (!data) throw new Error('data chunk not found');
  return { sampleRate: format.sampleRate, channels: format.channels, bitsPerSample: format.bitsPerSample, dataBytes: data.bytes, data: buf.subarray(data.start, data.start + data.bytes) };
}
