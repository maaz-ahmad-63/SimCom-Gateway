import { describe, expect, it } from 'vitest';
import { CallAudioVerifier, countWords, detectHearingComplaint, sanitize, TurnObservation } from '../src/ai/call-audio-verifier.js';

/** A controllable clock, so evidence timestamps and test windows are exact. */
function clock(start = Date.parse('2026-11-05T10:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}
const speech = (words: number, confidence: number | null = 0.9, extra: Partial<TurnObservation> = {}): TurnObservation => ({ status: 'completed', utterance: 'ok', transcriptWords: words, sttConfidence: confidence, ...extra });
const played = (bytes = 32000, extra: Partial<TurnObservation> = {}): Partial<TurnObservation> => ({ bytesWritten: bytes, playbackCompleted: true, playbackStoppedBy: null, underruns: 0, ...extra });
const active = (c = clock(), opts = {}) => {
  const v = new CallAudioVerifier('call-1', { now: c.now, direction: 'inbound', ...opts });
  v.callActive();
  v.pipelineAttached();
  v.wireState('flowing');
  return v;
};

describe('state machine basics', () => {
  it('starts pending for all three, moves inbound to verifying when the call is answered, and every result names call, time, source and reason', () => {
    const c = clock();
    const v = new CallAudioVerifier('call-42', { now: c.now });
    const s0 = v.snapshot();
    expect([s0.inbound.status, s0.transport.status, s0.audibility.status]).toEqual(['pending', 'pending', 'pending']);
    expect(s0.callId).toBe('call-42');
    c.advance(1000);
    v.callActive();
    const s1 = v.snapshot();
    expect(s1.inbound.status).toBe('verifying');
    expect(s1.activeAt).toBe('2026-11-05T10:00:01.000Z');
    for (const a of [s1.inbound, s1.transport, s1.audibility]) {
      expect(a.reason.length).toBeGreaterThan(5);
      expect(typeof a.updatedAt).toBe('string');
    }
    expect(s1.inbound.source).toBe('call-lifecycle');
  });

  it('snapshots are copies: changing one never changes the verifier', () => {
    const v = active();
    const s = v.snapshot();
    s.inbound.status = 'verified';
    expect(v.snapshot().inbound.status).toBe('verifying');
  });

  it('after the call ends nothing can change any more', () => {
    const v = active();
    v.callEnded();
    v.turn(speech(5));
    v.turn(speech(5));
    v.turn({ status: 'completed', ...played() });
    const s = v.snapshot();
    expect(s.final).toBe(true);
    expect(s.inbound.status).toBe('unable');
    expect(s.transport.status).toBe('unable');
  });
});

describe('inbound intelligibility', () => {
  it('is verified only by two speech utterances that the live STT turned into real words with good confidence', () => {
    const v = active();
    v.turn(speech(4, 0.92));
    expect(v.snapshot().inbound.status).toBe('verifying');
    v.turn(speech(3, 0.81));
    const s = v.snapshot().inbound;
    expect(s.status).toBe('verified');
    expect(s.source).toBe('live-stt');
    expect(s.evidence.filter((e) => e.kind === 'supporting')).toHaveLength(2);
  });

  it('a provider without confidence still counts, on words alone', () => {
    const v = active();
    v.turn(speech(3, null));
    v.turn(speech(2, null));
    expect(v.snapshot().inbound.status).toBe('verified');
  });

  it('PCM bytes alone never verify: a flowing stream with no transcripts ends as Unable to verify', () => {
    const v = active();
    for (let i = 0; i < 50; i++) v.wireState('flowing');
    expect(v.snapshot().inbound.status).toBe('verifying');
    v.callEnded();
    const s = v.snapshot().inbound;
    expect(s.status).toBe('unable');
    expect(s.reason).toMatch(/no caller speech was detected/);
  });

  it('silence is Unable to verify, never Failed', () => {
    const v = active();
    for (let i = 0; i < 6; i++) v.turn({ status: 'skipped', utterance: 'silent' });
    v.turn({ status: 'skipped', utterance: 'too-short' });
    v.callEnded();
    expect(v.snapshot().inbound.status).toBe('unable');
  });

  it('transcription unavailable (STT failing) is Unable to verify, never Failed', () => {
    const v = active();
    for (let i = 0; i < 5; i++) v.turn({ status: 'failed', reason: 'stt-failed', utterance: 'ok' });
    expect(v.snapshot().inbound.status).toBe('verifying');
    v.callEnded();
    const s = v.snapshot().inbound;
    expect(s.status).toBe('unable');
    expect(s.reason).toMatch(/transcription was unavailable/);
  });

  it('fails only when repeated speech-like utterances consistently give no usable words', () => {
    const v = active();
    v.turn(speech(0, null));
    v.turn(speech(3, 0.1));
    expect(v.snapshot().inbound.status).toBe('verifying');
    v.turn(speech(0, null));
    const s = v.snapshot().inbound;
    expect(s.status).toBe('failed');
    expect(s.reason).toMatch(/no usable words/);
  });

  it('low-but-not-terrible confidence and one-word answers are inconclusive, not counted either way', () => {
    const v = active();
    for (let i = 0; i < 5; i++) v.turn(speech(4, 0.45));
    for (let i = 0; i < 5; i++) v.turn(speech(1, 0.95));
    expect(v.snapshot().inbound.status).toBe('verifying');
    v.callEnded();
    expect(v.snapshot().inbound.status).toBe('unable');
  });

  it('one good utterance among bad ones prevents Failed', () => {
    const v = active();
    v.turn(speech(5, 0.9));
    for (let i = 0; i < 5; i++) v.turn(speech(0, null));
    expect(v.snapshot().inbound.status).toBe('verifying');
  });

  it('a stream that stops during the active call fails, but only after several samples in a row', () => {
    const v = active();
    v.wireState('stalled');
    v.wireState('flowing');
    v.wireState('stalled');
    v.wireState('stalled');
    expect(v.snapshot().inbound.status).toBe('verifying');
    v.wireState('stalled');
    const s = v.snapshot().inbound;
    expect(s.status).toBe('failed');
    expect(s.source).toBe('usb-audio-stream');
  });

  it('a stream that was never flowing is Unable to verify, not Failed', () => {
    const c = clock();
    const v = new CallAudioVerifier('c', { now: c.now });
    v.callActive();
    v.pipelineAttached();
    for (let i = 0; i < 10; i++) v.wireState('not-expected');
    v.callEnded();
    expect(v.snapshot().inbound).toMatchObject({ status: 'unable', reason: expect.stringMatching(/no caller audio stream/) });
  });
});

describe('outbound transport', () => {
  it('is verified when the adapter accepted the agent audio without errors or persistent underruns, and says that proves no hearing', () => {
    const v = active();
    v.turn({ ...speech(3), ...played(48000) });
    const s = v.snapshot();
    expect(s.transport.status).toBe('verified');
    expect(s.transport.evidence.at(-1)!.detail).toMatch(/not that anyone heard it/);
    expect(s.audibility.status).toBe('verifying'); // never verified by a write
  });

  it('a reply cut short by the port is Failed', () => {
    const v = active();
    v.turn({ status: 'completed', ...played(12000, { playbackCompleted: false, playbackStoppedBy: 'not-written' }) });
    expect(v.snapshot().transport).toMatchObject({ status: 'failed', source: 'audio-port' });
    expect(v.snapshot().audibility.status).toBe('unable');
  });

  it('an audio port error is Failed, with the message sanitized', () => {
    const v = active();
    v.transportError('write EPIPE x-api-key: abcdefabcdefabcdefabcdef1234567890abcdef');
    const s = v.snapshot().transport;
    expect(s.status).toBe('failed');
    expect(JSON.stringify(s)).not.toContain('abcdefabcdefabcdef');
  });

  it('persistent underruns fail; a single bad reply does not', () => {
    const v = active();
    v.turn({ status: 'completed', ...played(32000, { underruns: 5 }) });
    expect(v.snapshot().transport.status).toBe('pending');
    v.turn({ status: 'completed', ...played(32000) });
    expect(v.snapshot().transport.status).toBe('verified');
    v.turn({ status: 'completed', ...played(32000, { underruns: 4 }) });
    v.turn({ status: 'completed', ...played(32000, { underruns: 6 }) });
    expect(v.snapshot().transport).toMatchObject({ status: 'failed', source: 'playback' });
  });

  it('a reply interrupted by the caller still counts as delivered for the part that was written', () => {
    const v = active();
    v.turn({ status: 'cancelled', ...played(8000, { playbackCompleted: false, playbackStoppedBy: 'aborted' }) });
    expect(v.snapshot().transport.status).toBe('verified');
  });

  it('is Unable to verify when the agent never produced audio', () => {
    const v = active();
    v.turn(speech(4));
    v.callEnded();
    expect(v.snapshot().transport).toMatchObject({ status: 'unable', reason: expect.stringMatching(/did not produce any audio/) });
  });
});

describe('outbound remote audibility', () => {
  it('successful writes never prove audibility', () => {
    const v = active();
    for (let i = 0; i < 10; i++) v.turn({ status: 'completed', ...played() });
    v.callEnded();
    const s = v.snapshot();
    expect(s.transport.status).toBe('verified');
    expect(s.audibility.status).toBe('unable');
    expect(s.audibility.reason).toMatch(/no explicit confirmation/);
  });

  it('a caller who responds after the agent is recorded as "Caller responded", and still does not verify audibility', () => {
    const v = active();
    for (let i = 0; i < 5; i++) {
      v.turn({ status: 'completed', ...played() });
      v.turn(speech(4));
    }
    const mid = v.snapshot().audibility;
    expect(mid.status).toBe('verifying');
    expect(mid.evidence.filter((e) => e.source === 'caller-response' && /Caller responded/.test(e.detail))).toHaveLength(5);
    v.callEnded();
    const end = v.snapshot().audibility;
    expect(end.status).toBe('unable');
    expect(end.reason).toMatch(/caller responded after the agent 5 times, which is indirect/);
  });

  it('"I can\'t hear you" is a warning only: it never marks audibility Failed', () => {
    const v = active();
    v.turn({ status: 'completed', ...played() });
    v.turn(speech(4, 0.9, { callerReportsNotHearing: true }));
    v.turn(speech(4, 0.9, { callerReportsNotHearing: true }));
    const s = v.snapshot().audibility;
    expect(s.status).not.toBe('failed');
    expect(s.evidence.filter((e) => e.kind === 'warning')).toHaveLength(2);
    v.callEnded();
    expect(v.snapshot().audibility.status).toBe('unable');
  });

  it('an explicit remote key press during an armed diagnostic test verifies it', () => {
    const c = clock();
    const v = active(c);
    v.turn({ status: 'completed', ...played() });
    v.armKeyTest('1');
    c.advance(5000);
    v.remoteKey('5');
    expect(v.snapshot().audibility.status).toBe('verifying');
    v.remoteKey('1');
    const s = v.snapshot().audibility;
    expect(s).toMatchObject({ status: 'verified', source: 'remote-key-press' });
  });

  it('a key press without an armed test, after the window, or before the agent spoke proves nothing', () => {
    const c = clock();
    const v = active(c);
    v.remoteKey('1'); // not armed
    v.armKeyTest('1');
    v.remoteKey('1'); // agent has not spoken
    expect(v.snapshot().audibility.status).toBe('pending');
    v.turn({ status: 'completed', ...played() });
    v.armKeyTest('1', 10_000);
    c.advance(11_000);
    v.remoteKey('1'); // expired
    expect(v.snapshot().audibility.status).toBe('verifying');
  });
});

describe('isolation between calls and simulated setups', () => {
  it('each call starts from nothing: a verified call never leaks into the next', () => {
    const a = active();
    a.turn({ ...speech(4), ...played() });
    a.turn(speech(4));
    a.callEnded();
    expect(a.snapshot().inbound.status).toBe('verified');
    const b = new CallAudioVerifier('call-2', {});
    const s = b.snapshot();
    expect(s.callId).toBe('call-2');
    expect([s.inbound.status, s.transport.status, s.audibility.status]).toEqual(['pending', 'pending', 'pending']);
    expect(s.inbound.evidence).toEqual([]);
  });

  it('simulated hardware or mock providers can never be verified', () => {
    const v = new CallAudioVerifier('sim', { simulated: true });
    v.callActive();
    v.wireState('flowing');
    v.turn({ ...speech(5), ...played() });
    v.turn(speech(5));
    v.callEnded();
    const s = v.snapshot();
    for (const a of [s.inbound, s.transport, s.audibility]) expect(a.status).toBe('unable');
    expect(s.inbound.reason).toMatch(/simulated/);
  });

  it('a call that was never answered is Unable to verify on all three', () => {
    const v = new CallAudioVerifier('missed', {});
    v.callEnded();
    const s = v.snapshot();
    expect([s.inbound.status, s.transport.status, s.audibility.status]).toEqual(['unable', 'unable', 'unable']);
  });
});

describe('helpers', () => {
  it('counts real words, not punctuation', () => {
    expect(countWords('  yes, I can — 42 ... ')).toBe(4);
    expect(countWords('...')).toBe(0);
  });
  it('recognises callers who cannot hear, and not ordinary speech', () => {
    for (const t of ["I can't hear you", 'hello? hello?', 'can you hear me?', 'there is no sound', "you're breaking up"]) expect(detectHearingComplaint(t), t).toBe(true);
    for (const t of ['I can hear you fine', 'yes I would like an appointment', 'hello, this is Sam']) expect(detectHearingComplaint(t), t).toBe(false);
  });
  it('sanitizes credentials out of messages', () => {
    expect(sanitize('authorization: Bearer abc.def sk-live-ABCDEFGHIJKLMNOP')).not.toMatch(/abc\.def|ABCDEFGHIJKLMNOP/);
  });
});
