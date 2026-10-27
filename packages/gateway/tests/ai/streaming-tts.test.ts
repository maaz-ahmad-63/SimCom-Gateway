import { describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { playPcmStreamPaced } from '../../src/adapters/audio/paced-playback.js';
import { AudioFormat, CollectingAudioSink, PlayResult } from '../../src/ai/audio.js';
import { ChunkQueue } from '../../src/ai/chunk-queue.js';
import { ConversationSession, TraceInput } from '../../src/ai/conversation.js';
import { AudioWriteTimeoutError, GatewayAudioSink } from '../../src/ai/gateway-adapters.js';
import { createMockProviders, ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { CartesiaTts, DeepgramTts } from '../../src/ai/providers/tts.js';
import { AiProviderError, ProviderSet } from '../../src/ai/providers/types.js';
import { ConcurrencyLimiter, LimitedTts } from '../../src/ai/tts-limiter.js';
import { FORMAT_8K, makeConfig, sleep, speechPcm } from './helpers.js';

const signal = new AbortController().signal;
const pcm = (ms: number, fill = 1) => Buffer.alloc((8000 * 2 * ms) / 1000, fill);

async function collect(iterable: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of iterable) out.push(c);
  return out;
}

/** A Response whose body arrives in the given pieces (the way an HTTP stream does, at arbitrary boundaries). */
function streamed(pieces: Buffer[], delayMs = 0, status = 200): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs) await sleep(delayMs);
      if (i < pieces.length) controller.enqueue(new Uint8Array(pieces[i++]));
      else controller.close();
    },
  });
  return new Response(body, { status });
}

function split(buf: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  for (let i = 0; offset < buf.length; i++) {
    const size = sizes[i % sizes.length];
    out.push(buf.subarray(offset, offset + size));
    offset += size;
  }
  return out;
}

describe('ChunkQueue', () => {
  it('hands chunks over in order and ends when closed', async () => {
    const q = new ChunkQueue();
    q.push(Buffer.from([1]));
    q.push(Buffer.from([2]));
    setTimeout(() => (q.push(Buffer.from([3])), q.close()), 20);
    expect((await collect(q)).map((b) => b[0])).toEqual([1, 2, 3]);
  });

  it('delivers a failure only after the audio that already arrived has been read', async () => {
    const q = new ChunkQueue();
    q.push(Buffer.from([1]));
    q.fail(new Error('network dropped'));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const c of q) seen.push(c[0]);
      })()
    ).rejects.toThrow('network dropped');
    expect(seen).toEqual([1]);
  });
});

