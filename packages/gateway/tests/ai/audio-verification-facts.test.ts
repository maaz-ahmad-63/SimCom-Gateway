import { describe, expect, it } from 'vitest';
import { CollectingAudioSink, PlayResult } from '../../src/ai/audio.js';
import { ConversationEvent, ConversationSession } from '../../src/ai/conversation.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { SttProvider } from '../../src/ai/providers/types.js';
import { FORMAT_8K, makeConfig, speechPcm } from './helpers.js';

/**
 * The facts call-audio verification reads from a turn are carried on the turn result: a word count and the provider's confidence
 * (never new text), the in-memory "can't hear you" flag, and the delivery totals the playback already measured. Nothing about how
 * audio is captured, transcribed, paced or played changes; these tests check only what is reported.
 */

const sttWith = (text: string, confidence?: number): SttProvider => ({
  name: 'stt-with-confidence',
  transcribe: async () => (confidence === undefined ? { text } : { text, confidence }),
});
const build = (stt: SttProvider, sink = new CollectingAudioSink(FORMAT_8K), env: Record<string, string> = {}, passive = false) => {
  const events: ConversationEvent[] = [];
  const providers = { ...createMockProviders({ llm: ['Thank you, we open at nine.'] }), stt } as ReturnType<typeof createMockProviders>;
  const session = new ConversationSession({ callId: 'call-facts', config: makeConfig(env), providers, sink, emit: (e) => events.push(e), passive });
  return { session, sink, events };
};

describe('turn facts for call-audio verification', () => {
  it('carries the word count and the provider confidence, and the bytes the sink accepted', async () => {
    const { session, sink } = build(sttWith('what time do you open', 0.87));
    const r = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(r.status).toBe('completed');
    expect(r.transcriptWords).toBe(5);
    expect(r.sttConfidence).toBe(0.87);
    expect(r.callerReportsNotHearing).toBeUndefined();
    const played = sink.played.reduce((n, b) => n + b.length, 0);
    expect(played).toBeGreaterThan(0);
    expect(r.metrics.bytesWritten).toBe(played);
    expect(r.metrics.playbackCompleted).toBe(true);
    expect(r.metrics.playbackStoppedBy).toBeNull();
    expect(r.metrics.underruns).toBe(0);
  });

  it('reports null confidence when the provider gives none', async () => {
    const { session } = build(sttWith('book me an appointment please'));
    const r = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(r.transcriptWords).toBe(5);
    expect(r.sttConfidence).toBeNull();
  });

  it('flags "I can\'t hear you" without putting the text on the result when transcript logging is off', async () => {
    const { session } = build(sttWith("sorry I can't hear you", 0.9), undefined, { AI_LOG_TRANSCRIPTS: 'false' });
    const r = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(r.callerReportsNotHearing).toBe(true);
    expect(r.transcript).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('hear you');
  });

  it('has no transcript facts when speech-to-text failed', async () => {
    const failing: SttProvider = { name: 'failing', transcribe: async () => { throw new Error('provider down'); } };
    const { session } = build(failing);
    const r = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('stt-failed');
    expect(r.transcriptWords).toBeUndefined();
  });

  it('reports a reply the port did not fully take as not completed, stopped by not-written', async () => {
    class ShortSink extends CollectingAudioSink {
      async play(pcm: Buffer): Promise<PlayResult> {
        return { bytesWritten: Math.floor(pcm.length / 2), completed: false, stoppedBy: 'not-written' };
      }
    }
    const { session } = build(sttWith('is anybody there today', 0.9), new ShortSink(FORMAT_8K));
    const r = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(r.metrics.playbackCompleted).toBe(false);
    expect(r.metrics.playbackStoppedBy).toBe('not-written');
    expect(r.metrics.bytesWritten).toBeGreaterThan(0);
  });

  it('a passive (transcribe-only) turn reports nothing played', async () => {
    const { session } = build(sttWith('just listening here', 0.9), undefined, {}, true);
    const r = await session.handleUtterance(speechPcm(1200), 'u1');
    expect(r.metrics.bytesWritten ?? 0).toBe(0);
    expect(r.metrics.playbackCompleted ?? null).toBeNull();
  });
});
