import type { CallSession, CallStateChangeEvent, ICallSessionManager } from '@sim-gateway/shared';

export interface CallEnd {
  outcome: string | null;
  reason: string | null;
  durationSeconds: number;
}

export interface PlacedCall {
  callId: string;
  /** Resolves when this call (and only this call) ends. Set up before the dial, so an early end cannot be missed. */
  ended: Promise<CallEnd>;
  /** Resolves when the other side answers (the call becomes ACTIVE); never resolves for a call nobody answers. */
  answered: Promise<void>;
}

/** What the campaign runner needs from the telephony side. The production version wraps the existing call manager. */
export interface CampaignDialer {
  /** No call is in progress or ringing. */
  isIdle(): boolean;
  dial(e164: string, options: { timeoutSeconds: number; metadata: Record<string, unknown> & { campaignContactId: number } }): Promise<PlacedCall>;
}

/**
 * Places campaign calls through the same call manager as the dashboard's dial pad, so the state machine, the single-call rule,
 * USB audio handling and call logging are exactly the existing ones. It adds no AT command of its own and never hangs up.
 */
export function managerDialer(manager: ICallSessionManager): CampaignDialer {
  return {
    isIdle: () => {
      const call = manager.getCurrentCall();
      return call === null || call.state === 'IDLE';
    },
    async dial(e164, { timeoutSeconds, metadata }) {
      const mine = (session: CallSession) => session.metadata?.campaignContactId === metadata.campaignContactId;
      let onEnded: ((s: CallSession) => void) | null = null;
      let onState: ((e: CallStateChangeEvent) => void) | null = null;
      const detach = () => {
        if (onEnded) manager.off('call:ended', onEnded);
        if (onState) manager.off('call:state_changed', onState);
      };
      const ended = new Promise<CallEnd>((resolve) => {
        onEnded = (session) => {
          if (!mine(session)) return;
          detach();
          resolve({ outcome: session.outcome, reason: session.terminationReason ?? null, durationSeconds: session.durationSeconds });
        };
        manager.on('call:ended', onEnded);
      });
      const answered = new Promise<void>((resolve) => {
        onState = (event) => {
          if (event.currentState === 'ACTIVE' && mine(event.session)) resolve();
        };
        manager.on('call:state_changed', onState);
      });
      try {
        const session = await manager.dial({ phoneNumber: e164, timeoutSeconds, metadata });
        return { callId: session.id, ended, answered };
      } catch (error) {
        detach();
        throw error;
      }
    },
  };
}
