import { describe, expect, it, vi } from 'vitest';
import type { CallSession } from '@sim-gateway/shared';
import { GatewayEventBus } from '../../src/core/event-bus.js';
import { IvrError } from '../../src/ivr/errors.js';
import { IvrCallHandler, IvrCallOwnership } from '../../src/ivr/ownership.js';
import type { IvrSnapshot } from '../../src/ivr/store.js';

const call = (id = 'c1', direction: 'inbound' | 'outbound' = 'outbound'): CallSession => ({ id, direction, state: 'ACTIVE' }) as CallSession;
const snapshot = (version = 3) => ({ version, config: {}, pcm: () => undefined }) as unknown as IvrSnapshot;

function make(over: { enabled?: boolean; published?: boolean; snapshot?: () => IvrSnapshot | null; aiCanAnswer?: boolean; armAi?: () => Promise<void>; current?: CallSession | null } = {}) {
  const state = { enabled: over.enabled ?? true, published: over.published ?? true, aiCanAnswer: over.aiCanAnswer ?? true, current: over.current === undefined ? call() : over.current };
  const store = {
    isEnabled: vi.fn(() => state.enabled),
    getPublished: vi.fn(() => (state.published ? ({ version: 3 } as never) : null)),
    snapshot: vi.fn(over.snapshot ?? (() => snapshot())),
  };
  const marks: Array<{ callId: string; status: string; detail: string }> = [];
  const hangup = vi.fn(async () => {});
  const armAi = vi.fn(over.armAi ?? (async () => {}));
  const eventBus = new GatewayEventBus();
  const ownership = new IvrCallOwnership({
    store,
    manager: { getCurrentCall: () => state.current, hangup } as never,
    eventBus,
    aiCanAnswer: () => state.aiCanAnswer,
    armAi,
    mark: (callId, event) => void marks.push({ callId, status: event.status, detail: event.detail ?? '' }),
  });
  const started: Array<{ call: CallSession; snapshot: IvrSnapshot }> = [];
  const handler: IvrCallHandler = { start: (c, s) => void started.push({ call: c, snapshot: s }) };
  return { state, store, marks, hangup, armAi, ownership, eventBus, started, handler };
}

