import { describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { AudioFormat, CollectingAudioSink, PlayResult } from '../../src/ai/audio.js';
import { ConversationEvent, ConversationSession, TraceInput } from '../../src/ai/conversation.js';
import { GatewayAudioSink } from '../../src/ai/gateway-adapters.js';
import { AudioMeter } from '../../src/ai/meter.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { createMockProviders, ToneTts } from '../../src/ai/providers/mock.js';
import { AiProviderError, ProviderSet, TtsProvider } from '../../src/ai/providers/types.js';
import { ConcurrencyLimiter, LimitedTts } from '../../src/ai/tts-limiter.js';
import { aiEnv, fakeFetch, FORMAT_8K, json, makeConfig, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const signal = new AbortController().signal;

/** A text-to-speech provider that records how many requests overlapped, like a provider with a concurrency limit. */
class MeteredTts implements TtsProvider {
  readonly name = 'metered';
  inFlight = 0;
  maxInFlight = 0;
  readonly started: string[] = [];
  constructor(private readonly delayMs: number, private readonly failOn: (text: string) => Error | null = () => null) {}
  async synthesize(text: string, format: AudioFormat, abort: AbortSignal): Promise<Buffer> {
    this.started.push(text);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        abort.addEventListener('abort', () => (clearTimeout(t), reject(new AiProviderError('metered', 'tts', 'cancelled', { aborted: true }))), { once: true });
      });
      const err = this.failOn(text);
      if (err) throw err;
      return Buffer.alloc(Math.round(format.sampleRate * 0.1) * 2, 1);
    } finally {
      this.inFlight--;
    }
  }
}

// Each sentence is long enough that the splitter keeps it separate (it joins fragments shorter than 24 characters).
const S1 = 'This is the first full sentence here.';
const S2 = 'This is the second full sentence here.';
const S3 = 'This is the third full sentence here.';
const THREE_SENTENCES = `${S1} ${S2} ${S3}`;

function session(providers: ProviderSet, sink = new CollectingAudioSink(FORMAT_8K), env: Record<string, string | undefined> = {}) {
  const events: ConversationEvent[] = [];
  const traces: TraceInput[] = [];
  const s = new ConversationSession({
    callId: 'call-1',
    config: makeConfig(env),
    providers,
    sink,
    emit: (e) => events.push(e),
    trace: (t) => traces.push(t),
  });
  return { s, sink, events, traces };
}

