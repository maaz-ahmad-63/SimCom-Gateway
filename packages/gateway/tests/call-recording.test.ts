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
import { CallRecorder } from '../src/recording/call-recorder.js';
import { loadRecordingConfig, RecordingConfig } from '../src/recording/config.js';
import { parseWav, wavHeader, WAV_HEADER_BYTES } from '../src/recording/wav.js';
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
/** Frequency from zero crossings: proves the samples are the tone that was sent, not just "some bytes". */
const frequency = (pcm: Buffer, rate = RATE): number => {
  let crossings = 0;
  for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) < 0 !== pcm.readInt16LE(i) < 0) crossings++;
  return (crossings / 2) / (pcm.length / 2 / rate);
};

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

describe('CallRecorder', () => {
  const dirs: string[] = [];
  const recorders: CallRecorder[] = [];
  afterEach(() => {
    for (const r of recorders.splice(0)) r.stop();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function harness(over: Partial<RecordingConfig> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-rec-'));
    dirs.push(dir);
    const audio = new FakeAudio();
    const bus = new GatewayEventBus();
    let now = 1_000_000;
    const config: RecordingConfig = { enabled: true, consentAcknowledged: true, dir, retentionDays: 0, maxSeconds: 3600, errors: [], ...over };
    const recorder = new CallRecorder({ audio: audio as unknown as IAudioAdapter, eventBus: bus, config, sampleRate: () => RATE, now: () => now });
    recorders.push(recorder);
    recorder.start();
    const activate = (s = session()) => bus.emit('call:state_changed', { callId: s.id, previousState: 'INBOUND_RINGING', currentState: 'ACTIVE', timestamp: '', session: s });
    const end = (s = session(CALL, { state: 'IDLE', outcome: 'completed', endedAt: new Date().toISOString() })) => bus.emit('call:ended', s);
    return { dir, audio, bus, recorder, activate, end, tick: (ms: number) => (now += ms) };
  }

  it('records nothing unless enabled and consent is acknowledged, and says why', () => {
    const off = harness({ enabled: false });
    off.activate(); off.audio.frame(sine(440, 20)); off.end();
    expect(off.recorder.getStatus().inactiveReason).toMatch(/off/);
    expect(fs.readdirSync(off.dir)).toEqual([]);

    const noConsent = harness({ consentAcknowledged: false });
    noConsent.activate(); noConsent.audio.frame(sine(440, 20)); noConsent.end();
    expect(noConsent.recorder.getStatus().inactiveReason).toMatch(/CONSENT/);
    expect(fs.readdirSync(noConsent.dir)).toEqual([]);
  });

  it('saves playable WAV tracks that contain the audio that was sent, aligned to the call timeline', () => {
    const h = harness();
    h.activate();
    // 1 s of caller tone arriving in 20 ms frames, then 0.5 s of agent speech written after 0.4 s of silence.
    for (let i = 0; i < 50; i++) { h.tick(20); h.audio.frame(sine(440, 20, 12000, i * 160)); }
    h.tick(0);
    h.audio.out(sine(1000, 500));
    h.tick(500);
    h.end();

    const meta = h.recorder.list()[0];
    expect(meta).toMatchObject({ callId: CALL, kind: 'complete-call-recording', complete: true, sampleRate: RATE, channels: 1, bitsPerSample: 16, outcome: 'completed' });
    const caller = parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'caller')!));
    const agent = parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'agent')!));
    expect([caller.sampleRate, caller.channels, caller.bitsPerSample]).toEqual([8000, 1, 16]);
    // Real audio, not merely non-empty: the right tone at a real level.
    expect(rms(caller.data.subarray(0, 8000))).toBeGreaterThan(7000);
    expect(Math.abs(frequency(caller.data.subarray(0, 16000)) - 440)).toBeLessThan(15);
    // The agent track is silence while the caller spoke, then the 1 kHz tone, and both span the whole call.
    expect(rms(agent.data.subarray(0, 2 * 7000))).toBe(0);
    const speech = agent.data.subarray(2 * 8000, 2 * 8000 + 2 * 3000);
    expect(Math.abs(frequency(speech) - 1000)).toBeLessThan(30);
    expect(meta.tracks.caller.durationMs).toBeGreaterThanOrEqual(1490);
    expect(Math.abs(meta.tracks.caller.durationMs - meta.tracks.agent.durationMs)).toBeLessThan(100);
    expect(meta.tracks.caller.hasAudio && meta.tracks.agent.hasAudio).toBe(true);
  });

  it('fills a real gap with silence but does not distort continuous audio', () => {
    const h = harness();
    h.activate();
    h.tick(20); h.audio.frame(sine(440, 20));
    h.tick(1000); h.audio.frame(sine(440, 20)); // the port stalled for a second
    h.end();
    const caller = parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'caller')!));
    expect(caller.data.length / 2 / RATE).toBeGreaterThan(1.0);
    expect(rms(caller.data.subarray(2 * 400, 2 * 7000))).toBe(0); // the stalled second is silent, not squeezed out
  });

  it('keeps 16-bit alignment when a chunk arrives with an odd byte count', () => {
    const h = harness();
    h.activate();
    const tone = sine(440, 100);
    h.tick(10); h.audio.frame(tone.subarray(0, 201));
    h.tick(10); h.audio.frame(tone.subarray(201));
    h.end();
    const caller = parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'caller')!));
    expect(caller.dataBytes % 2).toBe(0);
    expect(rms(caller.data.subarray(0, tone.length - 2))).toBeGreaterThan(7000);
  });

  it('records a call once even when the ACTIVE event repeats, and starts clean for the next call', () => {
    const h = harness();
    h.activate(); h.activate(); h.activate();
    h.tick(20); h.audio.frame(sine(440, 20));
    h.end();
    expect(h.recorder.list()).toHaveLength(1);
    expect(h.recorder.getStatus().active).toBeNull();
    h.audio.frame(sine(440, 20)); // after the call: ignored
    h.activate(session(CALL_B));
    h.tick(20); h.audio.frame(sine(440, 20));
    h.end(session(CALL_B, { state: 'IDLE', outcome: 'completed' }));
    expect(h.recorder.list().map((m) => m.callId).sort()).toEqual([CALL, CALL_B].sort());
  });

  it('reports a call with no audio honestly, with valid empty-or-silent files', () => {
    const h = harness();
    h.activate();
    h.tick(1000);
    h.end();
    const meta = h.recorder.list()[0];
    expect(meta.tracks.caller.hasAudio).toBe(false);
    expect(meta.note).toMatch(/No audio was received/);
    expect(() => parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'caller')!))).not.toThrow();
  });

  it('keeps files valid mid-call and finalizes them if the gateway stops (abrupt end)', () => {
    const h = harness();
    h.activate();
    for (let i = 0; i < 30; i++) { h.tick(20); h.audio.frame(sine(440, 20, 12000, i * 160)); }
    h.recorder.stop(); // shutdown without call:ended
    const meta = h.recorder.list()[0];
    expect(meta.complete).toBe(false);
    expect(meta.error).toMatch(/gateway stopped/);
    const caller = parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'caller')!));
    expect(caller.dataBytes).toBeGreaterThan(8000);
    expect(h.recorder.getStatus().active).toBeNull();
  });

  it('stops recording at the configured maximum and says so, leaving a valid file', () => {
    const h = harness({ maxSeconds: 10 });
    h.activate();
    for (let i = 0; i < 700; i++) { h.tick(20); h.audio.frame(sine(440, 20)); } // 14 s
    h.end();
    const meta = h.recorder.list()[0];
    expect(meta.truncated).toBe(true);
    expect(meta.tracks.caller.durationMs).toBeLessThanOrEqual(10_000);
    expect(() => parseWav(fs.readFileSync(h.recorder.trackFile(CALL, 'caller')!))).not.toThrow();
  });

  it('never throws into the audio path when the disk is unusable, and reports the error', () => {
    const file = path.join(os.tmpdir(), `not-a-dir-${Date.now()}`);
    fs.writeFileSync(file, 'x');
    dirs.push(file);
    const h = harness({ dir: file });
    expect(() => { h.activate(); h.audio.frame(sine(440, 20)); h.audio.out(sine(440, 20)); h.end(); }).not.toThrow();
    expect(h.recorder.getStatus().lastError).toMatch(/Could not start recording/);
  });

  it('only serves tracks it recorded, for valid ids and names', () => {
    const h = harness();
    h.activate(); h.tick(20); h.audio.frame(sine(440, 20)); h.end();
    expect(h.recorder.trackFile(CALL, 'caller')).not.toBeNull();
    expect(h.recorder.trackFile(CALL, 'recording.json')).toBeNull();
    expect(h.recorder.trackFile('../../etc', 'caller')).toBeNull();
    expect(h.recorder.trackFile(CALL_B, 'caller')).toBeNull();
  });

  it('deletes only finished recordings older than the retention period, and never when it is 0', () => {
    const h = harness({ retentionDays: 0 });
    h.activate(); h.tick(20); h.audio.frame(sine(440, 20)); h.end();
    h.tick(400 * 86_400_000);
    h.activate(session(CALL_B)); h.tick(20); h.audio.frame(sine(440, 20)); h.end(session(CALL_B, { state: 'IDLE' }));
    expect(h.recorder.list()).toHaveLength(2); // retention 0: nothing deleted

    const r = harness({ retentionDays: 30 });
    const foreign = path.join(r.dir, 'my-own-notes');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.txt'), 'mine');
    r.activate(); r.tick(20); r.audio.frame(sine(440, 20)); r.end();
    r.tick(40 * 86_400_000);
    r.activate(session(CALL_B)); r.tick(20); r.audio.frame(sine(440, 20)); r.end(session(CALL_B, { state: 'IDLE' }));
    expect(r.recorder.list().map((m) => m.callId)).toEqual([CALL_B]); // the 40-day-old one is gone
    expect(fs.existsSync(path.join(foreign, 'keep.txt'))).toBe(true); // user files are never touched
  });
});