describe('who owns a call', () => {
  it('with no handler registered (the situation until the controller exists) nothing is ever the IVR\'s, and nothing is read or written', () => {
    const h = make();
    for (const id of ['a', 'b', 'c']) expect(h.ownership.decide(call(id))).toBe('ai');
    expect(h.store.isEnabled).not.toHaveBeenCalled();
    expect(h.store.snapshot).not.toHaveBeenCalled();
    expect(h.marks).toEqual([]);
    expect(h.ownership.isHeld('a')).toBe(false);
  });

  it('switched off, or nothing published: the AI\'s, decided once, with nothing said', () => {
    for (const over of [{ enabled: false }, { published: false }]) {
      const h = make(over);
      h.ownership.registerHandler(h.handler);
      expect(h.ownership.decide(call())).toBe('ai');
      expect(h.ownership.decide(call())).toBe('ai');
      expect(h.store.snapshot).not.toHaveBeenCalled();
      expect(h.store.isEnabled).toHaveBeenCalledTimes(1); // remembered: later questions cost nothing
      expect(h.marks).toEqual([]);
    }
  });

  it('inbound calls are never the IVR\'s (outbound only in this version): nothing is read, remembered or said, even with everything on', () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    for (const id of ['i1', 'i2']) expect(h.ownership.decide(call(id, 'inbound'))).toBe('ai');
    expect(h.store.isEnabled).not.toHaveBeenCalled();
    expect(h.store.snapshot).not.toHaveBeenCalled();
    expect(h.ownership.isHeld('i1')).toBe(false);
    expect(h.marks).toEqual([]);
    // ... and they cannot be pulled in later by anything that asks about them again.
    h.ownership.audioReady(call('i1', 'inbound'));
    expect(h.started).toEqual([]);
  });

  it('enabled and published with a handler: the IVR\'s, with the snapshot taken then, and the trace says so', () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    expect(h.ownership.decide(call())).toBe('ivr');
    expect(h.ownership.isHeld('c1')).toBe(true);
    expect(h.store.snapshot).toHaveBeenCalledTimes(1);
    expect(h.marks).toEqual([{ callId: 'c1', status: 'ok', detail: expect.stringContaining('IVR took ownership of this call (published configuration version 3)') }]);
    expect(h.ownership.decide(call())).toBe('ivr');
    expect(h.store.snapshot).toHaveBeenCalledTimes(1); // not read again
  });

  it('is fixed for the life of the call: switching the IVR off or on mid-call moves nothing', () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    expect(h.ownership.decide(call('x'))).toBe('ivr');
    h.state.enabled = false;
    expect(h.ownership.decide(call('x'))).toBe('ivr'); // still the IVR's
    expect(h.ownership.decide(call('y'))).toBe('ai'); // the next call sees the new setting
    h.state.enabled = true;
    expect(h.ownership.decide(call('y'))).toBe('ai'); // and y keeps what it was given
  });

  it('a published configuration whose audio cannot be loaded falls back to the AI path, and says why', () => {
    const h = make({
      snapshot: () => {
        throw new IvrError('asset_unavailable', 'The audio file "menu" is damaged.', 409);
      },
    });
    h.ownership.registerHandler(h.handler);
    expect(h.ownership.decide(call())).toBe('ai');
    expect(h.marks).toEqual([{ callId: 'c1', status: 'skipped', detail: expect.stringMatching(/could not take ownership.*"menu" is damaged.*normal AI path/) }]);
    expect(h.ownership.isHeld('c1')).toBe(false);
  });

  it('a call is forgotten when it ends', () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    expect(h.ownership.isHeld('c1')).toBe(true);
    h.eventBus.emit('call:ended', call() as never);
    expect(h.ownership.isHeld('c1')).toBe(false);
    h.ownership.stop();
  });
});

describe('starting the IVR', () => {
  it('audioReady starts the handler once, with the call and its snapshot', async () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    h.ownership.audioReady(call());
    h.ownership.audioReady(call()); // a repeat is ignored
    await Promise.resolve();
    expect(h.started).toHaveLength(1);
    expect(h.started[0].snapshot.version).toBe(3);
    expect(h.marks.map((m) => m.detail).join(' ')).toContain('the IVR is starting');
  });

  it('audioReady does nothing for a call the IVR does not hold', async () => {
    const h = make({ enabled: false });
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    h.ownership.audioReady(call());
    await Promise.resolve();
    expect(h.started).toEqual([]);
  });

  it('a handler that throws, or rejects, releases the call (to the AI when it can answer)', async () => {
    for (const start of [() => { throw new Error('boom'); }, async () => { throw new Error('async boom'); }]) {
      const h = make();
      h.ownership.registerHandler({ start });
      h.ownership.decide(call());
      h.ownership.audioReady(call());
      await vi.waitFor(() => expect(h.armAi).toHaveBeenCalledWith('c1'));
      expect(h.marks.map((m) => m.detail).join(' ')).toMatch(/IVR released the call: the IVR failed to start: (async )?boom/);
      expect(h.ownership.decide(call())).toBe('ai');
      expect(h.hangup).not.toHaveBeenCalled();
    }
  });
});

