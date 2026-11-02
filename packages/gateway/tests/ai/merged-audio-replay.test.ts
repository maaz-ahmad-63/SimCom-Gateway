import { describe, expect, it } from 'vitest';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ConversationSession, TraceInput } from '../../src/ai/conversation.js';
import { ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { ProviderSet, SttResult, SttStream } from '../../src/ai/providers/types.js';
import { buildCallContext } from '../../src/campaigns/personalization.js';
import { FORMAT_8K, makeConfig, sleep, speechPcm } from './helpers.js';

/**
 * Calls 65b1972c and 943c1a61 (outbound): the turns that followed an interruption had their audio merged, the streaming recognizer
 * had only heard the newest part, and the whole audio went to the batch request: 1.3 to 1.7 s of speech-to-text against about 0.3 s
 * for a streamed turn. A replay stream was tried, but on calls 9da41342 and 0710a7d4 it never opened in time and only delayed the batch request, so merged audio now starts the batch request at once and replays the stream in parallel with a longer window. Mocked: it proves the routing and the fallbacks, not
 * Deepgram's real speed.
 */
class FakeStream implements SttStream {
  readonly pushed: Buffer[] = [];
  closed = false;
  interim = '';
  error: Error | null = null;
  finalizeOutcome: SttStream['finalizeOutcome'] = null;
  constructor(private readonly answer: SttResult | null) {}
  push(pcm: Buffer) {
    this.pushed.push(Buffer.from(pcm));
  }
  flush() {}
  async finalize(): Promise<SttResult | null> {
    this.finalizeOutcome = { how: this.answer ? 'acknowledged' : 'timeout', waitedMs: 5, finals: this.answer ? 1 : 0 };
    return this.answer;
  }
  close() {
    this.closed = true;
  }
  get pushedBytes() {
    return this.pushed.reduce((n, b) => n + b.length, 0);
  }
}

function build(answers: Array<SttResult | null>) {
  const opened: FakeStream[] = [];
  const providers: ProviderSet = {
    stt: new ScriptedStt(['batch one', 'batch merged'], 40),
    llm: new ScriptedLlm(['A reply that takes a while to arrive.'], { delayMs: 10 }),
    tts: new ToneTts(),
    sttStream: {
      name: 'fake-stream',
      open: () => {
        const s = new FakeStream(answers[opened.length] ?? null);
        opened.push(s);
        return s;
      },
    },
  };
  const trace: TraceInput[] = [];
  const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => trace.push(e) });
  return { providers, opened, session, trace };
}

/** The barge-in shape from the logs: A is cancelled during recognition, B and C pile up, one merged turn answers them. */
async function interruptedTurn(session: ConversationSession, parts: Buffer[]) {
  const [a, b, c] = parts;
  const p1 = session.handleUtterance(a, 'a');
  await sleep(10);
  const p2 = session.handleUtterance(b, 'b');
  const p3 = session.handleUtterance(c, 'c');
  return Promise.all([p1, p2, p3]);
}

