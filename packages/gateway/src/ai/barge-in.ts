import { assertEnginePcm, AudioFormat } from './audio.js';

/**
 * Detects a caller talking over the agent.
 *
 * In half-duplex mode the audio that arrives while the agent speaks is discarded unheard, because on a phone line it
 * may be the agent's own voice coming back (echo from the caller's handset or the network). That also made barge-in
 * impossible: the caller's interruption never reached the endpointer.
 *
 * This looks only at LOUDNESS, and only for sustained speech clearly above the echo that has been measured so far in
 * this stretch of agent speech. A baseline of the line's level while the agent talks is tracked, and an interruption
 * needs `minMs` of audio above `echoMultiplier` times that baseline (and above an absolute floor). Echo that is steady
 * raises the baseline with it and never triggers; a person starting to talk is a jump above it that stays.
 *
 * It cannot tell speech from a loud noise, so the caller of this class counts triggers that turned out to contain no
 * speech and stops listening for interruptions after a few of them.
 */
export interface BargeInOptions {
  /** Sustained speech needed before it counts (default 300 ms). */
  minMs: number;
  /** How many times louder than the echo baseline (default 2.5). */
  echoMultiplier: number;
  /** Never trigger below this level, however quiet the line (fraction of full scale). */
  floor: number;
  /**
   * The first stretch of agent speech is used only to learn the line's level (default 600 ms). Echo that is already
   * there during it becomes the baseline instead of looking like a caller. Echo that arrives later than this is not
   * recognised by loudness, which is what the transcript check in the conversation is for.
   */
  calibrateMs?: number;
}

const WINDOW_MS = 20;
/** A dip this long ends the run; shorter ones are the gaps between syllables. */
const DIP_MS = 100;

export class BargeInDetector {
  private readonly windowBytes: number;
  private carry = Buffer.alloc(0);
  private baseline = 0;
  private aboveMs = 0;
  private belowMs = 0;
  private elapsedMs = 0;

  constructor(
    format: AudioFormat,
    private readonly options: BargeInOptions
  ) {
    assertEnginePcm(format);
    this.windowBytes = Math.round((format.sampleRate * WINDOW_MS) / 1000) * 2;
  }

  /** Forget the baseline: the agent has started a new stretch of speech. */
  reset(): void {
    this.carry = Buffer.alloc(0);
    this.baseline = 0;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.elapsedMs = 0;
  }

  /** The level the caller has to exceed right now. */
  get thresholdNow(): number {
    return Math.max(this.options.floor, this.baseline * this.options.echoMultiplier);
  }

  /** Feed incoming audio. Returns true at the moment an interruption is established. */
  feed(pcm: Buffer): boolean {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, pcm]) : pcm;
    let offset = 0;
    let triggered = false;
    while (data.length - offset >= this.windowBytes) {
      if (this.window(data.subarray(offset, offset + this.windowBytes))) triggered = true;
      offset += this.windowBytes;
    }
    this.carry = Buffer.from(data.subarray(offset));
    if (triggered) {
      this.aboveMs = 0;
      this.belowMs = 0;
    }
    return triggered;
  }

  private window(window: Buffer): boolean {
    let sum = 0;
    const n = window.length >> 1;
    for (let i = 0; i < n; i++) {
      const v = window.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    const level = n > 0 ? Math.sqrt(sum / n) : 0;
    this.elapsedMs += WINDOW_MS;
    if (this.elapsedMs <= (this.options.calibrateMs ?? 600)) {
      // Learning the line's level while the agent talks: whatever is here is the baseline, loud or not.
      this.baseline = this.baseline === 0 ? level : this.baseline * 0.7 + level * 0.3;
      return false;
    }
    if (level >= this.thresholdNow) {
      this.aboveMs += WINDOW_MS;
      this.belowMs = 0;
      return this.aboveMs >= this.options.minMs;
    }
    // At or under the threshold: this is the line's own level (echo, hiss), so it is what the baseline follows.
    this.baseline = this.baseline === 0 ? level : this.baseline * 0.95 + level * 0.05;
    this.belowMs += WINDOW_MS;
    if (this.belowMs >= DIP_MS) this.aboveMs = 0;
    return false;
  }
}
