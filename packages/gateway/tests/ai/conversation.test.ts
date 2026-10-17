import { describe, expect, it } from 'vitest';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ConversationEvent, ConversationSession } from '../../src/ai/conversation.js';
import { createMockProviders, ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { AiProviderError } from '../../src/ai/providers/types.js';
import { FORMAT_8K, makeConfig, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const build = (
  providers = createMockProviders(),
  env: Record<string, string | undefined> = {},
  sink = new CollectingAudioSink(FORMAT_8K)
) => {
  const events: ConversationEvent[] = [];
  const session = new ConversationSession({
    callId: 'call-1',
    config: makeConfig(env),
    providers,
    sink,
    emit: (event) => events.push(event),
  });
  return { session, providers, sink, events };
};
const turns = (events: ConversationEvent[]) => events.flatMap((e) => (e.type === 'turn' ? [e.result] : []));

describe('STT -> LLM -> TTS orchestration', () => {
  it('runs the stages in order for one caller turn and keeps the history', async () => {
    const providers = createMockProviders({
      stt: ['What are your opening hours?'],
      llm: ['We open at nine every weekday. Is there anything else I can help with?'],
    });
    const { session, sink, events } = build(providers);

    const result = await session.handleUtterance(speechPcm(1200), 'u1');

    expect(result.status).toBe('completed');
    expect(providers.stt.calls).toHaveLength(1);
    expect(providers.llm.requests).toHaveLength(1);
    expect(providers.llm.requests[0].messages).toEqual([{ role: 'user', content: 'What are your opening hours?' }]);
    expect(providers.llm.requests[0].system).toMatch(/CORE BEHAVIOR RULES/);
    expect(providers.tts.requests).toEqual([
      'We open at nine every weekday.',
      'Is there anything else I can help with?',
    ]);
    expect(sink.played).toHaveLength(2);
    expect(session.getHistory()).toEqual([
      { role: 'user', content: 'What are your opening hours?' },
      { role: 'assistant', content: 'We open at nine every weekday. Is there anything else I can help with?' },
    ]);
    expect(result.metrics.sttMs).not.toBeNull();
    expect(result.metrics.llmFirstTokenMs).not.toBeNull();
    expect(result.metrics.ttsFirstMs).not.toBeNull();
    expect(result.metrics.usage?.completionTokens).toBeGreaterThan(0);
    expect(session.totals).toMatchObject({ turns: 1, completed: 1, ttsChars: result.metrics.ttsChars });
    expect(turns(events)).toHaveLength(1);
  });

  it('sends the whole conversation so far on the next turn, and nothing from other calls', async () => {
    const providers = createMockProviders({ stt: ['first question here', 'second question here'], llm: ['First answer is long enough.', 'Second answer is long enough.'] });
    const { session } = build(providers);
    await session.handleUtterance(speechPcm(1200), 'a');
    await session.handleUtterance(speechPcm(1200), 'b');

    expect(providers.llm.requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    const other = build();
    expect(other.session.getHistory()).toEqual([]);
  });

  it('only keeps the configured number of history messages', async () => {
    const providers = createMockProviders({ stt: ['one two three'], llm: ['A reasonably long reply sentence.'] });
    const { session } = build(providers, { AI_MAX_HISTORY_MESSAGES: '4' });
    for (let i = 0; i < 5; i++) await session.handleUtterance(speechPcm(1200), `u${i}`);
    const history = session.getHistory();
    expect(history.length).toBeLessThanOrEqual(4);
    expect(history[0].role).toBe('user');
  });

  it('never speaks protocol syntax and honours the reply length cap', async () => {
    const providers = createMockProviders({
      stt: ['tell me something'],
      llm: ['This is the first spoken sentence here. <tool_call>{"name":"x"}</tool_call> never spoken.'],
    });
    const { session } = build(providers);
    await session.handleUtterance(speechPcm(1200));
    expect(providers.tts.requests).toEqual(['This is the first spoken sentence here.']);

    const long = createMockProviders({
      stt: ['go on'],
      llm: ['First sentence is quite long here. Second sentence is quite long here. Third sentence is quite long here.'],
    });
    const capped = build(long, { AI_MAX_RESPONSE_CHARS: '60' });
    await capped.session.handleUtterance(speechPcm(1200));
    expect(long.tts.requests).toEqual(['First sentence is quite long here.']);
  });

  it('keeps transcripts out of results unless asked', async () => {
    const quiet = build();
    expect((await quiet.session.handleUtterance(speechPcm(1200))).transcript).toBeUndefined();
    const verbose = build(createMockProviders(), { AI_LOG_TRANSCRIPTS: 'true' });
    expect((await verbose.session.handleUtterance(speechPcm(1200))).transcript).toBe('hello there');
  });
});

describe('silence, short audio and empty transcripts cost nothing', () => {
  it.each([
    ['digital silence', Buffer.alloc(16000), 'silent'],
    ['the idle line noise floor', noiseFloorPcm(1500), 'silent'],
    ['a clip that is too short', speechPcm(100), 'too-short'],
  ])('skips %s before any provider is called', async (_name, pcm, reason) => {
    const { session, providers } = build();
    const result = await session.handleUtterance(pcm as Buffer);
    expect(result).toMatchObject({ status: 'skipped', reason });
    expect(providers.stt.calls).toHaveLength(0);
    expect(providers.llm.requests).toHaveLength(0);
    expect(providers.tts.requests).toHaveLength(0);
  });

  it('skips malformed buffers', async () => {
    const { session, providers } = build();
    expect(await session.handleUtterance(Buffer.alloc(0))).toMatchObject({ status: 'skipped' });
    expect((await session.handleUtterance(Buffer.alloc(1001))).reason).toMatch(/invalid-audio/);
    expect(providers.stt.calls).toHaveLength(0);
  });

  it('does not call the LLM for a transcript with no words', async () => {
    const providers = createMockProviders({ stt: ['...', '   ', ''] });
    const { session } = build(providers);
    for (let i = 0; i < 3; i++) expect((await session.handleUtterance(speechPcm(1200), `x${i}`)).reason).toBe('empty-transcript');
    expect(providers.llm.requests).toHaveLength(0);
    expect(session.getHistory()).toEqual([]);
  });

  it('can be told to drop loud, unvoiced audio before paying for STT', async () => {
    const { loudNoisePcm } = await import('./helpers.js');
    const lenient = build();
    expect((await lenient.session.handleUtterance(loudNoisePcm(1200))).status).toBe('completed');
    const strict = build(createMockProviders(), { AI_SKIP_UNLIKELY_SPEECH: 'true' });
    expect((await strict.session.handleUtterance(loudNoisePcm(1200))).reason).toBe('unlikely-speech');
    expect(strict.providers.stt.calls).toHaveLength(0);
  });
});

describe('END_CALL handling', () => {
  it('speaks the goodbye, never the token, and raises exactly one end request', async () => {
    const providers = createMockProviders({ stt: ['no that is all thanks'], llm: ['Thank you for calling, goodbye! END_CALL'] });
    const { session, events } = build(providers);
    const result = await session.handleUtterance(speechPcm(1200));

    expect(result.endRequested).toBe(true);
    expect(providers.tts.requests).toEqual(['Thank you for calling, goodbye!']);
    expect(events.filter((e) => e.type === 'end-requested')).toHaveLength(1);
  });

  it('finds the token when the stream splits it across chunks and drops text after it', async () => {
    const providers = {
      ...createMockProviders({ stt: ['bye'] }),
      llm: new ScriptedLlm(['Goodbye and take care! END_CALL and some extra words'], { chunkChars: 3 }),
    };
    const { session } = build(providers);
    const result = await session.handleUtterance(speechPcm(1200));
    expect(result.endRequested).toBe(true);
    expect(providers.tts.requests.join(' ')).not.toMatch(/END|CALL|extra/);
  });
});

describe('one response per caller turn', () => {
  it('processes a redelivered utterance only once', async () => {
    const { session, providers } = build();
    const first = await session.handleUtterance(speechPcm(1200), 'same');
    const again = await session.handleUtterance(speechPcm(1200), 'same');
    expect(first.status).toBe('completed');
    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(providers.stt.calls).toHaveLength(1);
  });

  it('lets a newer utterance cancel the reply in progress, so only one reply is ever spoken', async () => {
    const providers = {
      stt: new ScriptedStt(['first thing', 'second thing']),
      llm: new ScriptedLlm(['Answer to the first. It goes on a while longer.', 'Answer to the second one.'], { delayMs: 60 }),
      tts: new ToneTts(),
    };
    const { session, sink } = build(providers);

    const first = session.handleUtterance(speechPcm(1200), 'a');
    await sleep(20); // the first turn is waiting for the LLM
    const second = session.handleUtterance(speechPcm(1200), 'b');
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.status).toBe('cancelled');
    expect(r2.status).toBe('completed');
    expect(providers.tts.requests).toEqual(['Answer to the second one.']);
    expect(sink.played).toHaveLength(1);
    expect(session.getHistory().filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(session.getHistory()[0]).toEqual({ role: 'user', content: 'first thing second thing' });
  });

  it('merges utterances that pile up while a turn is winding down into a single new turn', async () => {
    const providers = {
      stt: new ScriptedStt(['one', 'merged'], 40),
      llm: new ScriptedLlm(['A reply that takes a while to arrive.'], { delayMs: 10 }),
      tts: new ToneTts(),
    };
    const { session } = build(providers);
    const a = speechPcm(1200);
    const b = speechPcm(700);
    const c = speechPcm(800);

    const p1 = session.handleUtterance(a, 'a');
    await sleep(10);
    const p2 = session.handleUtterance(b, 'b');
    const p3 = session.handleUtterance(c, 'c');
    const results = await Promise.all([p1, p2, p3]);

    expect(results.map((r) => r.status)).toEqual(['cancelled', 'skipped', 'completed']);
    expect(results[1].reason).toBe('merged-into-newer-utterance');
    expect(providers.stt.calls).toHaveLength(2);
    expect(providers.stt.calls[1].bytes).toBe(b.length + c.length);
  });

  it('interrupt() stops speech that is being played and keeps only what was heard in the history', async () => {
    const providers = createMockProviders({
      stt: ['say something long'],
      llm: ['First sentence is spoken fully here. Second sentence never gets heard at all.'],
    });
    const sink = new CollectingAudioSink(FORMAT_8K, true, 50);
    const { session } = build(providers, {}, sink);

    const running = session.handleUtterance(speechPcm(1200), 'a');
    await sleep(70); // first sentence played, second one in flight
    session.interrupt();
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(session.getHistory().at(-1)).toEqual({ role: 'assistant', content: 'First sentence is spoken fully here.' });
    expect(sink.played).toHaveLength(1);
  });
});

describe('call ending while work is outstanding', () => {
  it.each([
    ['during STT', { stt: 80, llm: 0, tts: 0 }, 30],
    ['during the LLM request', { stt: 0, llm: 80, tts: 0 }, 30],
    ['during TTS', { stt: 0, llm: 0, tts: 80 }, 30],
  ])('close() %s cancels it, plays nothing and leaves nothing behind', async (_name, delays, closeAfter) => {
    const providers = createMockProviders({ delays });
    const { session, sink, events } = build(providers);

    const running = session.handleUtterance(speechPcm(1200), 'a');
    await sleep(closeAfter);
    const started = Date.now();
    await session.close('call-ended');
    const result = await running;

    expect(Date.now() - started).toBeLessThan(60); // cancelled, not waited out
    expect(result.status).toBe('cancelled');
    expect(sink.played).toHaveLength(0);
    expect(session.isClosed).toBe(true);
    expect(session.isBusy).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(await session.handleUtterance(speechPcm(1200), 'late')).toMatchObject({ status: 'skipped', reason: 'session-closed' });
  });

  it('close() during playback stops it', async () => {
    const sink = new CollectingAudioSink(FORMAT_8K, true, 500);
    const { session } = build(createMockProviders(), {}, sink);
    const running = session.handleUtterance(speechPcm(1200), 'a');
    await sleep(40);
    await session.close('call-ended');
    expect((await running).status).toBe('cancelled');
    expect(sink.played).toHaveLength(0);
  });

  it('close() is idempotent and safe on a session that never did anything', async () => {
    const { session } = build();
    await session.close('a');
    await session.close('b');
    expect(session.isClosed).toBe(true);
  });
});

describe('provider failures', () => {
  it('survives an STT failure: no LLM call, call-safe, error reported', async () => {
    const providers = createMockProviders({ stt: [new AiProviderError('deepgram', 'stt', 'HTTP 503: provider server error', { status: 503 })] });
    const { session, events } = build(providers);
    const result = await session.handleUtterance(speechPcm(1200));
    expect(result).toMatchObject({ status: 'failed', reason: 'stt-failed' });
    expect(providers.llm.requests).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', stage: 'stt' }));
    expect(session.getHistory()).toEqual([]);
  });

  it('keeps the caller\'s words when the LLM fails, so the next turn has context', async () => {
    const providers = createMockProviders({
      stt: ['my first question', 'are you there'],
      llm: [new AiProviderError('groq', 'llm', 'timed out after 8000 ms', { timedOut: true }), 'Yes I am here to help you.'],
    });
    const { session } = build(providers);
    expect((await session.handleUtterance(speechPcm(1200), 'a')).reason).toBe('llm-failed');
    expect((await session.handleUtterance(speechPcm(1200), 'b')).status).toBe('completed');
    expect(providers.llm.requests[1].messages[0].content).toBe('my first question are you there');
  });

  it('reports a TTS failure and does not call the sink with nothing', async () => {
    const providers = { ...createMockProviders({ stt: ['hello'] }), tts: new ToneTts(0, () => true) };
    const { session, sink, events } = build(providers);
    expect((await session.handleUtterance(speechPcm(1200))).reason).toBe('tts-failed');
    expect(sink.playCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', stage: 'tts' }));
  });

  it('stops answering after repeated failures, announces it once, and never throws', async () => {
    const providers = createMockProviders({ stt: [new Error('boom')] });
    const { session, events } = build(providers, { AI_MAX_CONSECUTIVE_FAILURES: '2' });
    await session.handleUtterance(speechPcm(1200), '1');
    expect(session.isDegraded).toBe(false);
    await session.handleUtterance(speechPcm(1200), '2');
    expect(session.isDegraded).toBe(true);
    expect(events.filter((e) => e.type === 'degraded')).toHaveLength(1);
    const calls = providers.stt.calls.length;
    expect(await session.handleUtterance(speechPcm(1200), '3')).toMatchObject({ status: 'skipped', reason: 'degraded' });
    expect(providers.stt.calls).toHaveLength(calls);
  });

  it('a success resets the failure count', async () => {
    const providers = createMockProviders({ stt: [new Error('x'), 'works now', new Error('x')] });
    const { session } = build(providers, { AI_MAX_CONSECUTIVE_FAILURES: '2' });
    await session.handleUtterance(speechPcm(1200), '1');
    await session.handleUtterance(speechPcm(1200), '2');
    await session.handleUtterance(speechPcm(1200), '3');
    expect(session.isDegraded).toBe(false);
  });

  it('turns an unexpected exception inside a provider into a failed turn, not a crash', async () => {
    const providers = createMockProviders();
    providers.stt.transcribe = (async () => {
      throw new TypeError('provider bug');
    }) as typeof providers.stt.transcribe;
    const { session } = build(providers);
    expect(await session.handleUtterance(speechPcm(1200))).toMatchObject({ status: 'failed' });
  });
});

describe('session isolation', () => {
  it('keeps two calls\' history, audio and totals apart', async () => {
    const a = build(createMockProviders({ stt: ['call A speaking'], llm: ['Reply for call A only.'] }));
    const b = build(createMockProviders({ stt: ['call B speaking'], llm: ['Reply for call B only.'] }));
    await Promise.all([a.session.handleUtterance(speechPcm(1200), 'x'), b.session.handleUtterance(speechPcm(1200), 'x')]);

    expect(a.session.getHistory()[0].content).toBe('call A speaking');
    expect(b.session.getHistory()[0].content).toBe('call B speaking');
    expect(a.providers.tts.requests).toEqual(['Reply for call A only.']);
    expect(b.providers.tts.requests).toEqual(['Reply for call B only.']);
    await a.session.close('done');
    expect(b.session.isClosed).toBe(false);
    expect(b.session.getHistory()).toHaveLength(2);
  });

  it('speaks a fixed greeting without calling the LLM', async () => {
    const { session, providers, sink } = build();
    expect((await session.say('Hello, how can I help?')).status).toBe('completed');
    expect(providers.llm.requests).toHaveLength(0);
    expect(providers.tts.requests).toEqual(['Hello, how can I help?']);
    expect(sink.played).toHaveLength(1);
    expect(session.getHistory().at(-1)).toBeUndefined(); // an assistant-only opening is not sent as a leading message
  });
});
