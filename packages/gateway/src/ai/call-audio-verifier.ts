/**
 * Automatic, evidence-based verification of one call's audio, decided only from what THIS call produced.
 *
 * Three questions, answered independently and never merged into one "audio OK" flag:
 *
 *   inbound      Was the caller intelligible? Proven only by the live pipeline: utterances the speech detector judged to be
 *                speech AND the live speech-to-text turned into real words (with good confidence when the provider reports
 *                one). Bytes arriving prove nothing about speech.
 *   transport    Did the agent's audio go out through the modem's audio port? Proven by what the port accepted (bytes counted by
 *                the adapter), playbacks that completed, no write errors, no persistent underruns. Says NOTHING about hearing.
 *   audibility   Did the remote person hear the agent? Software on this side cannot hear the far end. Only an explicit
 *                confirmation from the remote side (a diagnostic key press the caller was asked for) may verify it. A caller who
 *                speaks after the agent, or who says "I can't hear you", is recorded as evidence, never as a verdict.
 *
 * Statuses: pending (nothing to judge yet), verifying (judging, evidence arriving), verified, failed, unable (the call ended or
 * the setup cannot produce the evidence: silence, transcription unavailable, the agent never spoke, simulated hardware).
 * "Unable to verify" is never turned into "failed", and a previous call's result is never reused: one verifier per call.
 *
 * This module only reads observations it is given. It never touches audio, the modem or the call.
 */

export type VerificationStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'unable';
export type VerificationAspect = 'inbound' | 'transport' | 'audibility';
export type EvidenceSource =
  | 'usb-audio-stream'
  | 'speech-detector'
  | 'live-stt'
  | 'playback'
  | 'audio-port'
  | 'caller-response'
  | 'caller-phrase'
  | 'remote-key-press'
  | 'call-lifecycle'
  | 'setup';
export type EvidenceKind = 'supporting' | 'negative' | 'warning' | 'info';

export interface Evidence {
  at: string;
  source: EvidenceSource;
  kind: EvidenceKind;
  detail: string;
  /** Numbers and flags only: never transcript text, never secrets. */
  data?: Record<string, number | string | boolean | null>;
}

export interface AspectResult {
  aspect: VerificationAspect;
  status: VerificationStatus;
  /** One sentence: why the status is what it is. */
  reason: string;
  /** What the current status rests on (null while nothing has been observed). */
  source: EvidenceSource | null;
  updatedAt: string;
  evidence: Evidence[];
}

export interface CallAudioVerification {
  callId: string;
  direction: 'inbound' | 'outbound' | null;
  startedAt: string;
  activeAt: string | null;
  endedAt: string | null;
  /** Set when the call ended: the results are final and will not change. */
  final: boolean;
  /** The call ran on simulated hardware or mock providers: nothing here can be verified. */
  simulated: boolean;
  inbound: AspectResult;
  transport: AspectResult;
  audibility: AspectResult;
}

/** What one finished AI turn says about audio. Built from the pipeline's turn result; no text is ever passed in. */
export interface TurnObservation {
  status: 'completed' | 'skipped' | 'cancelled' | 'failed';
  reason?: string;
  /** The speech detector's verdict on the caller's utterance ('ok', 'silent', 'too-short', 'unlikely-speech'). */
  utterance?: string;
  /** Words in the final live transcript (counted, never stored). */
  transcriptWords?: number;
  /** The provider's confidence for the final transcript, when it reports one. */
  sttConfidence?: number | null;
  /** The in-memory phrase check found the caller saying they cannot hear (the text itself is not kept). */
  callerReportsNotHearing?: boolean;
  /** Agent audio for this turn, as counted by the audio adapter. */
  bytesWritten?: number;
  /** Every playback of the reply ran to its end. */
  playbackCompleted?: boolean;
  /** Why playback stopped early ('not-written', 'call-ended', 'aborted', ...), null when it completed or nothing was played. */
  playbackStoppedBy?: string | null;
  underruns?: number;
  riskFrames?: number;
  lateFrames?: number;
  slowWrites?: number;
}

export interface VerifierThresholds {
  /** Good caller utterances needed to verify intelligibility. */
  minGoodUtterances: number;
  minWords: number;
  /** Minimum provider confidence for an utterance to count (only when the provider reports one). */
  minConfidence: number;
  /** Below this a reported confidence counts against intelligibility. */
  badConfidence: number;
  /** Speech-like utterances with no usable words, with none good, before intelligibility fails. */
  failAfterBadUtterances: number;
  /** A playback with at least this many underruns is degraded. */
  underrunsPerPlayback: number;
  /** Degraded playbacks in a row before transport fails for persistent underruns. */
  persistentUnderrunPlaybacks: number;
  /** How long an armed diagnostic key-press test waits for the caller's key. */
  keyTestWindowMs: number;
}