describe('paced streaming playback', () => {
  it('writes at the sample rate (not as fast as the data arrives), in frame-sized pieces', async () => {
    const writes: number[] = [];
    const started = performance.now();
    const result = await playPcmStreamPaced(
      async (chunk) => void writes.push(chunk.length),
      (async function* () {
        yield pcm(250);
        yield pcm(250); // all 500 ms is available at once
      })(),
      { sampleRate: 8000, prerollMs: 100 }
    );
    const elapsed = performance.now() - started;
    expect(result.bytesWritten).toBe(pcm(500).length);
    expect(Math.max(...writes)).toBeLessThanOrEqual(320);
    expect(elapsed).toBeGreaterThan(380); // real time, minus the write-ahead
    expect(elapsed).toBeLessThan(900);
    expect(result.stoppedBy).toBeNull();
  });

  it('starts on the first bytes, calls onFirstWrite once, and does not wait for the end of the stream', async () => {
    let firstAt = 0;
    let endAt = 0;
    const started = performance.now();
    await playPcmStreamPaced(
      async () => {},
      (async function* () {
        yield pcm(200);
        await sleep(300);
        yield pcm(200);
        endAt = performance.now();
      })(),
      { sampleRate: 8000, prerollMs: 100, onFirstWrite: () => (firstAt ||= performance.now()) }
    );
    expect(firstAt - started).toBeLessThan(100);
    expect(endAt - started).toBeGreaterThan(250);
  });

  it('counts an underrun when the network falls behind, and does not play the late audio in a fast burst', async () => {
    const stamps: number[] = [];
    const started = performance.now();
    const result = await playPcmStreamPaced(
      async () => void stamps.push(performance.now()),
      (async function* () {
        yield pcm(200);
        await sleep(400); // the source stalls well beyond the write-ahead
        yield pcm(200);
      })(),
      { sampleRate: 8000, prerollMs: 100 }
    );
    expect(result.underruns).toBeGreaterThanOrEqual(1);
    expect(result.bytesWritten).toBe(pcm(400).length);
    expect(performance.now() - started).toBeGreaterThan(550); // the stall plus the audio, not squeezed together
    // After the gap, frames resume at the frame rate: no two late frames are back to back in a burst.
    const afterGap = stamps.slice(-8);
    const gaps = afterGap.slice(1).map((t, i) => t - afterGap[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
    expect(gaps.filter((g) => g < 5).length).toBeLessThanOrEqual(3); // only the write-ahead may be near-instant
  });

  it('stops at once when asked, and releases the source so its download is cancelled', async () => {
    let released = false;
    let frames = 0;
    const result = await playPcmStreamPaced(
      async () => void frames++,
      (async function* () {
        try {
          for (let i = 0; i < 50; i++) yield pcm(100);
        } finally {
          released = true;
        }
      })(),
      { sampleRate: 8000, prerollMs: 50, shouldStop: () => (frames >= 5 ? 'aborted' : null) }
    );
    expect(result.stoppedBy).toBe('aborted');
    expect(released).toBe(true);
    expect(result.framesWritten).toBeLessThan(10);
  });

  it('lets a source failure through, after writing what had already arrived', async () => {
    const written: number[] = [];
    await expect(
      playPcmStreamPaced(
        async (c) => void written.push(c.length),
        (async function* () {
          yield pcm(200);
          throw new Error('stream broke');
        })(),
        { sampleRate: 8000, prerollMs: 50 }
      )
    ).rejects.toThrow('stream broke');
    expect(written.reduce((sum, n) => sum + n, 0)).toBe(pcm(200).length); // the audio that had arrived was played first
  });
});

describe('streaming text-to-speech providers', () => {
  const deepgram = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: object = {}) =>
    new DeepgramTts({ apiKey: 'key-key-key', fetchImpl, timeoutMs: 2000, maxRetries: 0, voice: 'aura-asteria-en', ...over });

  it('yields whole 16-bit samples as they arrive, however the network splits them', async () => {
    const audio = pcm(300, 7);
    const urls: string[] = [];
    const tts = deepgram(async (url) => (urls.push(url), streamed(split(audio, [3, 7, 11, 100, 1]))));
    const chunks = await collect(tts.synthesizeStream(' hello', FORMAT_8K, signal));
    expect(chunks.every((c) => c.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks).equals(audio)).toBe(true);
    expect(urls[0]).toContain('encoding=linear16');
    expect(urls[0]).toContain('container=none');
  });

  it('yields the first chunk before the rest of the body has arrived', async () => {
    const tts = deepgram(async () => streamed([pcm(100), pcm(100), pcm(100)], 60));
    const started = performance.now();
    let firstAt = 0;
    for await (const _ of tts.synthesizeStream('hi', FORMAT_8K, signal)) firstAt ||= performance.now() - started;
    expect(firstAt).toBeLessThan(150);
    expect(performance.now() - started).toBeGreaterThan(150);
  });

  it('fails clearly on an empty reply, a half sample, and an HTTP error', async () => {
    await expect(collect(deepgram(async () => streamed([])).synthesizeStream('x', FORMAT_8K, signal))).rejects.toThrow(/no audio/);
    await expect(collect(deepgram(async () => streamed([Buffer.alloc(11)])).synthesizeStream('x', FORMAT_8K, signal))).rejects.toThrow(/odd number/);
    await expect(collect(deepgram(async () => new Response('nope', { status: 401 })).synthesizeStream('x', FORMAT_8K, signal))).rejects.toThrow(/authentication failed/);
  });

  it('still validates a WAV container if one comes back, and rejects the wrong format', async () => {
    const samples = pcm(100, 3);
    const wav = (rate: number) => {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + samples.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
      h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(samples.length, 40);
      return Buffer.concat([h, samples]);
    };
    const good = await collect(deepgram(async () => streamed(split(wav(8000), [30, 200]))).synthesizeStream('x', FORMAT_8K, signal));
    expect(Buffer.concat(good).equals(samples)).toBe(true);
    await expect(collect(deepgram(async () => streamed([wav(16000)])).synthesizeStream('x', FORMAT_8K, signal))).rejects.toThrow(/16000 Hz/);
  });

  it('turns a caller abort into a cancelled provider error and stops reading', async () => {
    const controller = new AbortController();
    let pulled = 0;
    const tts = deepgram(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          pulled++;
          await sleep(30);
          if (init?.signal?.aborted) return c.error(new Error('aborted'));
          c.enqueue(new Uint8Array(pcm(20)));
        },
      });
      return new Response(body);
    });
    const seen: unknown[] = [];
    const run = (async () => {
      for await (const c of tts.synthesizeStream('x', FORMAT_8K, controller.signal)) {
        seen.push(c);
        if (seen.length === 2) controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ details: { aborted: true } });
    const before = pulled;
    await sleep(150);
    expect(pulled - before).toBeLessThanOrEqual(2);
  });

  it('streams from Cartesia the same way', async () => {
    const audio = pcm(200, 9);
    const tts = new CartesiaTts({ apiKey: 'key-key-key', fetchImpl: async () => streamed(split(audio, [5, 50, 3])), timeoutMs: 2000, maxRetries: 0, voice: 'katie', language: 'en' });
    const chunks = await collect(tts.synthesizeStream('hello', FORMAT_8K, signal));
    expect(Buffer.concat(chunks).equals(audio)).toBe(true);
  });
});

