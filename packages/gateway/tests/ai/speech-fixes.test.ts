import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { BargeInDetector } from '../../src/ai/barge-in.js';
import { ConversationSession, TurnResult } from '../../src/ai/conversation.js';
import { EndpointerOptions, EnergyEndpointer, SpeechDetector, UtteranceInfo } from '../../src/ai/endpointer.js';
import { ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { DeepgramStreamingStt, deepgramListenWsUrl, WsLike } from '../../src/ai/providers/stt-stream.js';
import { ProviderSet } from '../../src/ai/providers/types.js';
import { loadSileroSession, SileroSession, SileroSpeechDetector, StreamResampler } from '../../src/ai/vad/silero.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, makeConfig, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

// ------------------------------------------------------------------------------------------------ audio helpers

const WINDOW_BYTES = 320; // 20 ms at 8 kHz, 16-bit mono

/** Constant-level audio: alternating +A/-A samples have an RMS of exactly A (a fraction of full scale). */
function level(rms: number, ms: number): Buffer {
  const samples = (8000 * ms) / 1000;
  const b = Buffer.alloc(samples * 2);
  const a = Math.round(rms * 32768);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? a : -a, i * 2);
  return b;
}
const SPEECH = 0.05;
const loud = (ms: number) => level(SPEECH, ms);
const quiet = (ms: number) => Buffer.alloc((8000 * ms * 2) / 1000);
const loudWindows = (pcm: Buffer): number => {
  let n = 0;
  for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) {
    let peak = 0;
    for (let i = 0; i < WINDOW_BYTES; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(o + i)));
    if (peak > 1000) n++;
  }
  return n;
};

function rig(options: Partial<EndpointerOptions> = {}) {
  let clock = 1000;
  const log = {
    soft: [] as number[],
    cancelled: [] as number[],
    utterances: [] as Array<{ pcm: Buffer; info: UtteranceInfo }>,
    starts: 0,
    streamed: [] as Array<{ bytes: number; start: boolean }>,
  };
  const endpointer = new EnergyEndpointer(
    FORMAT_8K,
    { rmsThreshold: 0.003, minSpeechMs: 200, minSilenceMs: 800, maxUtteranceMs: 60000, preRollMs: 100, now: () => clock, ...options },
    {
      onSpeechStart: () => void log.starts++,
      onSoftEnd: (_pcm, info) => void log.soft.push(info.id),
      onSoftCancel: (id) => void log.cancelled.push(id),
      onUtteranceAudio: (pcm, info) => void log.streamed.push({ bytes: pcm.length, start: info.start }),
      onUtterance: (pcm, info) => void log.utterances.push({ pcm, info }),
    }
  );
  const feed = (pcm: Buffer) => {
    for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) {
      clock += 20;
      endpointer.feed(pcm.subarray(o, o + WINDOW_BYTES));
    }
  };
  return { endpointer, log, feed };
}

// ------------------------------------------------------------------------------------------------ endpointing

