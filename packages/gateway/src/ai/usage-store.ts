import { Database as DatabaseType } from 'better-sqlite3';
import { AiTurnLogEntry, AiUsageTotals } from '@sim-gateway/shared';
import { estimateCostUsd, PRICING_NOTE } from './pricing.js';

export interface TurnRecord {
  callId: string;
  status: string;
  reason?: string | null;
  sttMs: number | null;
  llmFirstTokenMs: number | null;
  ttsFirstMs: number | null;
  totalMs: number | null;
  utteranceMs: number | null;
  sttSeconds: number;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  /** What the provider reported as served from / written to its prompt cache; null when it reported nothing (not the same as 0). */
  llmCachedTokens?: number | null;
  llmCacheWriteTokens?: number | null;
  ttsChars: number;
  selection: { stt: string; llm: string; tts: string };
  /** Offline mock providers: logged, but never counted as usage or cost. */
  mock: boolean;
  transcript?: string | null;
  reply?: string | null;
  /**
   * Latency and quality metrics. Optional so older callers still compile; omitted or null means "not available for
   * this turn" and is stored as NULL. A measured 0 or false is stored as 0.
   */
  firstAudioMs?: number | null;
  perceivedFirstAudioMs?: number | null;
  endpointMs?: number | null;
  sttWaitedMs?: number | null;
  speculativeStt?: boolean | null;
  lateFrames?: number | null;
  riskFrames?: number | null;
  knowledgeHits?: number | null;
  /** Correlation id of the turn (`<callId>:t<n>`), the same id the trace events carry. */
  turnRef?: string | null;
  llmTotalMs?: number | null;
  ttsTotalMs?: number | null;
  playMs?: number | null;
  /** True/false when a model request was made (does the model stream?); null/undefined when none was. */
  tftAvailable?: boolean | null;
  /** What sttMs measured: 'batch' (whole request), 'speculative' (request started during the pause), 'stream' (wait for the final text of a live stream). */
  sttMode?: 'batch' | 'speculative' | 'stream' | null;
  maxLateMs?: number | null;
  loopLagMaxMs?: number | null;
  cancelSource?: string | null;
}

interface Row {
  id: number;
  call_id: string;
  at: string;
  status: string;
  reason: string | null;
  stt_ms: number | null;
  llm_first_token_ms: number | null;
  tts_first_ms: number | null;
  total_ms: number | null;
  utterance_ms: number | null;
  stt_seconds: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  tts_chars: number;
  transcript: string | null;
  reply: string | null;
  first_audio_ms: number | null;
  perceived_first_audio_ms: number | null;
  endpoint_ms: number | null;
  stt_waited_ms: number | null;
  speculative_stt: number | null;
  late_frames: number | null;
  risk_frames: number | null;
  knowledge_hits: number | null;
}

/** Per-turn log and usage totals. Text columns stay NULL unless the operator turned transcripts on. */
export class AiUsageStore {
  constructor(private readonly db: DatabaseType) {}

  record(turn: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO ai_turns (call_id, at, status, reason, stt_ms, llm_first_token_ms, tts_first_ms, total_ms, utterance_ms,
           stt_seconds, llm_prompt_tokens, llm_completion_tokens, tts_chars, stt_key, llm_key, tts_key, mock, transcript, reply,
           first_audio_ms, perceived_first_audio_ms, endpoint_ms, stt_waited_ms, speculative_stt, late_frames, risk_frames, knowledge_hits,
           turn_ref, llm_total_ms, tts_total_ms, play_ms, tft_available, stt_mode, max_late_ms, loop_lag_max_ms, cancel_source,
           llm_cached_tokens, llm_cache_write_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.callId,
        new Date().toISOString(),
        turn.status,
        turn.reason ?? null,
        turn.sttMs,
        turn.llmFirstTokenMs,
        turn.ttsFirstMs,
        turn.totalMs,
        turn.utteranceMs,
        turn.sttSeconds,
        turn.llmPromptTokens,
        turn.llmCompletionTokens,
        turn.ttsChars,
        turn.selection.stt,
        turn.selection.llm,
        turn.selection.tts,
        turn.mock ? 1 : 0,
        turn.transcript ?? null,
        turn.reply ?? null,
        turn.firstAudioMs ?? null,
        turn.perceivedFirstAudioMs ?? null,
        turn.endpointMs ?? null,
        turn.sttWaitedMs ?? null,
        turn.speculativeStt === undefined || turn.speculativeStt === null ? null : turn.speculativeStt ? 1 : 0,
        turn.lateFrames ?? null,
        turn.riskFrames ?? null,
        turn.knowledgeHits ?? null,
        turn.turnRef ?? null,
        turn.llmTotalMs ?? null,
        turn.ttsTotalMs ?? null,
        turn.playMs ?? null,
        turn.tftAvailable === undefined || turn.tftAvailable === null ? null : turn.tftAvailable ? 1 : 0,
        turn.sttMode ?? null,
        turn.maxLateMs ?? null,
        turn.loopLagMaxMs ?? null,
        turn.cancelSource ?? null,
        turn.llmCachedTokens ?? null,
        turn.llmCacheWriteTokens ?? null
      );
  }

