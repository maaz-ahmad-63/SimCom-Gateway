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
  /**
   * What caused the transition, for diagnostics: "urc:VOICE_CALL_BEGIN", "api:dial", "api:hangup", ...
   * Never contains phone numbers or other identifiers.
   */
  trigger?: string;
  /** The fixed protocol line behind a urc trigger ("VOICE CALL: BEGIN", "CONNECT", "NO CARRIER"); only whitelisted lines. */
  triggerLine?: string;
}

/** Result of AT+CPCMREG=1 plus best-effort, read-only module format queries. */
export interface UsbAudioActivation {
  command: string;
  response: string;
  timestamp: string;
  /**
   * What the module itself reports (AT+CPCMFRM? / AT+CPCMBANDWIDTH?), or null when the query failed.
   * SIMCom documents 8 kHz 16-bit linear as the USB audio default, 16 kHz after CPCMFRM=1, and a
   * per-bearer PCM rate (CPCMBANDWIDTH: <volte>,<novolte>, 0 = 16 kHz, 1 = 8 kHz).
   */
  moduleAudioFormat?: {
    cpcmfrm: number | null;
    cpcmbandwidth: { volte: number; novolte: number } | null;
  };
}

/** Outcome of checking everything a USB drop could have broken, one field per thing verified. */
export interface UsbAudioRecoveryReport {
  trigger: 'modem-reconnected' | 'manual';
  startedAt: string;
  finishedAt: string;
  callId: string | null;
  /** 'usable' = module lists an active voice call; 'lost' = it lists none; 'unknown' = could not ask. */
  call: 'none' | 'usable' | 'lost' | 'unknown';
  /** AT+CPCMREG state: only checked or re-issued when the operator had activated it before the drop. */
  registration: 'not-applicable' | 'verified' | 'reissued' | 'failed' | 'unknown';
  audioPort: 'not-applicable' | 'still-open' | 'reopened' | 'failed';
  /** Whether PCM bytes actually arrived after recovery; null when not checked. */
  audioFlowing: boolean | null;
  notes: string[];
}

export interface UsbAudioStatus {
  registrationActive: boolean;
  /** True after a modem drop until recovery has verified the registration again. */
  needsRecovery: boolean;
  lastRecovery: UsbAudioRecoveryReport | null;
  /**
   * What the wire shows, not what a flag claims: 'flowing' = bytes within the last 500 ms,
   * 'stalled' = registered and streaming but silent on the wire, 'unverified' = a modem drop has
   * not been recovered yet, 'not-streaming' = the audio port is not open, 'not-expected' = no
   * active call with USB audio activated. Even 'flowing' says nothing about speech.
   */
  audio: {
    state: 'not-expected' | 'unverified' | 'not-streaming' | 'stalled' | 'flowing';
    msSinceLastFrame: number | null;
  };
  /**
   * True when the last AT+CPCMREG=0 was rejected or never answered, so the module may still hold the registration.
   * It stays set (and visible) until a later activation or a successful stop settles it; it never makes a new call
   * look activated.
   */
  registrationUncertain?: boolean;
  /** Outcome of the most recent attempt to stop USB audio (AT+CPCMREG=0), null if none was made. */
  lastDeactivation?: { ok: boolean; at: string; error?: string } | null;
  /** What the module reported (read-only queries) when this call's USB audio was activated; null if not activated or unanswered. */
  moduleAudioFormat?: UsbAudioActivation['moduleAudioFormat'] | null;
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

  /** Explicitly controlled SIM7600 USB-audio diagnostic activation. */
  activateUsbAudioDiagnostic?(): Promise<UsbAudioActivation>;
  /**
   * The same registration (AT+CPCMREG=1) for the production call flow: hands-free calling activates USB audio on every call it handles,
   * so this is never gated by the diagnostic switch, which governs only the operator's manual endpoint.
   */
  activateUsbAudioForCall?(): Promise<UsbAudioActivation>;
  deactivateUsbAudioDiagnostic?(): Promise<{ command: string; response: string; timestamp: string } | null>;
  isUsbAudioDiagnosticActive?(): boolean;
  /** Verify the call, AT+CPCMREG registration and audio port after a USB drop; never assumes any of them. */
  recoverUsbAudio?(trigger?: UsbAudioRecoveryReport['trigger']): Promise<UsbAudioRecoveryReport>;
  getUsbAudioStatus?(): UsbAudioStatus;

  /** Event listeners */
  on(event: 'call:state_changed', listener: (event: CallStateChangeEvent) => void): this;
  on(event: 'call:started', listener: (session: CallSession) => void): this;
  on(event: 'call:ended', listener: (session: CallSession) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