describe('when the IVR cannot continue: the AI if it can answer, otherwise a clean hang-up', () => {
  it('releases to the AI when it can answer: the call is the AI\'s from then on, and the AI is armed once', async () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    const result = await h.ownership.fail('c1', 'USB audio could not be activated');
    expect(result).toBe('ai');
    expect(h.armAi).toHaveBeenCalledTimes(1);
    expect(h.hangup).not.toHaveBeenCalled();
    expect(h.ownership.isHeld('c1')).toBe(false);
    expect(h.marks.map((m) => m.detail)).toEqual(expect.arrayContaining([expect.stringContaining('IVR released the call: USB audio could not be activated'), 'The call was handed to the AI']));
  });

  it('the call is released BEFORE the AI is armed (so the orchestrator will accept it), never after', async () => {
    let heldDuringArm: boolean | null = null;
    const h = make({ armAi: async () => void (heldDuringArm = h.ownership.isHeld('c1')) });
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    await h.ownership.fail('c1', 'x');
    expect(heldDuringArm).toBe(false);
  });

  it('ends the call cleanly, with the reason in the trace, when the AI is not set to answer (a passive AI would take it and stay silent)', async () => {
    const h = make({ aiCanAnswer: false });
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    const result = await h.ownership.fail('c1', 'no audio bytes arrived');
    expect(result).toBe('hung-up');
    expect(h.armAi).not.toHaveBeenCalled();
    expect(h.hangup).toHaveBeenCalledTimes(1);
    expect(h.marks.at(-1)).toMatchObject({ status: 'failed', detail: expect.stringMatching(/Ending the call: no audio bytes arrived, and the AI cannot take it \(the AI is not set to answer calls\)/) });
  });

  it('ends the call cleanly when the AI says it is not ready', async () => {
    const h = make({ armAi: async () => { throw new Error('AI agent is not ready: inbound-wire: no audio'); } });
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    expect(await h.ownership.fail('c1', 'x')).toBe('hung-up');
    expect(h.hangup).toHaveBeenCalledTimes(1);
    expect(h.marks.at(-1)!.detail).toContain('AI agent is not ready');
  });

  it('does nothing for a call that already ended, and nothing twice', async () => {
    const gone = make({ current: null });
    gone.ownership.registerHandler(gone.handler);
    gone.ownership.decide(call());
    expect(await gone.ownership.fail('c1', 'x')).toBe('gone');
    expect(gone.armAi).not.toHaveBeenCalled();
    expect(gone.hangup).not.toHaveBeenCalled();

    const h = make();
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    await h.ownership.fail('c1', 'first');
    expect(await h.ownership.fail('c1', 'second')).toBe('gone');
    expect(h.armAi).toHaveBeenCalledTimes(1);
  });

  it('a hang-up that itself fails is reported, not thrown', async () => {
    const h = make({ aiCanAnswer: false });
    h.hangup.mockRejectedValueOnce(new Error('modem busy'));
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    await expect(h.ownership.fail('c1', 'x')).resolves.toBe('hung-up');
  });

  it('a call the IVR does not hold is never failed, handed over or ended by it', async () => {
    const h = make({ enabled: false });
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    expect(await h.ownership.fail('c1', 'x')).toBe('gone');
    expect(await h.ownership.handOffToAi('c1')).toBe('gone');
    expect(h.armAi).not.toHaveBeenCalled();
    expect(h.hangup).not.toHaveBeenCalled();
  });
});

describe('handing the call to the AI on purpose', () => {
  it('releases the call, then arms the AI; the same fallback applies if the AI cannot take it', async () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    expect(await h.ownership.handOffToAi('c1')).toBe('ai');
    expect(h.armAi).toHaveBeenCalledTimes(1);
    expect(h.marks.map((m) => m.detail)).toContain('IVR is handing the call to the AI');

    const refused = make({ armAi: async () => { throw new Error('AI agent is not ready'); } });
    refused.ownership.registerHandler(refused.handler);
    refused.ownership.decide(call());
    expect(await refused.ownership.handOffToAi('c1')).toBe('hung-up');
    expect(refused.hangup).toHaveBeenCalledTimes(1);
  });

  it('finish() lets a handler that ended the call itself (a hang-up action) forget it', async () => {
    const h = make();
    h.ownership.registerHandler(h.handler);
    h.ownership.decide(call());
    h.ownership.finish('c1');
    expect(h.ownership.isHeld('c1')).toBe(false);
  });
});
