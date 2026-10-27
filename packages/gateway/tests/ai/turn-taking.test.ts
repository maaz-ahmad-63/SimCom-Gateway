import { describe, expect, it, vi } from 'vitest';
import { CollectingAudioSink, PlayResult } from '../../src/ai/audio.js';
import { ConversationSession, TraceInput, TurnResult } from '../../src/ai/conversation.js';
import { KNOWLEDGE_RULES, KnowledgeProvider } from '../../src/ai/knowledge.js';
import { ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { AiProviderError, ProviderSet } from '../../src/ai/providers/types.js';
import { FORMAT_8K, makeConfig, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

const S1 = 'This is the first full sentence here.';
const S2 = 'This is the second full sentence here.';
const S3 = 'This is the third full sentence here.';

/** A sink that plays a stream in real time and reports exactly how much went out before it was stopped. */
class RealtimeSink extends CollectingAudioSink {
  firstWriteAt = 0;
  async playStream(chunks: AsyncIterable<Buffer>, abort: AbortSignal, hooks?: { onFirstWrite?: () => void }): Promise<PlayResult> {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of chunks) {
      if (abort.aborted) return { bytesWritten: bytes, completed: false, stoppedBy: 'aborted' };
      if (parts.length === 0) {
        this.firstWriteAt = performance.now();
        hooks?.onFirstWrite?.();
      }
      parts.push(chunk);
      bytes += chunk.length;
      await sleep((chunk.length / 2 / 8000) * 1000); // playing takes as long as the audio lasts
      if (abort.aborted) return { bytesWritten: bytes, completed: false, stoppedBy: 'aborted' };
    }
    this.played.push(Buffer.concat(parts));
    return { bytesWritten: bytes, completed: true, stoppedBy: null };
  }
}

function make(over: {
  stt?: ScriptedStt;
  llm?: ScriptedLlm;
  tts?: ToneTts;
  sink?: CollectingAudioSink;
  env?: Record<string, string | undefined>;
  knowledge?: KnowledgeProvider | null;
} = {}) {
  const providers: ProviderSet & { stt: ScriptedStt; llm: ScriptedLlm; tts: ToneTts } = {
    stt: over.stt ?? new ScriptedStt(['hello there']),
    llm: over.llm ?? new ScriptedLlm([`${S1} ${S2}`]),
    tts: over.tts ?? new ToneTts(0, () => false, { chunkMs: 100 }),
  };
  const sink = over.sink ?? new RealtimeSink(FORMAT_8K, true);
  const traces: TraceInput[] = [];
  const results: TurnResult[] = [];
  const s = new ConversationSession({
    callId: 'call-1',
    config: makeConfig(over.env ?? {}),
    providers,
    sink,
    trace: (t) => traces.push(t),
    emit: (e) => e.type === 'turn' && results.push(e.result),
    knowledge: over.knowledge,
  });
  return { s, providers, sink, traces, results };
}

describe('the turn timeline', () => {
  it('measures first audio from the moment the caller stopped talking, and orders every stage', async () => {
    const { s, traces } = make({ stt: new ScriptedStt(['hello there'], 120), llm: new ScriptedLlm([`${S1}`], { delayMs: 40 }), tts: new ToneTts(30, () => false, { chunkMs: 100 }) });
    const now = performance.now();
    // The endpointer reports that speech ended 650 ms ago and it decided 5 ms ago, i.e. it waited out ~645 ms of silence.
    const result = await s.handleUtterance(speechPcm(1200), 'u1', { speechEndedAt: now - 650, endpointedAt: now - 5 });
    const { timeline: t, perceivedFirstAudioMs: perceived } = result.metrics;
    expect(t).not.toBeNull();
    expect(t!.endpointMs).toBe(645);
    // Stages happen in pipeline order, all measured from the end of speech.
    expect(t!.turnStartMs!).toBeGreaterThanOrEqual(645);
    expect(t!.sttDoneMs!).toBeGreaterThanOrEqual(t!.turnStartMs! + 100);
    expect(t!.llmFirstTokenMs!).toBeGreaterThan(t!.sttDoneMs!);
    expect(t!.ttsFirstAudioMs!).toBeGreaterThan(t!.llmFirstTokenMs!);
    expect(t!.firstWriteMs!).toBeGreaterThanOrEqual(t!.ttsFirstAudioMs!);
    expect(t!.turnEndMs!).toBeGreaterThan(t!.firstWriteMs!);
    // What the caller waited includes the silence that came before the turn, which firstAudioMs alone leaves out.
    expect(perceived).toBe(t!.firstWriteMs);
    expect(perceived!).toBeGreaterThan(result.metrics.firstAudioMs! + 600);
    // And it is stated, in plain words, in the call events.
    const line = traces.find((x) => x.stage === 'call' && /First audio written/.test(x.detail ?? ''));
    expect(line?.detail).toMatch(/after the caller stopped talking/);
    expect(line?.detail).toMatch(/not proven heard/);
    expect(line?.data).toMatchObject({ perceivedFirstAudioMs: perceived, speculativeStt: false });
  });

  it('is measured from the start of the turn when the endpointer gave no speech-end time, and says so', async () => {
    const { s, traces } = make();
    const result = await s.handleUtterance(speechPcm(1200), 'u1');
    expect(result.metrics.perceivedFirstAudioMs).toBeNull();
    expect(result.metrics.timeline?.firstWriteMs).not.toBeNull();
    expect(traces.find((x) => /after the turn began/.test(x.detail ?? ''))).toBeDefined();
  });

  it('has no first-audio time for a turn that never spoke', async () => {
    const { s } = make();
    const result = await s.handleUtterance(noiseFloorPcm(1500), 'u1', { speechEndedAt: performance.now() - 100, endpointedAt: performance.now() });
    expect(result.status).toBe('skipped');
    expect(result.metrics.timeline?.firstWriteMs).toBeNull();
    expect(result.metrics.perceivedFirstAudioMs).toBeNull();
  });
});

describe('speculative transcription', () => {
  it('reuses the transcript requested during the pause, so the turn does not wait for a second request', async () => {
    const { s, providers, traces } = make({ stt: new ScriptedStt(['What time do you close?'], 160) });
    const pcm = speechPcm(1500);
    s.beginSpeculative(pcm, 7);
    await sleep(130); // the rest of the silence wait: the request is almost done
    const result = await s.handleUtterance(pcm, 'u1', { speculativeId: 7 });
    expect(result.status).toBe('completed');
    expect(providers.stt.calls).toHaveLength(1); // one request, not two
    expect(result.metrics.speculativeStt).toBe(true);
    expect(result.metrics.sttMs!).toBeGreaterThanOrEqual(150); // the provider's own latency
    expect(result.metrics.sttWaitedMs!).toBeLessThan(result.metrics.sttMs! - 60); // mostly hidden behind the silence
    expect(providers.llm.requests[0].messages.at(-1)).toEqual({ role: 'user', content: 'What time do you close?' });
    expect(traces.find((t) => t.stage === 'stt-submit')?.data).toMatchObject({ speculative: true });
    expect(traces.find((t) => t.stage === 'stt-result')?.data).toMatchObject({ speculative: true });
  });

  it('is withdrawn when the caller carries on: the turn transcribes the whole utterance afresh', async () => {
    const { s, providers } = make({ stt: new ScriptedStt(['only the first half', 'the whole sentence this time'], 20) });
    s.beginSpeculative(speechPcm(800), 1);
    s.cancelSpeculative(1);
    const result = await s.handleUtterance(speechPcm(1800), 'u1', { speculativeId: 1 });
    expect(providers.stt.calls).toHaveLength(2);
    expect(result.metrics.speculativeStt).toBe(false);
    expect(providers.llm.requests[0].messages.at(-1)?.content).toBe('the whole sentence this time');
  });

  it('is ignored when it belongs to a different pause, and when it failed', async () => {
    const mismatch = make({ stt: new ScriptedStt(['stale words', 'fresh words'], 10) });
    mismatch.s.beginSpeculative(speechPcm(900), 3);
    await mismatch.s.handleUtterance(speechPcm(1500), 'u1', { speculativeId: 99 });
    expect(mismatch.providers.llm.requests[0].messages.at(-1)?.content).toBe('fresh words');

    const failing = make({ stt: new ScriptedStt([new AiProviderError('stt', 'stt', 'rate limited'), 'recovered text'], 10) });
    failing.s.beginSpeculative(speechPcm(900), 4);
    const result = await failing.s.handleUtterance(speechPcm(1500), 'u1', { speculativeId: 4 });
    expect(result.status).toBe('completed'); // the speculative failure is not the turn's failure
    expect(failing.providers.llm.requests[0].messages.at(-1)?.content).toBe('recovered text');
  });

  it('never starts a turn by itself, and does not pay for audio that is only silence', async () => {
    const { s, providers, results } = make({ stt: new ScriptedStt(['hello there'], 10) });
    s.beginSpeculative(speechPcm(1000), 1);
    s.beginSpeculative(speechPcm(1200), 2); // a newer pause replaces the older request
    s.beginSpeculative(noiseFloorPcm(1000), 3);
    await sleep(120);
    expect(results).toHaveLength(0);
    expect(providers.llm.requests).toHaveLength(0);
    expect(providers.stt.calls).toHaveLength(2); // the silent one was never sent
    expect(await s.speculativeText(2)).toBe('hello there');
    expect(await s.speculativeText(1)).toBeNull(); // replaced
  });

  it('produces exactly one reply per utterance even when it is delivered twice or twice speculated', async () => {
    const { s, providers, results } = make({ stt: new ScriptedStt(['What are your hours?'], 10) });
    const pcm = speechPcm(1500);
    s.beginSpeculative(pcm, 1);
    const first = await s.handleUtterance(pcm, 'same-id', { speculativeId: 1 });
    const second = await s.handleUtterance(pcm, 'same-id', { speculativeId: 1 });
    expect(first.status).toBe('completed');
    expect(second).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(providers.llm.requests).toHaveLength(1);
    expect(results.filter((r) => r.status === 'completed')).toHaveLength(1);
  });
});

describe('interruption and the history that follows it', () => {
  it('keeps one assistant message per reply, never one per sentence', async () => {
    const { s } = make({ llm: new ScriptedLlm([`${S1} ${S2} ${S3}`]) });
    await s.handleUtterance(speechPcm(1200), 'u1');
    const history = s.getHistory();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[1].content).toBe(`${S1} ${S2} ${S3}`);
  });

  it('records only what was actually spoken when the caller cuts the reply off, and marks it unfinished', async () => {
    const tts = new ToneTts(0, () => false, { chunkMs: 100, gapMs: 20 });
    const { s, sink } = make({ llm: new ScriptedLlm([`${S1} ${S2} ${S3}`]), tts });
    const turn = s.handleUtterance(speechPcm(1200), 'u1');
    await vi.waitFor(() => expect((sink as RealtimeSink).played.length).toBe(1), { timeout: 4000 }); // sentence one finished
    await sleep(450); // about half of the second
    s.interrupt();
    const result = await turn;
    expect(result.status).toBe('cancelled');
    const assistant = s.getHistory().filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content.startsWith(S1)).toBe(true);
    expect(assistant[0].content.endsWith('…')).toBe(true);
    expect(assistant[0].content).not.toContain(S2); // the second was only partly said
    expect(assistant[0].content).not.toContain(S3); // the third never started
    const partial = assistant[0].content.slice(S1.length + 1, -1);
    expect(partial.length).toBeGreaterThan(5);
    expect(S2.startsWith(partial)).toBe(true); // a true prefix of what was being said
  });

  it('stops queued speech and the stale generation, and answers only the newest utterance', async () => {
    const tts = new ToneTts(0, () => false, { chunkMs: 100, gapMs: 20 });
    const stt = new ScriptedStt(['first question', 'second question']);
    const llm = new ScriptedLlm([`${S1} ${S2} ${S3}`, 'A short answer to the second question.']);
    const { s, sink, results } = make({ stt, llm, tts });
    const first = s.handleUtterance(speechPcm(1200), 'u1');
    await vi.waitFor(() => expect((sink as RealtimeSink).played.length).toBe(1), { timeout: 4000 });
    const second = await s.handleUtterance(speechPcm(1200), 'u2'); // the caller talks over the agent
    expect((await first).status).toBe('cancelled');
    expect(second.status).toBe('completed');
    // Sentences are synthesized ahead while the first plays, but nothing queued behind the interruption was ever played.
    expect((sink as RealtimeSink).played).toHaveLength(2); // sentence one of the old reply, and the new answer
    expect(Buffer.concat((sink as RealtimeSink).played).length).toBeLessThan(2 * 8000 * 2 * 2);
    const history = s.getHistory();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history.at(-1)?.content).toBe('A short answer to the second question.');
    expect(results.filter((r) => r.status === 'completed')).toHaveLength(1);
  });

  it('merges what was said before and after an interruption that got no reply into one caller message', async () => {
    const { s } = make({ stt: new ScriptedStt(['I need a chatbot', 'for my website']), llm: new ScriptedLlm(['Okay, tell me more about it please.']) });
    const first = s.handleUtterance(speechPcm(1200), 'u1', undefined);
    s.interrupt(); // cancelled before it could answer
    await first;
    await s.handleUtterance(speechPcm(1200), 'u2');
    const users = s.getHistory().filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('I need a chatbot for my website');
  });

  it('does not answer the agent’s own voice when an "interruption" turns out to be its echo', async () => {
    const reply = 'We can build a website chatbot for your startup.';
    const { s, providers } = make({ stt: new ScriptedStt(['hello there', 'we can build a website chatbot for your startup', 'build a website chatbot', 'I actually need something different']), llm: new ScriptedLlm([reply, 'Sure, tell me more.', 'Alright then.']) });
    await s.handleUtterance(speechPcm(1200), 'u1');
    const echoed = await s.handleUtterance(speechPcm(1500), 'u2', { afterBargeIn: true });
    expect(echoed).toMatchObject({ status: 'skipped', reason: 'echo' });
    expect(providers.llm.requests).toHaveLength(1); // the agent did not respond to itself
    // A real, short repeat of one of its phrases is not mistaken for echo, and neither is a different sentence.
    expect((await s.handleUtterance(speechPcm(1500), 'u3', { afterBargeIn: true })).status).toBe('completed');
    expect((await s.handleUtterance(speechPcm(1500), 'u4', { afterBargeIn: true })).status).toBe('completed');
  });

  it('only applies the echo check to utterances that began as an interruption', async () => {
    const { s } = make({ stt: new ScriptedStt(['hello there', 'we can build a website chatbot for your startup']), llm: new ScriptedLlm(['We can build a website chatbot for your startup.', 'Great.']) });
    await s.handleUtterance(speechPcm(1200), 'u1');
    expect((await s.handleUtterance(speechPcm(1500), 'u2')).status).toBe('completed'); // an ordinary turn is never dropped
  });

  it('lets the session listen again at once after an interruption instead of waiting out the guard', async () => {
    const { s } = make({ env: { AI_HALF_DUPLEX: 'true', AI_PLAYBACK_GUARD_MS: '2500' }, tts: new ToneTts(0, () => false, { chunkMs: 100, gapMs: 20 }) });
    const turn = s.handleUtterance(speechPcm(1200), 'u1');
    await vi.waitFor(() => expect(s.isDeaf()).toBe(true));
    s.interrupt();
    s.resumeListening();
    await turn;
    expect(s.isDeaf()).toBe(false);
  });
});

