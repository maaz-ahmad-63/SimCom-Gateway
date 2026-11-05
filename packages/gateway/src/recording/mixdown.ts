import fs from 'node:fs';
import os from 'node:os';
import { WavFileWriter, WAV_HEADER_BYTES } from './wav.js';

/**
 * The mixdown of one call: the audio the caller sent and the audio the gateway wrote back, which the recorder keeps as two aligned
 * working files, becomes ONE mono WAV the same length as the call.
 *
 * What it does to the audio, and nothing else:
 *  - It adds the two tracks sample by sample. They already share one timeline (the recorder pads each track with silence wherever
 *    nothing arrived), so speech lands where it happened and real pauses stay pauses.
 *  - It applies ONE constant gain to the caller's track, measured from the call itself. The modem hands the gateway the caller's
 *    voice far quieter than the text-to-speech it plays back (about 12-16 dB on this hardware, and already that quiet in the raw
 *    port capture), so an unadjusted mix makes the caller hard to hear next to the agent. The gain is measured on frames that
 *    actually carry speech, never above MAX_CALLER_GAIN, never enough to clip the caller, and never applied when too little speech
 *    was heard to measure. One fixed factor for the whole file: no gate, expander or noise reduction, so silence stays silent, noise
 *    keeps its ratio to speech, and nothing is invented. The agent's track is not changed.
 *  - It counts any sample the sum had to clamp (both sides loud at once), so that is visible instead of silent.
 *
 * The work is done in steps of one block so the caller can interleave it with other work (a call that lasted an hour is 115 MB of
 * working files) and, at shutdown, finish it in one go.
 */

export const FRAME_SAMPLES_PER_SECOND = 50; // 20 ms frames
/** A 20 ms frame whose RMS is at least this carries speech or real signal. The modem's idle frames are exact zeros or a few LSB. */
export const VOICED_RMS_GATE = 150;
/** Fewer voiced frames than this (0.5 s) is not enough evidence to measure a level from. */
export const MIN_VOICED_FRAMES = 25;
/** The level the caller's speech (90th percentile of its voiced frames) is brought to, about -18 dBFS. */
export const TARGET_CALLER_RMS = 4000;
export const MAX_CALLER_GAIN = 8; // +18 dB
const PEAK_CEILING = 0.9 * 32767;

export interface TrackLevels {
  samples: number;
  voicedFrames: number;
  /** 90th percentile of the voiced frames' RMS (0 when there were none). */
  p90Rms: number;
  peak: number;
}

export interface MixResult {
  /** Samples in the combined file. */
  samples: number;
  callerGain: number;
  callerGainDb: number;
  clippedSamples: number;
  caller: TrackLevels;
  agent: TrackLevels;
}

export const toDbfs = (rms: number): number | null => (rms > 0 ? Math.round(20 * Math.log10(rms / 32768) * 10) / 10 : null);

/** The gain for the caller's track from what was measured. Pure, so the rule can be tested without any audio. */
export function callerGainFor(levels: TrackLevels): number {
  if (levels.voicedFrames < MIN_VOICED_FRAMES || levels.p90Rms <= 0) return 1;
  let gain = Math.min(MAX_CALLER_GAIN, TARGET_CALLER_RMS / levels.p90Rms);
  if (levels.peak > 0) gain = Math.min(gain, PEAK_CEILING / levels.peak);
  return Math.max(1, Math.floor(gain * 100) / 100); // quieter speech is raised; louder speech is never lowered. Rounded DOWN so the peak limit above still holds
}

const BLOCK_BYTES = 64_000; // 200 frames of 160 samples; a whole number of frames and samples