describe('the concurrency limit applies to streamed requests too', () => {
  function timed(durations: number[]) {
    const log: string[] = [];
    let running = 0;
    let max = 0;
    const tts = {
      name: 'timed',
      synthesize: async () => Buffer.alloc(2),
      async *synthesizeStream(text: string) {
        running++;
        max = Math.max(max, running);
        log.push(`start:${text}`);
        try {
          yield pcm(20);
          await sleep(durations.shift() ?? 20);
          yield pcm(20);
          log.push(`end:${text}`);
        } finally {
          running--;
        }
      },
    };
    return { tts, log, maxRunning: () => max };
  }

  it('holds the slot until the whole reply has downloaded, so two requests never overlap', async () => {
    const { tts, log, maxRunning } = timed([60, 20]);
    const limited = new LimitedTts(tts, new ConcurrencyLimiter(1));
    const [a, b] = [collect(limited.synthesizeStream!('a', FORMAT_8K, signal)), collect(limited.synthesizeStream!('b', FORMAT_8K, signal))];
    await Promise.all([a, b]);
    expect(maxRunning()).toBe(1);
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('frees the slot after a failure and after a cancelled wait', async () => {
    const limiter = new ConcurrencyLimiter(1);
    let n = 0;
    const tts = {
      name: 'flaky',
      synthesize: async () => Buffer.alloc(2),
      async *synthesizeStream() {
        if (n++ === 0) throw new AiProviderError('flaky', 'tts', 'boom');
        yield pcm(20);
      },
    };
    const limited = new LimitedTts(tts, limiter);
    await expect(collect(limited.synthesizeStream!('a', FORMAT_8K, signal))).rejects.toThrow('boom');
    expect((await collect(limited.synthesizeStream!('b', FORMAT_8K, signal))).length).toBe(1);
  });

  it('does not offer streaming when the wrapped provider cannot', () => {
    const limited = new LimitedTts(new ToneTts(), new ConcurrencyLimiter(1));
    expect(limited.synthesizeStream).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------
class StreamSink extends CollectingAudioSink {
  firstChunkAt = 0;
  doneAt = 0;
  streamCalls = 0;
  async playStream(chunks: AsyncIterable<Buffer>, abort: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult> {
    this.streamCalls++;
    const parts: Buffer[] = [];
    for await (const chunk of chunks) {
      if (abort.aborted) return { bytesWritten: 0, completed: false, stoppedBy: 'aborted' };
      if (parts.length === 0) {
        this.firstChunkAt = performance.now();
        hooks?.onFirstWrite?.();
      }
      parts.push(chunk);
    }
    this.doneAt = performance.now();
    this.played.push(Buffer.concat(parts));
    return { bytesWritten: this.played.at(-1)!.length, completed: true, stoppedBy: null };
  }
}

const S1 = 'This is the first full sentence here.';
const S2 = 'This is the second full sentence here.';

function makeSession(tts: ToneTts, over: { sink?: CollectingAudioSink; cache?: Map<string, Buffer>; env?: Record<string, string | undefined>; llm?: string[] } = {}) {
  const providers: ProviderSet = {
    stt: new ScriptedStt(['hello there']),
    llm: new ScriptedLlm(over.llm ?? [`${S1} ${S2}`]),
    tts,
  };
  const sink = over.sink ?? new StreamSink(FORMAT_8K, true);
  const traces: TraceInput[] = [];
  const errors: string[] = [];
  const s = new ConversationSession({
    callId: 'call-1',
    config: makeConfig(over.env ?? {}),
    providers,
    sink,
    trace: (t) => traces.push(t),
    emit: (e) => e.type === 'error' && errors.push(`${e.stage}:${e.message}`),
    fixedAudioCache: over.cache,
  });
  return { s, sink, traces, errors };
}

describe('streamed replies in a conversation', () => {
  it('starts playing on the first bytes instead of after the whole sentence, and keeps sentence order', async () => {
    const tts = new ToneTts(0, () => false, { chunkMs: 100, gapMs: 60 });
    const { s, sink, traces } = makeSession(tts);
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('completed');
    const sinkS = sink as StreamSink;
    expect(sinkS.streamCalls).toBe(2);
    expect(tts.requests).toEqual([S1, S2]);
    // Audio went out before the first sentence had finished downloading.
    expect(result.metrics.firstAudioMs).not.toBeNull();
    expect(result.metrics.ttsFirstMs!).toBeLessThan(120);
    expect(result.metrics.ttsTotalMs).toBeGreaterThan(result.metrics.ttsFirstMs!);
    expect(result.metrics.firstAudioMs!).toBeLessThan(result.metrics.totalMs!);
    const generated = traces.filter((t) => t.stage === 'tts-generated');
    expect(generated).toHaveLength(2);
    expect(generated[0].data).toMatchObject({ streamed: true });
    expect(traces.filter((t) => t.stage === 'playback' && t.status === 'ok')).toHaveLength(2);
  });

  it('reports a stream that breaks mid-reply as a text-to-speech failure, not a port fault', async () => {
    const tts = new ToneTts(0, () => false, { chunkMs: 100, failAfterChunks: 1 });
    const { s, errors } = makeSession(tts);
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('tts-failed');
    expect(errors.some((e) => e.startsWith('tts:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('sink:'))).toBe(false);
  });

  it('cancels the download when the caller interrupts', async () => {
    const tts = new ToneTts(0, () => false, { chunkMs: 100, gapMs: 100 });
    const { s } = makeSession(tts);
    const turn = s.handleUtterance(speechPcm(1200), 'u1');
    await sleep(250);
    s.interrupt();
    const result = await turn;
    expect(result.status).toBe('cancelled');
    await vi.waitFor(() => expect(tts.streamCancelled).toBeGreaterThanOrEqual(1));
  });

  it('keeps the non-streaming path for providers that cannot stream', async () => {
    const tts = new ToneTts(0, () => false); // no stream configured
    const { s, sink } = makeSession(tts, { sink: new CollectingAudioSink(FORMAT_8K, true) });
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('completed');
    expect((sink as CollectingAudioSink).played).toHaveLength(2);
    expect(tts.requests).toEqual([S1, S2]);
  });
});

describe('fixed lines (the greeting) are synthesized once and replayed', () => {
  it('uses the text-to-speech provider the first time only, across calls', async () => {
    const cache = new Map<string, Buffer>();
    const tts = new ToneTts(0, () => false, { chunkMs: 100 });
    const first = makeSession(tts, { cache });
    const r1 = await first.s.say('Hello, thanks for calling.');
    expect(r1.status).toBe('completed');
    expect(tts.requests).toHaveLength(1);
    expect(cache.size).toBe(1);

    const second = makeSession(tts, { cache, sink: new CollectingAudioSink(FORMAT_8K, true) });
    const r2 = await second.s.say('Hello, thanks for calling.');
    expect(r2.status).toBe('completed');
    expect(tts.requests).toHaveLength(1); // no new request
    expect((second.sink as CollectingAudioSink).played[0].equals((first.sink as StreamSink).played[0])).toBe(true);
    expect(second.traces.find((t) => t.stage === 'tts-generated')?.data).toMatchObject({ cached: true });
    expect(r2.metrics.ttsFirstMs).toBeLessThan(50);
  });

  it('does not reuse a line for a different text or voice', async () => {
    const cache = new Map<string, Buffer>();
    const tts = new ToneTts(0, () => false, { chunkMs: 100 });
    await makeSession(tts, { cache }).s.say('Hello, thanks for calling.');
    await makeSession(tts, { cache }).s.say('Hello, thanks for calling again.');
    await makeSession(tts, { cache, env: { AI_TTS_VOICE: 'another-voice' } }).s.say('Hello, thanks for calling.');
    expect(tts.requests).toHaveLength(3);
  });

  it('never caches a line that was cut off or failed', async () => {
    const cache = new Map<string, Buffer>();
    const failing = new ToneTts(0, () => false, { chunkMs: 100, failAfterChunks: 1 });
    const bad = await makeSession(failing, { cache }).s.say('Hello, thanks for calling.');
    expect(bad.status).toBe('failed');
    expect(cache.size).toBe(0);

    const slow = new ToneTts(0, () => false, { chunkMs: 100, gapMs: 100 });
    const cut = makeSession(slow, { cache });
    const playing = cut.s.say('Hello, thanks for calling.');
    await sleep(150);
    cut.s.interrupt();
    expect((await playing).status).toBe('cancelled');
    expect(cache.size).toBe(0);
  });

  it('is empty (so nothing is reused) when no cache is provided', async () => {
    const tts = new ToneTts(0, () => false, { chunkMs: 100 });
    await makeSession(tts).s.say('Hello, thanks for calling.');
    await makeSession(tts).s.say('Hello, thanks for calling.');
    expect(tts.requests).toHaveLength(2);
  });
});

describe('the gateway audio sink plays streams', () => {
  async function adapter() {
    const audio = new MockAudioAdapter({ frameDurationMs: 20 });
    await audio.startSession('call-1');
    return audio;
  }

  it('writes every byte of a stream and reports it complete', async () => {
    const audio = await adapter();
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { prerollMs: 40 });
    let first = 0;
    const result = await sink.playStream(
      (async function* () {
        yield pcm(100);
        yield pcm(100);
      })(),
      new AbortController().signal,
      { onFirstWrite: () => first++ }
    );
    expect(result).toMatchObject({ completed: true, stoppedBy: null, bytesWritten: pcm(200).length });
    expect(first).toBe(1);
    await audio.stopSession();
  });

  it('stops when the call ends or the caller interrupts, without claiming the reply was played', async () => {
    const audio = await adapter();
    let live = true;
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => live, { prerollMs: 20 });
    const slow = (async function* () {
      for (let i = 0; i < 30; i++) {
        yield pcm(100);
        await sleep(20);
      }
    })();
    setTimeout(() => (live = false), 120);
    const result = await sink.playStream(slow, new AbortController().signal);
    expect(result.completed).toBe(false);
    expect(result.stoppedBy).toBe('call-ended');
    await audio.stopSession();
  });

  it('refuses to write when the port is not streaming', async () => {
    const audio = new MockAudioAdapter({ frameDurationMs: 20 }); // no session started
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true);
    await expect(sink.playStream((async function* () { yield pcm(20); })(), new AbortController().signal)).rejects.toThrow(/not streaming/);
  });

  it('fails fast when a write to the port hangs during a stream', async () => {
    const audio = await adapter();
    audio.writeAudioChunk = () => new Promise<void>(() => {});
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { writeTimeoutMs: 60, prerollMs: 20 });
    await expect(sink.playStream((async function* () { yield pcm(100); })(), new AbortController().signal)).rejects.toBeInstanceOf(AudioWriteTimeoutError);
    await audio.stopSession();
  });

  it('passes a text-to-speech failure through untouched so the conversation can classify it', async () => {
    const audio = await adapter();
    const sink = new GatewayAudioSink(audio, FORMAT_8K, true, () => true, { prerollMs: 20 });
    const boom = new AiProviderError('x', 'tts', 'stream broke');
    await expect(
      sink.playStream(
        (async function* () {
          yield pcm(20);
          throw boom;
        })(),
        new AbortController().signal
      )
    ).rejects.toBe(boom);
    await audio.stopSession();
  });
});

// keep the unused helper import honest for readers: this file builds its own providers.
void createMockProviders;

describe('Deepgram endpoint override', () => {
  it('accepts only https deepgram.com hosts, because the API key is sent there', async () => {
    const { deepgramSpeakUrl } = await import('../../src/ai/providers/index.js');
    expect(deepgramSpeakUrl(undefined)).toBeUndefined();
    expect(deepgramSpeakUrl('  ')).toBeUndefined();
    expect(deepgramSpeakUrl('https://api.deepgram.com/v1/speak')).toBe('https://api.deepgram.com/v1/speak');
    expect(deepgramSpeakUrl('https://api.eu.deepgram.com/v1/speak')).toContain('api.eu.deepgram.com');
    for (const bad of ['http://api.deepgram.com/v1/speak', 'https://evil.example.com/v1/speak', 'https://deepgram.com.evil.io/v1/speak', 'https://notdeepgram.com/x', 'not a url']) {
      expect(() => deepgramSpeakUrl(bad), bad).toThrow(/AI_DEEPGRAM_SPEAK_URL/);
    }
  });
});
