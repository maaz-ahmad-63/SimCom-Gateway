import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InboundCaptureTap, writeCaptureBundle } from '../src/diagnostics/inbound-capture.js';
import { CAPTURE_MAX_BYTES } from '../src/diagnostics/usb-pcm-verification.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-capture-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sine(samples: number, hz = 440, rate = 8000): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
}

const bundle = (data: Buffer, root: string) =>
  writeCaptureBundle({ data, outputRoot: root, timestamp: '2026-01-01T00-00-00-000Z', captureDurationMs: 1000, stopReason: 'duration', isSimulated: true });

describe('writeCaptureBundle', () => {
  it('writes the raw bytes, five candidate WAVs whose headers match their declared formats, report and README', () => {
    const root = tmp();
    const data = sine(8000);
    const out = bundle(data, root);
    expect(fs.readFileSync(out.binFile).equals(data)).toBe(true);
    expect(fs.existsSync(out.readmeFile)).toBe(true);
    const expected: Record<string, [number, number]> = {
      '8k_16bit_mono_LE': [8000, 16],
      '8k_16bit_mono_BE': [8000, 16],
      '16k_16bit_mono_LE': [16000, 16],
      '16k_16bit_mono_BE': [16000, 16],
      '8k_8bit_mono': [8000, 8],
    };
    expect(out.candidates.map((c) => c.label).sort()).toEqual(Object.keys(expected).sort());
    for (const c of out.candidates) {
      expect(c.error).toBeNull();
      const wav = fs.readFileSync(path.join(out.directory, c.wavFile!));
      const [rate, bits] = expected[c.label];
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(rate);
      expect(wav.readUInt16LE(34)).toBe(bits);
      expect(wav.readUInt16LE(32)).toBe(bits / 8);
      expect(wav.readUInt32LE(28)).toBe(rate * (bits / 8));
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
      expect(wav.readUInt32LE(40) % (bits / 8)).toBe(0);
      expect(c.calculatedDurationMs).toBeCloseTo((c.usedBytes / (bits / 8) / rate) * 1000, 1);
    }
    const report = JSON.parse(fs.readFileSync(out.reportFile, 'utf8'));
    expect(report).toMatchObject({ formatVerified: false, byteCount: 16000, captureDurationMs: 1000, stopReason: 'duration' });
    expect(report.candidates[0]).toHaveProperty('rms');
    expect(fs.readFileSync(out.readmeFile, 'utf8')).toMatch(/cannot tell you which is right/);
  });

  it('swaps big-endian candidates so the WAV holds the byte-reversed samples', () => {
    const out = bundle(sine(400), tmp());
    const raw = fs.readFileSync(out.binFile);
    const be = fs.readFileSync(path.join(out.directory, 'candidate_8k_16bit_mono_BE.wav'));
    const le = fs.readFileSync(path.join(out.directory, 'candidate_8k_16bit_mono_LE.wav'));
    expect(le.subarray(44).equals(raw)).toBe(true);
    expect(be.readInt16LE(44 + 20)).toBe(raw.readInt16BE(20));
  });

  it('drops a trailing unaligned byte from the WAVs, keeps it in the .bin, and records it', () => {
    const data = Buffer.concat([sine(100), Buffer.from([0x7f])]);
    const out = bundle(data, tmp());
    expect(fs.statSync(out.binFile).size).toBe(201);
    const c16 = out.candidates.find((c) => c.label === '8k_16bit_mono_LE')!;
    expect(c16).toMatchObject({ usedBytes: 200, droppedTrailingBytes: 1 });
    expect(fs.readFileSync(path.join(out.directory, c16.wavFile!)).readUInt32LE(40)).toBe(200);
    const c8 = out.candidates.find((c) => c.label === '8k_8bit_mono')!;
    expect(c8).toMatchObject({ usedBytes: 201, droppedTrailingBytes: 0 });
  });

  it('reports a conversion error instead of throwing when the capture is shorter than one sample', () => {
    const out = bundle(Buffer.from([1]), tmp());
    const c16 = out.candidates.find((c) => c.label === '8k_16bit_mono_LE')!;
    expect(c16.error).toMatch(/shorter than one sample/);
    expect(c16.wavFile).toBeNull();
    expect(out.candidates.find((c) => c.label === '8k_8bit_mono')!.error).toBeNull();
  });

  it('refuses data above the capture byte limit', () => {
    const root = tmp();
    expect(() => bundle(Buffer.alloc(CAPTURE_MAX_BYTES + 1), root)).toThrow(/capture limit/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('InboundCaptureTap', () => {
  function rig() {
    const audio = Object.assign(new EventEmitter(), { isSimulated: true });
    const calls = Object.assign(new EventEmitter(), { state: 'ACTIVE' as string | null, getCurrentCall() { return this.state ? { id: 'c1', state: this.state } : null; } });
    const root = tmp();
    const tap = new InboundCaptureTap({ audio: audio as never, callManager: calls as never, outputRoot: root });
    const frame = (n = 320) => audio.emit('audio_frame', { sequenceNumber: 0, frameDurationMs: 20, data: Buffer.alloc(n, 1) });
    return { audio, calls, root, tap, frame };
  }

  it('ignores frames until a call is ACTIVE, stops at the byte limit and writes one bundle', () => {
    const { calls, root, tap, frame } = rig();
    calls.state = 'RINGING';
    tap.arm();
    frame();
    expect(tap.status().state).toBe('armed');
    calls.state = 'ACTIVE';
    for (let i = 0; i < 600; i++) frame(320); // 192000 bytes offered
    const s = tap.status();
    expect(s).toMatchObject({ state: 'done', bytes: CAPTURE_MAX_BYTES, stopReason: 'byte-limit' });
    expect(fs.statSync(path.join(s.directory!, 'capture_raw.bin')).size).toBe(CAPTURE_MAX_BYTES);
    expect(fs.readdirSync(root)).toHaveLength(1);
  });

  it('listens read-only and removes every listener when finished or disarmed', () => {
    const { audio, calls, tap, frame } = rig();
    tap.arm();
    expect(audio.listenerCount('audio_frame')).toBe(1);
    expect(() => tap.arm()).toThrow(/already armed/);
    frame();
    calls.emit('call:ended');
    expect(tap.status()).toMatchObject({ state: 'done', stopReason: 'call-ended', bytes: 320 });
    expect(audio.listenerCount('audio_frame')).toBe(0);
    expect(calls.listenerCount('call:ended')).toBe(0);
    tap.arm();
    tap.disarm();
    expect(tap.status().state).toBe('idle');
    expect(audio.listenerCount('audio_frame')).toBe(0);
  });

  it('reports failure, not success, when no audio arrived and the capture is disarmed mid-capture cleanly', () => {
    const { tap, frame } = rig();
    tap.arm();
    frame(2);
    tap.disarm();
    expect(tap.status()).toMatchObject({ state: 'done', stopReason: 'aborted', bytes: 2 });
  });
});