describe('recording through the real gateway call flow (mock hardware)', () => {
  it('records an inbound call end to end and serves it behind the API key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-int-'));
    const key = 'recording-test-key-123';
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'dumps') },
      modem,
      audio,
      instanceLockDir: dir,
      recording: { enabled: true, consentAcknowledged: true, dir: path.join(dir, 'recs'), retentionDays: 0, maxSeconds: 600, errors: [] },
    });
    try {
      await server.start();
      await modem.initialize();
      modem.emit('urc', { raw: '+CRING: VOICE', type: 'RING', timestamp: new Date().toISOString(), isSimulated: false });
      modem.emit('urc', { raw: '+CLIP: "+919123456789",145', type: 'CLIP', phoneNumber: '+919123456789', typeOfAddress: 145, timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.answer();
      const callId = server.callManager.getCurrentCall()!.id;
      await new Promise((r) => setTimeout(r, 400)); // mock audio produces caller frames
      for (let i = 0; i < 10; i++) await audio.writeAudioChunk(sine(800, 20, 9000, i * 160));
      await server.callManager.hangup();

      const auth = (p: string) => request(server.app).get(p).set('x-api-key', key);
      expect((await request(server.app).get('/api/gateway/recordings')).status).toBe(401);
      const list = await auth('/api/gateway/recordings');
      expect(list.status).toBe(200);
      expect(list.body.status).toMatchObject({ enabled: true, inactiveReason: null });
      expect(list.body.recordings[0]).toMatchObject({ callId, kind: 'complete-call-recording', complete: true, isSimulated: true });

      const wav = await auth(`/api/gateway/recordings/${callId}/caller.wav`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(wav.status).toBe(200);
      expect(wav.headers['content-type']).toMatch(/audio\/wav/);
      const parsed = parseWav(wav.body as Buffer);
      expect(rms(parsed.data)).toBeGreaterThan(100); // real samples, not silence
      const agent = parseWav(fs.readFileSync(path.join(dir, 'recs', callId, 'agent.wav')));
      expect(rms(agent.data)).toBeGreaterThan(1000);

      expect((await auth('/api/gateway/recordings/not-a-call/caller.wav')).status).toBe(404);
      expect((await auth(`/api/gateway/recordings/${callId}/..%2Frecording.wav`)).status).toBe(404);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('speech played by the AI lands on the agent track', () => {
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
      const agent = parseWav(fs.readFileSync(recorder.trackFile(CALL, 'agent')!));
      // The first 20 ms of the agent track is the warm-up silence; measure the tone after it.
      expect(Math.abs(frequency(agent.data.subarray(2 * 400, 2 * 2800)) - 600)).toBeLessThan(30);
      expect(rms(agent.data)).toBeGreaterThan(5000);
    } finally {
      recorder.stop();
      await audio.stopSession();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
