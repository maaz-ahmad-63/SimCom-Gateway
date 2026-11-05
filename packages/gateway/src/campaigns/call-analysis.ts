import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * What a campaign call came to, kept apart from the call itself.
 *
 *  - The RULE classification is derived on every read from facts already saved (how the attempt ended, the duration, the caller's turns,
 *    the do-not-call list). It is never stored, so it can never disagree with the data.
 *  - The AI analysis is one extra language-model request on the saved transcript, made after the call has ended and only for a real
 *    conversation. Every run is stored as its own row and never edited or deleted.
 *  - A manual correction is a separate row that is laid over the result when read. The original AI result stays untouched.
 */

export const OUTCOMES = ['interested', 'quotation_requested', 'demo_requested', 'callback_requested', 'not_interested', 'no_answer', 'failed', 'incomplete', 'do_not_call', 'answered'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const INTERESTS = ['high', 'medium', 'low', 'none'] as const;
export type Interest = (typeof INTERESTS)[number];
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** The outcomes the model may choose; the others come from how the call ended and are decided by rules. */
const AI_OUTCOMES: Outcome[] = ['interested', 'quotation_requested', 'demo_requested', 'callback_requested', 'not_interested', 'incomplete'];

export interface Callback {
  requested: boolean;
  when: string | null;
  note: string | null;
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

export type ClassificationSource = 'rule' | 'ai' | 'manual';

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
  source: ClassificationSource;
  /** Which fields a person changed. */
  correctedFields: string[];
  note: string | null;
}

/** Facts already saved about one attempt. */
export interface CallFacts {
  attemptOutcome: string | null;
  error: string | null;
  durationSeconds: number | null;
  /** Turns of the call that carry text, and whether any text was stored at all (transcripts can be switched off). */
  callerTurns: number;
  turns: number;
  transcriptStored: boolean;
  optedOut: boolean;
  finished: boolean;
}

/** Fewer caller turns than this is not a conversation worth a model request. */
export const MIN_CALLER_TURNS_FOR_ANALYSIS = 2;

const blank = (): Omit<Classification, 'outcome' | 'summary' | 'source'> => ({
  interest: null,
  sentiment: null,
  nextAction: null,
  requirements: [],
  objections: [],
  callback: null,
  quotationRequested: false,
  demoRequested: false,
  callbackRequested: false,
  correctedFields: [],
  note: null,
});

/** What can be said without reading the conversation. A real conversation stays "answered" until it is analysed. */
export function ruleClassification(f: CallFacts): Classification {
  const base = blank();
  const make = (outcome: Outcome, summary: string, nextAction: string | null = null): Classification => ({ ...base, outcome, summary, nextAction, source: 'rule' });
  if (!f.finished) return make('incomplete', 'The call is still in progress or has not been saved as finished.');
  switch (f.attemptOutcome) {
    case 'no_answer':
      return make('no_answer', 'No answer. No conversation took place.', 'Retry later if the campaign allows another attempt.');
    case 'busy':
      return make('no_answer', 'The line was busy. No conversation took place.', 'Retry later if the campaign allows another attempt.');
    case 'failed':
      return make('failed', f.error ? `The call failed before a conversation: ${f.error}` : 'The call failed before a conversation took place.');
    case 'ended_before_answer':
      return make('incomplete', 'The call ended before it was answered. The modem cannot tell a declined call from an unreachable number.');
    case 'answered':
      break;
    default:
      return make('incomplete', f.error ? `The call ended without a recorded result: ${f.error}` : 'The call ended without a recorded result.');
  }
  if (f.optedOut) return make('do_not_call', 'The contact asked not to be called again.', 'Do not call this number again.');
  if (f.turns === 0) return make('incomplete', 'The call was answered but the agent had no conversation (no turns were recorded). It disconnected before the agent could explain the solution.');
  if (!f.transcriptStored) return make('answered', 'The call was answered. Transcripts were switched off, so the conversation cannot be summarised.');
  if (f.callerTurns === 0) return make('incomplete', 'The call was answered but the caller said nothing the agent could transcribe.');
  if (f.callerTurns < MIN_CALLER_TURNS_FOR_ANALYSIS) return make('incomplete', 'The call disconnected after a single reply from the caller, before the agent could explain the solution.');
  return make('answered', `A conversation took place (${f.callerTurns} caller turns). It has not been analysed yet.`);
}

/** Whether this attempt is a real conversation that the model should read. */
export function worthAnalysing(f: CallFacts): boolean {
  const rule = ruleClassification(f);
  return rule.outcome === 'answered' && f.transcriptStored && f.callerTurns >= MIN_CALLER_TURNS_FOR_ANALYSIS;
}

export interface Override {
  outcome: Outcome | null;
  interest: Interest | null;
  summary: string | null;
  nextAction: string | null;
  note: string | null;
  updatedAt: string;
}

/** The result people see: the model's analysis if there is one, otherwise the rules, with any manual correction laid over it. */
export function effective(rule: Classification, ai: AiResult | null, override: Override | null): Classification {
  let c: Classification = rule;
  if (ai && rule.outcome === 'answered') {
    c = {
      outcome: ai.outcome,
      interest: ai.interest,
      sentiment: ai.sentiment,
      summary: ai.summary,
      nextAction: ai.nextAction || null,
      requirements: ai.requirements,
      objections: ai.objections,
      callback: ai.callback,
      quotationRequested: ai.quotationRequested || ai.outcome === 'quotation_requested',
      demoRequested: ai.demoRequested || ai.outcome === 'demo_requested',
      callbackRequested: ai.callback.requested || ai.outcome === 'callback_requested',
      source: 'ai',
      correctedFields: [],
      note: null,
    };
  }
  if (!override) return c;
  const out: Classification = { ...c, correctedFields: [], note: override.note, source: 'manual' };
  if (override.outcome) {
    out.outcome = override.outcome;
    out.quotationRequested = override.outcome === 'quotation_requested';
    out.demoRequested = override.outcome === 'demo_requested';
    out.callbackRequested = override.outcome === 'callback_requested';
    out.correctedFields.push('outcome');
  }
  if (override.interest) {
    out.interest = override.interest;
    out.correctedFields.push('interest');
  }
  if (override.summary) {
    out.summary = override.summary;
    out.correctedFields.push('summary');
  }
  if (override.nextAction) {
    out.nextAction = override.nextAction;
    out.correctedFields.push('nextAction');
  }
  if (out.correctedFields.length === 0 && !override.note) return c;
  return out;
}

export const FILTERS = ['all', 'interested', 'quotation', 'demo', 'callback', 'not_interested', 'no_answer', 'failed', 'incomplete', 'do_not_call', 'answered'] as const;
export type CallFilter = (typeof FILTERS)[number];

/** The one definition of every filter. The table, the analytics counts and the export all use it, so they cannot disagree. */
export function matchesFilter(c: Classification, filter: CallFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'interested':
      return c.outcome !== 'not_interested' && c.outcome !== 'do_not_call' && (c.interest === 'high' || c.interest === 'medium' || c.outcome === 'interested' || c.quotationRequested || c.demoRequested || c.callbackRequested);
    case 'quotation':
      return c.quotationRequested;
    case 'demo':
      return c.demoRequested;
    case 'callback':
      return c.callbackRequested;
    case 'not_interested':
      return c.outcome === 'not_interested';
    case 'no_answer':
      return c.outcome === 'no_answer';
    case 'failed':
      return c.outcome === 'failed';
    case 'incomplete':
      return c.outcome === 'incomplete';
    case 'do_not_call':
      return c.outcome === 'do_not_call';
    case 'answered':
      return c.outcome !== 'no_answer' && c.outcome !== 'failed' && c.outcome !== 'incomplete';
  }
}

