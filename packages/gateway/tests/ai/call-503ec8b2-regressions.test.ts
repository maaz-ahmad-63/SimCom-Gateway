import { describe, expect, it } from 'vitest';
import { playPcmPaced, playPcmStreamPaced } from '../../src/adapters/audio/paced-playback.js';
import { writeToPort, WritablePort } from '../../src/adapters/modem/serial-transport.js';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { openAiCompatibleSpec, LLM_CATALOG } from '../../src/ai/catalog.js';
import { SecretCipher } from '../../src/ai/secrets.js';
import { resetSyncIo, slowestSyncIo, timeSyncIo } from '../../src/core/sync-io-watch.js';
import { ContactDetails, parseSpokenDigits } from '../../src/ai/contact-details.js';
import { ConversationEvent, ConversationSession, TraceInput } from '../../src/ai/conversation.js';
import { OpenAiCompatibleLlm } from '../../src/ai/providers/llm.js';
import { createMockProviders, ScriptedLlm, ScriptedStt } from '../../src/ai/providers/mock.js';
import { DeepgramStreamingStt, WsLike } from '../../src/ai/providers/stt-stream.js';
import { SttStream } from '../../src/ai/providers/types.js';
import { delta, FORMAT_8K, fakeFetch, makeConfig, sleep, speechPcm, sse } from './helpers.js';

// Everything here comes from call 503ec8b2: 16 turns, two empty replies, "fallback" streams, a number asked for five times.