describe('endpointing: stable wait, no lost speech', () => {
  it('a 700 ms pause stays inside one utterance when the configured wait is longer than it', () => {
    const r = rig({ minSilenceMs: 1000 });
    r.feed(loud(600));
    r.feed(quiet(700));
    r.feed(loud(600));
    r.feed(quiet(1100));
    expect(r.log.utterances).toHaveLength(1);
    expect(loudWindows(r.log.utterances[0].pcm)).toBe(60); // both stretches of speech, whole
  });

  it('the wait is exactly what is configured: a pause longer than it ends the utterance (documented, not adaptive)', () => {
    const r = rig({ minSilenceMs: 650 });
    r.feed(loud(600));
    r.feed(quiet(700));
    expect(r.log.utterances).toHaveLength(1);
    expect(r.endpointer.silenceTargetMs).toBe(650);
  });

  it('does not ratchet down: after many mid-sentence gaps the wait is still the configured one', () => {
    const r = rig({ minSilenceMs: 800 }); // adaptive is not set: the default is off
    for (let i = 0; i < 12; i++) {
      r.feed(loud(400));
      r.feed(quiet(200)); // a short gap, the kind the adaptive logic used to learn from
    }
    r.feed(loud(400));
    expect(r.endpointer.silenceTargetMs).toBe(800);
    expect(makeConfig().vad.adaptive).toBe(false);
  });

  it('keeps a short word that is followed by a brief gap and then more speech (the first word is not lost)', () => {
    const r = rig();
    r.feed(quiet(300));
    r.feed(loud(120)); // "I"
    r.feed(quiet(60)); // a gap well inside the onset hangover
    r.feed(loud(800)); // "want a website"
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(1);
    expect(loudWindows(r.log.utterances[0].pcm)).toBe(6 + 40);
  });

  it('keeps a short burst in the pre-roll even after a longer gap, when speech follows within the pre-roll window', () => {
    const r = rig({ preRollMs: 240, onsetHangoverMs: 100 });
    r.feed(quiet(300));
    r.feed(loud(100)); // a short word
    r.feed(quiet(120)); // longer than the hangover: the burst is over, but still inside the 240 ms pre-roll (100 + 120)
    r.feed(loud(800));
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(1);
    expect(loudWindows(r.log.utterances[0].pcm)).toBe(5 + 40);
  });

  it('click-only noise does not open an utterance, and a click far before speech is not dragged into it', () => {
    const r = rig();
    r.feed(quiet(200));
    r.feed(loud(40)); // a click
    r.feed(quiet(2000));
    expect(r.log.utterances).toHaveLength(0);
    expect(r.log.starts).toBe(0);

    r.feed(loud(40)); // another click ...
    r.feed(quiet(400)); // ... well outside the 100 ms pre-roll
    r.feed(loud(600));
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(1);
    expect(loudWindows(r.log.utterances[0].pcm)).toBe(30); // speech only
  });

  it('resumed speech after a short pause withdraws the soft end and stays one utterance', () => {
    const r = rig({ minSilenceMs: 800, softSilenceMs: 350 });
    r.feed(loud(600));
    r.feed(quiet(500)); // soft end offered at 350 ms, then the caller carries on
    expect(r.log.soft).toHaveLength(1);
    r.feed(loud(600));
    expect(r.log.cancelled).toEqual(r.log.soft);
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(1);
    expect(loudWindows(r.log.utterances[0].pcm)).toBe(60);
  });

  it('streams the utterance as it is spoken: pre-roll and speech at the start, then every window, in total the whole utterance', () => {
    const r = rig();
    r.feed(quiet(200));
    r.feed(loud(600));
    r.feed(quiet(900));
    expect(r.log.streamed[0].start).toBe(true);
    expect(r.log.streamed.slice(1).every((s) => !s.start && s.bytes === WINDOW_BYTES)).toBe(true);
    const total = r.log.streamed.reduce((n, s) => n + s.bytes, 0);
    expect(r.log.utterances).toHaveLength(1);
    expect(total).toBe(r.log.utterances[0].pcm.length);
  });

  it('a pluggable speech detector decides what is speech, and a failed one falls back to loudness', () => {
    // Treats a loud alternating (4 kHz) pattern as noise and anything else as speech: loudness alone cannot tell them apart.
    const noiseBurst = (ms: number) => loud(ms);
    const voiced = (ms: number) => speechPcm(ms);
    const detector: SpeechDetector & { healthy?: boolean } = {
      name: 'fake',
      healthy: true,
      isSpeech: (w) => {
        let changes = 0;
        for (let i = 2; i < w.length; i += 2) if (w.readInt16LE(i) > 0 !== w.readInt16LE(i - 2) > 0) changes++;
        return changes / (w.length / 2) < 0.2 && Math.abs(w.readInt16LE(20)) > 100;
      },
      reset: () => {},
    };
    const r = rig({ speechDetector: detector });
    r.feed(quiet(200));
    r.feed(noiseBurst(600)); // loud, but not speech
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(0);
    r.feed(voiced(600));
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(1);

    detector.healthy = false; // the model failed: loudness decides again, so the call is not left deaf
    r.feed(noiseBurst(600));
    r.feed(quiet(900));
    expect(r.log.utterances).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ cancellation and merging

describe('cancellation during recognition, merging and cancel sources', () => {
  const build = (providers: Partial<ProviderSet> & { stt: ScriptedStt }, env: Record<string, string | undefined> = {}) => {
    const full: ProviderSet = {
      llm: new ScriptedLlm(['Okay, noted.']),
      tts: new ToneTts(),
      ...providers,
    } as ProviderSet;
    const session = new ConversationSession({ callId: 'c1', config: makeConfig(env), providers: full, sink: new CollectingAudioSink(FORMAT_8K) });
    return { session, providers: full };
  };
  const userTexts = (s: ConversationSession) => s.getHistory().filter((m) => m.role === 'user').map((m) => m.content);

  it('a new utterance during recognition merges the earlier audio instead of dropping it', async () => {
    const stt = new ScriptedStt(['ignored', 'I need a chatbot for my website'], 60);
    const { session } = build({ stt });
    const a = speechPcm(1200);
    const b = speechPcm(900);
    const first = session.handleUtterance(a, 'a');
    await sleep(15);
    const second = session.handleUtterance(b, 'b');
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toMatchObject({ status: 'cancelled', reason: 'aborted-during-stt', cancelSource: 'endpoint-continuation' });
    expect(r2.status).toBe('completed');
    expect(stt.calls).toHaveLength(2);
    expect(stt.calls[1].bytes).toBe(a.length + b.length); // one transcription of the whole sentence
    expect(userTexts(session)).toEqual(['I need a chatbot for my website']); // said once, nothing duplicated
  });

  it('a reply replaced before any of it was played: its audio is transcribed again together with the new speech, each part once', async () => {
    const stt = new ScriptedStt(['first part', 'first part second part']);
    const llm = new ScriptedLlm(['A reply that is slow to arrive.'], { delayMs: 120 });
    const { session } = build({ stt, llm });
    const a = speechPcm(1000);
    const b = speechPcm(800);
    const first = session.handleUtterance(a, 'a');
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1)); // A's words are in the history now
    const second = session.handleUtterance(b, 'b');
    const [r1] = await Promise.all([first, second]);

    expect(r1).toMatchObject({ status: 'cancelled', reason: 'interrupted', cancelSource: 'endpoint-continuation' });
    expect(stt.calls[1].bytes).toBe(a.length + b.length); // the question goes back to audio and is heard with what followed (so noise can never leave it unanswered)
    expect(userTexts(session)).toEqual(['first part second part']); // each part exactly once
  });

  it('records who cancelled: caller speech, endpoint continuation, manual, teardown', async () => {
    const run = async (cancel: (s: ConversationSession) => void | Promise<void>): Promise<TurnResult> => {
      const stt = new ScriptedStt(['hello there'], 0);
      const llm = new ScriptedLlm(['A reply that is slow to arrive.'], { delayMs: 150 });
      const { session } = build({ stt, llm });
      const turn = session.handleUtterance(speechPcm(1000), 'u');
      await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
      await cancel(session);
      return turn;
    };
    expect((await run((s) => s.interrupt('caller-speech'))).cancelSource).toBe('caller-speech');
    expect((await run((s) => s.interrupt())).cancelSource).toBe('manual');
    expect((await run((s) => s.interrupt('manual'))).cancelSource).toBe('manual');
    expect((await run((s) => s.close('call ended'))).cancelSource).toBe('teardown');
  });

  it('keeps the audio after a caller-speech cancel during recognition, but not after a manual or teardown cancel', async () => {
    const attempt = async (cancel: (s: ConversationSession) => void) => {
      const stt = new ScriptedStt(['one', 'two'], 60);
      const { session } = build({ stt });
      const a = speechPcm(1000);
      const b = speechPcm(700);
      const first = session.handleUtterance(a, 'a');
      await sleep(15);
      cancel(session);
      const r1 = await first;
      const r2 = await session.handleUtterance(b, 'b');
      return { r1, r2, stt, a, b };
    };
    const caller = await attempt((s) => s.interrupt('caller-speech'));
    expect(caller.r1.cancelSource).toBe('caller-speech');
    expect(caller.stt.calls[1].bytes).toBe(caller.a.length + caller.b.length);

    const manual = await attempt((s) => s.interrupt('manual'));
    expect(manual.stt.calls[1].bytes).toBe(manual.b.length);
  });

  it('closing the session releases a pending streaming recognizer and never merges into a closed session', async () => {
    const closes: string[] = [];
    const stream = fakeStream({ onClose: () => closes.push('closed'), finalize: () => new Promise(() => {}) });
    const { session } = build({ stt: new ScriptedStt(['x'], 0) });
    const turn = session.handleUtterance(speechPcm(1000), 'u', { stream });
    await sleep(15);
    await session.close('call ended');
    await turn;
    expect(closes).toEqual(['closed']);
    expect((await session.handleUtterance(speechPcm(500), 'late')).reason).toBe('session-closed');
  });
});

// ------------------------------------------------------------------------------------------------ streaming STT

interface FakeWsOptions {
  autoOpen?: boolean;
  /** Final text the server returns for each Finalize, in order; '' once the list runs out (nothing left to say). */
  finals?: string[];
  /** Answer Finalize at all (false models a server that never finalizes). */
  answer?: boolean;
}

class FakeWs implements WsLike {
  readyState = 0;
  sent: Array<Buffer | string> = [];
  closed = false;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onerror: WsLike['onerror'] = null;
  onclose: WsLike['onclose'] = null;
  private finalizes = 0;

  constructor(
    readonly url: string,
    readonly protocols: string[],
    private readonly options: FakeWsOptions
  ) {
    if (options.autoOpen !== false) queueMicrotask(() => this.open());
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: Buffer | string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
    if (typeof data === 'string' && JSON.parse(data).type === 'Finalize' && this.options.answer !== false) {
      const text = this.options.finals?.[this.finalizes] ?? '';
      this.finalizes++;
      this.serverSend(result(text, { final: true, fromFinalize: true }));
    }
  }
  close(): void {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.();
  }
  serverSend(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  get audioBytes(): number {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s)).reduce((n, b) => n + b.length, 0);
  }
  get controls(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s).type);
  }
}

