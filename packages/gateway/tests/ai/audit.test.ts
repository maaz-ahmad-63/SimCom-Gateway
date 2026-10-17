import { describe, expect, it } from 'vitest';
import { AudioMeter } from '../../src/ai/meter.js';
import { EnergyEndpointer } from '../../src/ai/endpointer.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { analyzePcm } from '../../src/diagnostics/pcm-tools.js';
import { aiEnv, FORMAT_8K, fakeFetch, json, makeConfig, noiseFloorPcm, speechPcm } from './helpers.js';

const signal = new AbortController().signal;

async function sttRequest(env: Record<string, string | undefined>) {
  const fetched = fakeFetch([json({ results: { channels: [{ alternatives: [{ transcript: 'ok' }] }] }, text: 'ok' })]);
  const config = makeConfig(env);
  const providers = createProviders(config, { env: aiEnv(env), fetchImpl: fetched.impl, only: 'stt' });
  await providers.stt.transcribe(speechPcm(500), FORMAT_8K, signal);
  return fetched.requests[0];
}

describe('first-session audit: provider request details', () => {
  it('sends Groq Whisper a bare ISO language code, never a regional tag it would reject', async () => {
    const request = await sttRequest({ AI_STT: 'groq_whisper', AI_LANGUAGE: 'hi-IN' });
    expect((request.body as FormData).get('language')).toBe('hi');
    const english = await sttRequest({ AI_STT: 'groq_whisper', AI_LANGUAGE: 'en-US' });
    expect((english.body as FormData).has('language')).toBe(false);
  });

  it('selects the multilingual Deepgram model with language=multi on the global endpoint', async () => {
    const multi = await sttRequest({ AI_STT: 'nova-3-multi', AI_LANGUAGE: 'en' });
    const url = new URL(multi.url);
    expect(url.hostname).toBe('api.deepgram.com');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('multi');
    const plain = new URL((await sttRequest({ AI_STT: 'nova-3', AI_LANGUAGE: 'en' })).url);
    expect(plain.hostname).toBe('api.au.deepgram.com');
    expect(plain.searchParams.has('language')).toBe(false);
  });

  it('uploads exactly the captured samples as a self-describing WAV', async () => {
    const pcm = speechPcm(700);
    const fetched = fakeFetch([json({ results: { channels: [{ alternatives: [{ transcript: 'ok' }] }] } })]);
    const env = { AI_STT: 'nova-3' };
    const providers = createProviders(makeConfig(env), { env: aiEnv(env), fetchImpl: fetched.impl, only: 'stt' });
    await providers.stt.transcribe(pcm, FORMAT_8K, signal);
    const body = fetched.requests[0].body as Buffer;
    expect(body.toString('ascii', 0, 4)).toBe('RIFF');
    expect(body.readUInt32LE(24)).toBe(8000); // sample rate
    expect(body.readUInt16LE(22)).toBe(1); // mono
    expect(body.readUInt16LE(34)).toBe(16); // bits
    expect(body.readUInt32LE(40)).toBe(pcm.length); // data length equals the captured bytes
    expect(body.subarray(44).equals(pcm)).toBe(true);
    expect(fetched.requests[0].headers.authorization).toMatch(/^Token /);
    expect(fetched.requests[0].headers['content-type']).toBe('audio/wav');
  });

  it('rejects an odd number of bytes instead of uploading misaligned samples', async () => {
    const fetched = fakeFetch([json({})]);
    const providers = createProviders(makeConfig({}), { env: aiEnv(), fetchImpl: fetched.impl, only: 'stt' });
    await expect(providers.stt.transcribe(Buffer.alloc(321), FORMAT_8K, signal)).rejects.toThrow(/frames/);
    expect(fetched.requests).toHaveLength(0);
  });
});