class FakeWs implements WsLike {
  readyState = 1;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onerror: WsLike['onerror'] = null;
  onclose: WsLike['onclose'] = null;
  readonly sent: Array<Buffer | string> = [];
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  serverSays(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
const finalResult = (text: string, fromFinalize: boolean) => ({ type: 'Results', is_final: true, from_finalize: fromFinalize, channel: { alternatives: [{ transcript: text }] } });
const openStream = (opts: { finalizeTimeoutMs?: number } = {}) => {
  const made: FakeWs[] = [];
  const stt = new DeepgramStreamingStt({ apiKey: 'k', model: 'nova-3', language: 'en', keyterms: [], finalizeTimeoutMs: opts.finalizeTimeoutMs ?? 2000, quietMs: 40, webSocketFactory: () => { const w = new FakeWs(); made.push(w); return w; } });
  const stream = stt.open(FORMAT_8K, new AbortController().signal);
  made[0].onopen?.();
  return { stream, ws: made[0] };
};

describe('Deepgram: a stream is not "finished" just because the server has been quiet', () => {
  it('waits for the server\'s answer to our Finalize instead of falling back after 300 ms of silence', async () => {
    const { stream, ws } = openStream();
    stream.push(Buffer.alloc(3200));
    let settled = false;
    const result = stream.finalize().then((r) => ((settled = true), r));
    await sleep(200); // several times the quiet period, with no answer from the server yet
    expect(settled).toBe(false); // used to resolve here with no words, be rejected, and send the audio to the batch provider
    ws.serverSays(finalResult('what time do you open', true));
    expect(await result).toEqual({ text: 'what time do you open' });
    expect(stream.finalizeOutcome).toMatchObject({ how: 'acknowledged', finals: 1 });
    stream.close();
  });

  it('still finishes when the server folded the Finalize into an answer it already sent', async () => {
    const { stream, ws } = openStream();
    ws.serverSays(finalResult('already final', false)); // finalized on its own, before our request
    expect(await stream.finalize()).toEqual({ text: 'already final' });
    expect(stream.finalizeOutcome?.how).toBe('quiet-after-reply');
    stream.close();
  });

  it('gives up at the bound, and says it timed out', async () => {
    const { stream } = openStream({ finalizeTimeoutMs: 90 });
    expect(await stream.finalize()).toBeNull();
    expect(stream.finalizeOutcome).toMatchObject({ how: 'timeout', finals: 0 });
    expect(stream.finalizeOutcome!.waitedMs).toBeGreaterThanOrEqual(80);
    stream.close();
  });
});

describe('the turn records exactly why the stream\'s words were not used', () => {
  const run = async (opts: { stream?: SttStream; withProvider: boolean }) => {
    const trace: TraceInput[] = [];
    const providers = { ...createMockProviders({ stt: ['what time do you open'] }), ...(opts.withProvider ? { sttStream: { name: 'deepgram-stream', open: () => opts.stream! } } : {}) };
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => trace.push(e) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1', opts.stream ? { stream: opts.stream } : undefined);
    const stt = trace.find((e) => e.stage === 'stt-result' && e.status === 'ok');
    return { result, data: stt?.data };
  };
  const stub = (over: Partial<SttStream> & { outcome?: SttStream['finalizeOutcome'] }): SttStream => ({
    push() {}, flush() {}, close() {}, interim: '', error: null, finalizeOutcome: over.outcome ?? null,
    finalize: async () => null,
    ...over,
  });

  it('a failed stream: the provider\'s error is in the telemetry and the batch provider answers', async () => {
    const { result, data } = await run({ withProvider: true, stream: stub({ error: new Error('the connection closed before the utterance was finalized'), outcome: { how: 'failed', waitedMs: 12, finals: 0 } }) });
    expect(result.status).toBe('completed');
    expect(result.metrics.sttMode).toBe('batch');
    expect(data).toMatchObject({ streaming: 'fallback', streamFinalize: 'failed' });
    expect(String(data?.streamFallbackReason)).toMatch(/the stream failed: the connection closed before the utterance was finalized \(finalize failed after 12 ms, 0 final segment/);
  });

  it('a stream that times out says so, with how long it waited', async () => {
    const { data } = await run({ withProvider: true, stream: stub({ outcome: { how: 'timeout', waitedMs: 1500, finals: 0 } }) });
    expect(String(data?.streamFallbackReason)).toMatch(/no final text from the stream \(finalize timeout after 1500 ms/);
  });

  it('a stream that returned no words for speech-like audio is not trusted, and says that', async () => {
    const { data } = await run({ withProvider: true, stream: stub({ finalize: async () => ({ text: '' }), outcome: { how: 'quiet-after-reply', waitedMs: 300, finals: 0 } }) });
    expect(String(data?.streamFallbackReason)).toMatch(/returned no words for audio that looks like speech/);
  });

  it('a good stream has no fallback reason, and an utterance with no stream open is not called a fallback', async () => {
    const good = await run({ withProvider: true, stream: stub({ finalize: async () => ({ text: 'what time do you open' }), outcome: { how: 'acknowledged', waitedMs: 260, finals: 1 } }) });
    expect(good.result.metrics.sttMode).toBe('stream');
    expect(good.data).toMatchObject({ streaming: 'final', streamFinalize: 'acknowledged', streamFinalizeMs: 260 });
    expect(good.data).not.toHaveProperty('streamFallbackReason');
    const none = await run({ withProvider: true });
    expect(none.data).toMatchObject({ streaming: 'not-opened' });
    expect(String(none.data?.streamFallbackReason)).toMatch(/no stream was open/);
    const off = await run({ withProvider: false });
    expect(off.data).toMatchObject({ streaming: 'off' });
    expect(off.data).not.toHaveProperty('streamFallbackReason');
  });
});

describe('an empty model reply is never spoken and never left waiting', () => {
  const turn = async (script: string[]) => {
    const llm = new ScriptedLlm(script);
    const providers = { ...createMockProviders({ stt: ['I need a website for my shop please'] }), llm };
    const sink = new CollectingAudioSink(FORMAT_8K);
    const events: ConversationEvent[] = [];
    const trace: TraceInput[] = [];
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink, emit: (e) => events.push(e), trace: (e) => trace.push(e) });
    const started = Date.now();
    const result = await session.handleUtterance(speechPcm(1200), 'u1');
    return { result, llm, providers, sink, events, trace, session, ms: Date.now() - started };
  };

  it('asks once more when the first reply is empty, then speaks the second', async () => {
    const t = await turn(['', 'Sure, we can build that. What will the shop sell?']);
    expect(t.llm.requests).toHaveLength(2);
    expect(t.result.status).toBe('completed');
    expect(t.result.metrics.llmEmptyReplies).toBe(1);
    expect(t.providers.tts.requests).toEqual(['Sure, we can build that.', 'What will the shop sell?']);
    const empty = t.trace.find((e) => e.stage === 'llm-response' && e.status === 'failed');
    expect(empty?.data).toMatchObject({ emptyReply: true, request: 1 });
    expect(empty?.detail).toMatch(/returned no reply text.*Asking once more/);
    expect(t.session.getHistory().filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('after two empty replies the turn fails with a clear reason, speaks nothing, and does not hang', async () => {
    const t = await turn(['', '']);
    expect(t.llm.requests).toHaveLength(2); // bounded: never a third request
    expect(t.result).toMatchObject({ status: 'failed', reason: 'llm-empty' });
    expect(t.providers.tts.requests).toHaveLength(0); // no speech from an empty response
    expect(t.sink.played).toHaveLength(0);
    expect(t.ms).toBeLessThan(2000);
    const last = t.trace.filter((e) => e.stage === 'llm-response' && e.status === 'failed').pop();
    expect(last?.detail).toMatch(/Nothing was spoken/);
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'error', stage: 'llm', message: expect.stringMatching(/no reply text/) }));
    expect(t.session.getHistory().filter((m) => m.role === 'assistant')).toHaveLength(0); // nothing is remembered as said
    expect(t.session.getHistory().some((m) => m.role === 'user')).toBe(true); // the caller's words are kept for the next turn
  });

  it('says why when the model ran out of tokens, and the next turn works normally', async () => {
    const llm: import('../../src/ai/providers/types.js').LlmProvider = {
      name: 'reasoner',
      async *stream() {
        yield { usage: { promptTokens: 1400, completionTokens: 220, totalTokens: 1620 }, finishReason: 'length' };
      },
    };
    const trace: TraceInput[] = [];
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers: { ...createMockProviders(), llm }, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => trace.push(e) });
    expect((await session.handleUtterance(speechPcm(1200), 'u1')).reason).toBe('llm-empty');
    expect(trace.find((e) => e.status === 'failed' && e.stage === 'llm-response')?.detail).toMatch(/token budget ran out before any reply text.*220 completion tokens/);
  });

  it('gives a reasoning model room to think: low effort, and the reasoning does not eat the reply budget', async () => {
    const spec = openAiCompatibleSpec(LLM_CATALOG.groq_gpt_oss_120b, {})!;
    expect(spec.body).toMatchObject({ reasoning_effort: 'low' });
    const { impl, requests } = fakeFetch([sse([delta('Okay.'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])]);
    const llm = new OpenAiCompatibleLlm({ spec, apiKey: 'k', fetchImpl: impl, firstTokenTimeoutMs: 1000, totalTimeoutMs: 1000, maxRetries: 0, maxTokens: 220 });
    for await (const chunk of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) void chunk;
    expect(JSON.parse(requests[0].body as string)).toMatchObject({ max_tokens: 220 + 1024, reasoning_effort: 'low' });
    // Settable, validated, and the allowance can be turned off.
    expect(openAiCompatibleSpec(LLM_CATALOG.groq_gpt_oss_120b, { AI_LLM_REASONING_EFFORT: 'medium', AI_LLM_REASONING_TOKENS: '0' })).toMatchObject({ body: { reasoning_effort: 'medium' }, reasoningTokenAllowance: 0 });
    expect(() => openAiCompatibleSpec(LLM_CATALOG.groq_gpt_oss_120b, { AI_LLM_REASONING_EFFORT: 'extreme' })).toThrow(/low.*medium.*high/);
    expect(() => openAiCompatibleSpec(LLM_CATALOG.groq_gpt_oss_120b, { AI_LLM_REASONING_TOKENS: '-1' })).toThrow(/whole number/);
    // A model that does not reason is untouched.
    expect(openAiCompatibleSpec(LLM_CATALOG.groq_qwen_3_8_27b, {})?.reasoningTokenAllowance).toBeUndefined();
  });
});

describe('interruption still works with the new reply handling', () => {
  it('cancels at once, plays nothing stale, and does not retry the model after the caller spoke', async () => {
    const llm = new ScriptedLlm(['First sentence of a long reply goes here. Second sentence of the reply goes here. Third sentence follows.'], { chunkChars: 10, delayMs: 20 });
    const providers = { ...createMockProviders({ stt: ['tell me everything about your services'] }), llm };
    const sink = new CollectingAudioSink(FORMAT_8K, true, 60);
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink });
    const turn = session.handleUtterance(speechPcm(1200), 'u1');
    while (sink.playCalls < 1) await sleep(5);
    session.interrupt('caller-speech');
    const result = await turn;
    const spoken = sink.played.length;
    await sleep(120);
    expect(result).toMatchObject({ status: 'cancelled', cancelSource: 'caller-speech' });
    expect(sink.played.length).toBe(spoken);
    expect(llm.requests).toHaveLength(1); // an interruption is not an "empty reply": no second request
  });

