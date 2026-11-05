import type { CheckStatus } from './readiness.js';

/**
 * Whether the audio paths of a call may be trusted, decided from evidence.
 *
 * Two kinds of evidence exist. A PERSON's confirmation ("the caller was intelligible", "the agent was audible") is a claim recorded once.
 * A MEASUREMENT is what the stream shows during this very call: bytes are flowing in, the audio port accepts writes out. Software can
 * measure that a stream is alive and healthy; it cannot hear. So automatic verification replaces the person's claim with the
 * measurement for the question "is the stream available and healthy", and says so in the result (`basis`), instead of recording a
 * confirmation nobody made. No audio is ever played to check: nothing here touches the call's audio.
 *
 * Manual mode (a person's confirmation required) behaves exactly as the checks in readiness.ts always have; tests pin the wording.
 */

export interface AudioVerificationInput {
  hasAudioAdapter: boolean;
  callActive: boolean;
  /** The USB audio wire state for this call ('flowing', 'not-expected', ...). Undefined when unknown. */
  wireState: string | undefined;
  /** Whether the audio port is streaming and accepting writes now. */
  isStreaming: boolean;
  /** A person confirmed it (the stored confirmation counts at the current sample rate). */
  confirmedByPerson: boolean;
  /** Automatic verification is switched on (a Setting; on by default in the installed product). */
  autoVerify: boolean;
}

export interface AudioVerificationResult {
  status: CheckStatus;
  detail: string;
  /** What the result rests on, so the dashboard can say "verified automatically" or "confirmed by a person". */
  basis: 'person' | 'automatic' | 'none';
}

export function verifyInboundAudio(i: AudioVerificationInput): AudioVerificationResult {
  if (!i.hasAudioAdapter) return { status: 'fail', detail: 'no audio adapter', basis: 'none' };
  if (i.confirmedByPerson) {
    if (i.callActive && i.wireState !== 'flowing') return { status: 'fail', detail: `verified flag is set but the wire shows '${i.wireState ?? 'unknown'}'`, basis: 'person' };
    if (!i.callActive) return { status: 'unverified', detail: 'verified flag is set; the stream can only be checked during an active call', basis: 'person' };
    return { status: 'pass', detail: 'verified flag set and PCM bytes are flowing now (flowing is not speech)', basis: 'person' };
  }
  if (i.autoVerify) {
    if (!i.callActive) return { status: 'unverified', detail: 'automatic verification: the incoming stream is checked once the call is active', basis: 'automatic' };
    if (i.wireState !== 'flowing') return { status: 'fail', detail: `automatic verification: the incoming USB audio stream is '${i.wireState ?? 'unknown'}', not flowing`, basis: 'automatic' };
    return { status: 'pass', detail: 'verified automatically: PCM bytes are flowing in now (flowing is not speech)', basis: 'automatic' };
  }
  return {
    status: 'unverified',
    detail: 'intelligible caller speech over the USB audio port has not been confirmed; confirm it from the dashboard only after a real call produced a correct live transcript',
    basis: 'none',
  };
}

export function verifyOutboundAudio(i: AudioVerificationInput): AudioVerificationResult {
  if (!i.hasAudioAdapter) return { status: 'fail', detail: 'no audio adapter', basis: 'none' };
  if (i.confirmedByPerson) {
    if (i.callActive && !i.isStreaming) return { status: 'fail', detail: 'verified flag is set but the audio port is not streaming', basis: 'person' };
    return { status: 'pass', detail: 'verified flag set and the audio port accepts writes', basis: 'person' };
  }
  if (i.autoVerify) {
    if (!i.callActive) return { status: 'unverified', detail: 'automatic verification: the outgoing audio port is checked once the call is active', basis: 'automatic' };
    if (!i.isStreaming) return { status: 'fail', detail: 'automatic verification: the outgoing audio port is not streaming', basis: 'automatic' };
    return { status: 'pass', detail: 'verified automatically: the outgoing audio port accepts writes', basis: 'automatic' };
  }
  return {
    status: 'unverified',
    detail: 'audibility of written PCM on the call has not been confirmed; confirm it from the dashboard only after a remote party heard blind test tones',
    basis: 'none',
  };
}
