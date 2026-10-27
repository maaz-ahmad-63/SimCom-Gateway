import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { playPcmPaced, playPcmStreamPaced } from '../../src/adapters/audio/paced-playback.js';
import { BargeInDetector } from '../../src/ai/barge-in.js';
import { formatKnowledge, KNOWLEDGE_RULES, LocalKnowledgeBase, tokenize } from '../../src/ai/knowledge.js';
import { CallNotes } from '../../src/ai/memory.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/ai/prompt.js';
import { ScriptedLlm } from '../../src/ai/providers/mock.js';
import { SentenceSplitter } from '../../src/ai/text.js';
import { FORMAT_8K, makeConfig, sleep } from './helpers.js';

const WINDOW = 320;
function level(rms: number, ms: number): Buffer {
  const samples = (8000 * ms) / 1000;
  const b = Buffer.alloc(samples * 2);
  const a = Math.round(rms * 32768);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? a : -a, i * 2);
  return b;
}

describe('barge-in detector', () => {
  const make = (over: object = {}) => new BargeInDetector(FORMAT_8K, { minMs: 300, echoMultiplier: 2.5, floor: 0.006, ...over });
  const feedAll = (d: BargeInDetector, pcm: Buffer): boolean => {
    let hit = false;
    for (let o = 0; o + WINDOW <= pcm.length; o += WINDOW) if (d.feed(pcm.subarray(o, o + WINDOW))) hit = true;
    return hit;
  };

  it('does not trigger on a steady echo that was already there when the agent started speaking', () => {
    const d = make();
    expect(feedAll(d, level(0.03, 3000))).toBe(false); // strong, constant echo from the first moment
    expect(feedAll(d, level(0.035, 1000))).toBe(false); // fluctuating a little is still echo
  });

  it('triggers when the caller starts talking well above the echo, once the speech has been sustained', () => {
    const d = make();
    feedAll(d, level(0.02, 1200)); // calibration and echo
    expect(feedAll(d, level(0.1, 260))).toBe(false); // not long enough yet
    expect(feedAll(d, level(0.1, 60))).toBe(true);
  });

  it('ignores a short burst, and a brief dip inside speech does not restart the count', () => {
    const d = make();
    feedAll(d, level(0.01, 1200));
    expect(feedAll(d, level(0.1, 200))).toBe(false);
    expect(feedAll(d, level(0.01, 200))).toBe(false); // the burst ends: counting stops
    const d2 = make();
    feedAll(d2, level(0.01, 1200));
    feedAll(d2, level(0.1, 200));
    feedAll(d2, level(0.0, 60)); // a syllable gap
    expect(feedAll(d2, level(0.1, 120))).toBe(true);
  });

  it('never triggers below the absolute floor, however quiet the line is', () => {
    const d = make();
    feedAll(d, level(0.0005, 1200));
    expect(feedAll(d, level(0.004, 2000))).toBe(false);
  });

  it('cannot trigger during calibration, and starts again from scratch after a reset', () => {
    const d = make();
    expect(feedAll(d, level(0.2, 500))).toBe(false); // someone shouting in the first half second becomes the baseline
    d.reset();
    feedAll(d, level(0.01, 1200));
    expect(feedAll(d, level(0.1, 400))).toBe(true);
  });
});

