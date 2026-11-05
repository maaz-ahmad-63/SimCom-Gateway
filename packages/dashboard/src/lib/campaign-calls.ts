/**
 * The campaign call history: what the gateway sends for each campaign call, and the small pure helpers the table and the detail view
 * share. Every value comes from the gateway's saved call records; a value that was not recorded is null and is shown as unavailable.
 */

export type Outcome = 'interested' | 'quotation_requested' | 'demo_requested' | 'callback_requested' | 'not_interested' | 'no_answer' | 'failed' | 'incomplete' | 'do_not_call' | 'answered';
export type Interest = 'high' | 'medium' | 'low' | 'none';
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'mixed';
export type CallFilter = 'all' | 'interested' | 'quotation' | 'demo' | 'callback' | 'not_interested' | 'no_answer' | 'failed' | 'incomplete' | 'do_not_call' | 'answered';
export type CallSort = 'startedAt' | 'name' | 'duration' | 'status' | 'outcome' | 'cost' | 'sentiment';

export interface Callback {
  requested: boolean;
  when: string | null;
  note: string | null;
}

export interface Classification {
  outcome: Outcome;
  interest: Interest | null;
  sentiment: Sentiment | null;
  summary: string;
  nextAction: string | null;
  requirements: string[];
  objections: string[];
  callback: Callback | null;
  quotationRequested: boolean;
  demoRequested: boolean;
  callbackRequested: boolean;
  source: 'rule' | 'ai' | 'manual';
  correctedFields: string[];
  note: string | null;
}

export interface CampaignCallRow {
  attemptId: number;
  callId: string | null;
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  contact: { id: number; name: string; designation: string; company: string; extra: Record<string, string> };
  calledTo: string;
  sipNumber: string | null;
  durationSeconds: number | null;
  direction: 'outbound';
  status: string;
  terminationReason: string | null;
  agent: { configVersion: number | null; llmKey: string | null };
  sentiment: Sentiment | null;
  cost: { usd: number | null; note: string | null };
  toolCalls: { count: number; items: Array<{ tool: string; ok: boolean; code: string | null }> };
  transcript: { available: boolean; preview: string; lines: number; storedOff: boolean };
  classification: Classification;
  analysis: { status: 'analysed' | 'failed' | 'pending' | 'not_needed'; error: string | null };
}

export interface TranscriptLine {
  speaker: 'Agent' | 'Caller';
  at: string;
  text: string;
  turn: number;
}

export interface AiResult {
  outcome: Outcome;
  interest: Interest;
  sentiment: Sentiment;
  summary: string;
  requirements: string[];
  objections: string[];
  nextAction: string;
  callback: Callback;
  quotationRequested: boolean;
  demoRequested: boolean;
}

export interface CampaignCallDetail extends CampaignCallRow {
  campaignId: string;
  promptVersion: number | null;
  promptSha: string | null;
  attemptEndedAt: string | null;
  answeredAt: string | null;
  callOutcome: string | null;
  simulated: boolean;
  error: string | null;
  models: { stt: string | null; llm: string | null; tts: string | null };
  contactDetails: { designation: string; company: string; notes: string; phoneAsWritten: string; optedOutInFile: boolean };
  transcriptLines: TranscriptLine[];
  tools: Array<{ tool: string; ok: boolean; code: string | null; at: string }>;
  usage: { turns: number; inputTokens: number; outputTokens: number };
  analysisDetail: {
    original: AiResult | null;
    ranAt: string | null;
    model: string | null;
    tokens: { input: number | null; output: number | null } | null;
    runs: Array<{ at: string; status: string; error: string | null; model: string | null }>;
    rule: Classification;
    override: { outcome: Outcome | null; interest: Interest | null; summary: string | null; nextAction: string | null; note: string | null; updatedAt: string } | null;
  };
}

export interface CallList {
  page: number;
  pageSize: number;
  total: number;
  items: CampaignCallRow[];
}

export interface CallAnalytics {
  totalCalls: number;
  counts: Record<CallFilter, number>;
  analysed: number;
  awaitingAnalysis: number;
  corrected: number;
  costUsd: number | null;
}

