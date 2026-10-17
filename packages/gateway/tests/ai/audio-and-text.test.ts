import { describe, expect, it, vi } from 'vitest';
import { assertEnginePcm, checkPcmBuffer, toWav, unwrapWav } from '../../src/ai/audio.js';
import { assessUtterance, EnergyEndpointer } from '../../src/ai/endpointer.js';
import { extractEndCall, hasSpeechContent, ProtocolTextFilter, SentenceSplitter } from '../../src/ai/text.js';
import { FORMAT_8K, loudNoisePcm, noiseFloorPcm, speechPcm } from './helpers.js';

describe('audio format validation', () => {
  it('accepts only 16-bit mono little-endian PCM in range', () => {
    expect(() => assertEnginePcm(FORMAT_8K)).not.toThrow();
    expect(() => assertEnginePcm({ ...FORMAT_8K, bitDepth: 8 })).toThrow(/16-bit mono little-endian/);
    expect(() => assertEnginePcm({ ...FORMAT_8K, channels: 2 })).toThrow();
    expect(() => assertEnginePcm({ ...FORMAT_8K, endianness: 'big-endian' })).toThrow();
    expect(() => assertEnginePcm({ ...FORMAT_8K, sampleRate: 4000 })).toThrow(/sample rate/);
  });

  it('rejects empty and partial-sample buffers', () => {
    expect(checkPcmBuffer(Buffer.alloc(0), FORMAT_8K)).toEqual({ ok: false, reason: 'empty audio buffer' });
    expect(checkPcmBuffer(Buffer.alloc(321), FORMAT_8K)).toMatchObject({ ok: false });
    expect(checkPcmBuffer(Buffer.alloc(320), FORMAT_8K)).toEqual({ ok: true });
  });

  it('round-trips a WAV and rejects one that declares another format', () => {
    const pcm = speechPcm(100);
    const wav = toWav(pcm, FORMAT_8K);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(unwrapWav(wav, FORMAT_8K)).toEqual(pcm);
    expect(() => unwrapWav(wav, { ...FORMAT_8K, sampleRate: 16000 })).toThrow(/expected 16000 Hz/);
    expect(() => unwrapWav(Buffer.from('not a wav file at all, definitely not!!!!!!!!!!'), FORMAT_8K)).toThrow(/not a WAV/);
  });
});

describe('pre-STT utterance gate', () => {
  it('skips the idle line of the real modem (a few LSB of noise)', () => {
    const result = assessUtterance(noiseFloorPcm(1500), FORMAT_8K, { minDurationMs: 300 });
    expect(result.decision).toBe('silent');
  });

  it('skips digital silence and too-short clips', () => {
    expect(assessUtterance(Buffer.alloc(16000), FORMAT_8K, { minDurationMs: 300 }).decision).toBe('silent');
    expect(assessUtterance(speechPcm(100), FORMAT_8K, { minDurationMs: 300 }).decision).toBe('too-short');
  });

  it('passes voiced audio and flags loud unpitched noise as unlikely speech', () => {
    expect(assessUtterance(speechPcm(1200), FORMAT_8K, { minDurationMs: 300 }).decision).toBe('ok');
    expect(assessUtterance(loudNoisePcm(1200), FORMAT_8K, { minDurationMs: 300 }).decision).toBe('unlikely-speech');
  });
});

