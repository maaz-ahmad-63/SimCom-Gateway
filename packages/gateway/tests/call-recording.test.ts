import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioFrame, CallSession, IAudioAdapter } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { CallRecorder, COMBINED_FILE } from '../src/recording/call-recorder.js';
import { loadRecordingConfig, RecordingConfig } from '../src/recording/config.js';
import { callerGainFor, Mixdown, MAX_CALLER_GAIN, MIN_VOICED_FRAMES, TARGET_CALLER_RMS } from '../src/recording/mixdown.js';
import { parseWav, wavHeader, WavFileWriter, WAV_HEADER_BYTES } from '../src/recording/wav.js';
import { createGatewayServer } from '../src/server.js';
import { GatewayAudioSink } from '../src/ai/gateway-adapters.js';
import { FORMAT_8K } from './ai/helpers.js';

const RATE = 8000;
const CALL = '11111111-2222-4333-8444-555555555555';
const CALL_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

/** 16-bit mono sine, `ms` long. */
function sine(freq: number, ms: number, amp = 12000, startSample = 0): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * (startSample + i)) / RATE)), i * 2);
  return b;
}
const rms = (pcm: Buffer): number => {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
};
const peak = (pcm: Buffer): number => {
  let p = 0;
  for (let i = 0; i < pcm.length; i += 2) p = Math.max(p, Math.abs(pcm.readInt16LE(i)));
  return p;
};
/** Frequency from zero crossings: proves the samples are the tone that was sent, not just "some bytes". */
const frequency = (pcm: Buffer, rate = RATE): number => {
  let crossings = 0;
  for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) < 0 !== pcm.readInt16LE(i) < 0) crossings++;
  return crossings / 2 / (pcm.length / 2 / rate);
};
/** Seconds `a`..`b` of a mono 16-bit buffer. */
const seconds = (pcm: Buffer, a: number, b: number): Buffer => pcm.subarray(Math.round(a * RATE) * 2, Math.round(b * RATE) * 2);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

class FakeAudio extends EventEmitter {
  isSimulated = false;
  frame(data: Buffer): void {
    this.emit('audio_frame', { sequenceNumber: 1, frameDurationMs: 20, data, timestamp: Date.now(), rmsLevel: 0.1, isSimulated: false } as AudioFrame);
  }
  out(data: Buffer): void {
    this.emit('audio_out', data);
  }
}

const session = (id = CALL, over: Partial<CallSession> = {}): CallSession => ({
  id, direction: 'inbound', remoteNumber: '+910000000000', state: 'ACTIVE', startedAt: new Date().toISOString(),
  answeredAt: new Date().toISOString(), endedAt: null, durationSeconds: 0, outcome: null, isSimulated: false, ...over,
});

describe('WAV files', () => {
  it('writes a canonical header', () => {
    const h = wavHeader(8000, 1, 16, 320);
    expect(h.length).toBe(WAV_HEADER_BYTES);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(36 + 320);
    expect(h.readUInt16LE(22)).toBe(1);
    expect(h.readUInt32LE(24)).toBe(8000);
    expect(h.readUInt32LE(28)).toBe(16000);
    expect(h.readUInt16LE(32)).toBe(2);
    expect(h.readUInt16LE(34)).toBe(16);
  });

  it('refuses files that are only renamed raw PCM or are inconsistent', () => {
    expect(() => parseWav(sine(440, 100))).toThrow();
    const bad = Buffer.concat([wavHeader(8000, 1, 16, 999), sine(440, 100)]);
    expect(() => parseWav(bad)).toThrow(/size/);
  });
});

describe('recording configuration', () => {
  it('is off by default and needs consent as well', () => {
    const c = loadRecordingConfig({});
    expect(c).toMatchObject({ enabled: false, consentAcknowledged: false, retentionDays: 0, dir: './call-recordings' });
    expect(loadRecordingConfig({ CALL_RECORDING_ENABLED: 'true', CALL_RECORDING_RETENTION_DAYS: '-3' }).errors.join(' ')).toMatch(/RETENTION_DAYS/);
  });
});

describe('the caller gain rule', () => {
  const levels = (over: Partial<{ voicedFrames: number; p90Rms: number; peak: number }> = {}) => ({ samples: 80000, voicedFrames: 100, p90Rms: 1000, peak: 5000, ...over });

  it('raises quiet speech to the target, in one step, and says how much', () => {
    expect(callerGainFor(levels({ p90Rms: 1000 }))).toBe(4); // 4000 / 1000
    expect(callerGainFor(levels({ p90Rms: 1436, peak: 7213 }))).toBeCloseTo(TARGET_CALLER_RMS / 1436, 1);
  });

  it('never raises beyond the cap, never lowers loud speech, never clips the caller', () => {
    expect(callerGainFor(levels({ p90Rms: 100, peak: 500 }))).toBe(MAX_CALLER_GAIN);
    expect(callerGainFor(levels({ p90Rms: 6000, peak: 20000 }))).toBe(1);
    expect(callerGainFor(levels({ p90Rms: 1000, peak: 30000 }))).toBe(1); // 4x would clip a 30000 peak
    const g = callerGainFor(levels({ p90Rms: 1000, peak: 12000 }));
    expect(g * 12000).toBeLessThanOrEqual(0.9 * 32767 + 1);
  });

  it('measures nothing from too little speech: no gain, so noise is never what gets amplified', () => {
    expect(callerGainFor(levels({ voicedFrames: MIN_VOICED_FRAMES - 1, p90Rms: 200 }))).toBe(1);
    expect(callerGainFor(levels({ voicedFrames: 0, p90Rms: 0, peak: 6 }))).toBe(1);
  });
});