export interface CallQuery {
  search?: string;
  filter?: CallFilter;
  sort?: CallSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export const PAGE_SIZES = [10, 15, 25, 50, 100];

/** The filters, in the order they are offered. The same keys the gateway counts by, so a metric and its table always agree. */
export const FILTER_OPTIONS: Array<{ key: CallFilter; label: string }> = [
  { key: 'all', label: 'All calls' },
  { key: 'interested', label: 'Interested' },
  { key: 'quotation', label: 'Quotation requested' },
  { key: 'demo', label: 'Demo requested' },
  { key: 'callback', label: 'Callback requested' },
  { key: 'not_interested', label: 'Not interested' },
  { key: 'no_answer', label: 'No answer' },
  { key: 'failed', label: 'Failed' },
  { key: 'incomplete', label: 'Incomplete / disconnected' },
  { key: 'do_not_call', label: 'Do not call' },
];

export const filterLabel = (key: CallFilter): string => FILTER_OPTIONS.find((f) => f.key === key)?.label ?? 'All calls';

/** The metric tiles: every filter except "all", each with the count the gateway computed from the same records. */
export function metricTiles(analytics: CallAnalytics): Array<{ key: CallFilter; label: string; count: number }> {
  return FILTER_OPTIONS.filter((f) => f.key !== 'all').map((f) => ({ ...f, count: analytics.counts[f.key] ?? 0 }));
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  interested: 'Interested',
  quotation_requested: 'Quotation requested',
  demo_requested: 'Demo requested',
  callback_requested: 'Callback requested',
  not_interested: 'Not interested',
  no_answer: 'No answer',
  failed: 'Failed',
  incomplete: 'Incomplete',
  do_not_call: 'Do not call',
  answered: 'Answered (not analysed)',
};

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function outcomeTone(outcome: Outcome): Tone {
  switch (outcome) {
    case 'interested':
    case 'quotation_requested':
    case 'demo_requested':
    case 'callback_requested':
      return 'good';
    case 'not_interested':
    case 'failed':
    case 'do_not_call':
      return 'bad';
    case 'no_answer':
    case 'incomplete':
      return 'warn';
    default:
      return 'neutral';
  }
}

export const sentimentTone = (s: Sentiment | null): Tone => (s === 'positive' ? 'good' : s === 'negative' ? 'bad' : s === 'mixed' ? 'warn' : 'neutral');

export const STATUS_LABELS: Record<string, string> = {
  answered: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  ended_before_answer: 'Ended before answer',
  failed: 'Failed',
  in_progress: 'In progress',
  unknown: 'Unknown',
};
export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

/** 12 minutes 5 seconds as "12:05"; null (no call row) is unavailable, not zero. */
export function durationText(seconds: number | null): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A cost the gateway could price, or the plain statement that it could not. */
export function costText(cost: { usd: number | null }): string {
  if (cost.usd === null || cost.usd === undefined) return 'Not available';
  return cost.usd < 0.01 ? `<$0.01 ($${cost.usd.toFixed(4)})` : `$${cost.usd.toFixed(2)}`;
}

export function sourceText(c: Pick<Classification, 'source' | 'correctedFields'>): string {
  if (c.source === 'manual') return `Corrected by a person (${c.correctedFields.join(', ') || 'note'})`;
  if (c.source === 'ai') return 'Analysed by the AI from the transcript';
  return 'From how the call ended (not read by the AI)';
}

/** The query string for the list, the export and a link back to a filtered view. Empty values are left out. */
export function callQueryString(q: CallQuery): string {
  const params = new URLSearchParams();
  if (q.search && q.search.trim()) params.set('search', q.search.trim());
  if (q.filter && q.filter !== 'all') params.set('filter', q.filter);
  if (q.sort) params.set('sort', q.sort);
  if (q.dir) params.set('dir', q.dir);
  if (q.page && q.page > 1) params.set('page', String(q.page));
  if (q.pageSize) params.set('pageSize', String(q.pageSize));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Clicking a column header: the same column flips direction, a new one starts descending for dates and numbers, ascending for names. */
export function nextSort(current: { sort: CallSort; dir: 'asc' | 'desc' }, clicked: CallSort): { sort: CallSort; dir: 'asc' | 'desc' } {
  if (current.sort === clicked) return { sort: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: clicked, dir: clicked === 'name' || clicked === 'status' || clicked === 'outcome' ? 'asc' : 'desc' };
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** The transcript as copyable text, speaker by speaker, exactly as saved. */
export function transcriptText(lines: TranscriptLine[]): string {
  return lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
}

/** What a person changed. Blank fields mean "leave as the original"; nothing changed means nothing to save. */
export interface CorrectionDraft {
  outcome: Outcome | '';
  interest: Interest | '';
  summary: string;
  nextAction: string;
  note: string;
}

export const draftFromOverride = (o: CampaignCallDetail['analysisDetail']['override']): CorrectionDraft => ({
  outcome: o?.outcome ?? '',
  interest: o?.interest ?? '',
  summary: o?.summary ?? '',
  nextAction: o?.nextAction ?? '',
  note: o?.note ?? '',
});

export function correctionPatch(d: CorrectionDraft): { outcome: Outcome | null; interest: Interest | null; summary: string | null; nextAction: string | null; note: string | null } | null {
  const patch = {
    outcome: d.outcome || null,
    interest: d.interest || null,
    summary: d.summary.trim() || null,
    nextAction: d.nextAction.trim() || null,
    note: d.note.trim() || null,
  };
  return Object.values(patch).every((v) => v === null) ? null : patch;
}

/** The outcomes a person may choose when correcting (the ones that describe a conversation or how it ended). */
export const CORRECTABLE_OUTCOMES: Outcome[] = ['interested', 'quotation_requested', 'demo_requested', 'callback_requested', 'not_interested', 'incomplete', 'no_answer', 'failed', 'do_not_call'];
