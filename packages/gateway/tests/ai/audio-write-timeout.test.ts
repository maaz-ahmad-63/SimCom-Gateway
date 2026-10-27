import { describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { AudioWriteTimeoutError, GatewayAudioSink } from '../../src/ai/gateway-adapters.js';
import { FORMAT_8K } from './helpers.js';

const pcm = (ms: number) => Buffer.alloc((8000 * 2 * ms) / 1000, 1);

/** A port that stops consuming audio after `hangAfter` chunks, as one does after a USB reset. */
async function stuckAudio(hangAfter: number) {
  const audio = new MockAudioAdapter({ frameDurationMs: 20 });
  await audio.startSession('call-1');
  let written = 0;
  let hung = false;
  const real = audio.writeAudioChunk.bind(audio);
  audio.writeAudioChunk = (chunk: Buffer) => {
    if (written++ >= hangAfter && !hung) return new Promise<void>(() => {}); // never settles
    return real(chunk);
  };
  const recover = vi.fn(async () => {
    hung = true; // the reopened handle works again
  });
  (audio as unknown as { recoverSession: () => Promise<void> }).recoverSession = recover;
  return { audio, recover };
}

describe('audio playback when a port write never completes', () => {
  it('fails the turn quickly with a clear error instead of blocking until the call ends', async () => {
    const { audio, recover } = await stuckAudio(2);
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { writeTimeoutMs: 80, recoverTimeoutMs: 200 });
    const started = Date.now();
    await expect(sink.play(pcm(400), new AbortController().signal)).rejects.toBeInstanceOf(AudioWriteTimeoutError);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(recover).toHaveBeenCalledTimes(1); // one bounded reopen of the audio port, nothing else
    await audio.stopSession();
  });

  it('lets the next play proceed after the failure, so the AI is not stuck for the rest of the call', async () => {
    const { audio } = await stuckAudio(1);
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { writeTimeoutMs: 80, recoverTimeoutMs: 200 });
    await expect(sink.play(pcm(200), new AbortController().signal)).rejects.toThrow(/timed out/);
    const second = await sink.play(pcm(100), new AbortController().signal); // the reopened handle consumes audio
    expect(second.completed).toBe(true);
    expect(second.bytesWritten).toBe(pcm(100).length);
    await audio.stopSession();
  });

  it('releases a stuck write at once when the caller interrupts or the turn is cancelled', async () => {
    const { audio, recover } = await stuckAudio(0);
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { writeTimeoutMs: 60_000 });
    const controller = new AbortController();
    const playing = sink.play(pcm(400), controller.signal);
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await playing;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.completed).toBe(false);
    expect(result.stoppedBy).toBe('aborted');
    expect(recover).not.toHaveBeenCalled(); // an interruption is not a port fault
    await audio.stopSession();
  });

  it('does not count a failed or abandoned write as played, and a late failure is not an unhandled rejection', async () => {
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    await audio.startSession('call-1');
    let reject!: (e: Error) => void;
    audio.writeAudioChunk = () => new Promise<void>((_, r) => (reject = r));
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { writeTimeoutMs: 40 });
    await expect(sink.play(pcm(100), new AbortController().signal)).rejects.toBeInstanceOf(AudioWriteTimeoutError);
    expect(audio.getStats().bytesSent).toBe(0);
    reject(new Error('Invalid handle')); // arrives long after we stopped waiting
    await new Promise((r) => setTimeout(r, 20));
    await audio.stopSession();
  });

  it('plays normally when the port is healthy (no extra reopen, same result as before)', async () => {
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    await audio.startSession('call-1');
    const recover = vi.fn();
    (audio as unknown as { recoverSession: () => Promise<void> }).recoverSession = recover;
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    const result = await sink.play(pcm(200), new AbortController().signal);
    expect(result).toMatchObject({ completed: true, stoppedBy: null, bytesWritten: pcm(200).length });
    expect(recover).not.toHaveBeenCalled();
    await audio.stopSession();
  });
});

describe('the first write of a call is absorbed before playback is timed', () => {
  it('writes one silent frame first, then the audio, and reports only the audio as written', async () => {
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    await audio.startSession('call-1');
    const writes: Buffer[] = [];
    const real = audio.writeAudioChunk.bind(audio);
    audio.writeAudioChunk = async (chunk: Buffer) => {
      writes.push(chunk);
      return real(chunk);
    };
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    const first = await sink.play(pcm(100, 5), new AbortController().signal);
    expect(writes[0].equals(Buffer.alloc(320))).toBe(true); // a 20 ms frame of silence
    expect(first.bytesWritten).toBe(pcm(100).length); // the silence is not counted as the reply
    expect(first.completed).toBe(true);
    const count = writes.length;
    await sink.play(pcm(40, 5), new AbortController().signal);
    expect(writes.slice(count).every((w) => w.some((b) => b !== 0))).toBe(true); // no second warm-up
    await audio.stopSession();
  });
});