describe('Mixdown', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const work = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdown-'));
    dirs.push(d);
    return d;
  };
  const track = (file: string, pcm: Buffer) => {
    const w = new WavFileWriter(file, RATE);
    w.open();
    w.append(pcm);
    w.close();
  };

  it('works in steps (a long call is never one blocking pass) and gives the same file either way', () => {
    const d = work();
    track(path.join(d, 'c.wav'), sine(440, 12_000, 3000));
    track(path.join(d, 'a.wav'), sine(900, 12_000, 9000));
    const stepped = new Mixdown({ callerPath: path.join(d, 'c.wav'), agentPath: path.join(d, 'a.wav'), outPath: path.join(d, 'out1.wav'), sampleRate: RATE });
    let steps = 0;
    while (!stepped.step()) steps++;
    expect(steps).toBeGreaterThanOrEqual(8); // 24 s of audio is many 4-second blocks, not one
    const whole = new Mixdown({ callerPath: path.join(d, 'c.wav'), agentPath: path.join(d, 'a.wav'), outPath: path.join(d, 'out2.wav'), sampleRate: RATE }).runToEnd();
    expect(sha(fs.readFileSync(path.join(d, 'out1.wav')))).toBe(sha(fs.readFileSync(path.join(d, 'out2.wav'))));
    expect(whole.samples).toBe(12 * RATE);
    expect(parseWav(fs.readFileSync(path.join(d, 'out1.wav'))).dataBytes).toBe(12 * RATE * 2);
  });

  it('is as long as the longer side, with the shorter one silent past its end', () => {
    const d = work();
    track(path.join(d, 'c.wav'), sine(440, 500, 9000));
    track(path.join(d, 'a.wav'), sine(900, 1500, 9000));
    new Mixdown({ callerPath: path.join(d, 'c.wav'), agentPath: path.join(d, 'a.wav'), outPath: path.join(d, 'o.wav'), sampleRate: RATE }).runToEnd();
    const out = parseWav(fs.readFileSync(path.join(d, 'o.wav'))).data;
    expect(out.length / 2 / RATE).toBeCloseTo(1.5, 3);
    expect(Math.abs(frequency(seconds(out, 0.6, 1.4)) - 900)).toBeLessThan(30); // only the agent after the caller's side ended
  });

  it('reads the samples that are on disk, not what a stale header says (a working file left by a crash)', () => {
    const d = work();
    const pcm = sine(440, 1000, 9000);
    fs.writeFileSync(path.join(d, 'c.wav'), Buffer.concat([wavHeader(RATE, 1, 16, 0), pcm])); // the header was never refreshed
    const r = new Mixdown({ callerPath: path.join(d, 'c.wav'), agentPath: null, outPath: path.join(d, 'o.wav'), sampleRate: RATE }).runToEnd();
    expect(r.samples).toBe(RATE);
    expect(parseWav(fs.readFileSync(path.join(d, 'o.wav'))).data.equals(pcm)).toBe(true);
  });

  it('adds the sides exactly, and counts what had to be clamped when both are loud at once', () => {
    const d = work();
    track(path.join(d, 'c.wav'), sine(440, 1000, 26000));
    track(path.join(d, 'a.wav'), sine(440, 1000, 26000)); // the same phase: the sum is 52000
    const r = new Mixdown({ callerPath: path.join(d, 'c.wav'), agentPath: path.join(d, 'a.wav'), outPath: path.join(d, 'o.wav'), sampleRate: RATE }).runToEnd();
    expect(r.clippedSamples).toBeGreaterThan(1000);
    expect(peak(parseWav(fs.readFileSync(path.join(d, 'o.wav'))).data)).toBeGreaterThanOrEqual(32767); // clamped at the 16-bit limit, positive or negative
    // Whereas sides that do not collide are an exact sum.
    track(path.join(d, 'c2.wav'), sine(300, 500, 8000));
    track(path.join(d, 'a2.wav'), Buffer.concat([Buffer.alloc(8000), sine(900, 500, 8000)])); // starts 0.5 s later
    const r2 = new Mixdown({ callerPath: path.join(d, 'c2.wav'), agentPath: path.join(d, 'a2.wav'), outPath: path.join(d, 'o2.wav'), sampleRate: RATE }).runToEnd();
    expect(r2.clippedSamples).toBe(0);
  });
});

