import { describe, expect, it } from 'vitest';
import { CollectingAudioSink, PlayResult } from '../../src/ai/audio.js';
import { ConversationSession, TraceInput } from '../../src/ai/conversation.js';
import { ScriptedLlm, ToneTts } from '../../src/ai/providers/mock.js';
import { DeepgramStreamingStt, WsLike } from '../../src/ai/providers/stt-stream.js';
import { AiProviderError, ProviderSet, SttProvider, SttResult, SttStream } from '../../src/ai/providers/types.js';
import { ConcurrencyLimiter, LimitedTts } from '../../src/ai/tts-limiter.js';
import { FORMAT_8K, makeConfig, sleep, speechPcm } from './helpers.js';

/**
 * Calls 6dd78e2d, 9dbf8498, 1c1882b8 and e949e848: the streaming recognizer (Deepgram; the batch "soniox" is only its fallback) often
 * answered after 1.3 to 1.5 s or not at all, and the batch request then started only after the 1.5 s timeout (3.1 to 4.9 s turns).
 * The tests use fakes: they prove the routing, the cancellation and the counters, not any provider's real speed.
 */

/** A stream that answers (or not) after a delay, and stops waiting when the turn is cancelled. */
class SlowStream implements SttStream {
  interim = '';
  error: Error | null = null;
  closed = false;
  finalizeOutcome: SttStream['finalizeOutcome'] = null;
  constructor(
    private readonly answer: SttResult | null,
    private readonly delayMs: number
  ) {}
  push() {}
  flush() {}
  async finalize(signal?: AbortSignal): Promise<SttResult | null> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.delayMs);
      signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
    this.finalizeOutcome = { how: this.answer ? 'acknowledged' : 'timeout', waitedMs: this.delayMs, finals: this.answer ? 1 : 0 };
    return signal?.aborted ? null : this.answer;
  }
  close() {
    this.closed = true;
  }
}

/** The batch provider: records when each request started and whether it was cancelled. */
class ProbeStt implements SttProvider {
  readonly name = 'probe-batch';
  readonly startedAt: number[] = [];
  aborted = 0;
  constructor(
    private readonly text: string,
    private readonly delayMs: number
  ) {}
  transcribe(_pcm: Buffer, _format: unknown, signal: AbortSignal): Promise<SttResult> {
    this.startedAt.push(performance.now());
    return new Promise<SttResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: this.text }), this.delayMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          this.aborted++;
          reject(new AiProviderError(this.name, 'stt', 'cancelled', { aborted: true }));
        },
        { once: true }
      );
    });
  }
}

function build(env: Record<string, string | undefined>, batch: ProbeStt) {
  const llm = new ScriptedLlm(['Okay, noted.']);
  const tts = new ToneTts();
  const providers: ProviderSet = { stt: batch, llm, tts };
  const traces: TraceInput[] = [];
  const session = new ConversationSession({
    callId: 'c',
    config: makeConfig({ AI_STT_STREAMING: 'true', AI_STT_STREAM_FINALIZE_MS: '500', ...env }),
    providers,
    sink: new CollectingAudioSink(FORMAT_8K),
    trace: (e) => traces.push(e),
  });
  return { session, llm, tts, traces };
}