describe('verified company knowledge', () => {
  const base = () =>
    new LocalKnowledgeBase([
      {
        source: 'services.md',
        text: '# Services\n\nWe build AI voice agents for phone lines and chatbots for websites.\n\n# Pricing\n\nA voice agent project starts at five thousand dollars. A website chatbot starts at two thousand dollars.',
      },
      { source: 'hours.txt', text: 'Our office is open Monday to Friday, nine to six India time. We are closed on public holidays.' },
    ]);

  it('finds the passage that answers the question and says where it came from', async () => {
    const hits = await base().retrieve('How much does a voice agent cost? Pricing please', { topK: 3, maxChars: 1000 });
    expect(hits[0].text).toMatch(/five thousand dollars/);
    expect(hits[0].source).toBe('services.md > Pricing');
  });

  it('returns nothing for a question the documents do not cover, so the model is not handed noise', async () => {
    expect(await base().retrieve('what is the weather like in Paris', { topK: 3, maxChars: 1000 })).toEqual([]);
    expect(await base().retrieve('', { topK: 3, maxChars: 1000 })).toEqual([]);
  });

  it('keeps within the passage count and character budget', async () => {
    const kb = new LocalKnowledgeBase(Array.from({ length: 12 }, (_, i) => ({ source: `d${i}.md`, text: `Our voice agent service number ${i} includes phone support and reporting for callers.` })));
    const hits = await kb.retrieve('voice agent phone support', { topK: 2, maxChars: 1000 });
    expect(hits).toHaveLength(2);
    const tight = await kb.retrieve('voice agent phone support', { topK: 5, maxChars: 100 });
    expect(tight.length).toBe(1);
    expect(tight[0].text.length).toBeLessThanOrEqual(100);
  });

  it('reads .md and .txt files from a folder and ignores everything else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
    try {
      fs.writeFileSync(path.join(dir, 'faq.md'), '# Support\n\nSupport is available by phone and email during office hours.');
      fs.writeFileSync(path.join(dir, 'secret.json'), '{"password":"hunter2 support support support"}');
      fs.mkdirSync(path.join(dir, 'more'));
      fs.writeFileSync(path.join(dir, 'more', 'refunds.txt'), 'Refunds are handled within seven business days of the request.');
      const kb = LocalKnowledgeBase.fromDir(dir);
      expect(kb.size).toBe(2);
      expect((await kb.retrieve('how long do refunds take', { topK: 1, maxChars: 500 }))[0].source).toBe('more/refunds.txt');
      expect(await kb.retrieve('hunter2', { topK: 1, maxChars: 500 })).toEqual([]);
      expect(LocalKnowledgeBase.fromDir(path.join(dir, 'does-not-exist')).size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats the passages as the only source for company facts, and the rules forbid inventing', () => {
    expect(formatKnowledge([])).toBe('');
    const block = formatKnowledge([{ source: 'a.md', text: 'We open at nine.', score: 1 }]);
    expect(block).toMatch(/VERIFIED COMPANY INFORMATION/);
    expect(block).toContain('[a.md] We open at nine.');
    expect(KNOWLEDGE_RULES).toMatch(/Never guess, never invent/);
    expect(tokenize('The Services we offer')).toEqual(['service', 'offer']);
  });
});

describe('call notes', () => {
  const notesLlm = (reply: string | Error) =>
    new ScriptedLlm((_n, messages) => (messages[0].content.startsWith('CURRENT NOTES') ? reply : 'unused'));

  it('folds dropped turns into short notes and puts them in the system prompt', async () => {
    const llm = notesLlm('Caller is Ravi, a start-up founder. Wants a voice agent. Budget not decided.');
    const notes = new CallNotes({ enabled: true });
    expect(notes.withNotes('BASE')).toBe('BASE');
    notes.fold([{ role: 'user', content: 'Hi I am Ravi, I run a start-up and need a voice agent' }, { role: 'assistant', content: 'We can build that.' }], llm);
    await notes.settled();
    expect(notes.text).toMatch(/Ravi/);
    expect(notes.withNotes('BASE')).toMatch(/^BASE\n\nCALL NOTES .*\nCaller is Ravi/s);
    // The model was told to keep only what was said.
    expect(llm.requests[0].system).toMatch(/Never invent/);
    expect(llm.requests[0].messages[0].content).toMatch(/NEW TRANSCRIPT:\ncaller: Hi I am Ravi/);
  });

  it('keeps earlier notes when later turns are folded in, one request at a time', async () => {
    const replies = ['Name is Ravi.', 'Name is Ravi. Budget is two lakh rupees.'];
    const seen: string[] = [];
    const llm = new ScriptedLlm((n, messages) => {
      seen.push(messages[0].content);
      return replies[n] ?? replies[replies.length - 1];
    });
    const notes = new CallNotes({ enabled: true });
    notes.fold([{ role: 'user', content: 'I am Ravi' }], llm);
    notes.fold([{ role: 'user', content: 'my budget is two lakh' }], llm); // arrives while the first is running
    await notes.settled();
    expect(notes.text).toBe('Name is Ravi. Budget is two lakh rupees.');
    expect(seen[1]).toMatch(/CURRENT NOTES:\nName is Ravi\./);
  });

  it('never loses the facts when the model fails: a short form of the dropped lines is kept', async () => {
    const notes = new CallNotes({ enabled: true });
    notes.fold([{ role: 'user', content: 'my budget is fifty thousand rupees' }, { role: 'assistant', content: 'Noted.' }], notesLlm(new Error('rate limited')));
    await notes.settled();
    expect(notes.text).toMatch(/Caller said: my budget is fifty thousand rupees/);
  });

  it('does nothing when disabled, and bounds its own size', async () => {
    const off = new CallNotes({ enabled: false });
    const llm = notesLlm('x');
    off.fold([{ role: 'user', content: 'hello there' }], llm);
    await off.settled();
    expect(llm.requests).toHaveLength(0);
    const small = new CallNotes({ enabled: true, maxChars: 20 });
    small.fold([{ role: 'user', content: 'a long statement about things' }], notesLlm('0123456789012345678901234567890'));
    await small.settled();
    expect(small.text.length).toBeLessThanOrEqual(20);
  });
});

describe('sentence splitting for first audio', () => {
  const run = (splitter: SentenceSplitter, text: string) => [...splitter.push(text), ...splitter.flush()];

  it('keeps the original rule by default: a short opener is joined to the next sentence', () => {
    expect(run(new SentenceSplitter(), 'Sure. We can build that for you today. Anything else?')).toEqual(['Sure. We can build that for you today.', 'Anything else?']);
  });

  it('can release a short opener on its own when the first sentence is allowed to be short', () => {
    expect(run(new SentenceSplitter(24, 5), 'Sure. We can build that for you today. Anything else?')).toEqual(['Sure.', 'We can build that for you today.', 'Anything else?']);
  });

  it('applies the shorter limit to the first sentence only', () => {
    const s = new SentenceSplitter(24, 5);
    expect(s.push('Sure. Yes. We can do it.  ')).toEqual(['Sure.']);
    expect(s.flush()).toEqual(['Yes. We can do it.']);
  });
});

describe('playback scheduling', () => {
  const frame = (n: number) => Buffer.alloc(320 * n);

  it('counts frames that went out later than the write-ahead covers, separately from timer jitter', async () => {
    let n = 0;
    const slow = async () => {
      if (n++ === 3) await sleep(110); // one stuck write
    };
    const tight = await playPcmPaced(slow, frame(20), { sampleRate: 8000, leadFrames: 2 });
    expect(tight.riskFrames).toBeGreaterThan(0);
    expect(tight.lateFrames).toBeGreaterThanOrEqual(tight.riskFrames);
    n = 0;
    const roomy = await playPcmPaced(slow, frame(20), { sampleRate: 8000, leadFrames: 8 });
    expect(roomy.riskFrames).toBe(0); // a deeper write-ahead absorbs the same stall
    expect(roomy.stoppedBy).toBeNull();
  });

  it('reports no risk when every write is prompt', async () => {
    const result = await playPcmPaced(async () => {}, frame(15), { sampleRate: 8000 });
    expect(result.riskFrames).toBe(0);
    expect(result.bytesWritten).toBe(frame(15).length);
  });

  it('applies the same measure to streamed playback', async () => {
    let n = 0;
    const result = await playPcmStreamPaced(
      async () => {
        if (n++ === 3) await sleep(110);
      },
      (async function* () {
        yield frame(20);
      })(),
      { sampleRate: 8000, leadFrames: 2, prerollMs: 40 }
    );
    expect(result.riskFrames).toBeGreaterThan(0);
  });
});

describe('the standing instructions', () => {
  it('keep the call-ending protocol and add the spoken-reply, honesty and interruption rules', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/END_CALL/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/one or two short sentences/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Never invent facts about the company/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/ellipsis/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/automatic speech recognition/);
  });
});