  it('an interruption before any reply text is a cancellation, not an empty-reply failure', async () => {
    const llm = new ScriptedLlm([''], { delayMs: 80 });
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers: { ...createMockProviders(), llm }, sink: new CollectingAudioSink(FORMAT_8K) });
    const turn = session.handleUtterance(speechPcm(1200), 'u1');
    await sleep(30);
    session.interrupt('caller-speech');
    expect(await turn).toMatchObject({ status: 'cancelled' });
    expect(llm.requests.length).toBeLessThanOrEqual(1);
  });
});

describe('contact collection: what the caller already said is kept, and the number is never guessed', () => {
  it('reads spoken digits exactly as heard, marking an unclear one instead of inventing it', () => {
    expect(parseSpokenDigits("Yes. It's six two eight eight. Zero eight... Eight. Zero one nine eight.")).toMatchObject({ digits: '62880880198', known: 11, unclear: 0 });
    expect(parseSpokenDigits('Six three e eight. Zero eight zero one nine eight.')).toEqual({ digits: '63?8080198', known: 9, unclear: 1 }); // the unclear token keeps its place as a ?
    expect(parseSpokenDigits('nine eight double seven six five four three two one')?.digits).toBe('98776543' + '21'); // "double seven" is 77
    expect(parseSpokenDigits('call 9876543210 please')?.digits).toBe('9876543210');
    expect(parseSpokenDigits('I need two websites and three logos')).toBeNull(); // a few numbers in a sentence are not a phone number
    expect(parseSpokenDigits('Hello?')).toBeNull();
  });

  it('keeps one candidate, asks for a read-back, and only confirms on a yes after the read-back', () => {
    const c = new ContactDetails();
    c.noteCaller('My name is Maza.');
    c.noteCaller('It is nine eight seven six five four three two one zero');
    expect(c.snapshot).toMatchObject({ name: 'Maza', phone: { heard: '9876543210', confirmed: false, readBack: false } });
    expect(c.promptBlock()).toMatch(/name: Maza/);
    expect(c.promptBlock()).toMatch(/NOT confirmed\. Read these digits back once.*Do not ask for it again from the start/);
    c.noteCaller('yes'); // a yes before any read-back confirms nothing
    expect(c.snapshot.phone?.confirmed).toBe(false);
    c.noteAgent('Let me read that back: 9 8 7, 6 5 4, 3 2 1 0. Is that right?');
    expect(c.snapshot.phone?.readBack).toBe(true);
    expect(c.promptBlock()).toMatch(/wait for the caller to confirm or correct it/);
    c.noteCaller('Yes, that is correct.');
    expect(c.snapshot.phone?.confirmed).toBe(true);
    expect(c.promptBlock()).toMatch(/confirmed by the caller\. Do not ask for it again/);
  });

  it('a repeated number is counted, not re-collected, and a correction replaces it without being confirmed', () => {
    const c = new ContactDetails();
    c.noteCaller('six two eight eight zero eight zero one nine eight');
    c.noteCaller('six two eight eight zero eight zero one nine eight');
    expect(c.snapshot.phone).toMatchObject({ heard: '6288080198', times: 2 });
    expect(c.promptBlock()).toMatch(/already said this number 2 times: do not ask them to repeat it/);
    c.noteAgent('Reading it back: six two eight eight, zero eight zero, one nine eight. Correct?');
    c.noteCaller('No, it is six two eight eight zero eight zero one nine nine');
    expect(c.snapshot.phone).toMatchObject({ heard: '6288080199', confirmed: false, readBack: false });
  });

  it('an unclear digit is asked about on its own, and the number is not read back as if complete', () => {
    const c = new ContactDetails();
    c.noteCaller('six three e eight zero eight zero one nine eight');
    expect(c.snapshot.phone).toMatchObject({ unclear: 1, confirmed: false });
    expect(c.promptBlock()).toMatch(/digit shown as \? was not clear: ask only about that part/);
    c.noteAgent('6 3 ? 8 0 8 0 1 9 8');
    expect(c.snapshot.phone?.readBack).toBe(false); // a read-back with a gap in it is not a read-back
  });

  it('puts the block in this call\'s system prompt every turn, so the number is not asked for again', async () => {
    const providers = createMockProviders({ stt: ['my name is Maza', 'it is nine eight seven six five four three two one zero', 'yes that is right'], llm: ['Nice to meet you, Maza. What is your phone number?', 'Let me read that back: 9 8 7, 6 5 4, 3 2 1 0. Is that right?', 'Thanks. And your email address?'] });
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K) });
    for (const id of ['a', 'b', 'c']) await session.handleUtterance(speechPcm(1200), id);
    const systems = providers.llm.requests.map((r) => r.system);
    expect(systems[0]).toMatch(/name: Maza/); // what the caller said this turn is already known to this turn's reply
    expect(systems[0]).not.toMatch(/phone number/);
    expect(systems[1]).toMatch(/name: Maza/);
    expect(systems[1]).toMatch(/phone number: heard as 9 8 7 6 5 4 3 2 1 0.*NOT confirmed/);
    expect(systems[2]).toMatch(/confirmed by the caller\. Do not ask for it again/); // read back in turn 2, agreed in turn 3
    expect(systems[2]).toMatch(/Ask only for details that are still missing or unconfirmed, one question per turn/);
    // It is switched off with AI_CONTACT_DETAILS=false, and then the prompt is exactly what it was.
    const off = createMockProviders({ stt: ['my name is Maza'], llm: ['Nice to meet you.'] });
    const plain = new ConversationSession({ callId: 'c', config: makeConfig({ AI_CONTACT_DETAILS: 'false' }), providers: off, sink: new CollectingAudioSink(FORMAT_8K) });
    await plain.handleUtterance(speechPcm(1200), 'a');
    await plain.handleUtterance(speechPcm(1200), 'b');
    expect(off.llm.requests[1].system).not.toMatch(/CALL DETAILS/);
  });
});