describe('a slow streaming recognizer no longer delays the batch fallback until its timeout', () => {
  it('stream answers after the early batch request started: the stream is used, the batch request is cancelled, nothing is transcribed twice', async () => {
    const batch = new ProbeStt('from the batch', 1000);
    const { session, traces } = build({ AI_STT_STREAM_HEDGE_MS: '100' }, batch);
    const stream = new SlowStream({ text: 'from the stream' }, 250);
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream });
    expect(result.status).toBe('completed');
    expect(session.getHistory()[0]).toEqual({ role: 'user', content: 'from the stream' });
    expect(result.metrics.sttMode).toBe('stream');
    expect(batch.startedAt).toHaveLength(1); // started early...
    expect(batch.aborted).toBe(1); // ...and cancelled the moment the stream answered
    expect(stream.closed).toBe(true);
    expect(traces.find((t) => t.stage === 'stt-result' && t.status === 'ok')?.data).toMatchObject({ streaming: 'final', batchStartedEarly: true });
  });

  it('stream times out: the batch request that started early supplies the words, and it is the only batch request', async () => {
    const batch = new ProbeStt('from the batch', 200);
    const { session, traces } = build({ AI_STT_STREAM_HEDGE_MS: '100' }, batch);
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream: new SlowStream(null, 500) });
    expect(result.status).toBe('completed');
    expect(session.getHistory()[0]).toEqual({ role: 'user', content: 'from the batch' });
    expect(result.metrics.sttMode).toBe('batch');
    expect(batch.startedAt).toHaveLength(1); // exactly one request, not one early and one after the timeout
    expect(batch.aborted).toBe(0);
    // Waited for the stream's 500 ms, not 500 + 200: the batch answer was already there.
    expect(result.metrics.sttMs!).toBeGreaterThan(450);
    expect(result.metrics.sttMs!).toBeLessThan(650);
    expect(traces.find((t) => t.stage === 'stt-result' && t.status === 'ok')?.data).toMatchObject({ streaming: 'fallback', batchStartedEarly: true, streamFinalize: 'timeout' });
  });

  it('control: with the early start off, the batch request begins only after the stream gave up', async () => {
    const batch = new ProbeStt('from the batch', 200);
    const { session } = build({ AI_STT_STREAM_HEDGE_MS: '0' }, batch);
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream: new SlowStream(null, 500) });
    expect(result.status).toBe('completed');
    expect(batch.startedAt).toHaveLength(1);
    expect(result.metrics.sttMs!).toBeGreaterThan(680); // 500 + 200
  });

  it('a stream that answers quickly never causes a batch request', async () => {
    const batch = new ProbeStt('from the batch', 200);
    const { session } = build({ AI_STT_STREAM_HEDGE_MS: '100' }, batch);
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream: new SlowStream({ text: 'quick words' }, 20) });
    expect(result.status).toBe('completed');
    expect(result.metrics.sttMode).toBe('stream');
    expect(batch.startedAt).toHaveLength(0);
  });

  it('an empty answer from the stream for speech-like audio is still not trusted: the early batch request decides', async () => {
    const batch = new ProbeStt('words the stream missed', 100);
    const { session } = build({ AI_STT_STREAM_HEDGE_MS: '100' }, batch);
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream: new SlowStream({ text: '' }, 250) });
    expect(result.status).toBe('completed');
    expect(session.getHistory()[0]).toEqual({ role: 'user', content: 'words the stream missed' });
    expect(batch.startedAt).toHaveLength(1);
  });

  it('barge-in while the early batch request is running cancels it and starts no reply', async () => {
    const batch = new ProbeStt('never used', 5000);
    const { session, llm, tts } = build({ AI_STT_STREAM_HEDGE_MS: '100', AI_STT_STREAM_FINALIZE_MS: '2000' }, batch);
    const turn = session.handleUtterance(speechPcm(1200), 'u1', { stream: new SlowStream(null, 5000) });
    await sleep(300);
    expect(batch.startedAt).toHaveLength(1);
    session.interrupt('caller-speech');
    const result = await turn;
    expect(result.status).toBe('cancelled');
    expect(batch.aborted).toBe(1);
    expect(llm.requests).toHaveLength(0);
    expect(tts.requests).toHaveLength(0); // no stale audio is ever generated for a cancelled turn
  });

  it('the early start can only be configured below the timeout; the default is 700 ms', () => {
    expect(makeConfig({ AI_STT_STREAMING: 'true' }).sttStreaming.hedgeMs).toBe(700);
    expect(makeConfig({ AI_STT_STREAM_HEDGE_MS: '0' }).sttStreaming.hedgeMs).toBe(0);
  });
});