// ---- the model request ----------------------------------------------------------------------------------------------------------------

export interface TranscriptLine {
  speaker: 'Agent' | 'Caller';
  at: string;
  text: string;
  turn: number;
}

export const ANALYSIS_SYSTEM = [
  'You analyse one finished sales or outreach phone call from its transcript, for a dashboard.',
  'Use ONLY what the transcript says. Never invent a need, a price, a date, an email address, a phone number or a decision. If something is not in the transcript, leave it empty or null.',
  'The transcript may be in English, Hindi or a mix; read it as written and write your answer in English.',
  'The caller is the person who answered. The agent is the AI voice agent that called them.',
  'Reply with ONE JSON object and nothing else, with exactly these keys:',
  '{"outcome": one of "interested","quotation_requested","demo_requested","callback_requested","not_interested","incomplete",',
  ' "interest": one of "high","medium","low","none",',
  ' "sentiment": one of "positive","neutral","negative","mixed",',
  ' "summary": 1-2 sentences saying who the caller was (only if stated), what happened and the result,',
  ' "requirements": [short strings: what the caller said they need],',
  ' "objections": [short strings: reasons they gave for hesitation or refusal],',
  ' "next_action": one short sentence: what the team should do next,',
  ' "callback": {"requested": true|false, "when": string or null, "note": string or null},',
  ' "quotation_requested": true|false, "demo_requested": true|false}',
  'Choose "incomplete" when the caller never really engaged, the line dropped, or the conversation did not get far enough to tell. Choose "not_interested" only when the caller declined or said they do not need it.',
].join('\n');

