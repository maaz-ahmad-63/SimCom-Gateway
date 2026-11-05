import { describe, expect, it, vi } from 'vitest';
import type { CallSession } from '@sim-gateway/shared';
import type { AgentAudioSink, PlayResult } from '../../src/ai/audio.js';
import type { TraceInput } from '../../src/ai/conversation.js';
import { GatewayEventBus } from '../../src/core/event-bus.js';
import { defaultIvrConfig, IvrConfig } from '../../src/ivr/config.js';
import { IvrController } from '../../src/ivr/controller.js';
import type { IvrCallOwner } from '../../src/ivr/ownership.js';
import type { IvrSnapshot } from '../../src/ivr/store.js';
import { FORMAT_8K, sleep } from '../ai/helpers.js';

// The state machine on its own: a fake sink that records exactly when each announcement starts and stops, fake timing, and a fake
// owner. The audio of an "asset" is just its name as bytes, so the log can say which announcement was playing.

const call = { id: 'call-1', direction: 'inbound', state: 'ACTIVE' } as CallSession;
const NAMES = ['welcome', 'menu', 'invalid', 'timeout', 'info', 'bye'];

function config(over: Partial<IvrConfig> = {}): IvrConfig {
  return {
    ...defaultIvrConfig(),
    welcome: { assetId: 'welcome' },
    menu: { assetId: 'menu' },
    invalid: { assetId: 'invalid' },
    timeout: { assetId: 'timeout' },
    options: [
      { key: '1', label: 'AI', action: { type: 'connect-ai' } },
      { key: '2', label: 'Info', action: { type: 'play-announcement', assetId: 'info', then: 'return-to-menu' } },
      { key: '3', label: 'Again', action: { type: 'repeat-menu' } },
      { key: '9', label: 'Bye', action: { type: 'hang-up', goodbyeAssetId: 'bye' } },
    ],
    inputTimeoutMs: 80, // the schema's 2 s minimum guards operators; the controller only reads the number
    maxRetries: 2,
    finalAction: { type: 'hang-up', goodbyeAssetId: 'bye' },
    ...over,
  };
}

function snapshotOf(cfg: IvrConfig, missing: string[] = []): IvrSnapshot {
  return { version: 7, publishedAt: 'x', takenAt: 'x', sampleRate: 8000, config: cfg, pcm: (id: string) => (NAMES.includes(id) && !missing.includes(id) ? Buffer.from(id) : undefined) } as unknown as IvrSnapshot;
}

class FakeSink implements AgentAudioSink {
  readonly format = FORMAT_8K;
  readonly verified = true;
  readonly log: string[] = [];
  active = 0;
  maxActive = 0;
  playMs = 15;
  /** How long the sink takes to stop writing after an abort, so "await the playback" is a real wait. */
  stopMs = 8;
  failOn: Record<string, () => PlayResult | Error> = {};
  constructor(private readonly timeline: string[]) {}

  async play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    const name = pcm.toString();
    this.log.push(`start:${name}`);
    this.timeline.push(`start:${name}`);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const planned = this.failOn[name]?.();
      if (planned instanceof Error) throw planned;
      if (planned) return planned;
      const completed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), this.playMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve(false)), { once: true });
        if (signal.aborted) (clearTimeout(timer), resolve(false));
      });
      if (!completed) await sleep(this.stopMs);
      this.log.push(`${completed ? 'end' : 'abort'}:${name}`);
      this.timeline.push(`${completed ? 'end' : 'abort'}:${name}`);
      return { bytesWritten: pcm.length, completed, stoppedBy: completed ? null : signal.reason === undefined ? 'aborted' : 'call-ended' };
    } finally {
      this.active--;
    }
  }
}