describe('merged audio after an interruption: a fresh stream and the batch provider run in parallel', () => {
  const parts = [speechPcm(1200), speechPcm(700), speechPcm(800)];
  const total = parts.reduce((n, p) => n + p.length, 0);

  it('uses the stream words when they arrive, feeds it the whole audio, closes it, and drops the batch request that started with it', async () => {
    const { providers, opened, session, trace } = build([{ text: 'any vacancy for your company' }]);
    const results = await interruptedTurn(session, parts);
    expect(results.map((r) => r.status)).toEqual(['cancelled', 'skipped', 'completed']);
    expect(opened).toHaveLength(1);
    expect(opened[0].pushedBytes).toBe(total);
    expect(opened[0].pushed.every((b) => b.length <= 1600)).toBe(true); // 100 ms pieces, never one huge frame
    expect(opened[0].closed).toBe(true);
    expect(results[2].metrics.sttMode).toBe('stream');
    expect((providers.stt as ScriptedStt).calls).toHaveLength(2); // A's own request and the merged one, started at once
    expect(session.getHistory()[0]).toEqual({ role: 'user', content: 'any vacancy for your company' });
    expect(trace.filter((e) => e.stage === 'stt-submit').at(-1)?.data).toMatchObject({ streaming: true, replayedMergedAudio: true });
  });

  it('gives the replay stream a longer window than a live one (it has to connect first)', async () => {
    const seen: Array<number | undefined> = [];
    const { opened, session } = build([{ text: 'words' }]);
    const original = FakeStream.prototype.finalize;
    FakeStream.prototype.finalize = async function (this: FakeStream, _signal?: AbortSignal, timeoutMs?: number) {
      seen.push(timeoutMs);
      return original.call(this);
    };
    try {
      await interruptedTurn(session, parts);
    } finally {
      FakeStream.prototype.finalize = original;
    }
    expect(opened).toHaveLength(1);
    expect(seen).toEqual([3500]);
  });

  it('falls back to the batch result, with the whole audio, when the replayed stream cannot answer', async () => {
    const { providers, opened, session } = build([null]);
    const results = await interruptedTurn(session, parts);
    expect(results[2].status).toBe('completed');
    expect(opened[0].closed).toBe(true);
    expect(results[2].metrics.sttMode).toBe('batch');
    const calls = (providers.stt as ScriptedStt).calls;
    expect(calls).toHaveLength(2);
    expect(calls[1].bytes).toBe(total); // nothing is lost: the batch request still gets A + B + C
  });

  it('an empty answer for speech-like audio is not trusted: the batch provider decides', async () => {
    const { providers, session } = build([{ text: '' }]);
    const results = await interruptedTurn(session, parts);
    expect(results[2].status).toBe('completed');
    expect((providers.stt as ScriptedStt).calls).toHaveLength(2);
  });

  it('audio too long for a stream to hold while it connects goes straight to the batch provider', async () => {
    const long = [speechPcm(1200), speechPcm(10000), speechPcm(10000)]; // 21.2 s once merged
    const { providers, opened, session } = build([{ text: 'should not be used' }]);
    const results = await interruptedTurn(session, long);
    expect(opened).toHaveLength(0);
    expect(results[2].metrics.sttMode).toBe('batch');
    expect((providers.stt as ScriptedStt).calls).toHaveLength(2);
  });

  it('an ordinary single-capture turn still uses its own stream, and no batch request is started early for it', async () => {
    const { providers, opened, session } = build([]);
    const r = await session.handleUtterance(speechPcm(1200), 'solo', { stream: new FakeStream({ text: 'hello there' }) } as never);
    expect(opened).toHaveLength(0);
    expect(r.metrics.sttMode).toBe('stream');
    expect((providers.stt as ScriptedStt).calls).toHaveLength(0);
    const r2 = await build([]).session.handleUtterance(speechPcm(1200), 'solo2', { stream: new FakeStream(null) } as never);
    expect(r2.metrics.sttMode).toBe('batch'); // the stream gave nothing: batch fallback still works
  });

  it('with no streaming provider configured nothing changes: the batch provider transcribes the merged audio once', async () => {
    const providers: ProviderSet = {
      stt: new ScriptedStt(['one', 'merged'], 40),
      llm: new ScriptedLlm(['A reply that takes a while to arrive.'], { delayMs: 10 }),
      tts: new ToneTts(),
    };
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K) });
    const results = await interruptedTurn(session, parts);
    expect(results[2].metrics.sttMode).toBe('batch');
    expect((providers.stt as ScriptedStt).calls[1].bytes).toBe(total);
  });
});

describe('the campaign call context keeps an outbound agent focused', () => {
  const block = buildCallContext({ name: 'Imad', designation: '', company: 'Beta', context: '', extra: {} }, { contextNote: 'introduce the AI calling service', contextNoteMax: 0 } as never);

  it('says to introduce once, stay brief and on purpose, never invent an answer to an unrelated question, and still honours an opt-out', () => {
    expect(block).toContain('CAMPAIGN FOCUS');
    expect(block).toMatch(/never repeat the introduction/);
    expect(block).toMatch(/one or two short sentences/);
    expect(block).toMatch(/unrelated.*do not have that information.*never invent an answer/s);
    expect(block).toMatch(/ask them to repeat it instead of guessing/);
    expect(block).toContain('CAMPAIGN RULE: if the person asks not to be called again');
  });
});
