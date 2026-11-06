/** Types and pure helpers for complete-call recordings: the recording card and playback from the call history. Not the diagnostic captures. */

/** What the gateway measured when it mixed the caller's side and the agent's side into the one file. */
export interface RecordingMix {
  /** The one gain applied to the caller's side (the modem delivers the caller quieter than the agent's voice). 0 = none. */
  callerGainDb: number;
  callerVoicedFrames: number;
  callerSpeechDbfs: number | null;
  agentSpeechDbfs: number | null;
  callerPeak: number;
  agentPeak: number;
  clippedSamples: number;
}

/** Recordings made before the combined format kept two files per call; the gateway mixes them on first request. */
export interface RecordingTrackInfo {
  file: string;
  bytes: number;
  durationMs: number;
  hasAudio: boolean;
}

export interface RecordingInfo {
  callId: string;
  direction: string;
  startedAt: string;
  endedAt: string | null;
  complete: boolean;
  outcome: string | null;
  sampleRate: number;
  isSimulated: boolean;
  truncated: boolean;
  error?: string;
  /** The one combined WAV (null while the call is recording or the file is still being finished). */
  file: string | null;
  bytes: number;
  durationMs: number;
  hasCallerAudio: boolean;
  hasAgentAudio: boolean;
  mix: RecordingMix | null;
  note?: string;
  /** Can it be played right now? */
  available: boolean;
  tracks?: { caller: RecordingTrackInfo; agent: RecordingTrackInfo };
}

export interface RecorderStatus {
  enabled: boolean;
  consentAcknowledged: boolean;
  inactiveReason: string | null;
  dir: string;
  active: { callId: string; startedAt: string; callerBytes: number; agentBytes: number } | null;
  lastError: string | null;
  retentionDays: number;
}

/** Why a call that connected was not recorded, as the gateway noted it at that moment. */
export interface NotRecordedInfo {
  callId: string;
  status: 'off' | 'no-consent' | 'config-error' | 'start-failed' | string;
  reason: string;
  at: string;
}

export interface RecordingsResponse {
  status: RecorderStatus | null;
  recordings: RecordingInfo[];
  /** Only for calls asked about by id that have no recording (absent from an older gateway). */
  notRecorded?: NotRecordedInfo[];
}

/** GET/PUT /api/gateway/recordings/settings (Settings > Call Recording). */
export interface RecordingSettingsView {
  settings: { enabled: boolean; consentAcknowledged: boolean; consentAcknowledgedAt: string | null; retentionDays: number; maxSeconds: number };
  source: 'saved' | 'environment';
  dir: string;
  updatedAt: string | null;
  status: RecorderStatus | null;
}

/** What the operator confirms before recording can be switched on (Settings > Call Recording). */
export const CONSENT_TEXT =
  'I confirm that recording these calls is lawful where I and the people I call are, and that I have given any notice or obtained any consent that the law requires (for example, telling callers the call is recorded).';

/** The operator-facing sentence for a call that was not recorded. */
export function notRecordedReason(n: NotRecordedInfo): string {
  switch (n.status) {
    case 'off':
      return 'Not recorded: call recording was switched off when this call connected. Switch it on in Settings > Call Recording.';
    case 'no-consent':
      return 'Not recorded: recording was on, but the consent acknowledgement had not been confirmed (Settings > Call Recording).';
    case 'start-failed':
      return `The recording could not start, so this call was not recorded: ${n.reason}`;
    default:
      return `Not recorded: ${n.reason}`;
  }
}

export type RecorderTone = 'good' | 'warn' | 'bad' | 'neutral';

export function recorderState(status: RecorderStatus | null): { label: string; tone: RecorderTone; detail: string } {
  if (!status) return { label: 'Unknown', tone: 'neutral', detail: 'Waiting for the gateway' };
  if (status.lastError) return { label: 'Error', tone: 'bad', detail: status.lastError };
  if (status.active) return { label: 'Recording', tone: 'good', detail: `Recording call ${status.active.callId.slice(0, 8)}…` };
  if (status.inactiveReason) return { label: status.enabled ? 'Blocked' : 'Off', tone: status.enabled ? 'warn' : 'neutral', detail: status.inactiveReason };
  return { label: 'Armed', tone: 'good', detail: 'The next call that becomes ACTIVE will be recorded' };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Playback position as "0:12 / 1:00". */
export function formatPosition(positionSeconds: number, durationSeconds: number): string {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return `${formatDuration(safe(positionSeconds) * 1000)} / ${formatDuration(safe(durationSeconds) * 1000)}`;
}

/** How far through the recording playback is, 0 to 100 (0 while the length is not known). */
export function progressPercent(positionSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(100, (positionSeconds / durationSeconds) * 100));
}

