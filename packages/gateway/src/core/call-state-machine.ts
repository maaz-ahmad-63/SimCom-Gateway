import {
  CallDirection,
  CallOutcome,
  CallSession,
  CallState,
} from '@sim-gateway/shared';
import { InvalidStateTransitionError } from './errors.js';

const VALID_TRANSITIONS: Record<CallState, CallState[]> = {
  IDLE: ['DIALING', 'INBOUND_RINGING'],
  DIALING: ['OUTBOUND_RINGING', 'ACTIVE', 'TERMINATING'],
  OUTBOUND_RINGING: ['ACTIVE', 'TERMINATING'],
  INBOUND_RINGING: ['ACTIVE', 'TERMINATING'],
  ACTIVE: ['TERMINATING'],
  TERMINATING: ['IDLE'],
};

export class CallStateMachine {
  private currentSession: CallSession;

  constructor(session: CallSession) {
    this.currentSession = { ...session };
  }

  getState(): CallState {
    return this.currentSession.state;
  }

  getSession(): CallSession {
    return { ...this.currentSession };
  }

  canTransitionTo(nextState: CallState): boolean {
    const allowed = VALID_TRANSITIONS[this.currentSession.state];
    return allowed.includes(nextState);
  }

  transitionTo(
    nextState: CallState,
    options?: {
      outcome?: CallOutcome;
      reason?: string;
    }
  ): { previousState: CallState; currentState: CallState; session: CallSession } {
    const previousState = this.currentSession.state;

    if (!this.canTransitionTo(nextState)) {
      throw new InvalidStateTransitionError(
        previousState,
        nextState,
        options?.reason
      );
    }

    this.currentSession.state = nextState;

    if (nextState === 'ACTIVE' && !this.currentSession.answeredAt) {
      this.currentSession.answeredAt = new Date().toISOString();
    }

    if (nextState === 'TERMINATING') {
      const now = new Date();
      this.currentSession.endedAt = now.toISOString();

      if (this.currentSession.answeredAt) {
        const answeredMs = new Date(this.currentSession.answeredAt).getTime();
        this.currentSession.durationSeconds = Math.max(
          0,
          Math.round((now.getTime() - answeredMs) / 1000)
        );
      } else {
        this.currentSession.durationSeconds = 0;
      }

      if (options?.outcome) {
        this.currentSession.outcome = options.outcome;
      } else if (!this.currentSession.outcome) {
        // Infer default outcome based on whether call was ever active
        if (this.currentSession.answeredAt) {
          this.currentSession.outcome = 'completed';
        } else if (this.currentSession.direction === 'inbound') {
          this.currentSession.outcome = 'missed';
        } else {
          this.currentSession.outcome = 'no_answer';
        }
      }

      if (options?.reason) {
        this.currentSession.terminationReason = options.reason;
      }
    }

    return {
      previousState,
      currentState: nextState,
      session: { ...this.currentSession },
    };
  }
}
