import type {
  AiAudioMeter,
  AiConversationPhase,
  AiConversationReadiness,
  AiConversationView,
  AiReadinessView,
  AiTestResponseResult,
  AiTestStageStatus,
} from '@sim-gateway/shared';
import type { Tone } from './ai-secrets';

export interface ReadinessSummary {
  label: string;
  tone: Tone;
  detail: string;
}

/**
 * One honest headline for the agent. "Ready to reply" only appears when the gateway itself says every
 * check passed; mock hardware, unverified audio and missing keys each have their own wording.
 */
export function summarizeReadiness(r: AiReadinessView | null): ReadinessSummary {
  if (!r) return { label: 'Unknown', tone: 'neutral', detail: 'Waiting for the gateway' };
  if (r.mode === 'off') return { label: 'AI is off', tone: 'neutral', detail: 'The agent is disabled; nothing is transcribed or sent' };
  if (r.simulatedHardware && !r.ok) {
    return { label: 'Simulated hardware', tone: 'warn', detail: 'Mock mode can never make the agent ready; connect the real modem' };
  }
  if (r.ok) return { label: 'Ready to reply', tone: 'good', detail: 'Every readiness check passed' };
  if (r.passiveOk) {
    return { label: 'Passive ready', tone: 'warn', detail: 'Calls can be transcribed; replies stay blocked until audio is verified both ways' };
  }
  return { label: 'Blocked', tone: 'bad', detail: r.passiveBlockers[0] ?? r.blockers[0] ?? 'Not ready' };
}

export interface ChecklistRow {
  name: string;
  status: 'pass' | 'fail' | 'unverified';
  detail: string;
  /** Needed for passive transcription as well as for replies. */
  needed: 'passive' | 'replies';
}

const PASSIVE_CHECKS = new Set(['ai-config', 'stt-key', 'hardware', 'modem', 'call', 'audio-format', 'inbound-wire']);

export function checklist(r: AiReadinessView): ChecklistRow[] {
  return r.checks.map((c) => ({ ...c, needed: PASSIVE_CHECKS.has(c.name) ? 'passive' : 'replies' }));
}

export const CHECK_LABELS: Record<string, string> = {
  'ai-config': 'Provider selection valid',
  'stt-key': 'Speech-to-text key present',
  'provider-keys': 'All provider keys present',
  hardware: 'Real modem hardware',
  modem: 'Modem ready',
  call: 'Call active',
  'audio-format': 'Audio format configured',
  'inbound-wire': 'Caller audio arriving',
  'inbound-audio': 'Caller audio confirmed intelligible',
  'outbound-audio': 'Agent audio confirmed audible',
};

export interface AudioHealth {
  tone: Tone;
  notes: string[];
}

/** Plain-language reading of the live meters. Bytes arriving are not speech; this says so. */
export function describeAudioHealth(m: AiAudioMeter): AudioHealth {
  const notes: string[] = [];
  let tone: Tone = 'good';
  const worsen = (t: Tone) => {
    if (t === 'bad' || (t === 'warn' && tone === 'good')) tone = t;
  };
  if (m.receivedBytes === 0 || m.lastFrameAgoMs === null) {
    notes.push('No caller audio has arrived yet');
    worsen('bad');
  } else if (m.lastFrameAgoMs > 2000) {
    notes.push(`No audio for ${(m.lastFrameAgoMs / 1000).toFixed(1)} s: the stream has stalled`);
    worsen('bad');
  }
  if (m.maxGapMs > 200) {
    notes.push(`Longest gap between audio frames was ${m.maxGapMs} ms`);
    worsen('warn');
  }
  if (m.silentForMs !== null && m.silentForMs > 10_000) {
    notes.push(`Only line noise for ${(m.silentForMs / 1000).toFixed(0)} s: nothing is being said, or the audio is too quiet`);
    worsen('warn');
  }
  if (m.observedSampleRate !== null && Math.abs(m.observedSampleRate - m.expectedSampleRate) / m.expectedSampleRate > 0.15) {
    notes.push(`Bytes are arriving at about ${m.observedSampleRate} samples/s but the AI assumes ${m.expectedSampleRate} Hz: audio would be mislabeled, do not trust transcripts`);
    worsen('bad');
  }
  if (m.backlogMs > 1500) {
    notes.push(`Audio is arriving faster than real time (about ${(m.backlogMs / 1000).toFixed(1)} s of backlog): a stalled stream is being flushed, so replies could answer old speech`);
    worsen('warn');
  }
  if (m.peak > 0.99) {
    notes.push('Audio is clipping');
    worsen('warn');
  }
  if (notes.length === 0) notes.push('Audio is arriving steadily');
  return { tone, notes };
}

export function rmsToDb(rms: number): number | null {
  return rms > 0 ? 20 * Math.log10(rms) : null;
}

export function formatDb(rms: number): string {
  const db = rmsToDb(rms);
  return db === null ? '−∞ dBFS' : `${db.toFixed(1)} dBFS`;
}

export interface AttachState {
  /** Show the control at all. False only when there is no call. */
  visible: boolean;
  mode: 'attach' | 'detach' | 'none';
  enabled: boolean;
  /** Why the control is disabled (or, for no call, why it is absent). Null when it is usable. */
  reason: string | null;
}

const STATE_REASON: Record<string, string> = {
  DIALING: 'The call is still dialing. The AI can attach once the gateway marks it ACTIVE, which happens after the remote party answers.',
  OUTBOUND_RINGING: 'The call is ringing. The AI can attach once the gateway marks it ACTIVE, after the remote party answers.',
  INBOUND_RINGING: 'The call is ringing and has not been answered. Answer it first; the AI never answers calls.',
  TERMINATING: 'The call is ending.',
};