export interface PromptInput {
  campaignName: string;
  campaignPrompt: string;
  contact: { name: string; designation: string; company: string };
  lines: TranscriptLine[];
}

export const TRANSCRIPT_LIMIT = 12_000;

export function buildAnalysisPrompt(input: PromptInput): string {
  const header = [`Campaign: ${input.campaignName}`];
  if (input.campaignPrompt) header.push(`What the campaign's agent was told to do (excerpt):\n${input.campaignPrompt.slice(0, 1500)}`);
  const who = [input.contact.name, input.contact.designation, input.contact.company].filter(Boolean).join(', ');
  if (who) header.push(`The contact on the list: ${who}`);
  let body = input.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
  if (body.length > TRANSCRIPT_LIMIT) body = `${body.slice(0, TRANSCRIPT_LIMIT)}\n[transcript cut here for length]`;
  return `${header.join('\n\n')}\n\nTranscript:\n${body}`;
}

const strings = (v: unknown, max = 10, len = 200): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().slice(0, len)).slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : null);

export function parseAiResult(text: string): { ok: true; result: AiResult } | { ok: false; error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'The model did not return a JSON object.' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The model returned JSON that could not be read.' };
  }
  const outcome = oneOf(raw.outcome, AI_OUTCOMES);
  const interest = oneOf(raw.interest, INTERESTS);
  const sentiment = oneOf(raw.sentiment, SENTIMENTS);
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 700) : '';
  if (!outcome || !interest || !sentiment || !summary) return { ok: false, error: 'The model reply was missing a valid outcome, interest, sentiment or summary.' };
  const cb = raw.callback && typeof raw.callback === 'object' ? (raw.callback as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 300) : null);
  return {
    ok: true,
    result: {
      outcome,
      interest,
      sentiment,
      summary,
      requirements: strings(raw.requirements),
      objections: strings(raw.objections),
      nextAction: typeof raw.next_action === 'string' ? raw.next_action.trim().slice(0, 300) : '',
      callback: { requested: cb.requested === true, when: str(cb.when), note: str(cb.note) },
      quotationRequested: raw.quotation_requested === true,
      demoRequested: raw.demo_requested === true,
    },
  };
}

// ---- storage ---------------------------------------------------------------------------------------------------------------------------

