import fs from 'node:fs';
import path from 'node:path';
import { timeSyncIo } from '../core/sync-io-watch.js';

export const WAV_HEADER_BYTES = 44;

/** A canonical 44-byte PCM WAV header. `dataBytes` is the size of the sample data that follows. */
export function wavHeader(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  data: Buffer;
}

/** Strict reader for the files this module writes; throws on anything that is not a valid PCM WAV. */
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < WAV_HEADER_BYTES) throw new Error('file is shorter than a WAV header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  if (buf.toString('ascii', 12, 16) !== 'fmt ' || buf.readUInt16LE(20) !== 1) throw new Error('not PCM');
  if (buf.toString('ascii', 36, 40) !== 'data') throw new Error('data chunk not found');
  const dataBytes = buf.readUInt32LE(40);
  if (buf.readUInt32LE(4) !== 36 + dataBytes) throw new Error('RIFF size does not match the data size');
  if (buf.length - WAV_HEADER_BYTES !== dataBytes) throw new Error(`data size ${dataBytes} does not match the file (${buf.length - WAV_HEADER_BYTES} bytes of samples)`);
  return {
    sampleRate: buf.readUInt32LE(24),
    channels: buf.readUInt16LE(22),
    bitsPerSample: buf.readUInt16LE(34),
    dataBytes,
    data: buf.subarray(WAV_HEADER_BYTES),
  };
}

/**
 * Appends PCM to a WAV file. The header is rewritten on every flush point, so a file is playable even if the
 * process dies mid-call (it is then at most one refresh interval short), and exact once close() runs.
 */
export class WavFileWriter {
  private fd: number | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private written = 0;

  constructor(
    readonly filePath: string,
    readonly sampleRate: number,
    readonly channels = 1,
    readonly bitsPerSample = 16
  ) {}

  get dataBytes(): number {
    return this.written + this.pendingBytes;
  }

  open(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = fs.openSync(this.filePath, 'w');
    fs.writeSync(this.fd, wavHeader(this.sampleRate, this.channels, this.bitsPerSample, 0), 0, WAV_HEADER_BYTES, 0);
  }

  append(pcm: Buffer): void {
    if (this.fd === null || pcm.length === 0) return;
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    if (this.pendingBytes >= 32768) this.flush();
  }

  flush(): void {
    if (this.fd === null || this.pendingBytes === 0) return;
    const block = Buffer.concat(this.pending, this.pendingBytes);
    const fd = this.fd;
    timeSyncIo('call recording write', () => fs.writeSync(fd, block, 0, block.length, WAV_HEADER_BYTES + this.written));
    this.written += block.length;
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Flush and make the header describe exactly what is on disk. */
  refreshHeader(): void {
    if (this.fd === null) return;
    this.flush();
    const fd = this.fd;
    const header = wavHeader(this.sampleRate, this.channels, this.bitsPerSample, this.written);
    timeSyncIo('call recording header', () => fs.writeSync(fd, header, 0, WAV_HEADER_BYTES, 0));
  }

  close(): void {
    if (this.fd === null) return;
    try {
      this.refreshHeader();
    } finally {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