describe('concurrency limit', () => {
  it('runs one at a time in arrival order and releases the slot after success and failure', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: string[] = [];
    let running = 0;
    let max = 0;
    const task = (name: string, ms: number, fail = false) => () =>
      (async () => {
        running++;
        max = Math.max(max, running);
        order.push(`start:${name}`);
        await sleep(ms);
        running--;
        order.push(`end:${name}`);
        if (fail) throw new Error('boom');
        return name;
      })();
    const never = new AbortController().signal;
    const gone = () => new Error('cancelled');
    const results = await Promise.allSettled([
      limiter.run(task('a', 20), never, gone),
      limiter.run(task('b', 5, true), never, gone),
      limiter.run(task('c', 5), never, gone),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(max).toBe(1);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it('drops a request cancelled while waiting without ever running it, and does not leak its place', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const ran: string[] = [];
    const first = limiter.run(async () => (await sleep(30), ran.push('first')), new AbortController().signal, () => new Error('x'));
    const controller = new AbortController();
    const waiting = limiter.run(async () => ran.push('cancelled'), controller.signal, () => new Error('cancelled while queued'));
    const third = limiter.run(async () => ran.push('third'), new AbortController().signal, () => new Error('x'));
    controller.abort();
    await expect(waiting).rejects.toThrow('cancelled while queued');
    await Promise.all([first, third]);
    expect(ran).toEqual(['first', 'third']);
    expect(limiter.queued).toBe(0);
  });

  it('allows more than one only when told to', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let running = 0;
    let max = 0;
    const work = () => limiter.run(async () => (running++, (max = Math.max(max, running)), await sleep(15), running--), new AbortController().signal, () => new Error('x'));
    await Promise.all([work(), work(), work(), work()]);
    expect(max).toBe(2);
  });
});

describe('text-to-speech requests no longer overlap', () => {
  it('without the limit, a three-sentence reply fires its requests together (the cause of the 429s)', async () => {
    const tts = new MeteredTts(40);
    const providers = createMockProviders({ stt: ['hello'], llm: [THREE_SENTENCES] });
    const { s } = session({ ...providers, tts });
    await s.handleUtterance(speechPcm(1200), 'u1');
    expect(tts.maxInFlight).toBeGreaterThan(1);
  });

  it('with the limit, never more than one is in flight, and the sentences are spoken in order exactly once', async () => {
    const tts = new MeteredTts(40);
    const providers = createMockProviders({ stt: ['hello'], llm: [THREE_SENTENCES] });
    const sink = new CollectingAudioSink(FORMAT_8K);
    const { s } = session({ ...providers, tts: new LimitedTts(tts, new ConcurrencyLimiter(1)) }, sink);
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('completed');
    expect(tts.maxInFlight).toBe(1);
    expect(tts.started).toEqual([S1, S2, S3]);
    expect(sink.played).toHaveLength(3);
    expect(s.getHistory().at(-1)).toEqual({ role: 'assistant', content: THREE_SENTENCES });
  });

  it('queued sentences of an interrupted reply are cancelled, not sent, and the next turn is not delayed by them', async () => {
    const tts = new MeteredTts(80);
    const providers = createMockProviders({ stt: ['one', 'two'], llm: [THREE_SENTENCES, 'Short answer that is long enough.'] });
    const { s, sink } = session({ ...providers, tts: new LimitedTts(tts, new ConcurrencyLimiter(1)) }, new CollectingAudioSink(FORMAT_8K, true, 200));
    void s.handleUtterance(speechPcm(1200), 'u1');
    await sleep(150); // the first sentence is being played, the second is being synthesized, the third is waiting
    const startedBefore = tts.started.length;
    const second = await s.handleUtterance(speechPcm(1200), 'u2');
    expect(second.status).toBe('completed');
    expect(tts.started).not.toContain(S3); // never requested after the interruption
    expect(tts.started.length - startedBefore).toBeLessThanOrEqual(1); // only the new answer
    expect(tts.maxInFlight).toBe(1);
    expect(sink.played.length).toBeGreaterThanOrEqual(1);
  });

  it('createProviders wraps the configured provider: concurrent callers share one slot per provider', async () => {
    let inFlight = 0;
    let max = 0;
    const fetched = fakeFetch([
      async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await sleep(25);
        inFlight--;
        return new Response(Buffer.alloc(1600, 1), { status: 200 });
      },
    ]);
    const env = { AI_TTS: 'cartesia', AI_TTS_CONCURRENCY: '1' };
    const a = createProviders(makeConfig(env), { env: aiEnv(env), fetchImpl: fetched.impl, only: 'tts' });
    const b = createProviders(makeConfig(env), { env: aiEnv(env), fetchImpl: fetched.impl, only: 'tts' }); // another call's session
    await Promise.all([a.tts.synthesize('One.', FORMAT_8K, signal), b.tts.synthesize('Two.', FORMAT_8K, signal), a.tts.synthesize('Three.', FORMAT_8K, signal)]);
    expect(max).toBe(1);
    expect(fetched.requests).toHaveLength(3);
  });

  it('retries a rate-limited request once, speaks the text once, and gives up honestly if it keeps failing', async () => {
    const limited = () => json({ error_code: 'concurrency_limited', message: 'Too many concurrent requests' }, 429);
    const ok = () => new Response(Buffer.alloc(1600, 1), { status: 200 });
    const env = { AI_TTS: 'cartesia', AI_MAX_RETRIES: '1' };
    const recovering = fakeFetch([limited(), ok()]);
    const a = createProviders(makeConfig(env), { env: aiEnv(env), fetchImpl: recovering.impl, only: 'tts', sleep: async () => {} });
    const pcm = await a.tts.synthesize('Hello there.', FORMAT_8K, signal);
    expect(pcm.length).toBe(1600);
    expect(recovering.requests).toHaveLength(2);

    const hopeless = fakeFetch([limited()]);
    const b = createProviders(makeConfig(env), { env: aiEnv(env), fetchImpl: hopeless.impl, only: 'tts', sleep: async () => {} });
    await expect(b.tts.synthesize('Hello there.', FORMAT_8K, signal)).rejects.toThrow(/429/);
    expect(hopeless.requests).toHaveLength(2); // bounded: first try plus one retry
  });

  it('a failed sentence ends the reply without repeating anything already spoken', async () => {
    const tts = new MeteredTts(5, (text) => (text === S2 ? new AiProviderError('metered', 'tts', 'HTTP 429: concurrency_limited', { status: 429 }) : null));
    const providers = createMockProviders({ stt: ['hello'], llm: [THREE_SENTENCES] });
    const sink = new CollectingAudioSink(FORMAT_8K);
    const { s } = session({ ...providers, tts: new LimitedTts(tts, new ConcurrencyLimiter(1)) }, sink);
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('tts-failed');
    expect(sink.played).toHaveLength(1); // the first sentence only, spoken once
    expect(s.lastError?.stage).toBe('tts');
    expect(s.getHistory().at(-1)).toEqual({ role: 'assistant', content: S1 });
  });
});