function result(text: string, flags: { final: boolean; fromFinalize?: boolean }) {
  return { type: 'Results', is_final: flags.final, from_finalize: flags.fromFinalize === true, channel: { alternatives: [{ transcript: text }] } };
}

function sockets(options: FakeWsOptions = {}) {
  const made: FakeWs[] = [];
  return { made, factory: (url: string, protocols: string[]) => (made[made.push(new FakeWs(url, protocols, options)) - 1] as WsLike) };
}

function fakeStream(parts: { finalize?: () => Promise<{ text: string } | null>; onClose?: () => void } = {}) {
  return {
    interim: '',
    error: null,
    push: () => {},
    flush: () => {},
    finalize: parts.finalize ?? (async () => ({ text: '' })),
    close: () => parts.onClose?.(),
  };
}

const provider = (factory: ReturnType<typeof sockets>['factory'], extra: Record<string, unknown> = {}) =>
  new DeepgramStreamingStt({ apiKey: 'dg-test-key-0123456789', model: 'nova-3', language: 'en', keyterms: ['Call Assure', 'Voicely'], finalizeTimeoutMs: 120, quietMs: 40, webSocketFactory: factory, ...extra });

describe('streaming Deepgram provider', () => {
  it('uses the source project endpoint rules, declares the real audio format, and keeps the key out of the URL', () => {
    const { made, factory } = sockets();
    provider(factory).open(FORMAT_8K, new AbortController().signal);
    const url = new URL(made[0].url);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.au.deepgram.com'); // English uses the AU endpoint, as deepgram_stt.py does
    expect(url.pathname).toBe('/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '8000', // the gateway's own rate, not relabelled
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
    });
    expect(url.searchParams.getAll('keyterm')).toEqual(['Call Assure', 'Voicely']);
    expect(made[0].url).not.toContain('dg-test-key');
    expect(made[0].protocols).toEqual(['token', 'dg-test-key-0123456789']);

    expect(new URL(deepgramListenWsUrl({ model: 'nova-3', language: 'multi', sampleRate: 16000, keyterms: [] })).hostname).toBe('api.deepgram.com');
  });

  it('holds audio until the connection opens, then sends it in order, as binary frames', async () => {
    const { made, factory } = sockets({ autoOpen: false });
    const stream = provider(factory).open(FORMAT_8K, new AbortController().signal);
    stream.push(Buffer.alloc(320, 1));
    stream.push(Buffer.alloc(320, 2));
    expect(made[0].sent).toHaveLength(0);
    made[0].open();
    stream.push(Buffer.alloc(320, 3));
    expect(made[0].sent.map((s) => (Buffer.isBuffer(s) ? s[0] : s))).toEqual([1, 2, 3]);
    stream.close();
  });

  it('uses only final results; interim hypotheses are exposed for display and never become the transcript', async () => {
    const { made, factory } = sockets({ finals: [], answer: false });
    const stream = provider(factory, { finalizeTimeoutMs: 80 }).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    made[0].serverSend(result('hello wor', { final: false }));
    expect(stream.interim).toBe('hello wor');
    expect(await stream.finalize()).toBeNull(); // nothing final arrived: the caller must use the batch provider
    stream.close();
  });

  it('joins final segments in order and answers once the flush is acknowledged', async () => {
    const { made, factory } = sockets({ finals: [''] });
    const stream = provider(factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    made[0].serverSend(result('what time', { final: true }));
    made[0].serverSend(result('do you close', { final: true }));
    made[0].serverSend(result('on friday', { final: false }));
    const final = await stream.finalize();
    expect(final).toEqual({ text: 'what time do you close' }); // the interim 'on friday' is not included
    expect(made[0].controls).toContain('Finalize');
    stream.close();
    expect(made[0].controls).toContain('CloseStream');
    expect(made[0].closed).toBe(true);
  });

  it('answers when the server already finalized everything and has nothing left to flush', async () => {
    const { made, factory } = sockets({ answer: false });
    const stream = provider(factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    made[0].serverSend(result('already final', { final: true }));
    expect(await stream.finalize()).toEqual({ text: 'already final' });
    stream.close();
  });

  it('fails cleanly on a socket error, a provider error message, an early close and an abort', async () => {
    const errored = sockets();
    const s1 = provider(errored.factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    errored.made[0].onerror?.();
    expect(s1.error).toBeTruthy();
    expect(await s1.finalize()).toBeNull();

    const bad = sockets();
    const s2 = provider(bad.factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    bad.made[0].serverSend({ type: 'Error', description: 'invalid credentials' });
    expect(s2.error?.message).toMatch(/invalid credentials/);
    expect(await s2.finalize()).toBeNull();
    expect(bad.made[0].closed).toBe(true);

    const early = sockets();
    const s3 = provider(early.factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    early.made[0].onclose?.();
    expect(await s3.finalize()).toBeNull();

    const aborted = sockets({ answer: false });
    const controller = new AbortController();
    const s4 = provider(aborted.factory, { finalizeTimeoutMs: 5000 }).open(FORMAT_8K, controller.signal);
    await Promise.resolve();
    const pending = s4.finalize();
    controller.abort();
    expect(await pending).toBeNull();
    expect(aborted.made[0].closed).toBe(true);
    // An error message never carries the key.
    expect(JSON.stringify([s1.error?.message, s2.error?.message, s3.error?.message])).not.toContain('dg-test-key');
  });

  it('times out a connection that never opens, and a queue that grows without one', async () => {
    const slow = sockets({ autoOpen: false });
    const s1 = provider(slow.factory, { connectTimeoutMs: 40 }).open(FORMAT_8K, new AbortController().signal);
    await sleep(80);
    expect(s1.error?.message).toMatch(/did not open/);

    const stuck = sockets({ autoOpen: false });
    const s2 = provider(stuck.factory, { maxQueuedSeconds: 1 }).open(FORMAT_8K, new AbortController().signal);
    for (let i = 0; i < 60; i++) s2.push(Buffer.alloc(320));
    expect(s2.error?.message).toMatch(/too much audio/);
  });

  it('a factory that throws (no WebSocket available) is a failed stream, not an exception', () => {
    const stream = provider(() => {
      throw new Error('this Node.js has no built-in WebSocket');
    }).open(FORMAT_8K, new AbortController().signal);
    expect(stream.error?.message).toMatch(/no built-in WebSocket/);
    stream.push(Buffer.alloc(320)); // must not throw
  });
});

describe('streaming recognition inside a turn: final text only, batch fallback', () => {
  const build = (stt: ScriptedStt) => {
    const llm = new ScriptedLlm(['Okay, noted.']);
    const session = new ConversationSession({
      callId: 'c1',
      config: makeConfig(),
      providers: { stt, llm, tts: new ToneTts() },
      sink: new CollectingAudioSink(FORMAT_8K),
    });
    return { session, llm };
  };

  it('uses the final streamed text, never calls the batch provider, and releases the socket after the turn', async () => {
    const { made, factory } = sockets({ finals: ['what time do you close'] });
    const stream = provider(factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    const pcm = speechPcm(1200);
    stream.push(pcm);
    const stt = new ScriptedStt(['batch should not be used']);
    const { session, llm } = build(stt);
    const turn = await session.handleUtterance(pcm, 'u', { stream });

    expect(turn.status).toBe('completed');
    expect(stt.calls).toHaveLength(0);
    expect(llm.requests[0].messages).toEqual([{ role: 'user', content: 'what time do you close' }]);
    expect(made[0].closed).toBe(true);
    expect(turn.metrics.sttMs).not.toBeNull();
    expect(turn.metrics.speculativeStt).toBe(false);
  });

  it('never replies from an interim transcript: when only interim text exists the batch provider supplies the words', async () => {
    const { made, factory } = sockets({ answer: false });
    const stream = provider(factory, { finalizeTimeoutMs: 80 }).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    made[0].serverSend(result('interim only words', { final: false }));
    const stt = new ScriptedStt(['the batch transcript']);
    const { session, llm } = build(stt);
    const turn = await session.handleUtterance(speechPcm(1200), 'u', { stream });

    expect(turn.status).toBe('completed');
    expect(stt.calls).toHaveLength(1); // fell back
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].messages[0].content).toBe('the batch transcript');
    expect(JSON.stringify(llm.requests)).not.toContain('interim only words');
  });

  it('does not drop speech the stream missed: an empty final for audio that looks like speech goes to the batch provider', async () => {
    const emptyStream = () => fakeStream({ finalize: async () => ({ text: '' }) });
    const stt = new ScriptedStt(['hello there I need help']);
    const { session, llm } = build(stt);
    const turn = await session.handleUtterance(speechPcm(1500), 'u', { stream: emptyStream() });
    expect(turn.status).toBe('completed');
    expect(stt.calls).toHaveLength(1);
    expect(llm.requests[0].messages[0].content).toBe('hello there I need help');

    // When the batch provider also hears nothing the turn is skipped, with exactly one batch call and no reply.
    const none = new ScriptedStt(['']);
    const second = build(none);
    const skipped = await second.session.handleUtterance(speechPcm(1500), 'u2', { stream: emptyStream() });
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'empty-transcript' });
    expect(none.calls).toHaveLength(1);
    expect(second.llm.requests).toHaveLength(0);
  });

  it('falls back to the batch provider when the stream failed', async () => {
    const { made, factory } = sockets();
    const stream = provider(factory).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    made[0].onerror?.();
    const stt = new ScriptedStt(['batch words here']);
    const { session, llm } = build(stt);
    const turn = await session.handleUtterance(speechPcm(1200), 'u', { stream });
    expect(turn.status).toBe('completed');
    expect(llm.requests[0].messages[0].content).toBe('batch words here');
  });

  it('cancelling while the final text is pending cancels the turn without a reply and keeps the audio for the next one', async () => {
    const stt = new ScriptedStt(['whole sentence here'], 0);
    const { session, llm } = build(stt);
    const { made, factory } = sockets({ answer: false });
    const stream = provider(factory, { finalizeTimeoutMs: 5000 }).open(FORMAT_8K, new AbortController().signal);
    await Promise.resolve();
    const a = speechPcm(1000);
    const b = speechPcm(800);
    const first = session.handleUtterance(a, 'a', { stream });
    await sleep(20);
    session.interrupt('caller-speech');
    const r1 = await first;
    expect(r1).toMatchObject({ status: 'cancelled', reason: 'aborted-during-stt', cancelSource: 'caller-speech' });
    expect(llm.requests).toHaveLength(0);
    expect(made[0].closed).toBe(true);
    const r2 = await session.handleUtterance(b, 'b');
    expect(r2.status).toBe('completed');
    expect(stt.calls[0].bytes).toBe(a.length + b.length); // merged, transcribed once, in batch (the stream covered only A)
  });
});

// ------------------------------------------------------------------------------------------------ gateway integration

describe('gateway: a streamed utterance through the endpointer and orchestrator', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });
  const KEY = 'speech-fixes-test-key';

  async function harness(options: { sttStream?: ReturnType<typeof provider>; stt?: ScriptedStt; llm?: ScriptedLlm; env?: Record<string, string> }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-fixes-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true);
    const stt = options.stt ?? new ScriptedStt(['batch transcript']);
    const llm = options.llm ?? new ScriptedLlm(['We close at five. Anything else I can do for you?']);
    const providers: ProviderSet = { stt, llm, tts: new ToneTts(), ...(options.sttStream ? { sttStream: options.sttStream } : {}) };
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'gateway.sqlite'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv({ AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true', AI_PLAYBACK_GUARD_MS: '0', ...options.env }),
        providers,
        allowSimulatedHardware: true,
        mode: 'active',
        transports: () => ({ source, sink }),
      },
    });
    await modem.initialize();
    server.aiOrchestrator?.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
    await server.callManager.activateUsbAudioDiagnostic!();
    await sleep(60);
    await server.aiOrchestrator!.arm(call.id);
    return { server, source, sink, stt, llm, call };
  }

  it('streams the caller as they speak and replies only after the final text at the confirmed endpoint', async () => {
    const { made, factory } = sockets({ finals: ['what time do you close'] });
    const h = await harness({ sttStream: provider(factory) });
    h.source.push(speechPcm(1200));
    // Speech is streamed while it is spoken, before any endpoint exists.
    await vi.waitFor(() => expect(made[0]?.audioBytes ?? 0).toBeGreaterThan(8000));
    expect(h.llm.requests).toHaveLength(0);
    h.source.push(noiseFloorPcm(1200)); // the pause that ends the turn
    await vi.waitFor(() => expect(h.sink.played.length).toBeGreaterThan(0));

    expect(h.stt.calls).toHaveLength(0); // the batch provider was not needed
    expect(h.llm.requests).toHaveLength(1);
    expect(h.llm.requests[0].messages[0]).toEqual({ role: 'user', content: 'what time do you close' });
    expect(made[0].controls.filter((c) => c === 'Finalize').length).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(made[0].closed).toBe(true));
  });

  it('with only interim text from the server the reply is built from the batch transcript, never the interim one', async () => {
    const { made, factory } = sockets({ answer: false });
    const h = await harness({ sttStream: provider(factory, { finalizeTimeoutMs: 100 }) });
    h.source.push(speechPcm(1200));
    await vi.waitFor(() => expect(made.length).toBe(1));
    made[0].serverSend(result('interim words that must not be used', { final: false }));
    h.source.push(noiseFloorPcm(1200));
    await vi.waitFor(() => expect(h.sink.played.length).toBeGreaterThan(0));
    expect(h.stt.calls).toHaveLength(1);
    expect(h.llm.requests[0].messages[0].content).toBe('batch transcript');
    expect(JSON.stringify(h.llm.requests)).not.toContain('interim words that must not');
  });

  it('caller continuation after a short pause is one turn from merged audio: transcribed together, answered once', async () => {
    const stt = new ScriptedStt((n) => (n === 0 ? 'partial' : 'I want to book a visit for next week'), 120);
    const h = await harness({ stt, env: { AI_VAD_MIN_SILENCE_MS: '400', AI_VAD_SOFT_SILENCE_MS: '0' } });
    h.source.push(speechPcm(900));
    h.source.push(noiseFloorPcm(440)); // a pause just past the 400 ms wait: the turn starts and goes into recognition
    h.source.push(speechPcm(900)); // the caller carries on while it is still being recognized
    h.source.push(noiseFloorPcm(600));
    await vi.waitFor(() => expect(h.sink.played.length).toBeGreaterThan(0), { timeout: 4000 });

    expect(h.llm.requests).toHaveLength(1); // answered once, not twice
    expect(h.llm.requests[0].messages.filter((m) => m.role === 'user')).toEqual([{ role: 'user', content: 'I want to book a visit for next week' }]);
    expect(h.stt.calls.length).toBe(2);
    expect(h.stt.calls[1].bytes).toBeGreaterThan(h.stt.calls[0].bytes + 12000); // the second request carries both stretches
  });
});