const friendlyBlocker = (blocker: string): string => {
  const i = blocker.indexOf(': ');
  const name = i > 0 ? blocker.slice(0, i) : blocker;
  const detail = i > 0 ? blocker.slice(i + 2) : '';
  return `${CHECK_LABELS[name] ?? name}${detail ? `: ${detail}` : ''}`;
};

/**
 * Whether the operator may attach the AI to the current call, and if not, exactly why. It mirrors the
 * gateway's own rules (call ACTIVE, passive readiness) so the button is never a guess; the gateway
 * still re-checks every one of them when the request arrives.
 */
export function attachControlState(
  call: { state: string } | null,
  readiness: AiReadinessView | null,
  attached: boolean
): AttachState {
  if (!call || call.state === 'IDLE') {
    return { visible: false, mode: 'none', enabled: false, reason: 'No call is in progress. Audio can only be checked during one.' };
  }
  if (attached) return { visible: true, mode: 'detach', enabled: true, reason: null };
  const disabled = (reason: string): AttachState => ({ visible: true, mode: 'attach', enabled: false, reason });
  if (call.state !== 'ACTIVE') return disabled(STATE_REASON[call.state] ?? `The call is ${call.state}; the AI can attach once it is ACTIVE.`);
  if (!readiness) return disabled('Waiting for the gateway\'s AI status.');
  if (readiness.mode === 'off') return disabled('AI is off. Enable the agent on the Agent tab, then choose Passive mode.');
  if (!readiness.passiveOk) {
    const first = readiness.passiveBlockers[0];
    return disabled(first ? `Not ready yet. ${friendlyBlocker(first)}` : 'Not ready yet.');
  }
  return { visible: true, mode: 'attach', enabled: true, reason: null };
}

export interface TestStageRow {
  key: 'llm' | 'tts' | 'playbackSubmission' | 'playbackCompletion';
  label: string;
  status: AiTestStageStatus;
  ms: number | null;
  error: string | null;
  detail: string;
}

/**
 * The four stages of a test response, each on its own line. "Completed" is worded as the gateway
 * having written the audio; nothing in this list says the remote party heard it.
 */
export function testResponseRows(r: AiTestResponseResult): TestStageRow[] {
  const bytes = (a: number | null, b: number | null) => (a === null || b === null ? '' : `${a} of ${b} bytes`);
  return [
    { key: 'llm', label: 'LLM generation', status: r.llm.status, ms: r.llm.ms, error: r.llm.error, detail: r.llm.chars === null ? '' : `${r.llm.chars} characters` },
    { key: 'tts', label: 'TTS generation', status: r.tts.status, ms: r.tts.ms, error: r.tts.error, detail: r.tts.seconds === null ? '' : `${r.tts.seconds} s of audio, ${r.tts.bytes} bytes` },
    { key: 'playbackSubmission', label: 'Playback submitted to audio port', status: r.playbackSubmission.status, ms: r.playbackSubmission.ms, error: r.playbackSubmission.error, detail: bytes(r.playbackSubmission.bytesWritten, r.playbackSubmission.bytesTotal) },
    { key: 'playbackCompletion', label: 'Playback written to the end', status: r.playbackCompletion.status, ms: r.playbackCompletion.ms, error: r.playbackCompletion.error, detail: r.playbackCompletion.status === 'ok' ? 'all audio written, in real time (not proof it was heard)' : '' },
  ];
}

export const PHASE_LABELS: Record<AiConversationPhase, string> = {
  stopped: 'Stopped',
  listening: 'Listening',
  transcribing: 'Transcribing',
  generating: 'Generating reply',
  speaking: 'Speaking',
};

export interface ConversationControl {
  visible: boolean;
  mode: 'start' | 'stop';
  enabled: boolean;
  reason: string | null;
}

/**
 * Start/stop control for conversation mode on the current call. It mirrors the gateway's readiness (which
 * re-checks everything when the request arrives) and never offers Start on a call that is not ACTIVE.
 */
export function conversationControl(
  call: { state: string } | null,
  conversation: AiConversationView | null,
  readiness: AiConversationReadiness | null
): ConversationControl {
  if (!call || call.state === 'IDLE') {
    return { visible: false, mode: 'start', enabled: false, reason: 'No call is in progress.' };
  }
  if (conversation?.enabled) return { visible: true, mode: 'stop', enabled: true, reason: null };
  if (call.state !== 'ACTIVE') {
    return { visible: true, mode: 'start', enabled: false, reason: 'The call must be ACTIVE (answered) before the AI can talk.' };
  }
  if (!readiness) return { visible: true, mode: 'start', enabled: false, reason: "Waiting for the gateway's AI status." };
  if (!readiness.allowed) {
    const first = readiness.blockers[0];
    return { visible: true, mode: 'start', enabled: false, reason: first ? `Not ready yet. ${friendlyBlocker(first)}` : 'Not ready yet.' };
  }
  return { visible: true, mode: 'start', enabled: true, reason: null };
}

export interface LatencyRow {
  label: string;
  ms: number | null;
}

/** The last turn's stage timings, in pipeline order. A stage that did not run is null, never zero. */
export function conversationLatencies(view: AiConversationView): LatencyRow[] {
  const t = view.lastTurn;
  return [
    { label: 'Pause before reply', ms: view.endpointSilenceMs },
    { label: 'Speech-to-text', ms: t?.sttMs ?? null },
    { label: 'LLM first token', ms: t?.llmFirstTokenMs ?? null },
    { label: 'TTS first audio', ms: t?.ttsFirstMs ?? null },
    { label: 'To first audio', ms: t?.firstAudioMs ?? null },
    { label: 'Playback written', ms: t?.playMs ?? null },
    { label: 'Whole turn (incl. speaking)', ms: t?.totalMs ?? null },
  ];
}