function make(over: { cfg?: Partial<IvrConfig>; missing?: string[]; audioProblem?: string | null; noSink?: boolean; settleMs?: number; debounceMs?: number } = {}) {
  const timeline: string[] = [];
  const sink = new FakeSink(timeline);
  const marks: TraceInput[] = [];
  const listeners = new Set<(key: string) => void>();
  const eventBus = new GatewayEventBus();
  const hangup = vi.fn(async () => void timeline.push('hangup'));
  const owner: IvrCallOwner = {
    handOffToAi: vi.fn(async () => {
      timeline.push(`handoff(active writers: ${sink.active})`);
      return 'ai' as const;
    }),
    fail: vi.fn(async (_id: string, reason: string) => {
      timeline.push(`fail:${reason}`);
      return 'ai' as const;
    }),
    finish: vi.fn(),
  };
  const controller = new IvrController({
    manager: { getCurrentCall: () => call, hangup },
    eventBus,
    onDtmf: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    createSink: () => (over.noSink ? null : sink),
    audioProblem: () => over.audioProblem ?? null,
    mark: (_id, event) => void marks.push(event),
    handoffSettleMs: over.settleMs ?? 20,
    debounceMs: over.debounceMs ?? 60,
  });
  const snapshot = snapshotOf(config(over.cfg), over.missing);
  const press = (key: string) => listeners.forEach((l) => l(key));
  const start = () => controller.start(call, snapshot, owner);
  const hangUpRemote = () => eventBus.emit('call:ended', call as never);
  const finished = () => vi.waitFor(() => expect(controller.activeCalls).toEqual([]), { timeout: 3000 });
  const playing = (name: string) => vi.waitFor(() => expect(sink.log).toContain(`start:${name}`), { timeout: 3000 });
  const listening = async () => {
    // The menu prompt has finished and the IVR is waiting for a key.
    await vi.waitFor(() => expect(sink.log.at(-1)).toBe('end:menu'), { timeout: 3000 });
    await sleep(5);
  };
  const starts = (name: string) => sink.log.filter((l) => l === `start:${name}`).length;
  return { controller, sink, owner, marks, press, start, hangUpRemote, hangup, timeline, listeners, finished, playing, listening, starts, eventBus };
}

describe('welcome and menu', () => {
  it('plays the welcome, then the menu prompt, then waits for a key', async () => {
    const h = make();
    h.start();
    await h.listening();
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome', 'start:menu', 'end:menu']);
    expect(h.controller.activeCalls).toEqual(['call-1']);
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
    h.hangUpRemote();
    await h.finished();
  });

  it('a configuration with no welcome starts straight with the menu', async () => {
    const h = make({ cfg: { welcome: { assetId: null } } });
    h.start();
    await h.listening();
    expect(h.sink.log).toEqual(['start:menu', 'end:menu']);
    h.hangUpRemote();
    await h.finished();
  });

  it('no options at all: it announces and runs the final action without waiting for a key', async () => {
    const h = make({ cfg: { options: [], finalAction: { type: 'connect-ai' } } });
    h.start();
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalledWith('call-1'), { timeout: 3000 });
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome', 'start:menu', 'end:menu']);
    await h.finished();
  });

  it('no options and a hang-up final action: announces, says goodbye, ends the call', async () => {
    const h = make({ cfg: { options: [], finalAction: { type: 'hang-up', goodbyeAssetId: 'bye' } } });
    h.start();
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome', 'start:menu', 'end:menu', 'start:bye', 'end:bye']);
    expect(h.timeline.at(-1)).toBe('hangup');
  });

  it('keys pressed during announcements that cannot be interrupted are ignored, and a second start for the same call is ignored', async () => {
    const h = make({ cfg: { options: [], finalAction: { type: 'hang-up', goodbyeAssetId: null } } });
    h.start();
    h.start();
    h.press('1'); // no options: the welcome is not interruptible
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome', 'start:menu', 'end:menu']);
    expect(h.sink.maxActive).toBe(1);
  });
});