class TrackReader {
  private fd: number | null = null;
  readonly samples: number;
  constructor(readonly path: string | null, private readonly headerBytes: number) {
    let size = 0;
    if (path) {
      try {
        size = Math.max(0, fs.statSync(path).size - headerBytes);
        this.fd = fs.openSync(path, 'r');
      } catch {
        size = 0;
        this.fd = null;
      }
    }
    // The size on disk, not the header: a working file left by a crash may have a header that is up to one refresh interval behind.
    this.samples = Math.floor(size / 2);
  }
  /** Up to `samples` samples from sample `at`, zero-filled past the end of the file. Always returns `samples` samples. */
  read(at: number, samples: number): Int16Array {
    const out = Buffer.alloc(samples * 2); // not pooled, so byteOffset is 0 and the Int16Array view is aligned
    const available = Math.max(0, Math.min(samples, this.samples - at));
    if (this.fd !== null && available > 0) {
      let got = 0;
      while (got < available * 2) {
        const n = fs.readSync(this.fd, out, got, available * 2 - got, this.headerBytes + at * 2 + got);
        if (n <= 0) break;
        got += n;
      }
    }
    return new Int16Array(out.buffer, out.byteOffset, samples);
  }
  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

class LevelMeter {
  samples = 0;
  peak = 0;
  private voiced: number[] = [];
  private frameSum = 0;
  private frameCount = 0;
  add(block: Int16Array, validSamples: number): void {
    for (let i = 0; i < validSamples; i++) {
      const v = block[i];
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.frameSum += v * v;
      if (++this.frameCount === 160) this.endFrame();
    }
    this.samples += validSamples;
  }
  private endFrame(): void {
    const rms = Math.sqrt(this.frameSum / this.frameCount);
    if (rms >= VOICED_RMS_GATE) this.voiced.push(rms);
    this.frameSum = 0;
    this.frameCount = 0;
  }
  levels(): TrackLevels {
    if (this.frameCount >= 80) this.endFrame(); // a final partial frame of at least half a frame still counts
    this.frameCount = 0;
    this.frameSum = 0;
    const sorted = Float64Array.from(this.voiced).sort();
    const p90 = sorted.length > 0 ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0;
    return { samples: this.samples, voicedFrames: sorted.length, p90Rms: Math.round(p90), peak: this.peak };
  }
}

export interface MixdownOptions {
  callerPath: string | null;
  agentPath: string | null;
  /** The combined file is written here (the caller renames it into place once the mix is done). */
  outPath: string;
  sampleRate: number;
  /** Bytes before the samples in the input files (a canonical WAV header). */
  headerBytes?: number;
}

/**
 * The mixdown as a state machine: `step()` does one block and returns true when finished. `runToEnd()` is the same work in one go.
 */
export class Mixdown {
  private readonly caller: TrackReader;
  private readonly agent: TrackReader;
  private readonly out: WavFileWriter;
  private readonly callerMeter = new LevelMeter();
  private readonly agentMeter = new LevelMeter();
  private phase: 'scan-caller' | 'scan-agent' | 'mix' | 'done' | 'failed' = 'scan-caller';
  private position = 0;
  private gain = 1;
  private clipped = 0;
  private opened = false;
  private result: MixResult | null = null;
  private callerLevels: TrackLevels | null = null;
  private agentLevels: TrackLevels | null = null;

  constructor(private readonly options: MixdownOptions) {
    if (os.endianness() !== 'LE') throw new Error('the mixdown needs a little-endian machine');
    const header = options.headerBytes ?? WAV_HEADER_BYTES;
    this.caller = new TrackReader(options.callerPath, header);
    this.agent = new TrackReader(options.agentPath, header);
    this.out = new WavFileWriter(options.outPath, options.sampleRate);
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  /** What the two inputs add up to, once the scan has finished. */
  get total(): number {
    return Math.max(this.caller.samples, this.agent.samples);
  }

  step(): boolean {
    try {
      switch (this.phase) {
        case 'scan-caller':
          if (this.scan(this.caller, this.callerMeter)) {
            this.callerLevels = this.callerMeter.levels();
            this.phase = 'scan-agent';
            this.position = 0;
          }
          return false;
        case 'scan-agent':
          if (this.scan(this.agent, this.agentMeter)) {
            this.agentLevels = this.agentMeter.levels();
            this.gain = callerGainFor(this.callerLevels!);
            this.phase = 'mix';
            this.position = 0;
          }
          return false;
        case 'mix':
          return this.mix();
        default:
          if (this.phase === 'failed') throw new Error('the mixdown already failed');
          return true;
      }
    } catch (error) {
      this.phase = 'failed';
      this.abort();
      throw error;
    }
  }

  runToEnd(): MixResult {
    while (!this.step()) {
      /* each step is one block */
    }
    return this.finished();
  }

  finished(): MixResult {
    if (!this.result) throw new Error('the mixdown has not finished');
    return this.result;
  }

  /** Stop and release the files without a result (a failed or abandoned mixdown). The partly written output is left for the caller to delete. */
  abort(): void {
    this.caller.close();
    this.agent.close();
    try {
      this.out.close();
    } catch {
      /* already closed or never opened */
    }
  }

  private scan(reader: TrackReader, meter: LevelMeter): boolean {
    if (this.position >= reader.samples) return true;
    const n = Math.min(BLOCK_BYTES / 2, reader.samples - this.position);
    meter.add(reader.read(this.position, n), n);
    this.position += n;
    return this.position >= reader.samples;
  }

  private mix(): boolean {
    if (!this.opened) {
      this.out.open();
      this.opened = true;
    }
    const total = this.total;
    if (this.position < total) {
      const n = Math.min(BLOCK_BYTES / 2, total - this.position);
      const c = this.caller.read(this.position, n);
      const a = this.agent.read(this.position, n);
      const mixed = Buffer.alloc(n * 2);
      const gain = this.gain;
      for (let i = 0; i < n; i++) {
        let v = Math.round(c[i] * gain) + a[i];
        if (v > 32767) {
          v = 32767;
          this.clipped++;
        } else if (v < -32768) {
          v = -32768;
          this.clipped++;
        }
        mixed.writeInt16LE(v, i * 2);
      }
      this.out.append(mixed);
      this.position += n;
      if (this.position < total) return false;
    }
    this.out.close();
    this.caller.close();
    this.agent.close();
    this.result = {
      samples: total,
      callerGain: this.gain,
      callerGainDb: Math.round(20 * Math.log10(this.gain) * 10) / 10,
      clippedSamples: this.clipped,
      caller: this.callerLevels!,
      agent: this.agentLevels!,
    };
    this.phase = 'done';
    return true;
  }
}