describe('call notes in the conversation', () => {
  const notesAwareLlm = (turnReplies: string[]) => {
    let turn = 0;
    return new ScriptedLlm((_n, messages) => (messages[0].content.startsWith('CURRENT NOTES') ? 'Caller is Ravi. Budget is two lakh rupees.' : turnReplies[turn++] ?? 'Understood.'));
  };

  it('remembers facts from turns that scrolled out of the recent history', async () => {
    const llm = notesAwareLlm(['Nice to meet you.', 'Noted.', 'Okay.', 'Right.']);
    const { s } = make({ stt: new ScriptedStt(['I am Ravi and my budget is two lakh rupees', 'what do you do', 'and how long does it take', 'thanks']), llm, env: { AI_MAX_HISTORY_MESSAGES: '2' } });
    for (let i = 1; i <= 4; i++) await s.handleUtterance(speechPcm(1200), `u${i}`);
    const turnRequests = llm.requests.filter((r) => !r.messages[0].content.startsWith('CURRENT NOTES'));
    expect(turnRequests[0].system).not.toMatch(/CALL NOTES/); // nothing has scrolled out yet
    expect(turnRequests.at(-1)!.system).toMatch(/CALL NOTES[^]*Caller is Ravi\. Budget is two lakh rupees\./);
    expect(turnRequests.at(-1)!.messages.length).toBeLessThanOrEqual(2); // the window itself stays small
  });

  it('can be switched off', async () => {
    const llm = notesAwareLlm(['One.', 'Two.', 'Three.']);
    const { s } = make({ stt: new ScriptedStt(['a b c', 'd e f', 'g h i']), llm, env: { AI_MAX_HISTORY_MESSAGES: '2', AI_CALL_NOTES: 'false' } });
    for (let i = 1; i <= 3; i++) await s.handleUtterance(speechPcm(1200), `u${i}`);
    expect(llm.requests.some((r) => r.messages[0].content.startsWith('CURRENT NOTES'))).toBe(false);
  });
});

