import { describe, expect, it } from 'vitest';
import { AudioFrame } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';

describe('MockAudioAdapter', () => {
  it('identifies as simulated audio driver', () => {
    const audio = new MockAudioAdapter();
    expect(audio.isSimulated).toBe(true);
  });

  it('generates 20ms audio frames with valid RMS during active session', async () => {
    const audio = new MockAudioAdapter({ sampleRate: 8000, frameDurationMs: 10 });
    const frames: AudioFrame[] = [];

    audio.on('audio_frame', (frame) => {
      frames.push(frame);
    });

    await audio.startSession('call-test-audio-1');

    await new Promise((resolve) => setTimeout(resolve, 60));

    await audio.stopSession();

    expect(frames.length).toBeGreaterThanOrEqual(3);
    const firstFrame = frames[0];
    expect(firstFrame.frameDurationMs).toBe(10);
    expect(firstFrame.data.length).toBe(160); // 8000 * 2 * 0.010 = 160 bytes
    expect(firstFrame.rmsLevel).toBeGreaterThan(0.01);
    expect(firstFrame.isSimulated).toBe(true);

    const stats = audio.getStats();
    expect(stats.isStreaming).toBe(false);
    expect(stats.framesReceived).toBeGreaterThanOrEqual(3);
  });

  it('allows writing audio chunks to outbound line', async () => {
    const audio = new MockAudioAdapter({ sampleRate: 8000 });
    await audio.startSession('call-test-audio-2');

    const testChunk = Buffer.alloc(320);
    testChunk.writeInt16LE(1000, 0);

    await audio.writeAudioChunk(testChunk);
    const stats = audio.getStats();
    expect(stats.bytesSent).toBe(320);
    expect(stats.framesSent).toBe(1);

    await audio.stopSession();
  });
});