  recent(limit: number, callId?: string): AiTurnLogEntry[] {
    const capped = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = (callId
      ? this.db.prepare('SELECT * FROM ai_turns WHERE call_id = ? ORDER BY id DESC LIMIT ?').all(callId, capped)
      : this.db.prepare('SELECT * FROM ai_turns ORDER BY id DESC LIMIT ?').all(capped)) as Row[];
    return rows.map((r) => ({
      id: r.id,
      callId: r.call_id,
      at: r.at,
      status: r.status,
      reason: r.reason,
      sttMs: r.stt_ms,
      llmFirstTokenMs: r.llm_first_token_ms,
      ttsFirstMs: r.tts_first_ms,
      totalMs: r.total_ms,
      utteranceMs: r.utterance_ms,
      sttSeconds: r.stt_seconds,
      llmPromptTokens: r.llm_prompt_tokens,
      llmCompletionTokens: r.llm_completion_tokens,
      ttsChars: r.tts_chars,
      transcript: r.transcript,
      reply: r.reply,
      // `?? null` keeps NULL as "not available" and 0 as a measured zero (0 is not nullish).
      firstAudioMs: r.first_audio_ms ?? null,
      perceivedFirstAudioMs: r.perceived_first_audio_ms ?? null,
      endpointMs: r.endpoint_ms ?? null,
      sttWaitedMs: r.stt_waited_ms ?? null,
      speculativeStt: r.speculative_stt === null || r.speculative_stt === undefined ? null : r.speculative_stt !== 0,
      lateFrames: r.late_frames ?? null,
      riskFrames: r.risk_frames ?? null,
      knowledgeHits: r.knowledge_hits ?? null,
    }));
  }

  /** Totals of real-provider turns since `sinceIso`. Cost is summed per selection that produced the usage. */
  totals(sinceIso?: string): AiUsageTotals {
    const where = sinceIso ? 'WHERE mock = 0 AND at >= ?' : 'WHERE mock = 0';
    const args = sinceIso ? [sinceIso] : [];
    const groups = this.db
      .prepare(
        `SELECT stt_key, llm_key, tts_key, COUNT(*) AS turns, COUNT(DISTINCT call_id) AS calls,
           SUM(stt_seconds) AS stt_seconds, SUM(COALESCE(llm_prompt_tokens,0)) AS pt, SUM(COALESCE(llm_completion_tokens,0)) AS ct,
           SUM(tts_chars) AS tts_chars, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
         FROM ai_turns ${where} GROUP BY stt_key, llm_key, tts_key`
      )
      .all(...args) as Array<{
      stt_key: string;
      llm_key: string;
      tts_key: string;
      turns: number;
      calls: number;
      stt_seconds: number;
      pt: number;
      ct: number;
      tts_chars: number;
      failures: number;
    }>;
    const callCount = (
      this.db.prepare(`SELECT COUNT(DISTINCT call_id) AS n FROM ai_turns ${where} AND call_id NOT LIKE 'test:%'`).get(...args) as { n: number }
    ).n;
    let cost: number | null = 0;
    const totals: AiUsageTotals = {
      calls: callCount,
      turns: 0,
      sttSeconds: 0,
      llmPromptTokens: 0,
      llmCompletionTokens: 0,
      ttsChars: 0,
      failures: 0,
      estimatedCostUsd: null,
      costNote: PRICING_NOTE,
    };
    for (const g of groups) {
      totals.turns += g.turns;
      totals.sttSeconds += g.stt_seconds;
      totals.llmPromptTokens += g.pt;
      totals.llmCompletionTokens += g.ct;
      totals.ttsChars += g.tts_chars;
      totals.failures += g.failures;
      const part = estimateCostUsd(
        { stt: g.stt_key, llm: g.llm_key, tts: g.tts_key },
        { sttSeconds: g.stt_seconds, llmPromptTokens: g.pt, llmCompletionTokens: g.ct, ttsChars: g.tts_chars }
      );
      cost = cost === null || part === null ? null : cost + part;
    }
    totals.sttSeconds = Math.round(totals.sttSeconds * 100) / 100;
    totals.estimatedCostUsd = groups.length === 0 ? 0 : cost === null ? null : Math.round(cost * 1e6) / 1e6;
    if (cost === null) totals.costNote = `${PRICING_NOTE} Some used models have no known price, so no total is shown.`;
    return totals;
  }

  /** Delete turns older than `days`. Returns how many were removed. */
  purgeOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM ai_turns WHERE at < ?').run(cutoff).changes;
  }

  clear(): number {
    return this.db.prepare('DELETE FROM ai_turns').run().changes;
  }
}