describe('verified knowledge in the conversation', () => {
  const kb = (hits: Array<{ source: string; text: string; score: number }>): KnowledgeProvider & { queries: string[] } => {
    const queries: string[] = [];
    return { name: 'test-kb', queries, retrieve: async (q) => (queries.push(q), hits) };
  };

  it('puts only the retrieved passages in the prompt, labelled as the sole source of company facts', async () => {
    const provider = kb([{ source: 'pricing.md', text: 'A voice agent project starts at five thousand dollars.', score: 3 }]);
    const { s, providers, traces } = make({ stt: new ScriptedStt(['how much does a voice agent cost today']), knowledge: provider });
    await s.handleUtterance(speechPcm(1200), 'u1');
    const system = providers.llm.requests[0].system;
    expect(system).toContain(KNOWLEDGE_RULES);
    expect(system).toMatch(/VERIFIED COMPANY INFORMATION[^]*\[pricing\.md\] A voice agent project starts at five thousand dollars\./);
    expect(provider.queries[0]).toBe('how much does a voice agent cost today');
    expect(traces.find((t) => t.stage === 'llm-request')?.data).toMatchObject({ knowledgeHits: 1, knowledgeSources: 'pricing.md' });
  });

  it('still forbids inventing company facts when nothing matched, without adding an empty block', async () => {
    const { s, providers } = make({ stt: new ScriptedStt(['do you offer legal services for lawyers']), knowledge: kb([]) });
    await s.handleUtterance(speechPcm(1200), 'u1');
    const system = providers.llm.requests[0].system;
    expect(system).toContain(KNOWLEDGE_RULES);
    expect(system).not.toMatch(/VERIFIED COMPANY INFORMATION \(the only source/); // the rules are there, the block is not
  });

  it('adds the previous agent line to a very short answer, so "yes the second one" can be matched', async () => {
    const provider = kb([]);
    const { s } = make({ stt: new ScriptedStt(['do you build chatbots for websites', 'yes the second']), llm: new ScriptedLlm(['We offer a website chatbot and a voice agent. Which one interests you?', 'Okay.']), knowledge: provider });
    await s.handleUtterance(speechPcm(1200), 'u1');
    await s.handleUtterance(speechPcm(1200), 'u2');
    expect(provider.queries[1]).toMatch(/Which one interests you\?.*yes the second/);
  });

  it('does not let a slow or failing knowledge source delay or break a reply', async () => {
    const slow: KnowledgeProvider = { name: 'slow', retrieve: () => new Promise(() => {}) };
    const broken: KnowledgeProvider = { name: 'broken', retrieve: async () => { throw new Error('index offline'); } };
    for (const provider of [slow, broken]) {
      const { s } = make({ knowledge: provider });
      const result = await s.handleUtterance(speechPcm(1200), 'u1');
      expect(result.status).toBe('completed');
      // The lookup is abandoned after 150 ms, so the first audio is not held up for seconds (playback itself is real time).
      expect(result.metrics.firstAudioMs!).toBeLessThan(900);
    }
  });

  it('adds nothing to the prompt when no knowledge is configured', async () => {
    const { s, providers } = make();
    await s.handleUtterance(speechPcm(1200), 'u1');
    expect(providers.llm.requests[0].system).not.toContain(KNOWLEDGE_RULES);
  });
});