describe('playback problems are reported as playback problems', () => {
  class ScriptedSink extends CollectingAudioSink {
    constructor(private readonly script: () => PlayResult | Error) {
      super(FORMAT_8K);
    }
    async play(): Promise<PlayResult> {
      const r = this.script();
      if (r instanceof Error) throw r;
      return r;
    }
  }

  it('a greeting whose playback throws is a sink error, not a text-to-speech failure', async () => {
    const providers = createMockProviders();
    const { s, traces } = session(providers, new ScriptedSink(() => new Error('Audio port is not streaming; refusing to write playback')));
    const result = await s.say('Hello, thanks for calling.');
    expect(result).toMatchObject({ status: 'failed', reason: 'sink-error' });
    expect(s.lastError).toMatchObject({ stage: 'sink' });
    expect(traces.find((t) => t.stage === 'tts-generated')?.status).toBe('ok');
    expect(traces.find((t) => t.stage === 'playback')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/not streaming/) });
  });

  it('a port that stops accepting bytes mid-reply is a failure of the line, shown as such and counted toward giving up', async () => {
    const providers = createMockProviders({ stt: ['a', 'b', 'c'], llm: ['Reply one here.'] });
    const { s, events, traces } = session(
      providers,
      new ScriptedSink(() => ({ bytesWritten: 100, completed: false, stoppedBy: 'not-written' })),
      { AI_MAX_CONSECUTIVE_FAILURES: '2' }
    );
    const first = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(first).toMatchObject({ status: 'failed', reason: 'sink-error' });
    expect(s.lastError?.message).toMatch(/accepted fewer bytes/);
    expect(traces.find((t) => t.stage === 'playback')).toMatchObject({ status: 'failed' });
    await s.handleUtterance(speechPcm(1200), 'u2');
    expect(s.isDegraded).toBe(true); // stops speaking into a dead port
    expect(events.some((e) => e.type === 'degraded')).toBe(true);
  });

  it('reports late frames (an underrun risk) instead of calling a starved playback clean', async () => {
    const providers = createMockProviders({ stt: ['hello'], llm: ['Here is a reply.'] });
    const sink = new ScriptedSink(() => ({ bytesWritten: 3200, completed: true, stoppedBy: null, lateFrames: 4, maxLateMs: 120 }));
    const { s, traces } = session(providers, sink);
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('completed');
    expect(result.metrics.lateFrames).toBeGreaterThan(0);
    const playback = traces.find((t) => t.stage === 'playback')!;
    expect(playback.detail).toMatch(/frame\(s\) went out late .* gaps/);
    expect(playback.detail).toMatch(/not verified/);
    expect(playback.data).toMatchObject({ lateFrames: 4, maxLateMs: 120 });
  });

  it('the real sink passes the pacing result through: a slow modem write shows up as late frames', async () => {
    const audio = new MockAudioAdapter();
    await audio.startSession('c1');
    const original = audio.writeAudioChunk.bind(audio);
    audio.writeAudioChunk = async (chunk: Buffer) => {
      await sleep(45); // slower than the 20 ms frame
      return original(chunk);
    };
    const sink = new GatewayAudioSink(audio, FORMAT_8K, false, () => true);
    const result = await sink.play(Buffer.alloc(FORMAT_8K.sampleRate * 2 * 0.3, 1), signal);
    expect(result.completed).toBe(true);
    expect(result.lateFrames).toBeGreaterThan(0);
    expect(result.maxLateMs).toBeGreaterThan(20);
    await audio.stopSession();
  });
});

