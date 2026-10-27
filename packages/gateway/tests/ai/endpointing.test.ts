import { describe, expect, it } from 'vitest';
import { EndpointerOptions, EnergyEndpointer, UtteranceInfo } from '../../src/ai/endpointer.js';
import { FORMAT_8K } from './helpers.js';

const WINDOW_BYTES = 320; // 20 ms at 8 kHz, 16-bit

/** Constant-level audio: alternating +A/-A samples have an RMS of exactly A (as a fraction of full scale). */
function level(rms: number, ms: number): Buffer {
  const samples = (8000 * ms) / 1000;
  const b = Buffer.alloc(samples * 2);
  const a = Math.round(rms * 32768);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? a : -a, i * 2);
  return b;
}
const SPEECH = 0.05;
const speechMs = (ms: number) => level(SPEECH, ms);
const quietMs = (ms: number) => Buffer.alloc((8000 * ms * 2) / 1000);

function rig(options: Partial<EndpointerOptions> = {}) {
  let clock = 1000;
  const log = {
    soft: [] as Array<{ id: number; bytes: number; speechEndedAt: number }>,
    cancelled: [] as number[],
    utterances: [] as Array<{ pcm: Buffer; info: UtteranceInfo }>,
    starts: 0,
  };
  const endpointer = new EnergyEndpointer(
    FORMAT_8K,
    { rmsThreshold: 0.003, minSpeechMs: 100, minSilenceMs: 800, maxUtteranceMs: 30000, preRollMs: 100, now: () => clock, ...options },
    {
      onSpeechStart: () => void log.starts++,
      onSoftEnd: (pcm, info) => void log.soft.push({ id: info.id, bytes: pcm.length, speechEndedAt: info.speechEndedAt }),
      onSoftCancel: (id) => void log.cancelled.push(id),
      onUtterance: (pcm, info) => void log.utterances.push({ pcm, info }),
    }
  );
  /** Feeds audio window by window, advancing the clock by the audio's duration, as a live stream does. */
  const feed = (pcm: Buffer) => {
    for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) {
      clock += 20;
      endpointer.feed(pcm.subarray(o, o + WINDOW_BYTES));
    }
  };
  return { endpointer, log, feed, now: () => clock };
}

describe('endpointing with the original settings', () => {
  it('ends an utterance after the configured silence and nothing sooner', () => {
    const r = rig();
    r.feed(speechMs(600));
    r.feed(quietMs(780));
    expect(r.log.utterances).toHaveLength(0);
    r.feed(quietMs(40));
    expect(r.log.utterances).toHaveLength(1);
    expect(r.log.utterances[0].info.reason).toBe('silence');
    expect(r.log.soft).toHaveLength(0); // no soft end unless asked for
  });

  it('timestamps the end of speech and the decision, so latency can be counted from when the caller stopped', () => {
    const r = rig();
    r.feed(speechMs(500));
    const speechEnd = r.now();
    r.feed(quietMs(840));
    const { info } = r.log.utterances[0];
    expect(info.speechEndedAt).toBe(speechEnd);
    expect(info.endpointedAt - info.speechEndedAt).toBeGreaterThanOrEqual(800);
    expect(info.endpointedAt - info.speechEndedAt).toBeLessThanOrEqual(820);
    expect(info.silenceTargetMs).toBe(800);
  });

  it('ignores a click shorter than the minimum speech length', () => {
    const r = rig();
    r.feed(speechMs(40));
    r.feed(quietMs(1200));
    expect(r.log.utterances).toHaveLength(0);
    expect(r.log.starts).toBe(0);
  });
});