describe('text-to-speech: one request per sentence, and queue time is reported apart from the provider time', () => {
  class StreamSink extends CollectingAudioSink {
    async playStream(chunks: AsyncIterable<Buffer>, abort: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult> {
      const parts: Buffer[] = [];
      for await (const chunk of chunks) {
        if (abort.aborted) return { bytesWritten: 0, completed: false, stoppedBy: 'aborted' };
        if (parts.length === 0) hooks?.onFirstWrite?.();
        parts.push(chunk);
      }
      this.played.push(Buffer.concat(parts));
      return { bytesWritten: this.played.at(-1)!.length, completed: true, stoppedBy: null };
    }
  }
  const S1 = 'This is the first full sentence here.';
  const S2 = 'This is the second full sentence here.';
  const S3 = 'And this is the third full sentence here.';

  it('each sentence is requested exactly once, in order; sentence 2 and 3 report the time they waited behind the provider limit', async () => {
    const inner = new ToneTts(0, () => false, { chunkMs: 100, gapMs: 60 });
    const tts = new LimitedTts(inner, new ConcurrencyLimiter(1));
    const providers: ProviderSet = { stt: { name: 's', transcribe: async () => ({ text: 'hello there' }) }, llm: new ScriptedLlm([`${S1} ${S2} ${S3}`]), tts };
    const traces: TraceInput[] = [];
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new StreamSink(FORMAT_8K, true), trace: (e) => traces.push(e) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(result.status).toBe('completed');
    expect(inner.requests).toEqual([S1, S2, S3]); // no sentence twice, none lost
    expect(result.metrics.ttsRequests).toBe(3);
    const generated = traces.filter((t) => t.stage === 'tts-generated');
    expect(generated.map((t) => t.data?.request)).toEqual([1, 2, 3]);
    expect(generated[0].data!.queuedMs as number).toBeLessThan(30);
    expect(generated[1].data!.queuedMs as number).toBeGreaterThan(300); // waited for sentence 1's download
    // The reported latency is the provider's own time, so a queued sentence no longer looks like a slow provider.
    expect(generated[1].latencyMs!).toBeLessThan((generated[1].data!.sinceRequestMs as number) - 250);
    expect(result.metrics.ttsQueuedMs).toBeGreaterThan(600);
    const summary = traces.find((t) => t.stage === 'call' && t.data && 'ttsRequests' in t.data);
    expect(summary?.data).toMatchObject({ ttsRequests: 3, sttMode: 'batch' });
  });

  it('keeps the audio format and chunk order intact through the limiter (whole 16-bit samples, in order)', async () => {
    const inner = new ToneTts(0, () => false, { chunkMs: 100 });
    const tts = new LimitedTts(inner, new ConcurrencyLimiter(1));
    const chunks: Buffer[] = [];
    for await (const c of tts.synthesizeStream!(S1, FORMAT_8K, new AbortController().signal, { onStart: () => {} })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length % 2 === 0)).toBe(true);
    expect(chunks[0].length).toBe(1600); // 100 ms at 8 kHz, 16-bit
  });
});

describe('the streaming recognizer reports what it did, as numbers only', () => {
  class FakeWs implements WsLike {
    readyState = 1;
    onopen: WsLike['onopen'] = null;
    onmessage: WsLike['onmessage'] = null;
    onerror: WsLike['onerror'] = null;
    onclose: WsLike['onclose'] = null;
    readonly sent: Array<Buffer | string> = [];
    send(data: Buffer | string) {
      this.sent.push(data);
      if (typeof data === 'string' && data.includes('Finalize')) {
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'secret words' }] } }) });
          this.onmessage?.({ data: JSON.stringify({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'secret words here' }] } }) });
          this.onmessage?.({ data: JSON.stringify({ type: 'Metadata' }) });
        }, 20);
      }
    }
    close() {}
  }

  it('counts messages and times, never includes the words or the key, and still returns every final word', async () => {
    const ws = new FakeWs();
    const provider = new DeepgramStreamingStt({ apiKey: 'sk-should-never-appear', model: 'nova-3', language: 'en', keyterms: [], finalizeTimeoutMs: 1000, webSocketFactory: () => ws });
    const stream = provider.open(FORMAT_8K, new AbortController().signal);
    ws.onopen?.();
    stream.push(speechPcm(500));
    const result = await stream.finalize();
    expect(result).toEqual({ text: 'secret words here' });
    const outcome = stream.finalizeOutcome!;
    expect(outcome.how).toBe('acknowledged');
    expect(outcome.diag).toMatchObject({ audioMs: 500, flushesSent: 1, flushesAcked: 1, interimText: 1, finalText: 1, fromFinalize: 1, interimChars: 0 });
    expect(outcome.diag!.openMs).toBeGreaterThanOrEqual(0);
    expect(outcome.diag!.firstReplyMs).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('sk-should-never-appear');
  });

  it('a stream that never hears from the server says so: no reply, flushes unacknowledged', async () => {
    const ws = new FakeWs();
    ws.send = (d) => void ws.sent.push(d); // a server that never answers
    const provider = new DeepgramStreamingStt({ apiKey: 'k', model: 'nova-3', language: 'en', keyterms: [], finalizeTimeoutMs: 200, webSocketFactory: () => ws });
    const stream = provider.open(FORMAT_8K, new AbortController().signal);
    ws.onopen?.();
    stream.push(speechPcm(300));
    expect(await stream.finalize()).toBeNull();
    expect(stream.finalizeOutcome).toMatchObject({ how: 'timeout', finals: 0, diag: { firstReplyMs: -1, flushesSent: 1, flushesAcked: 0, finalText: 0 } });
  });
});
