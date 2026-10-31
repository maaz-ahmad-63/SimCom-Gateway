import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ConversationSession } from '../../src/ai/conversation.js';
import { IdleManager, idleActionAfterTurn } from '../../src/ai/idle.js';
import { createMockProviders, ScriptedLlm } from '../../src/ai/providers/mock.js';
import { FORMAT_8K, makeConfig, sleep, speechPcm } from './helpers.js';

// Calls 9da41342 and 0710a7d4: an idle check-in fired while a reply was being spoken, because a cancelled empty turn re-armed
// the idle clock and say() ran beside the running turn.

afterEach(() => vi.useRealTimers());

describe('idle manager', () => {
  const make = (isBusy: () => boolean) => {
    const say = vi.fn(async () => undefined);
    const idle = new IdleManager({ followups: ['Hello?'], goodbye: 'Bye', say, disconnect: () => undefined, isBusy, waitsMs: [100, 100, 100], random: () => 0 });
    return { say, idle };
  };

  it('1. does not fire during active agent speech; it waits and checks again, without advancing the count', async () => {
    vi.useFakeTimers();
    let busy = true;
    const { say, idle } = make(() => busy);
    idle.enable();
    idle.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(say).not.toHaveBeenCalled();
    expect(idle.idleCount).toBe(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(110);
    expect(say).toHaveBeenCalledTimes(1);
    expect(idle.idleCount).toBe(1);
  });

  it('resets after genuine caller activity and pauses while the caller speaks', async () => {
    vi.useFakeTimers();
    const { say, idle } = make(() => false);
    idle.enable();
    idle.start();
    await vi.advanceTimersByTimeAsync(110);
    expect(idle.idleCount).toBe(1);
    idle.pause(); // the caller starts talking
    await vi.advanceTimersByTimeAsync(500);
    expect(say).toHaveBeenCalledTimes(1);
    idle.resetOnUserSpeech(); // real words arrived
    expect(idle.idleCount).toBe(0);
    await vi.advanceTimersByTimeAsync(110);
    expect(say).toHaveBeenCalledTimes(2);
  });
});

describe('what a finished turn does to the idle clock', () => {
  it('2. a cancelled turn with no words does not re-arm the timer', () => {
    expect(idleActionAfterTurn({ status: 'cancelled', transcriptChars: 0 })).toBe('none');
    expect(idleActionAfterTurn({ status: 'cancelled' })).toBe('none');
  });
  it('real words reset the count; an empty completed or skipped turn (our own follow-up) restarts the clock', () => {
    expect(idleActionAfterTurn({ status: 'completed', transcriptChars: 12 })).toBe('reset');
    expect(idleActionAfterTurn({ status: 'cancelled', transcriptChars: 12 })).toBe('reset');
    expect(idleActionAfterTurn({ status: 'completed', transcriptChars: 0 })).toBe('restart');
    expect(idleActionAfterTurn({ status: 'skipped', transcriptChars: 0 })).toBe('restart');
  });
});

describe('say() beside a running turn', () => {
  const LONG = 'First sentence of a long reply goes here. Second sentence of the reply goes here. Third sentence follows.';
  const build = () => {
    const llm = new ScriptedLlm([LONG], { chunkChars: 10, delayMs: 20 });
    const sink = new CollectingAudioSink(FORMAT_8K, true, 60);
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers: { ...createMockProviders({ stt: ['tell me about your services'] }), llm }, sink });
    return { session, sink };
  };

  it('4. is refused while another turn is active: no concurrent turn, no audio, controller untouched', async () => {
    const { session, sink } = build();
    const turn = session.handleUtterance(speechPcm(1200), 'u1');
    while (sink.playCalls < 1) await sleep(5);
    expect(session.isAgentActive).toBe(true);
    const plays = sink.playCalls;
    const said = await session.say('Hello? Are you still there?');
    expect(said).toMatchObject({ status: 'skipped', reason: 'turn-active', turnId: 0 });
    expect(sink.playCalls).toBe(plays);
    session.interrupt('caller-speech'); // the running turn is still the one the caller can cancel
    expect(await turn).toMatchObject({ status: 'cancelled', cancelSource: 'caller-speech' });
    expect(session.isAgentActive).toBe(false);
  });

  it('works normally when nothing is running (the greeting and idle check-ins)', async () => {
    const { session, sink } = build();
    const r = await session.say('Hello? Are you still there?');
    expect(r.status).toBe('completed');
    expect(sink.playCalls).toBeGreaterThan(0);
  });

  it('3. a caller interrupting an idle check-in cancels it, and the caller utterance is then answered', async () => {
    const { session, sink } = build();
    const said = session.say('Hello? Are you still there? I am still here whenever you need me.');
    while (sink.playCalls < 1) await sleep(5);
    expect(session.isBusy).toBe(true);
    session.interrupt('caller-speech'); // what onSpeechStart does when barge-in is on
    expect(await said).toMatchObject({ status: 'cancelled', cancelSource: 'caller-speech' });
    const r = await session.handleUtterance(speechPcm(1200), 'u2');
    expect(r.status).toBe('completed');
  });

  it('5. barge-in cancels the turn that is running, even after say() was refused beside it', async () => {
    const { session, sink } = build();
    const turn = session.handleUtterance(speechPcm(1200), 'u1');
    while (sink.playCalls < 1) await sleep(5);
    await session.say('Are you there?');
    await session.say('Are you there?');
    session.interrupt('caller-speech');
    expect(await turn).toMatchObject({ status: 'cancelled', cancelSource: 'caller-speech' });
    const spoken = sink.played.length;
    await sleep(120);
    expect(sink.played.length).toBe(spoken); // nothing keeps playing after the cancel
  });

  it('a newer utterance still cancels and replaces the running turn (newest wins)', async () => {
    const { session, sink } = build();
    const first = session.handleUtterance(speechPcm(1200), 'u1');
    while (sink.playCalls < 1) await sleep(5);
    const second = session.handleUtterance(speechPcm(900), 'u2');
    expect((await first).status).toBe('cancelled');
    expect((await second).status).toBe('completed');
  });
});