describe('energy endpointer', () => {
  const options = { rmsThreshold: 0.012, minSpeechMs: 200, minSilenceMs: 1000, maxUtteranceMs: 15000, preRollMs: 200 };
  const make = () => {
    const utterances: Array<{ pcm: Buffer; reason: string }> = [];
    const onSpeechStart = vi.fn();
    const endpointer = new EnergyEndpointer(FORMAT_8K, options, {
      onSpeechStart,
      onUtterance: (pcm, info) => utterances.push({ pcm, reason: info.reason }),
    });
    return { endpointer, utterances, onSpeechStart };
  };

  it('emits nothing for silence or the idle noise floor', () => {
    const { endpointer, utterances, onSpeechStart } = make();
    endpointer.feed(noiseFloorPcm(5000));
    expect(utterances).toHaveLength(0);
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('emits one utterance after the caller has been quiet for the silence delay, with pre-roll', () => {
    const { endpointer, utterances, onSpeechStart } = make();
    endpointer.feed(noiseFloorPcm(500));
    endpointer.feed(speechPcm(1000));
    endpointer.feed(noiseFloorPcm(900)); // not long enough yet
    expect(utterances).toHaveLength(0);
    endpointer.feed(noiseFloorPcm(300));
    expect(utterances).toHaveLength(1);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    const ms = (utterances[0].pcm.length / 2 / 8000) * 1000;
    expect(ms).toBeGreaterThanOrEqual(1000 + 200); // speech + pre-roll
    expect(utterances[0].reason).toBe('silence');
  });

  it('ignores a click shorter than the minimum speech length', () => {
    const { endpointer, utterances, onSpeechStart } = make();
    endpointer.feed(speechPcm(60));
    endpointer.feed(noiseFloorPcm(2000));
    expect(utterances).toHaveLength(0);
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it('handles frames of any size and cuts very long speech', () => {
    const { endpointer, utterances } = make();
    const long = speechPcm(16000);
    for (let i = 0; i < long.length; i += 333) endpointer.feed(long.subarray(i, Math.min(i + 333, long.length)));
    expect(utterances).toHaveLength(1);
    expect(utterances[0].reason).toBe('max-length');
  });

  it('flush() emits what was heard when the call ends mid-sentence', () => {
    const { endpointer, utterances } = make();
    endpointer.feed(speechPcm(800));
    expect(endpointer.flush()).toBe(true);
    expect(utterances).toHaveLength(1);
    expect(endpointer.flush()).toBe(false);
  });

  it('refuses a format it cannot read', () => {
    expect(
      () => new EnergyEndpointer({ ...FORMAT_8K, bitDepth: 8 }, options, { onUtterance: () => {} })
    ).toThrow();
  });
});

describe('protocol text filter', () => {
  const run = (chunks: string[]) => {
    const filter = new ProtocolTextFilter();
    return chunks.map((c) => filter.feed(c)).join('') + filter.finish();
  };

  it('passes ordinary text unchanged however it is chunked', () => {
    expect(run(['Hel', 'lo ', 'there, <3 you!'])).toBe('Hello there, <3 you!');
  });

  it('cuts control syntax even when a marker straddles chunks', () => {
    expect(run(['Sure thing. <to', 'ol_call>{"x":1}</tool_call>'])).toBe('Sure thing. ');
    expect(run(['Okay <|im', '_start|> hidden'])).toBe('Okay ');
    expect(run(['Fine [tool_', 'calls] hidden'])).toBe('Fine ');
  });

  it('keeps an incomplete control tag private at the end of the stream', () => {
    expect(run(['Done. <fun'])).toBe('Done. ');
  });

  it('does not swallow an ordinary word that merely starts like the plain-text marker', () => {
    expect(run(['Please give us a call'])).toBe('Please give us a call');
    expect(run(['Please give us a c', 'all'])).toBe('Please give us a call');
    expect(run(['Goodbye! END_C', 'ALL'])).toBe('Goodbye! END_CALL');
    expect(run(['Then I will call tool=x'])).toBe('Then I will ');
  });
});

describe('END_CALL and sentence handling', () => {
  it('finds and removes the END_CALL token in the shapes the source accepts', () => {
    expect(extractEndCall('Goodbye now! END_CALL')).toEqual({ text: 'Goodbye now!', endRequested: true });
    expect(extractEndCall('Bye. **END_CALL**')).toEqual({ text: 'Bye.', endRequested: true });
    expect(extractEndCall('end_call')).toEqual({ text: '', endRequested: true });
    expect(extractEndCall('The word PREEND_CALLS is ordinary')).toEqual({ text: 'The word PREEND_CALLS is ordinary', endRequested: false });
    expect(extractEndCall('Take care. END_CALL and anything after it')).toEqual({ text: 'Take care.', endRequested: true });
  });

  it('splits a stream into whole sentences and holds short fragments', () => {
    const splitter = new SentenceSplitter(10);
    const out = [...splitter.push('Hi. This is the first sentence. And a sec'), ...splitter.push('ond one! Tail'), ...splitter.flush()];
    expect(out).toEqual(['Hi. This is the first sentence.', 'And a second one!', 'Tail']);
  });

  it('does not split on decimals or a missing space', () => {
    const splitter = new SentenceSplitter(5);
    expect(splitter.push('The price is 3.5 dollars today. Thanks')).toEqual(['The price is 3.5 dollars today.']);
  });

  it('recognises speakable content', () => {
    expect(hasSpeechContent('...')).toBe(false);
    expect(hasSpeechContent('  ')).toBe(false);
    expect(hasSpeechContent('ok')).toBe(true);
    expect(hasSpeechContent('नमस्ते')).toBe(true);
  });
});
