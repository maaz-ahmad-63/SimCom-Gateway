import type { AiInspectorEvent, AiInspectorStage, AiStageStatus } from '@sim-gateway/shared';

/** The eight pipeline stages, in the order a caller turn passes through them. */
export const INSPECTOR_STAGES: readonly AiInspectorStage[] = [
  'pcm-capture',
  'pcm-validation',
  'stt-submit',
  'stt-result',
  'llm-request',
  'llm-response',
  'tts-generated',
  'playback',
];

export const STAGE_LABELS: Record<AiInspectorStage, string> = {
  'pcm-capture': 'PCM captured',
  'pcm-validation': 'PCM validated',
  'stt-submit': 'Sent to STT',
  'stt-result': 'STT result',
  'llm-request': 'LLM request',
  'llm-response': 'LLM response',
  'tts-generated': 'TTS generated',
  playback: 'Playback to caller',
};

export type StageViewStatus = AiStageStatus | 'pending';

export interface StageView {
  stage: AiInspectorStage;
  status: StageViewStatus;
  latencyMs: number | null;
  at: string | null;
  detail: string | null;
  data: Record<string, number | string | boolean | null> | null;
  /** Number of events that updated this stage (a reply with several sentences reports tts/playback repeatedly). */
  count: number;
}

export type TurnOutcome = 'running' | 'completed' | 'passive' | 'failed' | 'skipped' | 'cancelled';

export interface TurnView {
  turnId: string;
  callId: string;
  startedAt: string;
  stages: Record<AiInspectorStage, StageView>;
  /** Present only when the gateway sent text (the operator enabled transcripts). */
  callerText: string | null;
  agentText: string[];
  /** The gateway withheld text because transcripts are off. */
  textHidden: boolean;
  outcome: TurnOutcome;
  /** First stage that failed, with the gateway's reason: failures are never swallowed. */
  failure: { stage: AiInspectorStage; detail: string } | null;
}

export interface CallMarker {
  seq: number;
  callId: string;
  timestamp: string;
  status: AiStageStatus;
  detail: string;
}

export interface InspectorState {
  turns: TurnView[];
  markers: CallMarker[];
  seen: Record<number, true>;
  maxSeq: number;
}

const MAX_TURNS = 40;
const MAX_MARKERS = 40;
const MAX_SEEN = 4000;

export const emptyInspector = (): InspectorState => ({ turns: [], markers: [], seen: {}, maxSeq: 0 });

const emptyStages = (): Record<AiInspectorStage, StageView> =>
  Object.fromEntries(
    INSPECTOR_STAGES.map((stage) => [
      stage,
      { stage, status: 'pending', latencyMs: null, at: null, detail: null, data: null, count: 0 } as StageView,
    ])
  ) as Record<AiInspectorStage, StageView>;

function deriveOutcome(turn: TurnView): TurnOutcome {
  const s = turn.stages;
  if (turn.failure) return 'failed';
  if (s['pcm-validation'].status === 'skipped' || s['stt-result'].status === 'skipped') return 'skipped';
  if (s['stt-result'].status === 'cancelled' || s['playback'].status === 'cancelled' || s['llm-response'].status === 'cancelled') {
    return 'cancelled';
  }
  if (s['stt-result'].status === 'ok' && s['llm-request'].status === 'not-run') return 'passive';
  if (s['playback'].status === 'ok') return 'completed';
  return 'running';
}

function trimSeen(seen: Record<number, true>, maxSeq: number): Record<number, true> {
  const keys = Object.keys(seen);
  if (keys.length <= MAX_SEEN) return seen;
  const floor = maxSeq - MAX_SEEN;
  return Object.fromEntries(keys.filter((k) => Number(k) > floor).map((k) => [k, true])) as Record<number, true>;
}

/**
 * Fold one gateway event into the inspector. Duplicates (same seq, as happens when the catch-up
 * request overlaps the live stream after a reconnect) are ignored. Pure: returns a new state.
 */
export function applyInspectorEvent(state: InspectorState, event: AiInspectorEvent): InspectorState {
  if (state.seen[event.seq]) return state;
  const seen = { ...state.seen, [event.seq]: true as const };
  const maxSeq = Math.max(state.maxSeq, event.seq);

  if (event.stage === 'call' || event.turnId === null) {
    const marker: CallMarker = {
      seq: event.seq,
      callId: event.callId,
      timestamp: event.timestamp,
      status: event.status,
      detail: event.detail ?? 'call event',
    };
    const markers = [...state.markers, marker].sort((a, b) => a.seq - b.seq).slice(-MAX_MARKERS);
    return { ...state, markers, seen: trimSeen(seen, maxSeq), maxSeq };
  }

  const turns = state.turns.slice();
  let index = turns.findIndex((t) => t.turnId === event.turnId);
  if (index < 0) {
    turns.push({
      turnId: event.turnId,
      callId: event.callId,
      startedAt: event.timestamp,
      stages: emptyStages(),
      callerText: null,
      agentText: [],
      textHidden: false,
      outcome: 'running',
      failure: null,
    });
    index = turns.length - 1;
  }
  const previous = turns[index];
  const stage = event.stage;
  const stages = { ...previous.stages };
  const current = stages[stage];
  stages[stage] = {
    stage,
    // A later event for a stage that already failed must not hide the failure.
    status: current.status === 'failed' ? 'failed' : event.status,
    latencyMs: event.latencyMs ?? current.latencyMs,
    at: current.at ?? event.timestamp,
    detail: event.detail ?? current.detail,
    data: event.data ? { ...current.data, ...event.data } : current.data,
    count: current.count + 1,
  };

  const next: TurnView = { ...previous, stages };
  if (event.text !== undefined) {
    if (event.role === 'caller') next.callerText = event.text;
    else if (event.role === 'agent') next.agentText = [...previous.agentText, event.text];
  }
  if (event.data?.textHidden === true) next.textHidden = true;
  if (event.status === 'failed' && !previous.failure) {
    next.failure = { stage, detail: event.detail ?? 'The stage failed without a reason' };
  }
  next.outcome = deriveOutcome(next);
  turns[index] = next;
  turns.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return { turns: turns.slice(-MAX_TURNS), markers: state.markers, seen: trimSeen(seen, maxSeq), maxSeq };
}

/** Apply a batch (catch-up after connect or reconnect), in sequence order. */
export function mergeInspectorEvents(state: InspectorState, events: AiInspectorEvent[]): InspectorState {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(applyInspectorEvent, state);
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** Wall-clock span from the first to the last stage of a turn. */
export function turnSpanMs(turn: TurnView): number | null {
  const times = Object.values(turn.stages)
    .map((s) => (s.at ? Date.parse(s.at) : NaN))
    .filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

export const OUTCOME_LABELS: Record<TurnOutcome, string> = {
  running: 'In progress',
  completed: 'Reply played',
  passive: 'Transcribed only',
  failed: 'Failed',
  skipped: 'Not sent to STT',
  cancelled: 'Cancelled',
};
