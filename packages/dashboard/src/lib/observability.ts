/** Types and pure helpers for the Call Logs / Observability page. The numbers come from the gateway; nothing is computed here that the gateway recorded. */

export interface Stat {
  n: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
}

export interface ProviderPick {
  key: string;
  provider: string;
  model: string | null;
}

export interface Selection {
  stt: ProviderPick | null;
  llm: ProviderPick | null;
  tts: ProviderPick | null;
}

export interface CallFilters {
  from?: string;
  to?: string;
  status?: string;
  direction?: 'inbound' | 'outbound';
  provider?: string;
  model?: string;
  q?: string;
  simulated?: 'only' | 'exclude';
}

export interface Overview {
  calls: { total: number; successful: number; failed: number; withAiErrors: number; byOutcome: Record<string, number>; failureRate: number | null };
  turns: { total: number; completed: number; failed: number; cancelled: number; errorRatePercent: number | null };
  latencyMs: { endToEnd: Stat; tft: Stat; stt: Stat; llmTotal: Stat; ttsFirstAudio: Stat; ttsTotal: Stat; turn: Stat };
  providers: Record<'stt' | 'llm' | 'tts', Array<{ key: string; turns: number; failedTurns: number; latencyMs: Stat }>>;
  /** How many turns each kind of STT timing is based on (they measure different things). */
  sttModes: Record<string, number>;
  cancellations: { total: number; afterAudioStarted: number; bySource: Record<string, number> };
  playback: { maxLateMs: Stat; loopLagMs: Stat; turnsWithLateFrames: number; turnsWithGapRisk: number };
  simulatedTurns: number;
}

export interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound';
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  status: string;
  terminationReason: string | null;
  simulated: boolean;
  campaign: { campaignId: string; contactId: number; attempt: number | null } | null;
  selection: Selection;
  turns: number;
  failedTurns: number;
  cancelledTurns: number;
  latency: { endToEndMs: number | null; sttMs: number | null; tftMs: number | null; llmTotalMs: number | null; ttsFirstMs: number | null };
}

export interface Paged<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export interface TraceEvent {
  id: number;
  callId: string;
  turnId: string | null;
  at: string;
  monoMs: number;
  stage: string;
  status: string;
  latencyMs: number | null;
  detail: string | null;
  data: Record<string, unknown> | null;
  provider: string | null;
  model: string | null;
  httpStatus: number | null;
  attempt: number | null;
}

export interface TurnLatency {
  utteranceMs: number | null;
  endpointMs: number | null;
  sttMs: number | null;
  sttWaitedMs: number | null;
  tftMs: number | null;
  tftAvailable: boolean | null;
  sttMode: string | null;
  maxLateMs: number | null;
  lateFrames: number | null;
  riskFrames: number | null;
  loopLagMaxMs: number | null;
  llmTotalMs: number | null;
  ttsFirstMs: number | null;
  ttsTotalMs: number | null;
  firstAudioMs: number | null;
  endToEndMs: number | null;
  playMs: number | null;
  turnMs: number | null;
}

export interface TurnTrace {
  turnId: string;
  index: number;
  at: string;
  status: string;
  reason: string | null;
  cancelSource: string | null;
  /** Caller text and agent reply as stored; null when transcripts were off (never reconstructed). */
  transcript: string | null;
  reply: string | null;
  failingStage: string | null;
  failureDetail: string | null;
  latency: TurnLatency;
  retries: number;
  events: TraceEvent[];
}

export interface CallDetail {
  call: { id: string; direction: string; startedAt: string; answeredAt: string | null; endedAt: string | null; durationSeconds: number; status: string; terminationReason: string | null; simulated: boolean; campaign: { campaignId: string; contactId: number; attempt: number | null } | null };
  selection: Selection;
  firstAudioReceivedAt: string | null;
  turns: TurnTrace[];
  callEvents: TraceEvent[];
  errors: Array<{ at: string; turnId: string | null; stage: string; detail: string | null; provider: string | null; httpStatus: number | null; attempt: number | null }>;
  totals: { turns: number; failedTurns: number; cancelledTurns: number; events: number };
  lifecycle: Array<{ type: string; from: string | null; to: string | null; at: string }>;
}

export const PAGE_SIZE = 25;

export const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any status' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'missed', label: 'Missed' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'busy', label: 'Busy' },
  { value: 'busy_rejected', label: 'Busy (rejected)' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'ai_error', label: 'AI errors (any failed turn)' },
];