describe('configuration of the new turn-taking features', () => {
  it('has safe, documented defaults', () => {
    const c = makeConfig();
    expect(c.vad).toMatchObject({ adaptive: true, minSilenceFloorMs: 450, softSilenceMs: 350, speculativeStt: true, earlyCommit: false });
    expect(c.bargeIn).toMatchObject({ enabled: true, whileSpeaking: true, minMs: 300, echoMultiplier: 2.5, maxFalseTriggers: 2 });
    expect(c.playback).toEqual({ leadFrames: 2, prerollMs: 150 });
    expect(c.knowledge).toEqual({ dir: null, topK: 3, maxChars: 1200 });
    expect(c.memory.callNotes).toBe(true);
    expect(c.limits.maxLlmTokens).toBe(220);
    expect(c.limits.firstSentenceMinChars).toBe(24);
  });

  it('reads overrides from the environment', () => {
    const c = makeConfig({ AI_EARLY_COMMIT: 'true', AI_VAD_SOFT_SILENCE_MS: '0', AI_BARGE_IN_WHILE_SPEAKING: 'false', AI_KNOWLEDGE_DIR: 'C:/kb', AI_PLAYBACK_LEAD_FRAMES: '4', AI_LLM_MAX_TOKENS: '120' });
    expect(c.vad.earlyCommit).toBe(true);
    expect(c.vad.softSilenceMs).toBe(0);
    expect(c.bargeIn.whileSpeaking).toBe(false);
    expect(c.knowledge.dir).toBe('C:/kb');
    expect(c.playback.leadFrames).toBe(4);
    expect(c.limits.maxLlmTokens).toBe(120);
  });
});