describe('soft end (speculative transcription)', () => {
  it('offers the audio so far after the soft silence, and the same audio is committed at the real end', () => {
    const r = rig({ softSilenceMs: 350 });
    r.feed(speechMs(1000));
    r.feed(quietMs(340));
    expect(r.log.soft).toHaveLength(0);
    r.feed(quietMs(40));
    expect(r.log.soft).toHaveLength(1);
    expect(r.log.soft[0].bytes).toBeGreaterThanOrEqual(speechMs(1000).length);
    expect(r.log.utterances).toHaveLength(0); // still waiting out the rest
    r.feed(quietMs(500));
    expect(r.log.utterances).toHaveLength(1);
    expect(r.log.utterances[0].info.softId).toBe(r.log.soft[0].id);
    expect(r.endpointer.pendingSoftId).toBeNull(); // consumed by the commit
  });

  it('withdraws the offer when the caller carries on, and a later pause is offered again under a new id', () => {
    const r = rig({ softSilenceMs: 350 });
    r.feed(speechMs(800));
    r.feed(quietMs(400)); // soft end #1
    r.feed(speechMs(500)); // ...but they were only pausing
    expect(r.log.cancelled).toEqual([r.log.soft[0].id]);
    r.feed(quietMs(400)); // soft end #2
    expect(r.log.soft).toHaveLength(2);
    expect(r.log.soft[1].id).not.toBe(r.log.soft[0].id);
    r.feed(quietMs(500));
    expect(r.log.utterances).toHaveLength(1);
    expect(r.log.utterances[0].info.softId).toBe(r.log.soft[1].id);
  });

  it('commits early only while a soft end is pending, with the audio that was offered', () => {
    const r = rig({ softSilenceMs: 350 });
    r.feed(speechMs(900));
    expect(r.endpointer.commitEarly()).toBe(false); // nothing offered yet
    r.feed(quietMs(380));
    expect(r.endpointer.commitEarly()).toBe(true);
    expect(r.log.utterances).toHaveLength(1);
    expect(r.log.utterances[0].info).toMatchObject({ reason: 'early-commit', softId: r.log.soft[0].id });
    r.feed(quietMs(1000)); // the rest of the silence must not produce a second utterance
    expect(r.log.utterances).toHaveLength(1);
    expect(r.endpointer.commitEarly()).toBe(false);
  });
});

describe('adaptive silence', () => {
  /** A caller who pauses `gapMs` between phrases, several times. */
  function talker(r: ReturnType<typeof rig>, gapMs: number, phrases = 5) {
    for (let i = 0; i < phrases; i++) {
      r.feed(speechMs(500));
      r.feed(quietMs(gapMs));
    }
  }

  it('shortens the wait for a caller whose pauses are short, but never below the floor', () => {
    const r = rig({ adaptive: true, minSilenceFloorMs: 450 });
    talker(r, 200, 5);
    expect(r.log.utterances).toHaveLength(0);
    expect(r.endpointer.silenceTargetMs).toBe(450);
    r.feed(speechMs(400));
    r.feed(quietMs(430));
    expect(r.log.utterances).toHaveLength(0);
    r.feed(quietMs(40));
    expect(r.log.utterances).toHaveLength(1);
    expect(r.log.utterances[0].info.silenceTargetMs).toBe(450);
  });

  it('keeps the full wait for a caller who pauses long mid-sentence', () => {
    const r = rig({ adaptive: true });
    talker(r, 700, 5);
    expect(r.endpointer.silenceTargetMs).toBe(800);
  });

  it('does not adapt until it has seen enough pauses, and not at all when switched off', () => {
    const fresh = rig({ adaptive: true });
    talker(fresh, 200, 2);
    expect(fresh.endpointer.silenceTargetMs).toBe(800);
    const off = rig({ adaptive: false });
    talker(off, 200, 6);
    expect(off.endpointer.silenceTargetMs).toBe(800);
  });

  it('never raises the wait above the configured ceiling', () => {
    const r = rig({ adaptive: true, minSilenceMs: 600 });
    talker(r, 500, 6);
    expect(r.endpointer.silenceTargetMs).toBeLessThanOrEqual(600);
  });
});

describe('adaptive loudness threshold', () => {
  it('stops a hissy line from being mistaken for speech, but only when adaptive', () => {
    const hiss = 0.0028; // under the 0.003 threshold, so it is silence either way
    const blip = 0.0075; // above the configured threshold, below three times the hiss floor
    const run = (adaptive: boolean) => {
      const r = rig({ adaptive });
      r.feed(level(hiss, 2000));
      r.feed(level(blip, 400));
      r.feed(quietMs(1200));
      return r.log.utterances.length;
    };
    expect(run(false)).toBe(1); // a 400 ms blip over the configured threshold is an utterance
    expect(run(true)).toBe(0); // the line's own noise floor says it is not
  });

  it('never needs more than the configured threshold on a clean line', () => {
    const r = rig({ adaptive: true });
    r.feed(quietMs(2000));
    expect(r.endpointer.thresholdNow).toBe(0.003);
    r.feed(speechMs(500));
    r.feed(quietMs(900));
    expect(r.log.utterances).toHaveLength(1);
  });
});