describe('CallRecorder', () => {
  const dirs: string[] = [];
  const recorders: CallRecorder[] = [];
  afterEach(() => {
    for (const r of recorders.splice(0)) r.stop();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function harness(over: Partial<RecordingConfig> = {}, existingDir?: string) {
    const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'call-rec-'));
    if (!existingDir) dirs.push(dir);
    const audio = new FakeAudio();
    const bus = new GatewayEventBus();
    let now = 1_000_000;
    const config: RecordingConfig = { enabled: true, consentAcknowledged: true, dir, retentionDays: 0, maxSeconds: 3600, errors: [], ...over };
    const recorder = new CallRecorder({ audio: audio as unknown as IAudioAdapter, eventBus: bus, config, sampleRate: () => RATE, now: () => now });
    recorders.push(recorder);
    recorder.start();
    const activate = (s = session()) => bus.emit('call:state_changed', { callId: s.id, previousState: 'INBOUND_RINGING', currentState: 'ACTIVE', timestamp: '', session: s });
    const end = (s = session(CALL, { state: 'IDLE', outcome: 'completed', endedAt: new Date().toISOString() })) => bus.emit('call:ended', s);
    const tick = (ms: number) => (now += ms);
    /** Caller audio arriving in 20 ms frames as the modem sends it, `ms` long. */
    const callerSpeaks = (ms: number, freq = 440, amp = 12000, from = 0) => {
      for (let i = 0; i < ms / 20; i++) {
        tick(20);
        audio.frame(sine(freq, 20, amp, from + i * 160));
      }
    };
    /** Caller silence as the modem sends it: frames of exact zeros. */
    const callerSilent = (ms: number) => {
      for (let i = 0; i < ms / 20; i++) {
        tick(20);
        audio.frame(Buffer.alloc(320));
      }
    };
    /** Hang up and wait for the combined file. */
    const finish = async (s?: CallSession) => {
      end(s);
      await recorder.whenIdle();
    };
    const wavOf = (callId = CALL) => parseWav(fs.readFileSync(recorder.combinedFile(callId)!));
    return { dir, audio, bus, recorder, activate, end, tick, callerSpeaks, callerSilent, finish, wavOf };
  }

  it('records nothing unless enabled and consent is acknowledged, and says why', () => {
    const off = harness({ enabled: false });
    off.activate(); off.audio.frame(sine(440, 20)); off.end();
    expect(off.recorder.getStatus().inactiveReason).toMatch(/off/);
    expect(fs.readdirSync(off.dir)).toEqual([]);

    const noConsent = harness({ consentAcknowledged: false });
    noConsent.activate(); noConsent.audio.frame(sine(440, 20)); noConsent.end();
    expect(noConsent.recorder.getStatus().inactiveReason).toMatch(/consent acknowledgement has not been confirmed/);
    expect(fs.readdirSync(noConsent.dir)).toEqual([]);
  });

  describe('one WAV per call', () => {
    it('leaves exactly one audio file in the call folder: no separate caller and agent files, no working files', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(500);
      h.audio.out(sine(1000, 300));
      h.tick(300);
      await h.finish();
      expect(fs.readdirSync(path.join(h.dir, CALL)).sort()).toEqual(['recording.json', COMBINED_FILE].sort());
    });

    it('CALLER ONLY: the caller\'s audio is in the file as sent (loud speech is not altered), the agent\'s side is silent', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(1000, 440, 12000);
      await h.finish();
      const wav = h.wavOf();
      expect(wav.data.length / 2 / RATE).toBeCloseTo(1.0, 2);
      expect(wav.data.equals(sine(440, 1000, 12000))).toBe(true); // byte for byte: gain 1 for speech this loud
      const meta = h.recorder.list()[0];
      expect(meta).toMatchObject({ complete: true, hasCallerAudio: true, hasAgentAudio: false, file: COMBINED_FILE, available: true });
      expect(meta.mix!.callerGainDb).toBe(0);
      expect(meta.note).toMatch(/Nothing was written to the caller/);
    });

    it('AI ONLY: what was written to the modem is in the file, on the timeline where it was written', async () => {
      const h = harness();
      h.activate();
      h.tick(400); // the AI waits 0.4 s, then speaks 0.5 s
      h.audio.out(sine(1000, 500, 9000));
      h.tick(500);
      await h.finish();
      const wav = h.wavOf();
      expect(rms(seconds(wav.data, 0, 0.38))).toBe(0);
      expect(Math.abs(frequency(seconds(wav.data, 0.45, 0.85)) - 1000)).toBeLessThan(30);
      expect(wav.data.subarray(Math.round(0.4 * RATE) * 2, Math.round(0.9 * RATE) * 2).equals(sine(1000, 500, 9000))).toBe(true);
      const meta = h.recorder.list()[0];
      expect(meta).toMatchObject({ hasCallerAudio: false, hasAgentAudio: true });
      expect(meta.note).toMatch(/No audio was received from the modem/);
    });

    it('COMBINED: both sides in one file in order of time, each as the tone that was sent, the length of the call', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(1000, 440, 12000); // 0 - 1 s: the caller
      h.audio.out(sine(1000, 500, 9000)); // 1 - 1.5 s: the AI answers
      h.tick(500);
      h.callerSpeaks(500, 600, 12000, 0); // 1.5 - 2 s: the caller again
      await h.finish();
      const wav = h.wavOf();
      expect(wav.data.length / 2 / RATE).toBeCloseTo(2.0, 2);
      expect(Math.abs(frequency(seconds(wav.data, 0.1, 0.9)) - 440)).toBeLessThan(15);
      expect(Math.abs(frequency(seconds(wav.data, 1.1, 1.4)) - 1000)).toBeLessThan(30);
      expect(Math.abs(frequency(seconds(wav.data, 1.6, 1.95)) - 600)).toBeLessThan(25);
      expect(rms(seconds(wav.data, 0.1, 0.9))).toBeGreaterThan(7000);
      expect(rms(seconds(wav.data, 1.1, 1.4))).toBeGreaterThan(5500);
      const meta = h.recorder.list()[0];
      expect(meta).toMatchObject({ complete: true, hasCallerAudio: true, hasAgentAudio: true, sampleRate: RATE, channels: 1, bitsPerSample: 16, outcome: 'completed' });
      expect(meta.durationMs).toBeGreaterThanOrEqual(1990);
      expect(meta.durationMs).toBeLessThanOrEqual(2010);
    });

    it('both sides at the same time (the caller talks over the AI) are both in the file', async () => {
      const h = harness();
      h.activate();
      h.audio.out(sine(1000, 1000, 6000));
      h.callerSpeaks(1000, 440, 6000);
      await h.finish();
      const both = seconds(h.wavOf().data, 0.2, 0.8);
      const caller = sine(440, 1000, 6000);
      const agent = sine(1000, 1000, 6000);
      // Neither side is lost: the sum is exactly the sum of what each sent.
      const expected = Buffer.alloc(both.length);
      const from = Math.round(0.2 * RATE);
      for (let i = 0; i < both.length / 2; i++) expected.writeInt16LE(caller.readInt16LE((from + i) * 2) + agent.readInt16LE((from + i) * 2), i * 2);
      expect(both.equals(expected)).toBe(true);
    });
  });

  describe('the caller side is quieter at the source, and the mix says so rather than hiding it', () => {
    it('applies ONE constant gain to the caller, leaves the agent exact, keeps silence silent and noise in the same ratio to speech', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(1000, 440, 1500); // 0 - 1 s: quiet speech (RMS about 1060)
      h.audio.out(sine(1000, 500, 12000)); // 1 - 1.5 s: the AI, while the caller is silent
      h.callerSilent(2000 - 1000); // 1 - 2 s: exact zeros
      for (let i = 0; i < 50; i++) { h.tick(20); h.audio.frame(sine(300, 20, 3, i * 160)); } // 2 - 3 s: line noise of a few LSB
      await h.finish();
      const wav = h.wavOf();
      const meta = h.recorder.list()[0];
      const gain = 10 ** (meta.mix!.callerGainDb / 20);
      expect(gain).toBeGreaterThan(3.3);
      expect(gain).toBeLessThan(4.2);
      // The caller's speech now sits near the target level instead of 12-16 dB under the agent.
      expect(rms(seconds(wav.data, 0.1, 0.9))).toBeGreaterThan(3500);
      expect(rms(seconds(wav.data, 0.1, 0.9))).toBeLessThan(4600);
      // The agent's speech is exactly what was written (the caller was silent then, so nothing else is in that stretch).
      expect(seconds(wav.data, 1.0, 1.5).equals(sine(1000, 500, 12000))).toBe(true);
      // Genuine silence stays genuine silence: no noise is manufactured out of nothing.
      expect(rms(seconds(wav.data, 1.55, 1.95))).toBe(0);
      // Line noise is scaled by the same constant as the speech (its ratio to speech is unchanged), and no more.
      const noise = seconds(wav.data, 2.1, 2.9);
      expect(peak(noise)).toBeLessThanOrEqual(Math.ceil(3 * gain) + 1);
      expect(peak(noise)).toBeGreaterThan(0);
      expect(meta.mix!.callerSpeechDbfs!).toBeLessThan(meta.mix!.agentSpeechDbfs ?? 0);
      expect(meta.note).toMatch(/raised by [\d.]+ dB/);
    });

    it('does not guess a level from too little speech: a brief quiet blip leaves the caller exactly as received', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(300, 440, 1500); // 15 voiced frames: under the 25 needed to measure
      h.callerSilent(700);
      await h.finish();
      const meta = h.recorder.list()[0];
      expect(meta.mix!.callerGainDb).toBe(0);
      expect(h.wavOf().data.subarray(0, 600 * 2 * 4).equals(Buffer.concat([sine(440, 300, 1500), Buffer.alloc(320 * 2 * 4 - 0)]).subarray(0, 600 * 2 * 4))).toBe(true);
    });

    it('a caller who is already loud is not turned down', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(1000, 440, 16000);
      await h.finish();
      expect(h.recorder.list()[0].mix!.callerGainDb).toBe(0);
      expect(peak(h.wavOf().data)).toBe(16000);
    });

    it('counts samples it had to clamp when both sides are loud at once, instead of hiding it', async () => {
      const h = harness();
      h.activate();
      h.audio.out(sine(440, 1000, 26000));
      h.callerSpeaks(1000, 440, 26000);
      await h.finish();
      const meta = h.recorder.list()[0];
      expect(meta.mix!.clippedSamples).toBeGreaterThan(100);
      expect(peak(h.wavOf().data)).toBeGreaterThanOrEqual(32767);
    });
  });

  describe('missing, late and bursty audio', () => {
    it('fills a real gap with silence but does not distort continuous audio', async () => {
      const h = harness();
      h.activate();
      h.tick(20); h.audio.frame(sine(440, 20));
      h.tick(1000); h.audio.frame(sine(440, 20)); // the port stalled for a second
      await h.finish();
      const wav = h.wavOf();
      expect(wav.data.length / 2 / RATE).toBeGreaterThan(1.0);
      expect(rms(wav.data.subarray(2 * 400, 2 * 7000))).toBe(0); // the stalled second is silent, not squeezed out
    });

    it('a late burst of frames keeps every sample, in order, contiguous (nothing dropped, overwritten or reordered)', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(500, 440, 9000); // 0.5 s on time
      h.tick(300); // the USB port delivers nothing for 0.3 s ...
      const burst = sine(700, 400, 9000);
      for (let i = 0; i < 20; i++) h.audio.frame(burst.subarray(i * 320, (i + 1) * 320)); // ... and then 20 frames at once
      await h.finish();
      const data = h.wavOf().data;
      const at = data.indexOf(burst);
      expect(at).toBeGreaterThanOrEqual(0); // the whole burst is in the file, intact
      expect(at % 2).toBe(0);
      expect(rms(data.subarray(0, 2 * 3900))).toBeGreaterThan(5000); // the on-time half second is untouched
      // Every non-zero sample sent was kept: the file holds as much speech as was sent.
      const speechSamples = (b: Buffer) => { let n = 0; for (let i = 0; i < b.length; i += 2) if (b.readInt16LE(i) !== 0) n++; return n; };
      expect(speechSamples(data)).toBeGreaterThanOrEqual(speechSamples(sine(440, 500, 9000)) + speechSamples(burst) - 2);
    });

    it('keeps 16-bit alignment when a chunk arrives with an odd byte count', async () => {
      const h = harness();
      h.activate();
      const tone = sine(440, 100);
      h.tick(10); h.audio.frame(tone.subarray(0, 201));
      h.tick(10); h.audio.frame(tone.subarray(201));
      await h.finish();
      const wav = h.wavOf();
      expect(wav.dataBytes % 2).toBe(0);
      expect(rms(wav.data.subarray(0, tone.length - 2))).toBeGreaterThan(7000);
    });

    it('a call with no audio at all is reported honestly and is a valid, silent, call-length file', async () => {
      const h = harness();
      h.activate();
      h.tick(1000);
      await h.finish();
      const meta = h.recorder.list()[0];
      expect(meta).toMatchObject({ hasCallerAudio: false, hasAgentAudio: false, complete: true });
      expect(meta.note).toMatch(/No audio was received/);
      const wav = h.wavOf();
      expect(wav.data.length / 2 / RATE).toBeCloseTo(1.0, 2);
      expect(rms(wav.data)).toBe(0);
    });

    it('a quiet stretch is not a defect: speech, a long real pause, speech again, with the pause kept at its true length', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(500, 440, 9000);
      h.callerSilent(3000);
      h.callerSpeaks(500, 440, 9000, 0);
      await h.finish();
      const data = h.wavOf().data;
      expect(data.length / 2 / RATE).toBeCloseTo(4.0, 2);
      expect(rms(seconds(data, 0.6, 3.4))).toBe(0);
      expect(rms(seconds(data, 3.6, 3.95))).toBeGreaterThan(5000);
    });
  });

  describe('finalizing', () => {
    it('on a normal hangup the file has an exact header, the length of the call and exactly the samples written', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(2500, 440, 12000);
      await h.finish();
      const raw = fs.readFileSync(h.recorder.combinedFile(CALL)!);
      const wav = parseWav(raw); // strict: RIFF size, data size and file size all agree
      expect(raw.length).toBe(WAV_HEADER_BYTES + wav.dataBytes);
      expect([wav.sampleRate, wav.channels, wav.bitsPerSample]).toEqual([8000, 1, 16]);
      expect(wav.dataBytes).toBe(2.5 * RATE * 2);
      const meta = h.recorder.list()[0];
      expect(meta).toMatchObject({ kind: 'complete-call-recording', complete: true, file: COMBINED_FILE, bytes: raw.length, durationMs: 2500 });
      expect(meta.endedAt).not.toBeNull();
    });

    it('does not block the gateway: the file is built in steps, and the call is already over for everything else', async () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(2000, 440, 12000);
      h.end();
      expect(h.recorder.getStatus().active).toBeNull(); // the next call may start at once
      expect(h.recorder.combinedFile(CALL)).toBeNull(); // the file is still being finished ...
      expect(h.recorder.list()[0]).toMatchObject({ complete: false, available: false });
      await h.recorder.whenIdle();
      expect(h.recorder.list()[0]).toMatchObject({ complete: true, available: true }); // ... and then it is there
    });

    it('records a call once even when the ACTIVE event repeats, and starts clean for the next call', async () => {
      const h = harness();
      h.activate(); h.activate(); h.activate();
      h.tick(20); h.audio.frame(sine(440, 20));
      await h.finish();
      expect(h.recorder.list()).toHaveLength(1);
      expect(h.recorder.getStatus().active).toBeNull();
      h.audio.frame(sine(440, 20)); // after the call: ignored
      h.activate(session(CALL_B));
      h.tick(20); h.audio.frame(sine(440, 20));
      await h.finish(session(CALL_B, { state: 'IDLE', outcome: 'completed' }));
      expect(h.recorder.list().map((m) => m.callId).sort()).toEqual([CALL, CALL_B].sort());
    });

    it('a gateway that stops mid-call (an abrupt end) still leaves a valid combined file, marked incomplete with the reason', () => {
      const h = harness();
      h.activate();
      h.callerSpeaks(600, 440, 12000);
      h.recorder.stop(); // shutdown without call:ended; the mix is finished there and then
      const meta = h.recorder.list()[0];
      expect(meta.complete).toBe(false);
      expect(meta.error).toMatch(/gateway stopped/);
      expect(meta.file).toBe(COMBINED_FILE);
      const wav = parseWav(fs.readFileSync(path.join(h.dir, CALL, COMBINED_FILE)));
      expect(wav.dataBytes).toBeGreaterThan(8000);
      expect(h.recorder.getStatus().active).toBeNull();
    });

    it('a crash that leaves working files behind is recovered at the next start: nothing recorded is lost', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-rec-crash-'));
      dirs.push(dir);
      const first = harness({}, dir);
      first.activate();
      first.callerSpeaks(1000, 440, 12000);
      first.audio.out(sine(1000, 500, 9000));
      first.recorder['active']!.caller.writer.refreshHeader(); // what the 5 s refresh timer would have done
      first.recorder['active']!.agent.writer.refreshHeader();
      first.recorder['active']!.timer.unref();
      // The process dies here: no call:ended, no stop(). The first recorder is simply abandoned.
      recorders.splice(recorders.indexOf(first.recorder), 1);
      expect(fs.readdirSync(path.join(dir, CALL)).sort()).toEqual(['agent.work.wav', 'caller.work.wav', 'recording.json']);

      const second = harness({}, dir); // the gateway starts again
      await second.recorder.whenIdle();
      const meta = second.recorder.list()[0];
      expect(meta).toMatchObject({ callId: CALL, complete: false, file: COMBINED_FILE, available: true });
      expect(meta.error).toMatch(/gateway stopped while the call was being recorded/);
      expect(meta.endedAt).not.toBeNull();
      const wav = parseWav(fs.readFileSync(path.join(dir, CALL, COMBINED_FILE)));
      expect(wav.dataBytes).toBeGreaterThanOrEqual(1.0 * RATE * 2);
      expect(Math.abs(frequency(seconds(wav.data, 0.1, 0.9)) - 440)).toBeLessThan(15);
      expect(fs.readdirSync(path.join(dir, CALL)).sort()).toEqual(['recording.json', COMBINED_FILE].sort()); // working files cleaned up
    });

    it('a call that had finished but whose file was not built yet is recovered as complete', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-rec-midmix-'));
      dirs.push(dir);
      const first = harness({}, dir);
      first.activate();
      first.callerSpeaks(800, 440, 12000);
      first.end(); // finished; the combined file is still being built ...
      expect(first.recorder.combinedFile(CALL)).toBeNull();
      recorders.splice(recorders.indexOf(first.recorder), 1); // ... and the process dies before it is
      await new Promise((r) => setTimeout(r, 50)); // (the abandoned recorder's own mix may or may not have run; either way the result is the same)
      fs.rmSync(path.join(dir, CALL, COMBINED_FILE), { force: true });
      const meta0 = JSON.parse(fs.readFileSync(path.join(dir, CALL, 'recording.json'), 'utf8'));
      meta0.file = null; meta0.complete = false; delete meta0.error;
      fs.writeFileSync(path.join(dir, CALL, 'recording.json'), JSON.stringify(meta0));
      fs.writeFileSync(path.join(dir, CALL, 'caller.work.wav'), Buffer.concat([wavHeader(RATE, 1, 16, 12800), sine(440, 800, 12000)]));
      const second = harness({}, dir);
      await second.recorder.whenIdle();
      expect(second.recorder.list()[0]).toMatchObject({ complete: true, available: true });
      expect(second.recorder.list()[0].error).toBeUndefined();
    });

    it('stops recording at the configured maximum and says so, leaving a valid file', async () => {
      const h = harness({ maxSeconds: 10 });
      h.activate();
      for (let i = 0; i < 700; i++) { h.tick(20); h.audio.frame(sine(440, 20)); } // 14 s
      await h.finish();
      const meta = h.recorder.list()[0];
      expect(meta.truncated).toBe(true);
      expect(meta.durationMs).toBeLessThanOrEqual(10_000);
      expect(() => h.wavOf()).not.toThrow();
    });

    it('never throws into the audio path when the disk is unusable, and reports the error', () => {
      const file = path.join(os.tmpdir(), `not-a-dir-${Date.now()}`);
      fs.writeFileSync(file, 'x');
      dirs.push(file);
      const h = harness({ dir: file });
      expect(() => { h.activate(); h.audio.frame(sine(440, 20)); h.audio.out(sine(440, 20)); h.end(); }).not.toThrow();
      expect(h.recorder.getStatus().lastError).toMatch(/Could not start recording/);
    });
  });

  describe('serving', () => {
    it('only hands out recordings it made, for valid call ids', async () => {
      const h = harness();
      h.activate(); h.tick(20); h.audio.frame(sine(440, 20)); await h.finish();
      expect(h.recorder.combinedFile(CALL)).not.toBeNull();
      expect(h.recorder.combinedFile(CALL_B)).toBeNull();
      expect(h.recorder.combinedFile('../../etc')).toBeNull();
      expect(await h.recorder.ensureCombined('../../etc')).toBeNull();
      expect(await h.recorder.ensureCombined(CALL_B)).toBeNull();
      expect(h.recorder.get('..')).toBeNull();
    });

    it('deletes only finished recordings older than the retention period, and never when it is 0', async () => {
      const h = harness({ retentionDays: 0 });
      h.activate(); h.tick(20); h.audio.frame(sine(440, 20)); await h.finish();
      h.tick(400 * 86_400_000);
      h.activate(session(CALL_B)); h.tick(20); h.audio.frame(sine(440, 20)); await h.finish(session(CALL_B, { state: 'IDLE' }));
      expect(h.recorder.list()).toHaveLength(2); // retention 0: nothing deleted

      const r = harness({ retentionDays: 30 });
      const foreign = path.join(r.dir, 'my-own-notes');
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, 'keep.txt'), 'mine');
      r.activate(); r.tick(20); r.audio.frame(sine(440, 20)); await r.finish();
      r.tick(40 * 86_400_000);
      r.activate(session(CALL_B)); r.tick(20); r.audio.frame(sine(440, 20)); await r.finish(session(CALL_B, { state: 'IDLE' }));
      expect(r.recorder.list().map((m) => m.callId)).toEqual([CALL_B]); // the 40-day-old one is gone
      expect(fs.existsSync(path.join(foreign, 'keep.txt'))).toBe(true); // user files are never touched
    });
  });

  describe('recordings made before the combined format (two files per call)', () => {
    function legacy(dir: string, id = CALL) {
      const d = path.join(dir, id);
      fs.mkdirSync(d, { recursive: true });
      const write = (file: string, pcm: Buffer) => fs.writeFileSync(path.join(d, file), Buffer.concat([wavHeader(RATE, 1, 16, pcm.length), pcm]));
      write('caller.wav', Buffer.concat([sine(440, 1000, 2000), Buffer.alloc(RATE * 2)])); // quiet caller (1 s), then 1 s of silence
      write('agent.wav', Buffer.concat([Buffer.alloc(RATE * 2), sine(1000, 1000, 9000)])); // 1 s of silence, then the agent
      fs.writeFileSync(path.join(d, 'recording.json'), JSON.stringify({
        kind: 'complete-call-recording', callId: id, direction: 'inbound', startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:02.000Z', complete: true,
        outcome: 'completed', sampleRate: RATE, sampleRateSource: 'configured', channels: 1, bitsPerSample: 16, format: 'wav-pcm-s16le', isSimulated: false,
        consentAcknowledged: true, truncated: false, note: 'old',
        tracks: { caller: { file: 'caller.wav', bytes: 32000, durationMs: 2000, hasAudio: true }, agent: { file: 'agent.wav', bytes: 32000, durationMs: 2000, hasAudio: true } },
      }));
      return d;
    }

    it('are listed as playable, and mixed into the combined file the first time it is asked for, with the old files untouched', async () => {
      const h = harness();
      const d = legacy(h.dir);
      const before = [sha(fs.readFileSync(path.join(d, 'caller.wav'))), sha(fs.readFileSync(path.join(d, 'agent.wav')))];
      const listed = h.recorder.list()[0];
      expect(listed).toMatchObject({ callId: CALL, available: true, durationMs: 2000, hasCallerAudio: true, hasAgentAudio: true });
      expect(h.recorder.combinedFile(CALL)).toBeNull();

      const [a, b] = await Promise.all([h.recorder.ensureCombined(CALL), h.recorder.ensureCombined(CALL)]); // two requests, one mix
      expect(a).toBe(b);
      const wav = parseWav(fs.readFileSync(a!));
      expect(wav.data.length / 2 / RATE).toBeCloseTo(2.0, 3);
      expect(Math.abs(frequency(seconds(wav.data, 0.1, 0.9)) - 440)).toBeLessThan(15);
      expect(rms(seconds(wav.data, 0.1, 0.9))).toBeGreaterThan(3000); // the quiet caller was raised, as for new recordings
      expect(seconds(wav.data, 1.0, 2.0).equals(sine(1000, 1000, 9000))).toBe(true);
      expect([sha(fs.readFileSync(path.join(d, 'caller.wav'))), sha(fs.readFileSync(path.join(d, 'agent.wav')))]).toEqual(before);
      expect(h.recorder.list()[0]).toMatchObject({ file: COMBINED_FILE, complete: true });
      expect(await h.recorder.ensureCombined(CALL)).toBe(a); // served from the file from now on
    });
  });
});