describe('playback scheduling and the audio port', () => {
  it('a port write waits for the device to drain by default (every port, the audio port included: that wait bounds stale audio after a barge-in); skipping it is an explicit switch that nothing uses', async () => {
    const order: string[] = [];
    const port: WritablePort = {
      write: (_d, cb) => { order.push('write'); setTimeout(() => cb(null), 1); },
      drain: (cb) => { order.push('drain'); setTimeout(() => cb(null), 60); },
    };
    const fail = (e: Error) => e;
    const t0 = Date.now();
    await writeToPort(port, Buffer.alloc(320), true, fail); // the default, for AT commands and audio frames alike
    expect(order).toEqual(['write', 'drain']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55); // not done until the device took it: the bound on queued audio
    order.length = 0;
    const t1 = Date.now();
    await writeToPort(port, Buffer.alloc(320), false, fail); // the explicit experiment switch (off everywhere today)
    expect(order).toEqual(['write']);
    expect(Date.now() - t1).toBeLessThan(40);
    await expect(writeToPort({ write: (_d, cb) => cb(new Error('boom')), drain: (cb) => cb(null) }, 'x', true, (e, what) => new Error(`${what}: ${e.message}`))).rejects.toThrow('write: boom');
  });

  it('times every write, so a slow port and a stalled loop are told apart in the telemetry', async () => {
    let n = 0;
    const result = await playPcmPaced(async () => { if (++n % 5 === 0) await sleep(30); }, speechPcm(400), { sampleRate: 8000 });
    expect(result.slowWrites).toBeGreaterThanOrEqual(2); // writes slower than one 20 ms frame
    expect(result.maxWriteMs).toBeGreaterThanOrEqual(25);
    const fast = await playPcmPaced(async () => {}, speechPcm(200), { sampleRate: 8000 });
    expect(fast.slowWrites).toBe(0);
    expect(fast.maxWriteMs).toBeLessThan(15);
  });

  it('keeps real-time pacing on absolute deadlines when the source delivers in bursts, and reports the gap it could not hide', async () => {
    async function* bursts() {
      const frame = speechPcm(2000);
      yield frame.subarray(0, 4800); // 150 ms
      await sleep(260); // the network stalls longer than the write-ahead
      yield frame.subarray(4800, 16000);
    }
    const written: number[] = [];
    const started = Date.now();
    const result = await playPcmStreamPaced(async (c) => void written.push(Date.now() - started + c.length * 0), bursts(), { sampleRate: 8000, prerollMs: 100 });
    expect(result.underruns).toBe(1); // counted, not hidden
    expect(result.bytesWritten).toBe(16000);
    // After the stall frames resume at 20 ms spacing, not in a burst that would play fast.
    const after = written.slice(-6);
    const gaps = after.slice(1).map((t, i) => t - after[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10);
  });

  it('stops within one frame when the caller interrupts (barge-in), however much is queued', async () => {
    let frames = 0;
    const stopAfter = 5;
    const result = await playPcmPaced(async () => void frames++, speechPcm(3000), { sampleRate: 8000, shouldStop: () => (frames >= stopAfter ? 'aborted' : null) });
    expect(result.stoppedBy).toBe('aborted');
    expect(frames).toBe(stopAfter);
  });

  it('reports a first-audio latency and the playback duration as separate figures on the turn', async () => {
    const trace: TraceInput[] = [];
    const providers = createMockProviders({ stt: ['what do you do'], llm: ['We build software and run IT for small firms. Would you like a call back?'] });
    const sink = new CollectingAudioSink(FORMAT_8K, true, 80); // each sentence "plays" for 80 ms
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink, trace: (e) => trace.push(e) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { speechEndedAt: performance.now() - 700, endpointedAt: performance.now() - 40 });
    const t = result.metrics.timeline!;
    expect(result.status).toBe('completed');
    expect(t.firstAudioLatencyMs).toBe(t.firstWriteMs);
    // Stages in the order they happen, from the end of the caller's speech: stt done, first token, model done, first audio, playback done.
    const order = [t.sttDoneMs, t.llmFirstTokenMs, t.llmDoneMs, t.firstWriteMs, t.playbackDoneMs].map((v) => v as number);
    for (const v of order) expect(v).not.toBeNull();
    expect(order[0]).toBeLessThanOrEqual(order[1]);
    expect(order[1]).toBeLessThanOrEqual(order[2]);
    expect(order[3]).toBeLessThanOrEqual(order[4]);
    expect(t.playbackMs).toBe(order[4] - order[3]); // the time spent speaking is not part of the wait
    expect(t.playbackMs).toBeGreaterThanOrEqual(0);
    const summary = trace.find((e) => e.stage === 'call' && e.data && 'firstAudioLatencyMs' in e.data);
    expect(summary?.data).toMatchObject({ firstAudioLatencyMs: t.firstWriteMs, playbackMs: t.playbackMs, maxWriteMs: expect.any(Number), loopLagMaxMs: null });
  });

  it('a turn that played nothing still reports where its time went, with no invented first-audio figure', async () => {
    const trace: TraceInput[] = [];
    const providers = { ...createMockProviders({ stt: ['I need a website'] }), llm: new ScriptedLlm(['', '']) };
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => trace.push(e) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { speechEndedAt: performance.now() - 700 });
    expect(result.metrics.timeline).toMatchObject({ firstWriteMs: null, firstAudioLatencyMs: null, playbackMs: null });
    expect(result.metrics.perceivedFirstAudioMs).toBeNull();
    const summary = trace.find((e) => e.stage === 'call' && /No audio was played/.test(e.detail ?? ''));
    expect(summary?.detail).toMatch(/failed: llm-empty/);
  });
});