/** One line that says what a recording contains, without claiming more than it proves. */
export function recordingSummary(r: RecordingInfo): string {
  const parts: string[] = [];
  parts.push(r.complete ? 'complete' : 'incomplete');
  if (!r.hasCallerAudio) parts.push('no caller audio was received');
  if (!r.hasAgentAudio) parts.push('nothing was written to the caller');
  if (r.mix && r.mix.callerGainDb > 0) parts.push(`caller raised ${r.mix.callerGainDb} dB`);
  if (r.truncated) parts.push('stopped at the time limit');
  if (r.isSimulated) parts.push('simulated audio');
  if (r.error) parts.push(r.error);
  return parts.join(' · ');
}

/** What the call history knows about one call's recording. */
export type RecordingAvailability =
  | { state: 'unknown' } // the list has not answered (yet): try to play and report what happens
  | { state: 'available'; recording: RecordingInfo }
  | { state: 'none'; reason: string };

/** Calls that never connected have nothing to record. */
const NEVER_CONNECTED = new Set(['missed', 'rejected', 'busy_rejected', 'busy', 'no_answer', 'failed']);

/**
 * Whether a call has a recording to play, and if not, why, in a sentence the operator can act on. `lookup` is what the gateway said
 * about the calls on the page (null: it did not answer).
 */
export function recordingAvailability(
  call: { id: string; answeredAt?: string | null; outcome?: string | null },
  lookup: Map<string, RecordingInfo> | null,
  notRecorded?: Map<string, NotRecordedInfo> | null
): RecordingAvailability {
  if (lookup === null) return { state: 'unknown' };
  const recording = lookup.get(call.id);
  if (recording?.available) return { state: 'available', recording };
  if (recording) {
    if (recording.error && !recording.endedAt) return { state: 'none', reason: `The recording failed: ${recording.error}` };
    if (!recording.endedAt) return { state: 'none', reason: 'This call is still being recorded. The recording can be played when it ends.' };
    if (!recording.file) return { state: 'none', reason: recording.error ? `The recording could not be finished: ${recording.error}` : 'The recording is still being finished. Try again in a moment.' };
    return { state: 'none', reason: 'The recording file is no longer on the gateway (it may have been deleted by the retention setting).' };
  }
  const skipped = notRecorded?.get(call.id);
  if (skipped) return { state: 'none', reason: notRecordedReason(skipped) };
  if (!call.answeredAt && (call.outcome ? NEVER_CONNECTED.has(call.outcome) : true)) {
    return { state: 'none', reason: 'This call was never answered, so there is nothing to record.' };
  }
  return {
    state: 'none',
    reason: 'No recording exists for this call. Calls are recorded only while recording is switched on with the consent acknowledgement confirmed (Settings > Call Recording), and only calls made while it was on.',
  };
}

/**
 * What pressing the recording button of one call does. Only one call's row is open at a time; a call with no recording opens its reason
 * (and pressing again closes it); a call with a recording opens the player, which starts playing, and pressing again pauses or resumes.
 */
export function nextRecordingAction(openCallId: string | null, callId: string, availability: RecordingAvailability): 'open' | 'close' | 'toggle' {
  if (openCallId !== callId) return 'open';
  return availability.state === 'none' ? 'close' : 'toggle';
}

export interface LoadedRecording {
  url: string;
  bytes: number;
}

/**
 * Fetch a call's recording through the authenticated gateway route and make it playable from the browser's own copy. Refuses an empty
 * answer and anything that is not a WAV, so a broken or wrong response is reported plainly instead of failing silently in the player.
 * `download` is the API client's (it carries the API key); there is no recording URL that a browser could open without it.
 */
export async function loadRecordingUrl(
  callId: string,
  deps: { download: (callId: string) => Promise<Blob>; createObjectUrl: (blob: Blob) => string }
): Promise<LoadedRecording> {
  const blob = await deps.download(callId);
  if (blob.size === 0) throw new Error('The gateway sent an empty recording.');
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const text = (from: number, to: number) => String.fromCharCode(...Array.from(head.subarray(from, to)));
  if (head.length < 12 || text(0, 4) !== 'RIFF' || text(8, 12) !== 'WAVE') throw new Error('The gateway did not send a WAV recording, so it cannot be played.');
  return { url: deps.createObjectUrl(blob), bytes: blob.size };
}