describe('each action', () => {
  it('connect to the AI: the call is released to the AI once, after the settle, with nothing playing', async () => {
    const h = make({ settleMs: 40 });
    h.start();
    await h.listening();
    const keyAt = Date.now();
    h.press('1');
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(Date.now() - keyAt).toBeGreaterThanOrEqual(35); // the tone had time to die away
    expect(h.owner.handOffToAi).toHaveBeenCalledWith('call-1');
    expect(h.timeline.at(-1)).toBe('handoff(active writers: 0)');
    await h.finished();
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome', 'start:menu', 'end:menu']); // nothing after the handoff
    expect(h.hangup).not.toHaveBeenCalled();
  });

  it('a key during the menu stops it, WAITS for it to stop writing, and only then hands over (no two writers)', async () => {
    const h = make({ settleMs: 20 });
    h.sink.playMs = 200; // the menu is still playing when the key arrives
    h.start();
    await h.playing('menu');
    h.press('1');
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const t = h.timeline;
    expect(t.indexOf('abort:menu')).toBeGreaterThan(-1);
    expect(t.indexOf('abort:menu')).toBeLessThan(t.findIndex((e) => e.startsWith('handoff')));
    expect(t.at(-1)).toBe('handoff(active writers: 0)');
    expect(h.sink.maxActive).toBe(1);
    await h.finished();
  });

  it('play an announcement and return to the menu: the announcement, then the menu again, then listening', async () => {
    const h = make();
    h.start();
    await h.listening();
    h.press('2');
    await vi.waitFor(() => expect(h.sink.log.slice(4)).toEqual(['start:info', 'end:info', 'start:menu', 'end:menu']), { timeout: 3000 });
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
    expect(h.hangup).not.toHaveBeenCalled();
    h.hangUpRemote();
    await h.finished();
  });

  it('play an announcement and then hang up', async () => {
    const h = make({ cfg: { options: [{ key: '2', label: 'Info', action: { type: 'play-announcement', assetId: 'info', then: 'hang-up' } }] } });
    h.start();
    await h.listening();
    h.press('2');
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.sink.log.slice(4)).toEqual(['start:info', 'end:info']);
    expect(h.timeline.at(-1)).toBe('hangup');
  });

  it('repeat the menu: it plays again, and it does not use up a retry however often it is chosen', async () => {
    const h = make({ cfg: { maxRetries: 0 }, debounceMs: 10 });
    h.start();
    await h.listening();
    for (let i = 1; i <= 3; i++) {
      h.press('3');
      await vi.waitFor(() => expect(h.starts('menu')).toBe(1 + i), { timeout: 3000 });
      await h.listening();
      await sleep(15); // let the debounce window pass before the next press
    }
    expect(h.hangup).not.toHaveBeenCalled(); // maxRetries 0 would have ended it at the first MISTAKE; a repeat is not one
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
    h.hangUpRemote();
    await h.finished();
  });

  it('hang up with a goodbye: the goodbye plays to its end (keys cannot interrupt it), then the call is ended', async () => {
    const h = make();
    h.sink.playMs = 40;
    h.start();
    await h.listening();
    h.press('9');
    await h.playing('bye');
    h.press('1'); // during the goodbye: not a choice
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.sink.log.slice(-2)).toEqual(['start:bye', 'end:bye']);
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
  });

  it('hang up without a goodbye ends the call at once', async () => {
    const h = make({ cfg: { options: [{ key: '9', label: 'Bye', action: { type: 'hang-up', goodbyeAssetId: null } }] } });
    h.start();
    await h.listening();
    h.press('9');
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.starts('bye')).toBe(0);
  });
});