describe('recording through the real gateway call flow (mock hardware)', () => {
  const KEYS = 'recording-test-key-123';

  async function boot(dir: string, recDir: string) {
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    const server = createGatewayServer({
      // A random high port, so a gateway already running on this computer (port 4000) cannot make this test fail
      config: { port: 41000 + Math.floor(Math.random() * 8000), host: '127.0.0.1', modemDriver: 'mock', gatewayApiKey: KEYS, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'dumps') },
      modem,
      audio,
      instanceLockDir: dir,
      recording: { enabled: true, consentAcknowledged: true, dir: recDir, retentionDays: 0, maxSeconds: 600, errors: [] },
    });
    await server.start();
    await modem.initialize();
    return { server, modem, audio };
  }
  const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('records an inbound call to one WAV, serves it only behind the API key (with seeking), and keeps serving it after a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-int-'));
    const recDir = path.join(dir, 'recs');
    let { server, modem, audio } = await boot(dir, recDir);
    try {
      modem.emit('urc', { raw: '+CRING: VOICE', type: 'RING', timestamp: new Date().toISOString(), isSimulated: false });
      modem.emit('urc', { raw: '+CLIP: "+919123456789",145', type: 'CLIP', phoneNumber: '+919123456789', typeOfAddress: 145, timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.answer();
      const callId = server.callManager.getCurrentCall()!.id;
      await new Promise((r) => setTimeout(r, 400)); // mock audio produces caller frames
      for (let i = 0; i < 10; i++) await audio.writeAudioChunk(sine(800, 20, 9000, i * 160));
      await server.callManager.hangup();
      await server.callRecorder.whenIdle();

      const get = (p: string) => request(server.app).get(p).set('x-api-key', KEYS);
      // Not without the key: neither the list nor the audio.
      expect((await request(server.app).get('/api/gateway/recordings')).status).toBe(401);
      expect((await request(server.app).get(`/api/gateway/recordings/${callId}/audio.wav`)).status).toBe(401);
      expect((await request(server.app).get(`/api/gateway/recordings/${callId}/audio.wav`).set('x-api-key', 'wrong')).status).toBe(401);

      const list = await get('/api/gateway/recordings');
      expect(list.status).toBe(200);
      expect(list.body.status).toMatchObject({ enabled: true, inactiveReason: null });
      expect(list.body.recordings[0]).toMatchObject({ callId, kind: 'complete-call-recording', complete: true, isSimulated: true, available: true, file: COMBINED_FILE });
      const only = await get(`/api/gateway/recordings?ids=${callId},${CALL_B},not-an-id`);
      expect(only.body.recordings.map((r: { callId: string }) => r.callId)).toEqual([callId]);

      const res = await get(`/api/gateway/recordings/${callId}/audio.wav`).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/wav/);
      expect(res.headers['cache-control']).toMatch(/private/);
      expect(res.headers['accept-ranges']).toBe('bytes');
      const parsed = parseWav(res.body as Buffer);
      expect(rms(parsed.data)).toBeGreaterThan(100); // real samples, both the mock caller audio and the 800 Hz the gateway wrote
      expect(parsed.data.indexOf(sine(800, 20, 9000, 0))).toBeGreaterThanOrEqual(0); // the agent's chunk is in the one file

      // Seeking: a player can ask for part of the file.
      const part = await get(`/api/gateway/recordings/${callId}/audio.wav`).set('Range', 'bytes=44-143').buffer(true).parse(binary);
      expect(part.status).toBe(206);
      expect((part.body as Buffer).length).toBe(100);
      expect((part.body as Buffer).equals((res.body as Buffer).subarray(44, 144))).toBe(true);

      // Not a recording, not a call id, or somebody else's path.
      const missing = await get(`/api/gateway/recordings/${CALL_B}/audio.wav`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('RECORDING_NOT_FOUND');
      expect((await get('/api/gateway/recordings/not-a-call/audio.wav')).status).toBe(404);
      expect((await get(`/api/gateway/recordings/${callId}/..%2Frecording.json`)).status).toBe(404);
      expect((await get(`/api/gateway/recordings/${callId}/caller.wav`)).status).toBe(404); // the separate files no longer exist as a download

      // A gateway restart: a new process with the same folder still lists and serves the recording.
      await server.close();
      ({ server, modem, audio } = await boot(dir, recDir));
      const again = await request(server.app).get(`/api/gateway/recordings/${callId}/audio.wav`).set('x-api-key', KEYS).buffer(true).parse(binary);
      expect(again.status).toBe(200);
      expect((again.body as Buffer).equals(res.body as Buffer)).toBe(true);
      expect((await request(server.app).get('/api/gateway/recordings').set('x-api-key', KEYS)).body.recordings.map((r: { callId: string }) => r.callId)).toContain(callId);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('speech played by the AI lands in the recording', () => {
  it('records what the production audio sink writes to the modem', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-sink-'));
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    const bus = new GatewayEventBus();
    const recorder = new CallRecorder({
      audio, eventBus: bus, sampleRate: () => RATE,
      config: { enabled: true, consentAcknowledged: true, dir, retentionDays: 0, maxSeconds: 60, errors: [] },
    });
    try {
      recorder.start();
      await audio.startSession(CALL);
      bus.emit('call:state_changed', { callId: CALL, previousState: 'INBOUND_RINGING', currentState: 'ACTIVE', timestamp: '', session: session() });
      const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
      const result = await sink.play(sine(600, 400, 10000), new AbortController().signal);
      expect(result.bytesWritten).toBe(RATE * 2 * 0.4);
      bus.emit('call:ended', session(CALL, { state: 'IDLE', outcome: 'completed' }));
      await recorder.whenIdle();
      const wav = parseWav(fs.readFileSync(recorder.combinedFile(CALL)!));
      // The first 20 ms is the warm-up silence; measure the tone after it.
      expect(Math.abs(frequency(wav.data.subarray(2 * 400, 2 * 2800)) - 600)).toBeLessThan(30);
      expect(rms(wav.data)).toBeGreaterThan(5000);
    } finally {
      recorder.stop();
      await audio.stopSession();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
