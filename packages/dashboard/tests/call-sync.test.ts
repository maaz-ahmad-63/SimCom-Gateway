import { describe, expect, it } from 'vitest';
import { CLEAR_AFTER_MISSES, reconcileCall } from '../src/lib/call-sync';

describe('reconcileCall', () => {
  it('does nothing when the screen and the gateway agree', () => {
    expect(reconcileCall(null, null, 0)).toEqual({ action: 'none', misses: 0 });
    expect(reconcileCall({ id: 'a', state: 'ACTIVE' }, { id: 'a', state: 'ACTIVE' }, 1)).toEqual({ action: 'none', misses: 0 });
  });

  it('clears a finished call that the screen still shows, but only after consecutive "no call" answers', () => {
    const shown = { id: 'a', state: 'DIALING' };
    let step = reconcileCall(shown, null, 0);
    expect(step).toEqual({ action: 'none', misses: 1 }); // one poll can race a brand-new call
    for (let i = 1; i < CLEAR_AFTER_MISSES - 1; i++) step = reconcileCall(shown, null, step.misses);
    step = reconcileCall(shown, null, step.misses);
    expect(step.action).toBe('clear');
  });

  it('resets the miss counter as soon as the gateway reports the call again', () => {
    expect(reconcileCall({ id: 'a', state: 'ACTIVE' }, { id: 'a', state: 'ACTIVE' }, 1).misses).toBe(0);
  });

  it('re-reads the call when the screen shows none, another call, or an older state', () => {
    expect(reconcileCall(null, { id: 'a', state: 'INBOUND_RINGING' }, 0).action).toBe('refresh');
    expect(reconcileCall({ id: 'a', state: 'ACTIVE' }, { id: 'b', state: 'ACTIVE' }, 0).action).toBe('refresh');
    expect(reconcileCall({ id: 'a', state: 'DIALING' }, { id: 'a', state: 'ACTIVE' }, 0).action).toBe('refresh');
  });

  it('works with an older gateway that does not send a call id', () => {
    expect(reconcileCall({ id: 'a', state: 'ACTIVE' }, { state: 'ACTIVE' }, 0).action).toBe('none');
  });
});