// ------------------------------------------------------------------------------------------------ barge-in detector

describe('barge-in detection on this line', () => {
  const feedAll = (d: BargeInDetector, parts: Array<[number, number]>): boolean => {
    let fired = false;
    for (const [rms, ms] of parts) {
      const pcm = level(rms, ms);
      for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) if (d.feed(pcm.subarray(o, o + WINDOW_BYTES))) fired = true;
    }
    return fired;
  };
  const make = () => new BargeInDetector(FORMAT_8K, { minMs: 300, echoMultiplier: 2.5, floor: 0.006 });

  it('steady echo of the agent does not interrupt it', () => {
    expect(feedAll(make(), [[0.02, 4000]])).toBe(false);
  });

  it('background silence (the idle stream is a few steps either side of zero) never interrupts', () => {
    expect(feedAll(make(), [[0.00006, 5000]])).toBe(false);
  });

  it('echo that rises a little, below the multiplier, does not interrupt', () => {
    expect(feedAll(make(), [[0.02, 1000], [0.035, 2000]])).toBe(false);
  });

  it('a caller talking clearly over the agent does interrupt', () => {
    expect(feedAll(make(), [[0.02, 1000], [0.2, 600]])).toBe(true);
  });

  it('a short burst of noise over the agent (under the sustained time) does not interrupt', () => {
    expect(feedAll(make(), [[0.02, 1000], [0.2, 140], [0.02, 1000]])).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ Silero adapter

/** A fake Silero session that follows the model contract and records what it was given. */
function fakeSilero(probability: (input: Float32Array) => number, options: { async?: boolean } = {}) {
  const calls: Array<{ length: number; sr: number; state0: number; head: Float32Array }> = [];
  const session: SileroSession = {
    run(input, state, sr) {
      calls.push({ length: input.length, sr, state0: state[0], head: input.slice(0, 4) });
      const next = new Float32Array(state.length);
      next[0] = calls.length; // the state the model hands back: proves it is passed into the next call
      const out = { probability: probability(input), state: next };
      return options.async ? Promise.resolve(out) : out;
    },
  };
  return { session, calls };
}
const rmsOf = (input: Float32Array): number => Math.sqrt(input.reduce((s, v) => s + v * v, 0) / input.length);
const speechLike = (input: Float32Array) => (rmsOf(input) > 0.02 ? 0.9 : 0.05);

function feedDetector(d: SileroSpeechDetector, pcm: Buffer): boolean[] {
  const out: boolean[] = [];
  for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) out.push(d.isSpeech(pcm.subarray(o, o + WINDOW_BYTES)));
  return out;
}

describe('Silero VAD adapter', () => {
  it('gives 8 kHz audio to the model as 8 kHz (never relabelled), in 256-sample windows with a 32-sample context', () => {
    const fake = fakeSilero(speechLike);
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 8000, threshold: 0.5 });
    feedDetector(d, speechPcm(400));
    expect(d.modelRate).toBe(8000);
    expect(fake.calls.length).toBeGreaterThan(5);
    expect(new Set(fake.calls.map((c) => c.sr))).toEqual(new Set([8000]));
    expect(new Set(fake.calls.map((c) => c.length))).toEqual(new Set([32 + 256]));
  });

  it('gives 16 kHz audio to the model as 16 kHz in 512-sample windows with a 64-sample context', () => {
    const fake = fakeSilero(speechLike);
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 16000, threshold: 0.5 });
    const pcm = speechPcm(400, 16000);
    for (let o = 0; o + 640 <= pcm.length; o += 640) d.isSpeech(pcm.subarray(o, o + 640)); // 20 ms at 16 kHz
    expect(new Set(fake.calls.map((c) => c.sr))).toEqual(new Set([16000]));
    expect(new Set(fake.calls.map((c) => c.length))).toEqual(new Set([64 + 512]));
  });

  it('resamples other rates to 16 kHz and tells the model the truth about it', () => {
    const fake = fakeSilero(speechLike);
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 24000, threshold: 0.5 });
    const pcm = speechPcm(640, 24000);
    for (let o = 0; o + 960 <= pcm.length; o += 960) d.isSpeech(pcm.subarray(o, o + 960)); // 20 ms at 24 kHz
    expect(d.modelRate).toBe(16000);
    expect(new Set(fake.calls.map((c) => c.sr))).toEqual(new Set([16000]));
    // 640 ms at 16 kHz is 10240 samples = 20 windows of 512 (give or take the resampler's one-sample hold-back)
    expect(fake.calls.length).toBeGreaterThanOrEqual(19);
    expect(fake.calls.length).toBeLessThanOrEqual(20);
  });

  it('passes the model state and the previous window\'s tail into the next step, and reset clears both', () => {
    const fake = fakeSilero(speechLike);
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 8000, threshold: 0.5 });
    feedDetector(d, speechPcm(200));
    expect(fake.calls[0].state0).toBe(0);
    expect(fake.calls[1].state0).toBe(1); // stateN of call 1 went into call 2
    expect(fake.calls[0].head.every((v) => v === 0)).toBe(true); // no context before the first window
    expect(Array.from(fake.calls[1].head).some((v) => v !== 0)).toBe(true); // the previous window's tail is the context
    d.reset();
    fake.calls.length = 0;
    feedDetector(d, speechPcm(100));
    expect(fake.calls[0].state0).toBe(0);
    expect(fake.calls[0].head.every((v) => v === 0)).toBe(true);
  });

  it('applies the speech probability threshold', () => {
    const fake = fakeSilero(speechLike);
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 8000, threshold: 0.5 });
    expect(feedDetector(d, quiet(200)).some(Boolean)).toBe(false);
    expect(feedDetector(d, speechPcm(400)).at(-1)).toBe(true);
    expect(feedDetector(d, quiet(400)).at(-1)).toBe(false);
  });

  it('works with an asynchronous model session (the real runtime is async) and keeps the steps in order', async () => {
    const fake = fakeSilero(speechLike, { async: true });
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 8000, threshold: 0.5 });
    feedDetector(d, speechPcm(400));
    await sleep(10);
    expect(fake.calls.map((c) => c.state0)).toEqual(fake.calls.map((_, i) => i)); // each step saw the previous step's state
    expect(feedDetector(d, speechPcm(100)).at(-1)).toBe(true);
  });

  it('marks itself unhealthy when the model throws, so the endpointer falls back to loudness', () => {
    const errors: string[] = [];
    const d = new SileroSpeechDetector({
      session: {
        run() {
          throw new Error('inference failed');
        },
      },
      inputRate: 8000,
      threshold: 0.5,
      onError: (e) => errors.push(e.message),
    });
    feedDetector(d, speechPcm(200));
    expect(d.healthy).toBe(false);
    expect(errors).toEqual(['inference failed']);

    let clock = 1000;
    const utterances: Buffer[] = [];
    const ep = new EnergyEndpointer(FORMAT_8K, { rmsThreshold: 0.003, minSpeechMs: 200, minSilenceMs: 400, maxUtteranceMs: 30000, preRollMs: 100, speechDetector: d, now: () => clock }, { onUtterance: (pcm) => void utterances.push(pcm) });
    for (const chunk of [speechPcm(600), quiet(600)]) for (let o = 0; o + WINDOW_BYTES <= chunk.length; o += WINDOW_BYTES) (clock += 20), ep.feed(chunk.subarray(o, o + WINDOW_BYTES));
    expect(utterances).toHaveLength(1);
  });

  it('drives the endpointer: model-judged speech opens an utterance, a loud non-speech burst does not', () => {
    // A loud 4 kHz alternating pattern is energetic but not speech; the fake model says so.
    const fake = fakeSilero((input) => {
      let changes = 0;
      for (let i = 1; i < input.length; i++) if (input[i] > 0 !== input[i - 1] > 0) changes++;
      return changes / input.length < 0.2 && rmsOf(input) > 0.02 ? 0.9 : 0.05;
    });
    const d = new SileroSpeechDetector({ session: fake.session, inputRate: 8000, threshold: 0.5 });
    let clock = 1000;
    const utterances: Buffer[] = [];
    const ep = new EnergyEndpointer(FORMAT_8K, { rmsThreshold: 0.003, minSpeechMs: 200, minSilenceMs: 400, maxUtteranceMs: 30000, preRollMs: 100, speechDetector: d, now: () => clock }, { onUtterance: (pcm) => void utterances.push(pcm) });
    const run = (chunk: Buffer) => {
      for (let o = 0; o + WINDOW_BYTES <= chunk.length; o += WINDOW_BYTES) {
        clock += 20;
        ep.feed(chunk.subarray(o, o + WINDOW_BYTES));
      }
    };
    run(quiet(300));
    run(level(0.3, 800)); // loud noise
    run(quiet(800));
    expect(utterances).toHaveLength(0);
    run(speechPcm(800));
    run(quiet(800));
    expect(utterances).toHaveLength(1);
  });

  it('streaming resampling is continuous across 20 ms chunks', () => {
    const whole = new Float32Array(2400);
    for (let i = 0; i < whole.length; i++) whole[i] = Math.sin((2 * Math.PI * 440 * i) / 24000);
    const one = new StreamResampler(24000, 16000).process(whole);
    const chunked: number[] = [];
    const r = new StreamResampler(24000, 16000);
    for (let o = 0; o < whole.length; o += 480) chunked.push(...r.process(whole.slice(o, o + 480)));
    expect(Math.abs(chunked.length - one.length)).toBeLessThanOrEqual(1);
    const n = Math.min(chunked.length, one.length);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(chunked[i] - one[i]));
    expect(maxDiff).toBeLessThan(1e-4);
    expect(Math.abs(one.length - 1600)).toBeLessThanOrEqual(1);
  });

  describe('loading the model', () => {
    it('names the model file when it is missing', async () => {
      await expect(loadSileroSession(path.join(os.tmpdir(), 'no-such-silero.onnx'), async () => ({}))).rejects.toThrow(/model file was not found/);
    });

    it('names the runtime when it is not installed', async () => {
      const file = path.join(os.tmpdir(), `silero-test-${Date.now()}.onnx`);
      fs.writeFileSync(file, 'not a model');
      try {
        await expect(
          loadSileroSession(file, async () => {
            throw new Error('Cannot find package');
          })
        ).rejects.toThrow(/onnxruntime-node package is not installed/);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('feeds the runtime the documented tensors and reads back probability and state', async () => {
      const file = path.join(os.tmpdir(), `silero-test-${Date.now()}-b.onnx`);
      fs.writeFileSync(file, 'not a model');
      const seen: Array<{ name: string; type: string; dims: number[] }> = [];
      class Tensor {
        constructor(
          readonly type: string,
          readonly data: ArrayLike<unknown>,
          readonly dims: number[]
        ) {}
      }
      const ort = {
        Tensor,
        InferenceSession: {
          create: async () => ({
            run: async (feeds: Record<string, Tensor>) => {
              for (const [name, t] of Object.entries(feeds)) seen.push({ name, type: t.type, dims: t.dims });
              return { output: { data: [0.73] }, stateN: { data: new Float32Array(256).fill(0.5) } };
            },
          }),
        },
      };
      try {
        const session = await loadSileroSession(file, async () => ort);
        const out = await session.run(new Float32Array(288), new Float32Array(256), 8000);
        expect(out.probability).toBeCloseTo(0.73);
        expect(out.state).toHaveLength(256);
        expect(seen).toEqual([
          { name: 'input', type: 'float32', dims: [1, 288] },
          { name: 'state', type: 'float32', dims: [2, 1, 128] },
          { name: 'sr', type: 'int64', dims: [] },
        ]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });
});
