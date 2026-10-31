import { describe, expect, it } from 'vitest';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ConversationSession, TraceInput } from '../../src/ai/conversation.js';
import { assessUtterance, utteranceLevels } from '../../src/ai/endpointer.js';
import { createMockProviders, ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { ProviderSet, SttResult, SttStream } from '../../src/ai/providers/types.js';
import { analyzePcm } from '../../src/diagnostics/pcm-tools.js';
import { FORMAT_8K, makeConfig, speechPcm } from './helpers.js';

// Calls a239ca50 and 114431fb: the audio check before speech-to-text ran analyzePcm(), whose 370-frequency Goertzel sweep the
// check never reads. It took 165-230 ms of synchronous work for a 7 s utterance, on the path between the end of speech and the first
// STT byte. The levels it needs are now computed in one pass, with the same definitions.

const FORMAT_16K = { ...FORMAT_8K, sampleRate: 16000 };

function noisy(seconds: number, sampleRate: number, amp: number, seed = 7): Buffer {
  const n = Math.round(seconds * sampleRate);
  const b = Buffer.alloc(n * 2);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const v = Math.max(-32768, Math.min(32767, Math.round(Math.sin(i / 9) * amp + ((s % 2001) - 1000))));
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

describe('utteranceLevels', () => {
  it.each([
    ['quiet speech', noisy(2, 8000, 800), FORMAT_8K],
    ['loud and clipping', noisy(1.5, 16000, 40000), FORMAT_16K],
    ['digital silence', Buffer.alloc(8000 * 2), FORMAT_8K],
    ['odd byte count', Buffer.concat([noisy(0.5, 8000, 3000), Buffer.from([1])]), FORMAT_8K],
    ['a single sample', noisy(1 / 8000, 8000, 3000), FORMAT_8K],
  ])('matches analyzePcm exactly: %s', (_name, pcm, format) => {
    const slow = analyzePcm(pcm, format);
    expect(utteranceLevels(pcm, format)).toEqual({ durationMs: slow.durationMs, rms: slow.rms, peak: slow.peak, clippedRatio: slow.clippedRatio });
  });

  it('falls back to analyzePcm for anything but 16-bit audio', () => {
    const format = { ...FORMAT_8K, bitDepth: 8 } as typeof FORMAT_8K;
    const pcm = Buffer.from(Array.from({ length: 800 }, (_, i) => 128 + Math.round(Math.sin(i / 5) * 60)));
    const slow = analyzePcm(pcm, format);
    expect(utteranceLevels(pcm, format)).toEqual({ durationMs: slow.durationMs, rms: slow.rms, peak: slow.peak, clippedRatio: slow.clippedRatio });
  });

  it('does not change what the gate decides, and is much cheaper than the full analysis on a long utterance', () => {
    const long = noisy(7, 16000, 3000);
    expect(assessUtterance(long, FORMAT_16K, { minDurationMs: 300 }).decision).toBe('ok');
    expect(assessUtterance(Buffer.alloc(16000), FORMAT_8K, { minDurationMs: 300 }).decision).toBe('silent');
    expect(assessUtterance(noisy(0.1, 8000, 3000), FORMAT_8K, { minDurationMs: 300 }).decision).toBe('too-short');
    const time = (fn: () => void) => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    time(() => analyzePcm(long, FORMAT_16K)); // warm both
    time(() => utteranceLevels(long, FORMAT_16K));
    const full = Math.min(...[1, 2, 3].map(() => time(() => analyzePcm(long, FORMAT_16K))));
    const quick = Math.min(...[1, 2, 3].map(() => time(() => utteranceLevels(long, FORMAT_16K))));
    expect(quick).toBeLessThan(full / 3);
  });
});

class FakeStream implements SttStream {
  interim = '';
  error: Error | null = null;
  finalizeOutcome: SttStream['finalizeOutcome'] = null;
  constructor(private readonly answer: SttResult | null) {}
  push() {}
  flush() {}
  async finalize(): Promise<SttResult | null> {
    this.finalizeOutcome = { how: this.answer ? 'acknowledged' : 'timeout', waitedMs: 5, finals: this.answer ? 1 : 0 };
    return this.answer;
  }
  close() {}
}

describe('the trace says which provider was selected and which one answered', () => {
  const build = () => {
    const trace: TraceInput[] = [];
    const providers: ProviderSet = {
      ...createMockProviders(),
      stt: new ScriptedStt(['from the batch provider'], 10),
      llm: new ScriptedLlm(['A short reply.'], { delayMs: 5 }),
      tts: new ToneTts(),
      sttStream: { name: 'deepgram-stream', open: () => new FakeStream(null) },
    };
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K), trace: (e) => trace.push(e) });
    return { session, trace, selected: providers.stt.name };
  };
  const sttResult = (trace: TraceInput[]) => trace.filter((e) => e.stage === 'stt-result' && e.status === 'ok').at(-1)?.data as Record<string, unknown>;

  it('a transcript supplied by the stream is attributed to the streaming provider, and the selected provider is still shown', async () => {
    const { session, trace, selected } = build();
    await session.handleUtterance(speechPcm(1200), 'u1', { stream: new FakeStream({ text: 'streamed words' }) } as never);
    expect(sttResult(trace)).toMatchObject({ streaming: 'final', usedProvider: 'deepgram-stream', selectedProvider: selected });
    expect(trace.find((e) => e.stage === 'stt-submit')?.data).toMatchObject({ selectedProvider: selected, streamProvider: 'deepgram-stream' });
  });

  it('when the stream gave nothing, the batch provider is the one that answered', async () => {
    const { session, trace, selected } = build();
    await session.handleUtterance(speechPcm(1200), 'u1', { stream: new FakeStream(null) } as never);
    expect(sttResult(trace)).toMatchObject({ usedProvider: selected, selectedProvider: selected });
  });

  it('records how long the audio check took, so a slow check is visible on the turn', async () => {
    const { session, trace } = build();
    await session.handleUtterance(speechPcm(1200), 'u1');
    const check = trace.find((e) => e.stage === 'pcm-validation')?.data as Record<string, unknown>;
    expect(typeof check.assessMs).toBe('number');
  });
});