describe('what the timings measure', () => {
  it('separates the wait before the first audio from the whole turn, which includes speaking', async () => {
    const providers = createMockProviders({ stt: ['hello'], llm: ['A reply that takes a while to say out loud.'], delays: { stt: 20, llm: 20, tts: 40 } });
    const { s } = session(providers, new CollectingAudioSink(FORMAT_8K, true, 300));
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    const m = result.metrics;
    expect(m.firstAudioMs).not.toBeNull();
    expect(m.firstAudioMs!).toBeGreaterThanOrEqual(80); // stt + llm + tts before any audio
    expect(m.firstAudioMs!).toBeLessThan(m.totalMs - 250); // the rest of the turn is the speaking time
    expect(m.totalMs).toBeGreaterThanOrEqual(m.firstAudioMs! + 250);
  });

  it('has no first-audio time for a turn that never spoke', async () => {
    const providers = createMockProviders({ stt: ['hello'], llm: [new AiProviderError('groq', 'llm', 'HTTP 503', { status: 503 })] });
    const { s } = session(providers);
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('failed');
    expect(result.metrics.firstAudioMs).toBeNull();
  });
});

describe('stale inbound audio', () => {
  it('reports audio that arrives faster than real time as a backlog', () => {
    let now = 0;
    const meter = new AudioMeter(FORMAT_8K, () => now);
    // 6 s of audio delivered in 2 s: a stalled stream flushed in a burst.
    for (let i = 0; i < 110; i++) {
      meter.feed(noiseFloorPcm(60));
      now += 20;
    }
    expect(meter.snapshot(0, 0).backlogMs).toBeGreaterThan(3500);

    now = 0;
    const steady = new AudioMeter(FORMAT_8K, () => now);
    for (let i = 0; i < 200; i++) {
      steady.feed(noiseFloorPcm(20));
      now += 20;
    }
    expect(steady.snapshot(0, 0).backlogMs).toBeLessThan(100);
  });
});

describe('configuration', () => {
  it('defaults to one simultaneous text-to-speech request and rejects nonsense', () => {
    expect(makeConfig({}).limits.ttsConcurrency).toBe(1);
    expect(makeConfig({ AI_TTS_CONCURRENCY: '3' }).limits.ttsConcurrency).toBe(3);
    expect(() => makeConfig({ AI_TTS_CONCURRENCY: '9' })).toThrow(/AI_TTS_CONCURRENCY/);
  });

  it('selects Deepgram for speech only when asked, and only with an Aura voice', () => {
    expect(() => makeConfig({ AI_TTS: 'deepgram', AI_TTS_VOICE: 'flux-alexis-en' })).toThrow(/Aura voice/);
    const cfg = makeConfig({ AI_TTS: 'deepgram', AI_TTS_VOICE: 'aura-asteria-en' });
    expect(cfg.tts).toEqual({ key: 'deepgram', voice: 'aura-asteria-en' });
    expect(cfg.requiredKeyEnv).toContain('DEEPGRAM_API_KEY');
    expect(ToneTts).toBeDefined();
  });
});