describe('barge-in', () => {
  it('with barge-in on, a key during the welcome skips the menu prompt and is taken as the choice', async () => {
    const h = make();
    h.sink.playMs = 100;
    h.start();
    await h.playing('welcome');
    h.press('9');
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.starts('menu')).toBe(0);
    expect(h.sink.log).toContain('abort:welcome');
  });

  it('with barge-in off, a key during a prompt is ignored; the prompt finishes, and the next key counts', async () => {
    const h = make({ cfg: { allowBargeIn: false } });
    h.sink.playMs = 60;
    h.start();
    await h.playing('menu');
    h.press('9'); // ignored
    await h.listening();
    expect(h.sink.log).not.toContain('abort:menu');
    expect(h.hangup).not.toHaveBeenCalled();
    await sleep(70); // outside the debounce window
    h.press('9');
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('a held key is one press: its repeats do not choose again', async () => {
    const h = make({ debounceMs: 80, cfg: { inputTimeoutMs: 2000 } }); // long enough that no silence interferes
    h.start();
    await h.listening();
    h.press('3'); // repeat-menu
    await h.playing('menu');
    for (let i = 0; i < 6; i++) {
      await sleep(25);
      h.press('3'); // the modem keeps reporting the held key
    }
    await sleep(40);
    expect(h.starts('menu')).toBe(2); // the first press repeated the menu once; the repeats did nothing
    expect(h.starts('timeout')).toBe(0);
    expect(h.starts('invalid')).toBe(0);
    h.hangUpRemote();
    await h.finished();
  });

  it('after a handoff the caller\'s keys reach nothing', async () => {
    const h = make({ settleMs: 10 });
    h.start();
    await h.listening();
    h.press('1');
    await h.finished();
    expect(h.listeners.size).toBe(0);
    h.press('9');
    expect(h.hangup).not.toHaveBeenCalled();
  });
});

describe('invalid input, timeout and the retry limit', () => {
  it('a key that is not an option: the invalid announcement, then the menu again', async () => {
    const h = make({ debounceMs: 10 });
    h.start();
    await h.listening();
    h.press('5');
    await vi.waitFor(() => expect(h.sink.log.slice(4, 8)).toEqual(['start:invalid', 'end:invalid', 'start:menu', 'end:menu']), { timeout: 3000 });
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
    h.hangUpRemote();
    await h.finished();
  });

  it('no key in time: the timeout announcement, then the menu again', async () => {
    const h = make();
    h.start();
    await vi.waitFor(() => expect(h.sink.log.slice(4, 8)).toEqual(['start:timeout', 'end:timeout', 'start:menu', 'end:menu']), { timeout: 3000 });
    h.hangUpRemote();
    await h.finished();
  });

  it('timeouts count against the limit: maxRetries 2 allows two retries and the third silence runs the final action (a goodbye and a hang-up)', async () => {
    const h = make();
    h.start();
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(h.sink.log.filter((l) => l.startsWith('start:'))).toEqual(['start:welcome', 'start:menu', 'start:timeout', 'start:menu', 'start:timeout', 'start:menu', 'start:bye']);
  });

  it('wrong keys and silences share one count', async () => {
    const h = make({ cfg: { maxRetries: 1 }, debounceMs: 10 });
    h.start();
    await h.listening();
    h.press('5'); // mistake 1: invalid
    await vi.waitFor(() => expect(h.sink.log.at(-1)).toBe('end:menu'), { timeout: 3000 });
    await vi.waitFor(() => expect(h.hangup).toHaveBeenCalledTimes(1), { timeout: 3000 }); // mistake 2 is a silence: over the limit
    expect(h.starts('invalid')).toBe(1);
    expect(h.starts('timeout')).toBe(0); // the last mistake goes straight to the final action
  });

  it('maxRetries 0: the first mistake runs the final action, here connecting the AI', async () => {
    const h = make({ cfg: { maxRetries: 0, finalAction: { type: 'connect-ai' } }, debounceMs: 10 });
    h.start();
    await h.listening();
    h.press('5');
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.starts('invalid')).toBe(0);
    expect(h.hangup).not.toHaveBeenCalled();
  });

  it('a correct key after a mistake still works, and the retries are not refilled', async () => {
    const h = make({ cfg: { maxRetries: 1 }, debounceMs: 10 });
    h.start();
    await h.listening();
    h.press('5');
    await vi.waitFor(() => expect(h.sink.log.at(-1)).toBe('end:menu'), { timeout: 3000 });
    await sleep(15);
    h.press('1');
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('missing optional announcements: the menu simply plays again', async () => {
    const h = make({ cfg: { invalid: { assetId: null }, timeout: { assetId: null } }, debounceMs: 10 });
    h.start();
    await h.listening();
    h.press('5');
    await vi.waitFor(() => expect(h.starts('menu')).toBe(2), { timeout: 3000 });
    expect(h.starts('invalid')).toBe(0);
    h.hangUpRemote();
    await h.finished();
  });
});

describe('the caller hangs up', () => {
  it('during an announcement: playback is aborted at once and nothing else happens', async () => {
    const h = make();
    h.sink.playMs = 300;
    h.start();
    await h.playing('welcome');
    h.hangUpRemote();
    await h.finished();
    expect(h.sink.log).toEqual(['start:welcome', 'abort:welcome']);
    expect(h.hangup).not.toHaveBeenCalled();
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
    expect(h.owner.fail).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
    expect(h.marks.map((m) => m.detail).join(' ')).toContain('the caller hung up');
  });

  it('while waiting for a key: the wait ends, no timeout fires afterwards, and nothing more is played', async () => {
    const h = make({ cfg: { inputTimeoutMs: 60 } });
    h.start();
    await h.listening();
    h.hangUpRemote();
    await h.finished();
    await sleep(120); // longer than the input timeout
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome', 'start:menu', 'end:menu']);
    expect(h.owner.fail).not.toHaveBeenCalled();
  });

  it('during the settle before a handoff: the AI is never armed', async () => {
    const h = make({ settleMs: 120 });
    h.start();
    await h.listening();
    h.press('1');
    await sleep(30);
    h.hangUpRemote();
    await h.finished();
    await sleep(150);
    expect(h.owner.handOffToAi).not.toHaveBeenCalled();
  });

  it('during the goodbye: the call is not ended a second time', async () => {
    const h = make();
    h.sink.playMs = 200;
    h.start();
    await h.listening();
    h.press('9');
    await h.playing('bye');
    h.hangUpRemote();
    await h.finished();
    expect(h.hangup).not.toHaveBeenCalled();
  });

  it('stop() (the gateway shutting down) ends every menu the same way', async () => {
    const h = make();
    h.sink.playMs = 300;
    h.start();
    await h.playing('welcome');
    h.controller.stop();
    await h.finished();
    expect(h.sink.log).toEqual(['start:welcome', 'abort:welcome']);
  });
});

describe('when audio is not ready, or playback breaks: released through the ownership layer', () => {
  it('an audio problem at the start: nothing is played, and the call is released with the reason', async () => {
    const h = make({ audioProblem: 'outbound-audio: audibility of written PCM on the call has not been confirmed' });
    h.start();
    await vi.waitFor(() => expect(h.owner.fail).toHaveBeenCalledTimes(1));
    expect(h.owner.fail).toHaveBeenCalledWith('call-1', expect.stringContaining('audio is not ready for the IVR: outbound-audio'));
    expect(h.sink.log).toEqual([]);
    expect(h.controller.activeCalls).toEqual([]);
    expect(h.listeners.size).toBe(0);
  });

  it('no audio path configured: released', async () => {
    const h = make({ noSink: true });
    h.start();
    await vi.waitFor(() => expect(h.owner.fail).toHaveBeenCalledWith('call-1', expect.stringContaining('no audio path')));
    expect(h.controller.activeCalls).toEqual([]);
  });

  it('the port refusing to write mid-menu: playback stops, the call is released, and the controller does not hang up itself', async () => {
    const h = make();
    h.sink.failOn.menu = () => new Error('Audio port is not streaming; refusing to write playback');
    h.start();
    await vi.waitFor(() => expect(h.owner.fail).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.owner.fail).toHaveBeenCalledWith('call-1', expect.stringContaining('Audio port is not streaming'));
    expect(h.hangup).not.toHaveBeenCalled(); // the ownership layer decides between the AI and a hang-up
    await h.finished();
    expect(h.sink.active).toBe(0);
  });

  it('playback that stopped early for any reason but the caller leaving is a failure too', async () => {
    const h = make();
    h.sink.failOn.welcome = () => ({ bytesWritten: 0, completed: false, stoppedBy: 'not-written' });
    h.start();
    await vi.waitFor(() => expect(h.owner.fail).toHaveBeenCalledWith('call-1', expect.stringContaining('stopped early (not-written)')), { timeout: 3000 });
    await h.finished();
  });

  it('audio missing from the snapshot: released, never played half way', async () => {
    const h = make({ missing: ['menu'] });
    h.start();
    await vi.waitFor(() => expect(h.owner.fail).toHaveBeenCalledWith('call-1', expect.stringContaining('menu prompt is missing')), { timeout: 3000 });
    expect(h.sink.log).toEqual(['start:welcome', 'end:welcome']);
  });

  it('a call that cannot be ended is released rather than left behind', async () => {
    const h = make({ cfg: { options: [], finalAction: { type: 'hang-up', goodbyeAssetId: null } } });
    h.hangup.mockRejectedValueOnce(new Error('modem busy'));
    h.start();
    await vi.waitFor(() => expect(h.owner.fail).toHaveBeenCalledWith('call-1', expect.stringContaining('could not be ended: modem busy')), { timeout: 3000 });
  });
});

describe('audit trail and the audio port', () => {
  it('the trace records what happened without ever recording a key', async () => {
    const h = make({
      cfg: {
        options: [
          { key: '#', label: 'Hash', action: { type: 'play-announcement', assetId: 'info', then: 'return-to-menu' } },
          { key: '*', label: 'Star', action: { type: 'connect-ai' } },
        ],
      },
      debounceMs: 10,
    });
    h.start();
    await h.listening();
    h.press('7'); // a wrong key
    await vi.waitFor(() => expect(h.sink.log.at(-1)).toBe('end:menu'), { timeout: 3000 });
    await sleep(15);
    h.press('#');
    await vi.waitFor(() => expect(h.starts('info')).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(h.sink.log.at(-1)).toBe('end:menu'), { timeout: 3000 });
    await sleep(15);
    h.press('*');
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalled(), { timeout: 3000 });
    await h.finished();
    const text = JSON.stringify(h.marks);
    expect(text).toContain('menu started (published configuration version 7)');
    expect(text).toContain('the caller chose option 1 (play-announcement)');
    expect(text).toContain('the caller chose option 2 (connect-ai)');
    expect(text).toContain('a key that is not one of the options (mistake 1');
    expect(text).not.toMatch(/[#*]/);
    expect(text).not.toMatch(/"digit"|"key"|pressed (7|#|\*)/i);
    expect(h.marks.every((m) => m.stage === 'call')).toBe(true);
  });

  it('there is never more than one announcement being written, through a whole busy conversation', async () => {
    const h = make({ debounceMs: 5 });
    h.sink.playMs = 40;
    h.start();
    await h.playing('welcome');
    h.press('3'); // barge-in: repeat menu
    await h.playing('menu');
    h.press('5'); // barge-in: wrong key
    await h.playing('invalid');
    h.press('2'); // barge-in again: info announcement
    await h.playing('info');
    h.press('1'); // barge-in: hand over
    await vi.waitFor(() => expect(h.owner.handOffToAi).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(h.sink.maxActive).toBe(1);
    expect(h.timeline.at(-1)).toBe('handoff(active writers: 0)');
    await h.finished();
  });
});
