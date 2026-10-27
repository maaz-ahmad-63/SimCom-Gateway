import { buildWavHeader, PcmFormat } from '../diagnostics/pcm-tools.js';

/**
 * The seam between the AI engine and any audio transport. The engine only ever sees these two
 * interfaces, so test fixtures, local files or the SIM7600EI USB audio port are interchangeable.
 * Both declare the exact PCM format they carry and whether that format has been verified.
 */
export type AudioFormat = PcmFormat;

export interface CallerAudioSource {
  readonly format: AudioFormat;
  /** True only when someone has shown (by listening) that this transport carries intelligible speech. */
  readonly verified: boolean;
  /** Subscribe to caller PCM. Returns the unsubscribe function. */
  onAudio(listener: (pcm: Buffer) => void): () => void;
}

export interface PlayResult {
  /** Frames written later than the write-ahead could cover (an audible gap is possible). */
  riskFrames?: number;
  bytesWritten: number;
  /** False when playback was cut short (abort, call ended, transport failure). */
  completed: boolean;
  stoppedBy: string | null;
  /** Frames written more than one frame length behind real time: the modem was fed too late (an underrun risk). */
  lateFrames?: number;
  maxLateMs?: number;
}

export interface AgentAudioSink {
  readonly format: AudioFormat;
  /** True only when someone has shown that audio written to this transport is audible on the call. */
  readonly verified: boolean;
  play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult>;
  /**
   * Optional: play PCM that is still arriving, starting on the first bytes. `onFirstWrite` fires just before audio
   * first goes out. If the source throws, so does this (the caller tells a text-to-speech failure from a port fault).
   */
  playStream?(chunks: AsyncIterable<Buffer>, signal: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult>;
}

export function formatsEqual(a: AudioFormat, b: AudioFormat): boolean {
  return (
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels &&
    a.bitDepth === b.bitDepth &&
    a.endianness === b.endianness
  );
}

export function describeFormat(format: AudioFormat): string {
  return `${format.sampleRate} Hz ${format.bitDepth}-bit ${format.channels === 1 ? 'mono' : `${format.channels}ch`} ${
    format.endianness === 'little-endian' ? 'LE' : 'BE'
  } PCM`;
}

/** The engine's native format: 16-bit signed little-endian mono. Anything else is rejected, not guessed. */
export function assertEnginePcm(format: AudioFormat): void {
  if (format.bitDepth !== 16 || format.channels !== 1 || format.endianness !== 'little-endian') {
    throw new Error(`Unsupported audio format (${describeFormat(format)}); the AI engine handles 16-bit mono little-endian PCM only`);
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 48000) {
    throw new Error(`Unsupported sample rate ${format.sampleRate}`);
  }
}

/** Structural check of a PCM buffer against a declared format. It cannot prove the bytes are speech. */
export function checkPcmBuffer(pcm: Buffer, format: AudioFormat): { ok: true } | { ok: false; reason: string } {
  if (pcm.length === 0) return { ok: false, reason: 'empty audio buffer' };
  const frameBytes = (format.bitDepth / 8) * format.channels;
  if (pcm.length % frameBytes !== 0) {
    return { ok: false, reason: `buffer length ${pcm.length} is not a whole number of ${frameBytes}-byte frames` };
  }
  return { ok: true };
}

/** WAV container for an upload to a speech-to-text API; describes the buffer, verifies nothing. */
export function toWav(pcm: Buffer, format: AudioFormat): Buffer {
  assertEnginePcm(format);
  return Buffer.concat([buildWavHeader({ ...format, verified: true }, pcm.length), pcm]);
}

/**
 * Parse a WAV file into its PCM payload, requiring the header to match `expected`. Used to accept
 * TTS responses that arrive wrapped in a container without trusting them blindly.
 */
export function unwrapWav(data: Buffer, expected: AudioFormat): Buffer {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('response is not a WAV file');
  }
  let offset = 12;
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        tag: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        rate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk precedes the fmt chunk');
      if (fmt.tag !== 1 || fmt.channels !== expected.channels || fmt.rate !== expected.sampleRate || fmt.bits !== expected.bitDepth) {
        throw new Error(
          `WAV is ${fmt.rate} Hz ${fmt.bits}-bit ${fmt.channels}ch (tag ${fmt.tag}), expected ${describeFormat(expected)}`
        );
      }
      return data.subarray(body, Math.min(body + size, data.length));
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

// ---------------------------------------------------------------------------
// Offline implementations (tests, fixtures, the CLI)
// ---------------------------------------------------------------------------

/** A source you push PCM into by hand. */
export class ManualAudioSource implements CallerAudioSource {
  private readonly listeners = new Set<(pcm: Buffer) => void>();

  constructor(
    readonly format: AudioFormat,
    readonly verified = true
  ) {}

  onAudio(listener: (pcm: Buffer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(pcm: Buffer): void {
    for (const listener of [...this.listeners]) listener(pcm);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** A sink that records what would have been played. Never touches any device. */
export class CollectingAudioSink implements AgentAudioSink {
  readonly played: Buffer[] = [];
  playCalls = 0;
  /** Optional pause before play() resolves, to simulate playback time in tests. */
  constructor(
    readonly format: AudioFormat,
    readonly verified = true,
    private readonly playbackMs = 0
  ) {}

  async play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    this.playCalls++;
    if (signal.aborted) return { bytesWritten: 0, completed: false, stoppedBy: 'aborted' };
    if (this.playbackMs > 0) {
      const finished = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), this.playbackMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(false);
          },
          { once: true }
        );
      });
      if (!finished) return { bytesWritten: 0, completed: false, stoppedBy: 'aborted' };
    }
    this.played.push(Buffer.from(pcm));
    return { bytesWritten: pcm.length, completed: true, stoppedBy: null };
  }

  /** Streaming playback in tests: the chunks are collected and recorded as one played buffer. */
  async playStream(chunks: AsyncIterable<Buffer>, signal: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult> {
    const parts: Buffer[] = [];
    for await (const chunk of chunks) {
      if (signal.aborted) return { bytesWritten: 0, completed: false, stoppedBy: 'aborted' };
      if (parts.length === 0) hooks?.onFirstWrite?.();
      parts.push(chunk);
    }
    return this.play(Buffer.concat(parts), signal);
  }

  get totalBytes(): number {
    return this.played.reduce((sum, chunk) => sum + chunk.length, 0);
  }
}
