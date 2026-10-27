/** Types and pure helpers for the complete-call recording card. Not the diagnostic captures. */

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
  tracks: { caller: RecordingTrackInfo; agent: RecordingTrackInfo };
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

export interface RecordingsResponse {
  status: RecorderStatus | null;
  recordings: RecordingInfo[];
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

/** One line that says what a recording contains, without claiming more than it proves. */
export function recordingSummary(r: RecordingInfo): string {
  const parts: string[] = [];
  parts.push(r.complete ? 'complete' : 'incomplete');
  if (!r.tracks.caller.hasAudio) parts.push('no caller audio was received');
  if (!r.tracks.agent.hasAudio) parts.push('nothing was written to the caller');
  if (r.truncated) parts.push('stopped at the time limit');
  if (r.isSimulated) parts.push('simulated audio');
  if (r.error) parts.push(r.error);
  return parts.join(' · ');
}