export interface StoredAnalysis {
  id: number;
  attemptId: number;
  callId: string | null;
  status: 'ok' | 'failed';
  result: AiResult | null;
  error: string | null;
  llmKey: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export class CallAnalysisStore {
  constructor(private readonly db: DatabaseType, private readonly now: () => Date = () => new Date()) {}

  add(entry: { attemptId: number; campaignId: string; callId: string | null; result: AiResult | null; error: string | null; llmKey: string | null; promptTokens: number | null; completionTokens: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO call_analyses (attempt_id, campaign_id, call_id, status, result, error, llm_key, prompt_tokens, completion_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(entry.attemptId, entry.campaignId, entry.callId, entry.result ? 'ok' : 'failed', entry.result ? JSON.stringify(entry.result) : null, entry.error, entry.llmKey, entry.promptTokens, entry.completionTokens, this.now().toISOString());
  }

  private map(r: Record<string, any>): StoredAnalysis {
    return {
      id: r.id,
      attemptId: r.attempt_id,
      callId: r.call_id,
      status: r.status,
      result: r.result ? (JSON.parse(r.result) as AiResult) : null,
      error: r.error,
      llmKey: r.llm_key,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      createdAt: r.created_at,
    };
  }

  /** Every run for an attempt, newest first. */
  runs(attemptId: number): StoredAnalysis[] {
    return (this.db.prepare('SELECT * FROM call_analyses WHERE attempt_id = ? ORDER BY id DESC').all(attemptId) as Array<Record<string, any>>).map((r) => this.map(r));
  }

  /** The newest run that produced a result, and the newest run overall (which may have failed). */
  latest(attemptId: number): { ok: StoredAnalysis | null; last: StoredAnalysis | null } {
    const runs = this.runs(attemptId);
    return { ok: runs.find((r) => r.status === 'ok') ?? null, last: runs[0] ?? null };
  }

  /** Newest results for many attempts of one campaign, in one query. */
  forCampaign(campaignId: string): Map<number, { ok: StoredAnalysis | null; last: StoredAnalysis | null }> {
    const out = new Map<number, { ok: StoredAnalysis | null; last: StoredAnalysis | null }>();
    const rows = this.db.prepare('SELECT * FROM call_analyses WHERE campaign_id = ? ORDER BY id DESC').all(campaignId) as Array<Record<string, any>>;
    for (const r of rows) {
      const run = this.map(r);
      const entry = out.get(run.attemptId) ?? { ok: null, last: run };
      if (!entry.ok && run.status === 'ok') entry.ok = run;
      out.set(run.attemptId, entry);
    }
    return out;
  }

  override(attemptId: number): Override | null {
    const r = this.db.prepare('SELECT * FROM call_analysis_overrides WHERE attempt_id = ?').get(attemptId) as Record<string, any> | undefined;
    return r ? this.mapOverride(r) : null;
  }

  overridesForCampaign(campaignId: string): Map<number, Override> {
    const rows = this.db.prepare('SELECT * FROM call_analysis_overrides WHERE campaign_id = ?').all(campaignId) as Array<Record<string, any>>;
    return new Map(rows.map((r) => [r.attempt_id as number, this.mapOverride(r)]));
  }

  private mapOverride(r: Record<string, any>): Override {
    return { outcome: r.outcome, interest: r.interest, summary: r.summary, nextAction: r.next_action, note: r.note, updatedAt: r.updated_at };
  }

  setOverride(attemptId: number, campaignId: string, o: Omit<Override, 'updatedAt'>): Override {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO call_analysis_overrides (attempt_id, campaign_id, outcome, interest, summary, next_action, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET outcome = excluded.outcome, interest = excluded.interest, summary = excluded.summary, next_action = excluded.next_action, note = excluded.note, updated_at = excluded.updated_at`
      )
      .run(attemptId, campaignId, o.outcome, o.interest, o.summary, o.nextAction, o.note, at);
    return { ...o, updatedAt: at };
  }

  clearOverride(attemptId: number): boolean {
    return this.db.prepare('DELETE FROM call_analysis_overrides WHERE attempt_id = ?').run(attemptId).changes > 0;
  }
}
