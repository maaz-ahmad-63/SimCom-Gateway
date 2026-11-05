/**
 * Automatic call-audio verification, as the gateway reports it (GET /api/ai/audio-verification, socket 'ai:audio-verification').
 *
 * Three independent results per call, never merged into one "audio OK": caller audio intelligibility, agent audio transport (did it
 * reach the modem) and agent audio remote audibility (did the far end hear it). Transport being verified says nothing about
 * audibility, and the page must never suggest otherwise.
 */

export type VerificationStatus = 'pending' | 'verifying' | 'verified' | 'failed' | 'unable';
export type VerificationAspect = 'inbound' | 'transport' | 'audibility';

export interface VerificationEvidence {
  at: string;
  source: string;
  kind: 'supporting' | 'negative' | 'warning' | 'info';
  detail: string;
  data?: Record<string, number | string | boolean | null>;
}

export interface AspectResult {
  aspect: VerificationAspect;
  status: VerificationStatus;
  reason: string;
  source: string | null;
  updatedAt: string;
  evidence: VerificationEvidence[];
}

export interface CallAudioVerification {
  callId: string;
  direction: 'inbound' | 'outbound' | null;
  startedAt: string;
  activeAt: string | null;
  endedAt: string | null;
  final: boolean;
  simulated: boolean;
  inbound: AspectResult;
  transport: AspectResult;
  audibility: AspectResult;
}

export interface AudioVerificationSummary {
  callId: string;
  direction: string | null;
  startedAt: string;
  endedAt: string | null;
  final: boolean;
  inbound: VerificationStatus;
  transport: VerificationStatus;
  audibility: VerificationStatus;
  updatedAt: string;
}

export interface AudioVerificationResponse {
  enabled: boolean;
  current: CallAudioVerification | null;
  recent: AudioVerificationSummary[];
}

export const STATUS_LABEL: Record<VerificationStatus, string> = {
  pending: 'Pending',
  verifying: 'Verifying',
  verified: 'Verified',
  failed: 'Failed',
  unable: 'Unable to verify',
};

export const STATUS_TONE: Record<VerificationStatus, 'good' | 'warn' | 'bad' | 'neutral'> = {
  pending: 'neutral',
  verifying: 'neutral',
  verified: 'good',
  failed: 'bad',
  unable: 'warn',
};

export const ASPECTS: Array<{ key: VerificationAspect; title: string; explains: string }> = [
  { key: 'inbound', title: 'Caller audio intelligibility', explains: 'Caller speech detected and turned into real words by the live transcription.' },
  { key: 'transport', title: 'Agent audio transport', explains: "The agent's audio was accepted by the modem audio port. This proves delivery to the modem, not that the caller heard it." },
  { key: 'audibility', title: 'Agent audio remote audibility', explains: 'Only an explicit confirmation from the caller side (a diagnostic key-press test) can verify this.' },
];

export const SOURCE_LABEL: Record<string, string> = {
  'usb-audio-stream': 'USB audio stream',
  'speech-detector': 'Speech detector',
  'live-stt': 'Live transcription',
  playback: 'Playback to the modem',
  'audio-port': 'Modem audio port',
  'caller-response': 'Caller response (indirect)',
  'caller-phrase': 'Caller phrase (warning only)',
  'remote-key-press': 'Caller key press',
  'call-lifecycle': 'Call state',
  setup: 'Setup',
};

export const sourceLabel = (s: string | null): string => (s ? SOURCE_LABEL[s] ?? s : 'No evidence yet');

/** Warnings worth showing next to the status: e.g. "the caller said they cannot hear", which never changes the status itself. */
export function warningsOf(a: AspectResult): VerificationEvidence[] {
  return a.evidence.filter((e) => e.kind === 'warning');
}

/** The latest few evidence lines, newest first. */
export function latestEvidence(a: AspectResult, n = 4): VerificationEvidence[] {
  return [...a.evidence].reverse().slice(0, n);
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
