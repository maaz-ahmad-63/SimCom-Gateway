/**
 * Call control state machine, session records, and manager interfaces.
 */

export type CallDirection = 'inbound' | 'outbound';

export type CallState =
  | 'IDLE'
  | 'DIALING'
  | 'OUTBOUND_RINGING'
  | 'INBOUND_RINGING'
  | 'ACTIVE'
  | 'TERMINATING';

export type CallOutcome =
  | 'completed'
  | 'missed'
  | 'rejected'
  | 'busy'
  | 'busy_rejected' // Inbound call rejected because gateway was already handling another call
  | 'failed'
  | 'no_answer';

export interface CallSession {
  /** Unique session UUID */
  id: string;
  direction: CallDirection;
  remoteNumber: string;
  state: CallState;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** Active duration in seconds (computed from answeredAt to endedAt) */
  durationSeconds: number;
  outcome: CallOutcome | null;
  terminationReason?: string;
  /** Flag ensuring mock events are never confused with hardware */
  isSimulated: boolean;
  /** Diagnostic audio dump file path if enabled */
  audioDumpPath?: string;
  metadata?: Record<string, unknown>;
}

export interface CallRecordSummary {
  id: string;
  direction: CallDirection;
  remoteNumber: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  outcome: CallOutcome;
  isSimulated: boolean;
}

export interface DialRequest {
  phoneNumber: string;
  timeoutSeconds?: number;
  callerId?: string;
  metadata?: Record<string, unknown>;
}

export interface DtmfRequest {
  digit: '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '*' | '#';
  durationMs?: number;
}

export interface CallStateChangeEvent {
  callId: string;
  previousState: CallState;
  currentState: CallState;
  timestamp: string;
  session: CallSession;
}

/**
 * Authoritative Call Session Manager managing single-call concurrency and state.
 */
export interface ICallSessionManager {
  /** Returns the active call session or null if IDLE */
  getCurrentCall(): CallSession | null;
  
  /** Initiates an outbound call. Throws error if another call is in progress */
  dial(request: DialRequest): Promise<CallSession>;
  
  /** Answers an incoming ringing call */
  answer(): Promise<CallSession>;
  
  /** Hangs up active or ringing call */
  hangup(reason?: string): Promise<void>;
  
  /** Sends DTMF digit over active call */
  sendDtmf(request: DtmfRequest): Promise<void>;

  /** Event listeners */
  on(event: 'call:state_changed', listener: (event: CallStateChangeEvent) => void): this;
  on(event: 'call:started', listener: (session: CallSession) => void): this;
  on(event: 'call:ended', listener: (session: CallSession) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