/** Query string for the observability endpoints; empty values are left out. */
export function buildQuery(filters: CallFilters, page?: { page: number; pageSize: number }): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (typeof v === 'string' && v.trim() !== '') params.set(k, v.trim());
  if (page) {
    params.set('page', String(page.page));
    params.set('pageSize', String(page.pageSize));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** A date input value (YYYY-MM-DD, the viewer's local day) to the UTC instant the filter sends. */
export function dayBoundary(value: string, edge: 'start' | 'end'): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split('-').map(Number);
  const date = edge === 'start' ? new Date(y, m - 1, d, 0, 0, 0, 0) : new Date(y, m - 1, d, 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function statusTone(status: string): Tone {
  if (status === 'completed') return 'good';
  if (status === 'failed' || status === 'unfinished') return 'bad';
  if (['missed', 'no_answer', 'rejected', 'busy', 'busy_rejected', 'cancelled', 'in_progress'].includes(status)) return 'warn';
  return 'neutral';
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}%`;
}

export function pickLabel(p: ProviderPick | null): string {
  if (!p) return '—';
  return p.model && p.model !== p.provider ? `${p.provider} / ${p.model}` : p.provider;
}

const STAGE_LABELS: Record<string, string> = {
  'pcm-capture': 'Caller audio received',
  'pcm-validation': 'Audio check',
  'stt-submit': 'STT started',
  'stt-result': 'STT result',
  'llm-request': 'LLM started',
  'llm-response': 'LLM result',
  'tts-generated': 'TTS audio',
  playback: 'Playback to caller',
  'provider-attempt': 'Provider request',
  call: 'Call event',
};
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;

const STT_MODE_NOTES: Record<string, string> = {
  batch: 'one request after the caller stopped',
  speculative: 'request started during the pause',
  stream: 'wait for the final text of a live stream',
};

/** What the STT figure measured, since the three modes are not the same thing. */
export function sttModeNote(l: TurnLatency): string | undefined {
  const mode = l.sttMode ? STT_MODE_NOTES[l.sttMode] : undefined;
  const waited = l.sttMs !== null && l.sttWaitedMs !== null && l.sttWaitedMs < l.sttMs ? `waited ${ms(l.sttWaitedMs)}` : undefined;
  return [mode, waited].filter(Boolean).join(' · ') || undefined;
}

/** The five figures the call detail leads with, each saying plainly when it was not measured. */
export function breakdownRows(l: TurnLatency): Array<{ label: string; value: string; note?: string }> {
  const missing = 'not measured for this turn';
  return [
    {
      label: 'STT duration',
      value: ms(l.sttMs),
      note: l.sttMs === null ? missing : sttModeNote(l),
    },
    { label: 'LLM first token (TFT)', value: l.tftAvailable === false ? 'n/a' : ms(l.tftMs), note: l.tftAvailable === false ? 'provider does not stream' : l.tftMs === null ? missing : undefined },
    { label: 'LLM completion', value: ms(l.llmTotalMs), note: l.llmTotalMs === null ? missing : undefined },
    { label: 'TTS first audio', value: ms(l.ttsFirstMs), note: l.ttsFirstMs === null ? missing : undefined },
    {
      label: 'End-to-end',
      value: ms(l.endToEndMs),
      note: l.endToEndMs === null ? 'no end-of-speech time or no reply audio' : 'end of caller speech to first reply audio written to the modem audio port',
    },
  ];
}

export interface TimelineRow {
  id: number;
  offsetMs: number;
  at: string;
  stage: string;
  label: string;
  status: string;
  latencyMs: number | null;
  provider: string | null;
  httpStatus: number | null;
  attempt: number | null;
  detail: string | null;
  retry: boolean;
}

/** Chronological rows for a set of events. Offsets use the monotonic clock, relative to the first event shown. */
export function timelineRows(events: TraceEvent[]): TimelineRow[] {
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const base = sorted.length > 0 ? sorted[0].monoMs : 0;
  return sorted.map((e) => ({
    id: e.id,
    offsetMs: Math.round((e.monoMs - base) * 10) / 10,
    at: e.at,
    stage: e.stage,
    label: e.stage === 'provider-attempt' && e.attempt ? `Provider request (attempt ${e.attempt})` : stageLabel(e.stage),
    status: e.status,
    latencyMs: e.latencyMs,
    provider: e.provider,
    httpStatus: e.httpStatus,
    attempt: e.attempt,
    detail: e.detail,
    retry: e.data?.willRetry === true,
  }));
}

/** Playback jitter and event-loop stall for a turn; says whether late audio was the network or a stalled loop. */
export function playbackNote(l: TurnLatency): string {
  if (l.maxLateMs === null && l.loopLagMaxMs === null) return 'playback jitter not measured';
  const parts: string[] = [];
  if (l.maxLateMs !== null) parts.push(`worst frame ${ms(l.maxLateMs)} late (${l.lateFrames ?? 0} late, ${l.riskFrames ?? 0} past the write-ahead)`);
  if (l.loopLagMaxMs !== null) parts.push(`longest event-loop stall ${ms(l.loopLagMaxMs)}`);
  return parts.join(' · ');
}

/** Provider response codes seen in a turn's failed attempts, in order (for the diagnostics box). */
export function responseCodes(events: TraceEvent[]): number[] {
  return events.filter((e) => e.stage === 'provider-attempt' && e.httpStatus !== null && e.status !== 'ok').map((e) => e.httpStatus as number);
}
