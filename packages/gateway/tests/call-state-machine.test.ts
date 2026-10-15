import { describe, expect, it } from 'vitest';
import { CallSession } from '@sim-gateway/shared';
import { CallStateMachine } from '../src/core/call-state-machine.js';
import { InvalidStateTransitionError } from '../src/core/errors.js';

describe('CallStateMachine', () => {
  const createBaseSession = (): CallSession => ({
    id: 'test-session-1',
    direction: 'outbound',
    remoteNumber: '+919876543210',
    state: 'IDLE',
    startedAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    durationSeconds: 0,
    outcome: null,
    isSimulated: true,
  });

  it('initializes with IDLE state', () => {
    const sm = new CallStateMachine(createBaseSession());
    expect(sm.getState()).toBe('IDLE');
  });

  it('executes valid outbound lifecycle transitions', () => {
    const sm = new CallStateMachine(createBaseSession());

    // IDLE -> DIALING
    const t1 = sm.transitionTo('DIALING');
    expect(t1.previousState).toBe('IDLE');
    expect(t1.currentState).toBe('DIALING');

    // DIALING -> OUTBOUND_RINGING
    const t2 = sm.transitionTo('OUTBOUND_RINGING');
    expect(t2.currentState).toBe('OUTBOUND_RINGING');

    // OUTBOUND_RINGING -> ACTIVE
    const t3 = sm.transitionTo('ACTIVE');
    expect(t3.currentState).toBe('ACTIVE');
    expect(t3.session.answeredAt).toBeDefined();

    // ACTIVE -> TERMINATING
    const t4 = sm.transitionTo('TERMINATING', { reason: 'User hung up' });
    expect(t4.currentState).toBe('TERMINATING');
    expect(t4.session.endedAt).toBeDefined();
    expect(t4.session.outcome).toBe('completed');

    // TERMINATING -> IDLE
    const t5 = sm.transitionTo('IDLE');
    expect(t5.currentState).toBe('IDLE');
  });

  it('executes valid inbound lifecycle transitions', () => {
    const base = createBaseSession();
    base.direction = 'inbound';
    const sm = new CallStateMachine(base);

    // IDLE -> INBOUND_RINGING
    sm.transitionTo('INBOUND_RINGING');
    expect(sm.getState()).toBe('INBOUND_RINGING');

    // INBOUND_RINGING -> ACTIVE
    sm.transitionTo('ACTIVE');
    expect(sm.getState()).toBe('ACTIVE');

    // ACTIVE -> TERMINATING
    sm.transitionTo('TERMINATING');
    expect(sm.getState()).toBe('TERMINATING');
    expect(sm.getSession().outcome).toBe('completed');
  });

  it('marks unanswered inbound call as missed outcome', () => {
    const base = createBaseSession();
    base.direction = 'inbound';
    const sm = new CallStateMachine(base);

    sm.transitionTo('INBOUND_RINGING');
    sm.transitionTo('TERMINATING', { reason: 'Caller hung up before answer' });
    expect(sm.getSession().outcome).toBe('missed');
    expect(sm.getSession().durationSeconds).toBe(0);
  });

  it('rejects illegal transitions with InvalidStateTransitionError', () => {
    const sm = new CallStateMachine(createBaseSession());

    // Cannot transition directly from IDLE to ACTIVE
    expect(() => sm.transitionTo('ACTIVE')).toThrow(InvalidStateTransitionError);

    // Can transition to DIALING
    sm.transitionTo('DIALING');

    // Cannot transition from DIALING back to INBOUND_RINGING
    expect(() => sm.transitionTo('INBOUND_RINGING')).toThrow(InvalidStateTransitionError);
  });
});
