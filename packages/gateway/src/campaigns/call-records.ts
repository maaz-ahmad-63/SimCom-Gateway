import type { Database as DatabaseType } from 'better-sqlite3';
import { estimateCostUsd } from '../ai/pricing.js';
import {
  AiResult,
  ANALYSIS_SYSTEM,
  buildAnalysisPrompt,
  CallAnalysisStore,
  CallFacts,
  CallFilter,
  Classification,
  effective,
  FILTERS,
  matchesFilter,
  parseAiResult,
  ruleClassification,
  TranscriptLine,
  worthAnalysing,
} from './call-analysis.js';

/**
 * One campaign's call records, read from what is already saved (campaign attempts, calls, the AI turn log, the trace and the analysis
 * tables). Nothing here is copied into a second store, and nothing is invented: a figure that was not recorded is null.
 */

export const SORTS = ['startedAt', 'name', 'duration', 'status', 'outcome', 'cost', 'sentiment'] as const;
export type CallSort = (typeof SORTS)[number];

export interface CallQuery {
  search?: string;
  filter?: CallFilter;
  sort?: CallSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

interface Base {
  attemptId: number;
  callId: string | null;
  attempt: number;
  startedAt: string;
  attemptEndedAt: string | null;
  attemptOutcome: string | null;
  error: string | null;
  configVersion: number | null;
  promptSha: string | null;
  attemptLlm: string | null;
  contact: { id: number; name: string; phoneE164: string | null; phoneRaw: string; designation: string; company: string; context: string; extra: Record<string, string>; optOut: boolean };
  call: { answeredAt: string | null; endedAt: string | null; durationSeconds: number | null; outcome: string | null; terminationReason: string | null; simulated: boolean } | null;
}

interface TurnRow {
  call_id: string;
  at: string;
  status: string;
  transcript: string | null;
  reply: string | null;
  stt_seconds: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  tts_chars: number;
  stt_key: string | null;
  llm_key: string | null;
  tts_key: string | null;
  mock: number;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function transcriptLines(turns: TurnRow[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  turns.forEach((t, i) => {
    const caller = clean(t.transcript);
    const agent = clean(t.reply);
    if (caller) lines.push({ speaker: 'Caller', at: t.at, text: caller, turn: i + 1 });
    if (agent) lines.push({ speaker: 'Agent', at: t.at, text: agent, turn: i + 1 });
  });
  return lines;
}

const SENTIMENT_RANK: Record<string, number> = { positive: 3, mixed: 2, neutral: 1, negative: 0 };

export class CampaignCallRecords {
  constructor(
    private readonly db: DatabaseType,
    private readonly analysis: CallAnalysisStore
  ) {}

  private bases(campaignId: string, attemptId?: number): Base[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS attempt_id, a.call_id, a.attempt, a.started_at, a.ended_at AS attempt_ended, a.outcome AS attempt_outcome, a.error,
                a.config_version, a.prompt_sha, a.llm_key AS attempt_llm,
                c.id AS contact_id, c.name, c.phone_e164, c.phone_raw, c.designation, c.company, c.context, c.extra, c.opt_out,
                k.answered_at, k.ended_at AS call_ended, k.duration_seconds, k.outcome AS call_outcome, k.termination_reason, k.is_simulated
         FROM campaign_attempts a
         JOIN campaign_contacts c ON c.id = a.contact_id
         LEFT JOIN calls k ON k.id = a.call_id
         WHERE a.campaign_id = ? ${attemptId === undefined ? '' : 'AND a.id = ?'}
         ORDER BY a.started_at DESC, a.id DESC`
      )
      .all(...(attemptId === undefined ? [campaignId] : [campaignId, attemptId])) as Array<Record<string, any>>;
    return rows.map((r) => {
      let extra: Record<string, string> = {};
      try {
        extra = r.extra ? (JSON.parse(r.extra) as Record<string, string>) : {};
      } catch {
        extra = {};
      }
      return {
        attemptId: r.attempt_id,
        callId: r.call_id,
        attempt: r.attempt,
        startedAt: r.started_at,
        attemptEndedAt: r.attempt_ended,
        attemptOutcome: r.attempt_outcome,
        error: r.error,
        configVersion: r.config_version,
        promptSha: r.prompt_sha,
        attemptLlm: r.attempt_llm,
        contact: { id: r.contact_id, name: r.name, phoneE164: r.phone_e164, phoneRaw: r.phone_raw, designation: r.designation, company: r.company, context: r.context, extra, optOut: r.opt_out === 1 },
        call: r.call_id
          ? { answeredAt: r.answered_at, endedAt: r.call_ended, durationSeconds: r.duration_seconds, outcome: r.call_outcome, terminationReason: r.termination_reason, simulated: r.is_simulated === 1 }
          : null,
      };
    });
  }

  private turnsByCall(campaignId: string): Map<string, TurnRow[]> {
    const rows = this.db
      .prepare(
        `SELECT call_id, at, status, transcript, reply, stt_seconds, llm_prompt_tokens, llm_completion_tokens, tts_chars, stt_key, llm_key, tts_key, mock
         FROM ai_turns WHERE call_id IN (SELECT call_id FROM campaign_attempts WHERE campaign_id = ? AND call_id IS NOT NULL) ORDER BY id`
      )
      .all(campaignId) as TurnRow[];
    const out = new Map<string, TurnRow[]>();
    for (const r of rows) (out.get(r.call_id) ?? out.set(r.call_id, []).get(r.call_id)!).push(r);
    return out;
  }

  private toolsByCall(campaignId: string): Map<string, Array<{ tool: string; ok: boolean; code: string | null; at: string }>> {
    const rows = this.db
      .prepare(
        `SELECT call_id, at, data FROM call_trace_events
         WHERE stage = 'call' AND data LIKE '%"tool"%' AND call_id IN (SELECT call_id FROM campaign_attempts WHERE campaign_id = ? AND call_id IS NOT NULL) ORDER BY id`
      )
      .all(campaignId) as Array<{ call_id: string; at: string; data: string | null }>;
    const out = new Map<string, Array<{ tool: string; ok: boolean; code: string | null; at: string }>>();
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data ?? '{}') as { tool?: unknown; ok?: unknown; code?: unknown };
        if (typeof d.tool !== 'string') continue;
        (out.get(r.call_id) ?? out.set(r.call_id, []).get(r.call_id)!).push({ tool: d.tool, ok: d.ok === true, code: typeof d.code === 'string' ? d.code : null, at: r.at });
      } catch {
        /* a trace row that is not JSON is not a tool call */
      }
    }
    return out;
  }

  private dncSources(): Map<string, string> {
    const rows = this.db.prepare('SELECT phone_e164, source FROM do_not_call').all() as Array<{ phone_e164: string; source: string }>;
    return new Map(rows.map((r) => [r.phone_e164, r.source]));
  }

  private facts(b: Base, turns: TurnRow[], dnc: Map<string, string>): CallFacts {
    const real = turns.filter((t) => t.mock === 0);
    const source = b.contact.phoneE164 ? dnc.get(b.contact.phoneE164) : undefined;
    return {
      attemptOutcome: b.attemptOutcome,
      error: b.error,
      durationSeconds: b.call?.durationSeconds ?? null,
      callerTurns: real.filter((t) => clean(t.transcript) !== '').length,
      turns: real.length,
      transcriptStored: real.some((t) => t.transcript !== null || t.reply !== null),
      // Asked on the call (a tool or the spoken opt-out) or marked in the file: not an operator's manual entry made later.
      optedOut: b.contact.optOut || source === 'spoken' || source === 'campaign',
      finished: b.attemptEndedAt !== null,
    };
  }

  private cost(turns: TurnRow[]): { usd: number | null; note: string | null } {
    const real = turns.filter((t) => t.mock === 0);
    if (real.length === 0) return { usd: null, note: 'No model usage was recorded for this call.' };
    const key = (f: 'stt_key' | 'llm_key' | 'tts_key') => real.map((t) => t[f]).find((k): k is string => !!k) ?? '';
    const usage = {
      sttSeconds: real.reduce((n, t) => n + (t.stt_seconds ?? 0), 0),
      llmPromptTokens: real.reduce((n, t) => n + (t.llm_prompt_tokens ?? 0), 0),
      llmCompletionTokens: real.reduce((n, t) => n + (t.llm_completion_tokens ?? 0), 0),
      ttsChars: real.reduce((n, t) => n + (t.tts_chars ?? 0), 0),
    };
    const usd = estimateCostUsd({ stt: key('stt_key'), llm: key('llm_key'), tts: key('tts_key') }, usage);
    return { usd, note: usd === null ? 'A model used on this call has no known price, so no cost is shown.' : 'Estimated from the provider prices known to the gateway; not an invoice.' };
  }

  private build(campaignId: string, attemptId?: number) {
    const bases = this.bases(campaignId, attemptId);
    const turns = this.turnsByCall(campaignId);
    const tools = this.toolsByCall(campaignId);
    const dnc = this.dncSources();
    const analyses = this.analysis.forCampaign(campaignId);
    const overrides = this.analysis.overridesForCampaign(campaignId);
    return bases.map((b) => {
      const t = b.callId ? (turns.get(b.callId) ?? []) : [];
      const facts = this.facts(b, t, dnc);
      const rule = ruleClassification(facts);
      const found = analyses.get(b.attemptId) ?? { ok: null, last: null };
      const override = overrides.get(b.attemptId) ?? null;
      const classification = effective(rule, found.ok?.result ?? null, override);
      return { b, turns: t, facts, rule, found, override, classification, tools: b.callId ? (tools.get(b.callId) ?? []) : [], cost: this.cost(t) };
    });
  }

  private row(x: ReturnType<CampaignCallRecords['build']>[number]) {
    const lines = transcriptLines(x.turns.filter((t) => t.mock === 0));
    const preview = lines.slice(0, 3).map((l) => `${l.speaker}: ${l.text}`).join(' ');
    const llm = x.b.attemptLlm ?? x.turns.map((t) => t.llm_key).find((k) => !!k) ?? null;
    return {
      attemptId: x.b.attemptId,
      callId: x.b.callId,
      attempt: x.b.attempt,
      startedAt: x.b.startedAt,
      endedAt: x.b.call?.endedAt ?? x.b.attemptEndedAt,
      contact: { id: x.b.contact.id, name: x.b.contact.name, designation: x.b.contact.designation, company: x.b.contact.company, extra: x.b.contact.extra },
      calledTo: x.b.contact.phoneE164 ?? x.b.contact.phoneRaw,
      // The number of the SIM that placed the call is not stored with a call, so it is not shown (never guessed).
      sipNumber: null as string | null,
      durationSeconds: x.b.call?.durationSeconds ?? null,
      direction: 'outbound' as const,
      status: x.b.attemptOutcome ?? (x.b.attemptEndedAt ? 'unknown' : 'in_progress'),
      terminationReason: x.b.call?.terminationReason ?? null,
      agent: { configVersion: x.b.configVersion, llmKey: llm },
      sentiment: x.classification.sentiment,
      cost: { usd: x.cost.usd, note: x.cost.note },
      toolCalls: { count: x.tools.length, items: x.tools.map((t) => ({ tool: t.tool, ok: t.ok, code: t.code })) },
      transcript: { available: lines.length > 0, preview: preview.length > 220 ? `${preview.slice(0, 220)}…` : preview, lines: lines.length, storedOff: x.turns.length > 0 && !x.facts.transcriptStored },
      classification: x.classification,
      analysis: { status: x.found.ok ? 'analysed' : x.found.last ? 'failed' : worthAnalysing(x.facts) ? 'pending' : 'not_needed', error: x.found.ok ? null : (x.found.last?.error ?? null) },
    };
  }

  list(campaignId: string, q: CallQuery = {}) {
    const filter = q.filter && (FILTERS as readonly string[]).includes(q.filter) ? q.filter : 'all';
    const search = (q.search ?? '').trim().toLowerCase();
    const all = this.build(campaignId).filter((x) => matchesFilter(x.classification, filter));
    const found = search
      ? all.filter((x) => {
          const hay = [x.b.contact.name, x.b.contact.phoneE164, x.b.contact.phoneRaw, x.b.contact.company, x.classification.summary, x.b.callId, ...transcriptLines(x.turns).map((l) => l.text)].join('\n').toLowerCase();
          return hay.includes(search);
        })
      : all;
    const dir = q.dir === 'asc' ? 1 : -1;
    const key = q.sort && (SORTS as readonly string[]).includes(q.sort) ? q.sort : 'startedAt';
    const value = (x: (typeof found)[number]): string | number => {
      switch (key) {
        case 'name':
          return x.b.contact.name.toLowerCase();
        case 'duration':
          return x.b.call?.durationSeconds ?? -1;
        case 'status':
          return x.b.attemptOutcome ?? '';
        case 'outcome':
          return x.classification.outcome;
        case 'cost':
          return x.cost.usd ?? -1;
        case 'sentiment':
          return x.classification.sentiment ? SENTIMENT_RANK[x.classification.sentiment] : -1;
        default:
          return x.b.startedAt;
      }
    };
    found.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir || b.b.attemptId - a.b.attemptId;
    });
    const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 15)));
    const page = Math.max(1, Math.floor(q.page ?? 1));
    return { page, pageSize, total: found.length, items: found.slice((page - 1) * pageSize, page * pageSize).map((x) => this.row(x)) };
  }

  /** Every matching record, for export (no paging). */
  all(campaignId: string, q: CallQuery = {}) {
    const first = this.list(campaignId, { ...q, page: 1, pageSize: 100 });
    const items = [...first.items];
    for (let page = 2; items.length < first.total; page++) items.push(...this.list(campaignId, { ...q, page, pageSize: 100 }).items);
    return items;
  }

  detail(campaignId: string, attemptId: number) {
    const x = this.build(campaignId, attemptId)[0];
    if (!x) return null;
    const real = x.turns.filter((t) => t.mock === 0);
    const models = {
      stt: real.map((t) => t.stt_key).find((k) => !!k) ?? null,
      llm: x.b.attemptLlm ?? real.map((t) => t.llm_key).find((k) => !!k) ?? null,
      tts: real.map((t) => t.tts_key).find((k) => !!k) ?? null,
    };
    const runs = this.analysis.runs(attemptId);
    return {
      ...this.row(x),
      campaignId,
      promptVersion: x.b.configVersion,
      promptSha: x.b.promptSha ? x.b.promptSha.slice(0, 12) : null,
      attemptEndedAt: x.b.attemptEndedAt,
      answeredAt: x.b.call?.answeredAt ?? null,
      callOutcome: x.b.call?.outcome ?? null,
      simulated: x.b.call?.simulated ?? false,
      error: x.b.error,
      models,
      contactDetails: { designation: x.b.contact.designation, company: x.b.contact.company, notes: x.b.contact.context, phoneAsWritten: x.b.contact.phoneRaw, optedOutInFile: x.b.contact.optOut },
      transcriptLines: transcriptLines(real),
      tools: x.tools,
      usage: {
        turns: real.length,
        inputTokens: real.reduce((n, t) => n + (t.llm_prompt_tokens ?? 0), 0),
        outputTokens: real.reduce((n, t) => n + (t.llm_completion_tokens ?? 0), 0),
      },
      analysisDetail: {
        original: x.found.ok?.result ?? null,
        ranAt: x.found.ok?.createdAt ?? null,
        model: x.found.ok?.llmKey ?? null,
        tokens: x.found.ok ? { input: x.found.ok.promptTokens, output: x.found.ok.completionTokens } : null,
        runs: runs.map((r) => ({ at: r.createdAt, status: r.status, error: r.error, model: r.llmKey })),
        rule: x.rule,
        override: x.override,
      },
    };
  }

  /** Counts by the same classification and the same filter definitions as the table. */
  analytics(campaignId: string) {
    const built = this.build(campaignId);
    const counts = Object.fromEntries(FILTERS.map((f) => [f, built.filter((x) => matchesFilter(x.classification, f)).length])) as Record<CallFilter, number>;
    const analysed = built.filter((x) => x.found.ok).length;
    const pending = built.filter((x) => !x.found.ok && worthAnalysing(x.facts)).length;
    const cost = built.map((x) => x.cost.usd);
    return {
      totalCalls: built.length,
      counts,
      analysed,
      awaitingAnalysis: pending,
      corrected: built.filter((x) => x.override).length,
      costUsd: built.length === 0 ? 0 : cost.some((c) => c === null) ? null : Math.round(cost.reduce((n: number, c) => n + (c ?? 0), 0) * 1e6) / 1e6,
    };
  }

  /** Facts and context the analysis service needs for one attempt. */
  forAnalysis(campaignId: string, attemptId: number) {
    const x = this.build(campaignId, attemptId)[0];
    if (!x) return null;
    const lines = transcriptLines(x.turns.filter((t) => t.mock === 0));
    return { facts: x.facts, lines, contact: x.b.contact, callId: x.b.callId, llmKey: x.b.attemptLlm };
  }
}

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // A cell that starts like a formula would be executed by a spreadsheet: it is made plain text.
  // A plain number (a phone number, a duration, a cost) is not a formula and is left as it is.
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d\s().-]*$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function callsCsv(items: ReturnType<CampaignCallRecords['row']>[]): string {
  const head = ['Date & Time', 'Contact', 'Called To', 'Duration (s)', 'Direction', 'Status', 'Outcome', 'Interest', 'Sentiment', 'Cost (USD)', 'Tool calls', 'Summary', 'Next action', 'Corrected by a person', 'Call ID'];
  const rows = items.map((r) => [
    r.startedAt,
    r.contact.name,
    r.calledTo,
    r.durationSeconds ?? '',
    r.direction,
    r.status,
    r.classification.outcome,
    r.classification.interest ?? '',
    r.sentiment ?? '',
    r.cost.usd ?? '',
    r.toolCalls.count,
    r.classification.summary,
    r.classification.nextAction ?? '',
    r.classification.correctedFields.length > 0 ? r.classification.correctedFields.join(' ') : '',
    r.callId ?? '',
  ]);
  return `﻿${[head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ---- the analysis service -------------------------------------------------------------------------------------------------------------

export interface CompleteResult {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  llmKey: string;
}

export interface AnalysisDeps {
  db: DatabaseType;
  records: CampaignCallRecords;
  store: CallAnalysisStore;
  /** One language-model request, made with the campaign's model. Absent: analysis is unavailable. */
  complete?: (request: { llmKey: string | null; system: string; user: string }) => Promise<CompleteResult>;
  logger?: { warn(message: string): void };
}

export type AnalyzeStatus = 'analysed' | 'skipped' | 'failed';

export class CallAnalysisService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AnalysisDeps) {}

  get available(): boolean {
    return this.deps.complete !== undefined;
  }

  /** Reads one finished conversation and stores the model's analysis. Requests are made one at a time. */
  analyze(campaignId: string, attemptId: number, options: { force?: boolean } = {}): Promise<{ status: AnalyzeStatus; reason?: string }> {
    const run = this.chain.then(() => this.run(campaignId, attemptId, options));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async run(campaignId: string, attemptId: number, { force = false }: { force?: boolean }): Promise<{ status: AnalyzeStatus; reason?: string }> {
    const { db, records, store, complete } = this.deps;
    if (!complete) return { status: 'skipped', reason: 'No language model is available for analysis.' };
    const ctx = records.forAnalysis(campaignId, attemptId);
    if (!ctx) return { status: 'skipped', reason: 'That call does not belong to this campaign.' };
    if (!ctx.facts.finished) return { status: 'skipped', reason: 'The call has not finished.' };
    if (!worthAnalysing(ctx.facts)) return { status: 'skipped', reason: 'Only a real conversation is analysed (no answer, failed, dropped and opted-out calls are classified from how they ended).' };
    if (!force && store.latest(attemptId).ok) return { status: 'skipped', reason: 'Already analysed.' };
    const campaign = db.prepare('SELECT c.name, v.prompt, v.llm_key FROM campaigns c LEFT JOIN campaign_config_versions v ON v.campaign_id = c.id AND v.version = c.config_version WHERE c.id = ?').get(campaignId) as { name: string; prompt: string | null; llm_key: string | null } | undefined;
    if (!campaign) return { status: 'skipped', reason: 'Unknown campaign.' };
    const llmKey = ctx.llmKey ?? campaign.llm_key ?? null;
    const user = buildAnalysisPrompt({ campaignName: campaign.name, campaignPrompt: campaign.prompt ?? '', contact: { name: ctx.contact.name, designation: ctx.contact.designation, company: ctx.contact.company }, lines: ctx.lines });
    try {
      const reply = await complete({ llmKey, system: ANALYSIS_SYSTEM, user });
      const parsed = parseAiResult(reply.text);
      const base = { attemptId, campaignId, callId: ctx.callId, llmKey: reply.llmKey, promptTokens: reply.promptTokens, completionTokens: reply.completionTokens };
      if (!parsed.ok) {
        store.add({ ...base, result: null, error: parsed.error });
        return { status: 'failed', reason: parsed.error };
      }
      store.add({ ...base, result: parsed.result as AiResult, error: null });
      return { status: 'analysed' };
    } catch (e) {
      const reason = ((e as Error).message ?? 'The analysis request failed').slice(0, 300);
      store.add({ attemptId, campaignId, callId: ctx.callId, result: null, error: reason, llmKey, promptTokens: null, completionTokens: null });
      this.deps.logger?.warn(`Call analysis failed for attempt ${attemptId}: ${reason}`);
      return { status: 'failed', reason };
    }
  }

  /** After an attempt finishes: wait a moment for the call's turns to be saved, then analyse it. Never throws. */
  scheduleAfterAttempt(campaignId: string, contactId: number, callId: string | null, delayMs = 5000): void {
    if (!this.available || !callId) return;
    const timer = setTimeout(() => {
      const row = this.deps.db.prepare('SELECT id FROM campaign_attempts WHERE campaign_id = ? AND contact_id = ? AND call_id = ? ORDER BY id DESC LIMIT 1').get(campaignId, contactId, callId) as { id: number } | undefined;
      if (row) void this.analyze(campaignId, row.id).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  }
}

export type { Classification };