export const DEFAULT_THRESHOLDS: VerifierThresholds = {
  minGoodUtterances: 2,
  minWords: 2,
  minConfidence: 0.6,
  badConfidence: 0.3,
  failAfterBadUtterances: 3,
  underrunsPerPlayback: 3,
  persistentUnderrunPlaybacks: 2,
  keyTestWindowMs: 60_000,
};

const MAX_EVIDENCE = 25;

/** Phrases a caller uses when they cannot hear the agent. Checked in memory only; the text is never kept or logged. */
const NOT_HEARING = [
  /\b(?:i|we)\s+(?:can(?:'|’)?t|cannot|can\s*not|couldn(?:'|’)?t)\s+hear\b/i,
  /\b(?:can|could)\s+(?:you|anyone|anybody)\s+hear\s+me\b.*\?/i,
  /\bno\s+(?:sound|audio)\b/i,
  /\bhello\s*\?\s*hello\b/i,
  /\b(?:you(?:'|’)?re|you\s+are)\s+(?:breaking\s+up|very\s+quiet|too\s+quiet)\b/i,
  /\bi\s+(?:can(?:'|’)?t|cannot)\s+understand\s+you\b/i,
];

export function detectHearingComplaint(text: string): boolean {
  return NOT_HEARING.some((re) => re.test(text));
}

/** Real words in a transcript: tokens that contain a letter or a digit. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export class CallAudioVerifier {
  private readonly state: CallAudioVerification;
  private good = 0;
  private bad = 0;
  private inconclusive = 0;
  private silent = 0;
  private sttUnavailable = 0;
  private wireEverFlowing = false;
  private wireFailed = false;
  private goodPlaybacks = 0;
  private degradedInARow = 0;
  private transportFailed = false;
  private agentAttempted = false;
  private agentSpoke = false;
  private lastReplyPlayedAt: number | null = null;
  private responses = 0;
  private keyTest: { key: string; until: number } | null = null;

  constructor(
    callId: string,
    opts: { direction?: 'inbound' | 'outbound' | null; simulated?: boolean; thresholds?: Partial<VerifierThresholds>; now?: () => Date } = {}
  ) {
    this.now = opts.now ?? (() => new Date());
    this.t = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds ?? {}) };
    const at = this.iso();
    const fresh = (aspect: VerificationAspect, reason: string): AspectResult => ({ aspect, status: 'pending', reason, source: null, updatedAt: at, evidence: [] });
    this.state = {
      callId,
      direction: opts.direction ?? null,
      startedAt: at,
      activeAt: null,
      endedAt: null,
      final: false,
      simulated: opts.simulated === true,
      inbound: fresh('inbound', 'waiting for the call to be answered'),
      transport: fresh('transport', 'waiting for the agent to speak'),
      audibility: fresh('audibility', 'waiting for the agent to speak'),
    };
    if (this.state.simulated) {
      for (const a of ['inbound', 'transport', 'audibility'] as const) {
        this.set(a, 'unable', 'simulated hardware or simulated AI providers: nothing about real call audio can be verified', 'setup', true);
      }
    }
  }

  private readonly now: () => Date;
  private readonly t: VerifierThresholds;
  private iso(): string {
    return this.now().toISOString();
  }

  /** A copy: callers can never change the verifier's state. */
  snapshot(): CallAudioVerification {
    return JSON.parse(JSON.stringify(this.state)) as CallAudioVerification;
  }

  get callId(): string {
    return this.state.callId;
  }
  get isFinal(): boolean {
    return this.state.final;
  }

  private add(aspect: VerificationAspect, e: Omit<Evidence, 'at'>): void {
    const list = this.state[aspect].evidence;
    list.push({ at: this.iso(), ...e });
    if (list.length > MAX_EVIDENCE) list.splice(0, list.length - MAX_EVIDENCE);
    this.state[aspect].updatedAt = this.iso();
  }

  private set(aspect: VerificationAspect, status: VerificationStatus, reason: string, source: EvidenceSource | null, force = false): void {
    if (this.state.final && !force) return;
    if (this.state.simulated && !force) return;
    const r = this.state[aspect];
    r.status = status;
    r.reason = reason;
    r.source = source;
    r.updatedAt = this.iso();
  }

  // ---- call lifecycle ----------------------------------------------------------------------------------------------------------

  callActive(): void {
    if (this.state.final || this.state.activeAt) return;
    this.state.activeAt = this.iso();
    this.add('inbound', { source: 'call-lifecycle', kind: 'info', detail: 'call answered; listening for caller speech' });
    if (!this.state.simulated) this.set('inbound', 'verifying', 'listening for caller speech and its live transcript', 'call-lifecycle');
  }

  /**
   * The USB audio stream state as the call manager reports it ('flowing', 'stalled', 'not-streaming', ...), sampled while the call
   * is active. A stream that was flowing and then stays stalled/not streaming for `wireFailSamples` samples in a row has failed;
   * a single stalled sample is not a failure.
   */
  wireState(state: string | undefined, wireFailSamples = 3): void {
    if (this.state.final || !this.state.activeAt) return;
    if (state === 'flowing') {
      if (!this.wireEverFlowing) this.add('inbound', { source: 'usb-audio-stream', kind: 'info', detail: 'caller audio bytes are arriving (this alone proves nothing about speech)' });
      this.wireEverFlowing = true;
      this.wireBadSamples = 0;
      return;
    }
    if (!this.wireEverFlowing || this.wireFailed) return;
    if (state !== 'stalled' && state !== 'not-streaming') return;
    this.wireBadSamples++;
    if (this.wireBadSamples < wireFailSamples) return;
    this.wireFailed = true;
    this.add('inbound', { source: 'usb-audio-stream', kind: 'negative', detail: `the caller audio stream stopped during the active call (state '${state}' for ${this.wireBadSamples} samples in a row)`, data: { state } });
    if (this.state.inbound.status !== 'verified') this.set('inbound', 'failed', `the caller audio stream failed during the active call (state '${state}')`, 'usb-audio-stream');
  }
  private wireBadSamples = 0;

  /** The live AI pipeline (speech detection + transcription) is attached to this call. Without it intelligibility cannot be judged. */
  pipelineAttached(): void {
    this.pipeline = true;
  }
  private pipeline = false;

  /** The audio port or the AI's audio sink reported a write failure. */
  transportError(message: string): void {
    if (this.state.final) return;
    this.agentAttempted = true;
    this.transportFailed = true;
    this.add('transport', { source: 'audio-port', kind: 'negative', detail: `audio port error: ${sanitize(message)}` });
    this.set('transport', 'failed', `writing the agent's audio to the modem failed: ${sanitize(message)}`, 'audio-port');
    if (this.state.audibility.status === 'pending' || this.state.audibility.status === 'verifying')
      this.set('audibility', 'unable', 'the agent audio did not reach the modem intact, so whether the caller heard it cannot be verified', 'audio-port');
  }

  // ---- AI turns ----------------------------------------------------------------------------------------------------------------

  turn(o: TurnObservation): void {
    if (this.state.final) return;
    this.noteCaller(o);
    this.notePlayback(o);
  }

  private noteCaller(o: TurnObservation): void {
    const words = o.transcriptWords ?? 0;
    const conf = typeof o.sttConfidence === 'number' ? o.sttConfidence : null;
    const speechLike = o.utterance === 'ok';
    const data = { words, confidence: conf, utterance: o.utterance ?? null };

    if (o.utterance && !speechLike) {
      this.silent++;
      this.add('inbound', { source: 'speech-detector', kind: 'info', detail: `utterance judged '${o.utterance}' by the speech detector (not counted)`, data });
    } else if (o.status === 'failed' && o.reason === 'stt-failed') {
      this.sttUnavailable++;
      this.add('inbound', { source: 'live-stt', kind: 'info', detail: 'speech-to-text failed for this utterance (transcription unavailable; not counted against the caller audio)', data });
    } else if (speechLike) {
      if (words >= this.t.minWords && (conf === null || conf >= this.t.minConfidence)) {
        this.good++;
        this.add('inbound', { source: 'live-stt', kind: 'supporting', detail: `speech produced a final live transcript of ${words} words${conf === null ? ' (the provider reports no confidence)' : ` at confidence ${conf.toFixed(2)}`}`, data });
      } else if (words === 0 || (conf !== null && conf < this.t.badConfidence)) {
        this.bad++;
        this.add('inbound', { source: 'live-stt', kind: 'negative', detail: words === 0 ? 'speech-like audio produced no words' : `speech-like audio produced a low-confidence transcript (${conf!.toFixed(2)})`, data });
      } else {
        this.inconclusive++;
        this.add('inbound', { source: 'live-stt', kind: 'info', detail: `speech produced ${words} word(s)${conf === null ? '' : ` at confidence ${conf.toFixed(2)}`}: not enough to count either way`, data });
      }
    }

    // Caller responded after the agent spoke: recorded for audibility, NEVER a verdict.
    if (speechLike && words > 0 && this.lastReplyPlayedAt !== null) {
      this.responses++;
      this.add('audibility', { source: 'caller-response', kind: 'supporting', detail: `Caller responded after the agent spoke (${this.responses} time${this.responses === 1 ? '' : 's'}); this is indirect and does not prove the caller heard the agent` });
      this.lastReplyPlayedAt = null;
    }
    if (o.callerReportsNotHearing) {
      this.add('audibility', { source: 'caller-phrase', kind: 'warning', detail: 'the caller said something like "I can\'t hear you" (phrase check in memory; a warning only, not a verdict)' });
    }

    if (this.state.inbound.status === 'verified') return;
    if (this.good >= this.t.minGoodUtterances) {
      this.set('inbound', 'verified', `${this.good} caller utterances were judged speech and produced live transcripts of at least ${this.t.minWords} words${'' /* confidence rule applied when reported */}`, 'live-stt');
    } else if (!this.wireFailed && this.bad >= this.t.failAfterBadUtterances && this.good === 0) {
      this.set('inbound', 'failed', `${this.bad} speech-like caller utterances produced no usable words (empty or confidence below ${this.t.badConfidence}); the caller audio is not intelligible to speech recognition`, 'live-stt');
    } else if (this.state.activeAt && !this.wireFailed) {
      this.set('inbound', 'verifying', `${this.good} of ${this.t.minGoodUtterances} good caller utterances so far`, 'live-stt');
    }
  }

  private notePlayback(o: TurnObservation): void {
    const bytes = o.bytesWritten ?? 0;
    const stoppedBy = o.playbackStoppedBy ?? null;
    if (bytes <= 0 && stoppedBy !== 'not-written') return; // the agent did not produce audio in this turn
    this.agentAttempted = true;
    const underruns = o.underruns ?? 0;
    const data = { bytesWritten: bytes, underruns, riskFrames: o.riskFrames ?? 0, lateFrames: o.lateFrames ?? 0, slowWrites: o.slowWrites ?? 0, stoppedBy };

    if (stoppedBy === 'not-written') {
      this.transportFailed = true;
      this.add('transport', { source: 'audio-port', kind: 'negative', detail: 'the audio port accepted fewer bytes than were sent (it closed or stopped streaming mid-reply)', data });
      this.set('transport', 'failed', 'the agent reply was not fully written to the modem audio port (port closed or stopped streaming)', 'audio-port');
      this.set('audibility', 'unable', 'the agent audio did not reach the modem intact, so whether the caller heard it cannot be verified', 'audio-port');
      return;
    }
    const degraded = underruns >= this.t.underrunsPerPlayback;
    this.degradedInARow = degraded ? this.degradedInARow + 1 : 0;
    if (degraded) {
      this.add('transport', { source: 'playback', kind: 'negative', detail: `${underruns} underruns while playing the reply: the modem was fed too late, so the caller may have heard gaps`, data });
      if (this.degradedInARow >= this.t.persistentUnderrunPlaybacks) {
        this.transportFailed = true;
        this.set('transport', 'failed', `persistent underruns: ${this.degradedInARow} replies in a row were fed to the modem too late to play smoothly`, 'playback');
      }
    } else if (o.playbackCompleted !== false || stoppedBy === 'aborted' || stoppedBy === 'call-ended') {
      this.goodPlaybacks++;
      this.add('transport', {
        source: 'playback',
        kind: 'supporting',
        detail: `${bytes} bytes of agent audio were accepted by the modem audio port${o.playbackCompleted === false ? ` (stopped early: ${stoppedBy})` : ''}; this proves delivery to the modem, not that anyone heard it`,
        data,
      });
    }
    if (!this.transportFailed && this.goodPlaybacks > 0) {
      this.set('transport', 'verified', `${this.goodPlaybacks} agent repl${this.goodPlaybacks === 1 ? 'y was' : 'ies were'} written to the modem audio port without write errors or persistent underruns`, 'playback');
    }
    if (bytes > 0) {
      this.agentSpoke = true;
      this.lastReplyPlayedAt = this.now().getTime();
      if (this.state.audibility.status === 'pending') {
        this.set('audibility', 'verifying', 'the agent has spoken; remote audibility needs confirmation from the caller side (no local measurement can prove it)', 'playback');
      }
    }
  }

  // ---- explicit remote confirmation (diagnostic) -------------------------------------------------------------------------------

  /** Arm a diagnostic key-press test for this call: the caller is asked (by a person, not by the system) to press `key`. */
  armKeyTest(key: string, windowMs = this.t.keyTestWindowMs): void {
    if (this.state.final) return;
    this.keyTest = { key, until: this.now().getTime() + windowMs };
    this.add('audibility', { source: 'remote-key-press', kind: 'info', detail: `diagnostic key-press test armed: waiting for the caller to press ${key}`, data: { key, windowMs } });
  }

  /** A DTMF key pressed by the remote party (from the modem's own DTMF report). */
  remoteKey(key: string): void {
    if (this.state.final || !this.keyTest) return;
    const t = this.now().getTime();
    if (t > this.keyTest.until) {
      this.add('audibility', { source: 'remote-key-press', kind: 'info', detail: 'diagnostic key-press test expired before the caller answered', data: { key } });
      this.keyTest = null;
      return;
    }
    if (key !== this.keyTest.key) {
      this.add('audibility', { source: 'remote-key-press', kind: 'info', detail: `the caller pressed ${key}, not the requested ${this.keyTest.key} (not counted)`, data: { key } });
      return;
    }
    this.keyTest = null;
    if (!this.agentSpoke) {
      this.add('audibility', { source: 'remote-key-press', kind: 'info', detail: 'the requested key arrived, but the agent had not spoken on this call yet, so it proves nothing about hearing the agent', data: { key } });
      return;
    }
    this.add('audibility', { source: 'remote-key-press', kind: 'supporting', detail: `the caller pressed the requested key ${key} during the diagnostic test`, data: { key } });
    this.set('audibility', 'verified', 'explicit confirmation from the caller side: the caller pressed the requested key during the diagnostic audibility test', 'remote-key-press');
  }

  // ---- end -------------------------------------------------------------------------------------------------------------------

  callEnded(): void {
    if (this.state.final) return;
    this.state.endedAt = this.iso();
    const ending = (a: VerificationAspect, reason: string, source: EvidenceSource | null) => {
      const s = this.state[a].status;
      if (s === 'pending' || s === 'verifying') this.set(a, 'unable', reason, source);
    };
    if (!this.state.activeAt) {
      ending('inbound', 'the call ended before it was answered', 'call-lifecycle');
      ending('transport', 'the call ended before it was answered', 'call-lifecycle');
      ending('audibility', 'the call ended before it was answered', 'call-lifecycle');
    } else {
      const heardAnything = this.good + this.bad + this.inconclusive + this.silent + this.sttUnavailable > 0;
      if (!this.pipeline && !heardAnything) {
        ending('inbound', 'no live transcription ran on this call (the AI agent was not attached), so intelligibility could not be judged', 'setup');
      }
      ending(
        'inbound',
        !this.wireEverFlowing
          ? 'no caller audio stream was received during the call'
          : this.good + this.bad + this.inconclusive === 0
            ? this.sttUnavailable > 0
              ? 'transcription was unavailable for the caller speech'
              : 'no caller speech was detected (silence)'
            : `only ${this.good} of ${this.t.minGoodUtterances} caller utterances were clear enough to count`,
        this.good + this.bad + this.inconclusive === 0 ? (this.sttUnavailable > 0 ? 'live-stt' : 'speech-detector') : 'live-stt'
      );
      ending('transport', 'the agent did not produce any audio on this call', 'playback');
      ending(
        'audibility',
        this.agentAttempted
          ? `no explicit confirmation from the caller side${this.responses > 0 ? ` (the caller responded after the agent ${this.responses} time${this.responses === 1 ? '' : 's'}, which is indirect)` : ''}`
          : 'the agent did not speak on this call',
        this.responses > 0 ? 'caller-response' : null
      );
    }
    this.state.final = true;
  }
}

/** Error text for logs and evidence: no credentials, no long tokens, bounded length. */
export function sanitize(message: string): string {
  return message
    .replace(/\b(?:x-api-key|authorization)\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi, '<redacted>')
    .replace(/\bbearer\s+\S+/gi, '<redacted>')
    .replace(/\b(?:sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, '<redacted>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted>')
    .slice(0, 300);
}