describe('the scripted STT with a streaming provider still does not double-transcribe', () => {
  it('a final from the stream means the batch provider is never called', async () => {
    const batch = new ScriptedStt(['batch words']);
    const stream: SttStream = { push() {}, flush() {}, close() {}, interim: '', error: null, finalize: async () => ({ text: 'stream words' }), finalizeOutcome: { how: 'acknowledged', waitedMs: 250, finals: 1 } };
    const providers = { ...createMockProviders(), stt: batch };
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K) });
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream });
    expect(result.metrics.sttMode).toBe('stream');
    expect(batch.calls).toHaveLength(0);
  });
});

describe('what stalls the loop is named, not guessed', () => {
  it('a key that cannot be decrypted is not re-derived on every dashboard poll', () => {
    const blob = new SecretCipher('the-master-key-it-was-saved-with').encrypt('provider-key-value-1234');
    const now = new SecretCipher('a-different-master-key-entirely');
    const first = Date.now();
    expect(() => now.decrypt(blob)).toThrow(/could not be decrypted/);
    const firstMs = Date.now() - first;
    const again = Date.now();
    for (let i = 0; i < 200; i++) expect(() => now.decrypt(blob)).toThrow(/could not be decrypted/); // every poll, for every stored key
    const repeatMs = Date.now() - again;
    expect(firstMs).toBeGreaterThanOrEqual(20); // one real attempt (scrypt is deliberately slow)
    expect(repeatMs).toBeLessThan(Math.max(150, firstMs * 2)); // 200 more would have been ~11 s of blocked loop
    expect(new SecretCipher('the-master-key-it-was-saved-with').decrypt(blob)).toBe('provider-key-value-1234'); // the right key still works
  });

  it('records the slowest synchronous operation and what it was, and starts clean each turn', () => {
    resetSyncIo();
    expect(slowestSyncIo()).toEqual({ ms: 0, label: null });
    timeSyncIo('quick', () => 1);
    timeSyncIo('call recording write', () => { const end = Date.now() + 25; while (Date.now() < end); });
    expect(slowestSyncIo().label).toBe('call recording write');
    expect(slowestSyncIo().ms).toBeGreaterThanOrEqual(20);
    expect(timeSyncIo('returns what it runs', () => 42)).toBe(42);
    expect(() => timeSyncIo('throws', () => { throw new Error('x'); })).toThrow('x'); // timing never swallows an error
    resetSyncIo();
    expect(slowestSyncIo().label).toBeNull();
  });

  it('puts it on the turn: loop stall, garbage collection, port write time and the slow synchronous operation, side by side', async () => {
    const trace: TraceInput[] = [];
    const providers = createMockProviders({ stt: ['what do you do'], llm: ['We build software for small firms every day.'] });
    const sink = new (class extends CollectingAudioSink {
      override async play(pcm: Buffer, signal: AbortSignal) {
        timeSyncIo('call recording write', () => { const end = Date.now() + 30; while (Date.now() < end); }); // a synchronous write during playback
        return { ...(await super.play(pcm, signal)), maxWriteMs: 12, slowWrites: 1 };
      }
    })(FORMAT_8K);
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink, trace: (e) => trace.push(e), loopLag: { reset() {}, maxMs: () => 41, gcMaxMs: () => 7, stop() {} } });
    const result = await session.handleUtterance(speechPcm(1200), 'u1', { speechEndedAt: performance.now() - 700 });
    expect(result.metrics).toMatchObject({ loopLagMaxMs: 41, gcMaxMs: 7, syncIoLabel: 'call recording write', maxWriteMs: 12 });
    expect(result.metrics.syncIoMaxMs).toBeGreaterThanOrEqual(25);
    const summary = trace.find((e) => e.stage === 'call' && e.data && 'syncIoLabel' in e.data);
    expect(summary?.data).toMatchObject({ loopLagMaxMs: 41, gcMaxMs: 7, syncIoLabel: 'call recording write', maxWriteMs: 12 });
  });

  it('a stream that was not used is explained in the timeline text, the metrics, and not at all when it was used', async () => {
    const run = async (finalize: SttStream['finalize']) => {
      const trace: TraceInput[] = [];
      const stream: SttStream = { push() {}, flush() {}, close() {}, interim: '', error: null, finalize, finalizeOutcome: { how: 'timeout', waitedMs: 1500, finals: 0 } };
      const providers = { ...createMockProviders({ stt: ['what time do you open'] }), sttStream: { name: 'deepgram-stream', open: () => stream } };
      const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => trace.push(e) });
      const result = await session.handleUtterance(speechPcm(1200), 'u1', { stream });
      return { trace, result };
    };
    const fell = await run(async () => null);
    expect(fell.trace.find((e) => e.stage === 'stt-result' && e.status === 'ok')?.detail).toMatch(/^Speech-to-text stream not used: no final text from the stream \(finalize timeout after 1500 ms/);
    expect(fell.result.metrics.sttFallbackReason).toMatch(/no final text from the stream/);
    const used = await run(async () => ({ text: 'what time do you open' }));
    expect(used.trace.find((e) => e.stage === 'stt-result' && e.status === 'ok')?.detail).toBeUndefined();
    expect(used.result.metrics.sttFallbackReason).toBeNull();
  });
});