describe('first-session audit: capture path', () => {
  it('detects speech at the very low level measured on this modem with the default threshold', () => {
    // Real captures: speech segments sat near -47 dBFS RMS (about 0.0045). The old default (0.012) never fired.
    const quiet = speechPcm(1200, 8000, 170);
    const { rms } = analyzePcm(quiet, FORMAT_8K);
    expect(rms).toBeGreaterThan(0.003);
    expect(rms).toBeLessThan(0.008);
    const config = makeConfig({});
    expect(config.vad.rmsThreshold).toBeLessThanOrEqual(0.003);

    const utterances: Buffer[] = [];
    const endpointer = new EnergyEndpointer(FORMAT_8K, config.vad, { onUtterance: (pcm) => utterances.push(pcm) });
    // Delivered the way the modem does: 320-byte chunks.
    const stream = Buffer.concat([noiseFloorPcm(300), quiet, noiseFloorPcm(1500)]);
    for (let i = 0; i < stream.length; i += 320) endpointer.feed(stream.subarray(i, i + 320));
    expect(utterances).toHaveLength(1);
    expect(utterances[0].length % 2).toBe(0);
    expect(utterances[0].length).toBeGreaterThanOrEqual(quiet.length); // nothing of the speech was cut

    // The previous default would have discarded this speech entirely.
    const old: Buffer[] = [];
    const legacy = new EnergyEndpointer(FORMAT_8K, { ...config.vad, rmsThreshold: 0.012 }, { onUtterance: (pcm) => old.push(pcm) });
    for (let i = 0; i < stream.length; i += 320) legacy.feed(stream.subarray(i, i + 320));
    expect(old).toHaveLength(0);
  });

  it('does not treat the idle line (about +/-2 LSB) as speech', () => {
    const config = makeConfig({});
    const utterances: Buffer[] = [];
    const endpointer = new EnergyEndpointer(FORMAT_8K, config.vad, { onUtterance: (pcm) => utterances.push(pcm) });
    const idle = noiseFloorPcm(10_000);
    for (let i = 0; i < idle.length; i += 320) endpointer.feed(idle.subarray(i, i + 320));
    expect(utterances).toHaveLength(0);
  });

  it('keeps sample alignment when the stream is chopped at odd byte boundaries', () => {
    const config = makeConfig({});
    const utterances: Buffer[] = [];
    const endpointer = new EnergyEndpointer(FORMAT_8K, config.vad, { onUtterance: (pcm) => utterances.push(pcm) });
    const stream = Buffer.concat([noiseFloorPcm(200), speechPcm(1000), noiseFloorPcm(1500)]);
    for (let i = 0; i < stream.length; ) {
      const size = 101 + (i % 7); // deliberately odd chunk sizes
      endpointer.feed(stream.subarray(i, i + size));
      i += size;
    }
    expect(utterances).toHaveLength(1);
    // Every sample decodes as the same value it had in the source stream (no byte shift).
    const start = stream.indexOf(utterances[0].subarray(0, 32));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start % 2).toBe(0);
  });

  it('measures the byte rate that actually arrives, so a wrongly labelled rate is visible', () => {
    let now = 1_000;
    const at8k = new AudioMeter(FORMAT_8K, () => now);
    for (let i = 0; i < 200; i++) {
      at8k.feed(noiseFloorPcm(20));
      now += 20;
    }
    const good = at8k.snapshot(0, 0);
    expect(good.expectedSampleRate).toBe(8000);
    expect(good.observedSampleRate).toBeGreaterThan(7800);
    expect(good.observedSampleRate).toBeLessThan(8200);

    now = 1_000;
    const doubled = new AudioMeter(FORMAT_8K, () => now);
    for (let i = 0; i < 200; i++) {
      doubled.feed(noiseFloorPcm(40)); // twice the data per real-time interval = 16 kHz worth
      now += 20;
    }
    expect(doubled.snapshot(0, 0).observedSampleRate).toBeGreaterThan(15_500);

    const tooEarly = new AudioMeter(FORMAT_8K, () => now);
    tooEarly.feed(noiseFloorPcm(20));
    expect(tooEarly.snapshot(0, 0).observedSampleRate).toBeNull();
  });
});

describe('first-session audit: configuration', () => {
  it('keeps the old VAD threshold selectable through the environment', () => {
    expect(loadAiConfig(aiEnv({ AI_VAD_RMS_THRESHOLD: '0.012' })).config.vad.rmsThreshold).toBe(0.012);
  });
});
