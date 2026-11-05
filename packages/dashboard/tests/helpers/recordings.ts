import type { RecordingInfo } from '../../src/lib/recordings';

/** A complete, playable recording as the gateway lists it. */
export const rec = (over: Partial<RecordingInfo> = {}): RecordingInfo => ({
  callId: '11111111-2222-4333-8444-555555555555', direction: 'inbound', startedAt: '2026-10-26T08:42:28.000Z', endedAt: '2026-10-26T08:43:28.000Z',
  complete: true, outcome: 'completed', sampleRate: 8000, isSimulated: false, truncated: false,
  file: 'recording.wav', bytes: 960044, durationMs: 60000, hasCallerAudio: true, hasAgentAudio: true, mix: null, available: true, ...over,
});
