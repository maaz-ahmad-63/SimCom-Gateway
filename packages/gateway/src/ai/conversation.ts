import { performance } from 'node:perf_hooks';
import type { AiConversationPhase, AiInspectorEvent } from '@sim-gateway/shared';
import { AgentAudioSink, AudioFormat, checkPcmBuffer, PlayResult } from './audio.js';
import { AiConfig } from './config.js';
import { assessUtterance, UtteranceAssessment } from './endpointer.js';
import { AiProviderError, ChatMessage, LlmUsage, ProviderSet } from './providers/types.js';
import { extractEndCall, hasSpeechContent, ProtocolTextFilter, SentenceSplitter } from './text.js';

export type TurnStatus = 'completed' | 'skipped' | 'cancelled' | 'failed';

export interface TurnMetrics {
  sttMs: number | null;
  llmFirstTokenMs: number | null;
  llmTotalMs: number | null;
  ttsFirstMs: number | null;
  ttsTotalMs: number;
  playMs: number;
  totalMs: number;
  utteranceMs: number;
  ttsChars: number;
  usage: LlmUsage | null;
  /**
   * From the start of this turn (after the caller's pause was detected) to the moment the first reply audio
   * began to be written. This is the latency the caller waits through; totalMs also includes the time spent speaking.
   */
  firstAudioMs: number | null;
  /** Frames written late during playback (an underrun risk); 0 means the modem was kept fed. */
  lateFrames: number;
}

export interface TurnResult {
  turnId: number;
  status: TurnStatus;
  reason?: string;
  assessment?: UtteranceAssessment;
  transcriptChars?: number;
  replyChars?: number;
  endRequested: boolean;
  metrics: TurnMetrics;
  /** Present only when AI_LOG_TRANSCRIPTS=true. */
  transcript?: string;
  reply?: string;
}

export type ConversationEvent =
  | { type: 'turn'; callId: string; result: TurnResult }
  | { type: 'end-requested'; callId: string; reason: 'agent-end-call' }
  | { type: 'degraded'; callId: string; consecutiveFailures: number }
  | { type: 'recovering'; callId: string; afterMs: number }
  | { type: 'error'; callId: string; stage: 'stt' | 'llm' | 'tts' | 'sink' | 'internal'; message: string };

export interface SessionTotals {
  turns: number;
  completed: number;
  skipped: number;
  cancelled: number;
  failed: number;
  /** Seconds of caller audio sent to STT (what is billed), characters sent to TTS, LLM tokens when reported. */
  sttAudioSeconds: number;
  ttsChars: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
}

/** What the session reports to the inspector; the orchestrator adds the call id, sequence and timestamp. */
export type TraceInput = Omit<AiInspectorEvent, 'seq' | 'timestamp' | 'callId'>;

export interface ConversationDeps {
  callId: string;
  config: AiConfig;
  providers: ProviderSet;
  sink: AgentAudioSink;
  emit?: (event: ConversationEvent) => void;
  trace?: (event: TraceInput) => void;
  /** Transcribe only: no LLM, no TTS, nothing is ever sent to the caller. Switchable with setPassive(). */
  passive?: boolean;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }
  close(): void {
    this.closed = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  async next(): Promise<T | undefined> {
    for (;;) {
      if (this.items.length > 0) return this.items.shift();
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}

const MAX_PENDING_SECONDS = 30;

const NOT_WRITTEN_MESSAGE =
  'The audio port accepted fewer bytes than were sent (the port closed or stopped streaming mid-reply), so the caller got a broken or silent reply';

/** What the inspector says about one finished playback. Bytes written is all the gateway can know. */
function playbackDetail(played: PlayResult): string {
  if (!played.completed) {
    return played.stoppedBy === 'not-written' ? NOT_WRITTEN_MESSAGE : `stopped: ${played.stoppedBy ?? 'unknown'}`;
  }
  const late = played.lateFrames ?? 0;
  return late > 0
    ? `written to the audio port, but ${late} frame(s) went out late (up to ${played.maxLateMs ?? 0} ms behind real time), so the caller may have heard gaps; whether the caller heard it is not verified`
    : 'written to the audio port; whether the caller heard it is not verified';
}

const emptyMetrics = (utteranceMs: number): TurnMetrics => ({
  sttMs: null,
  llmFirstTokenMs: null,
  llmTotalMs: null,
  ttsFirstMs: null,
  ttsTotalMs: 0,
  playMs: 0,
  totalMs: 0,
  utteranceMs,
  ttsChars: 0,
  usage: null,
  firstAudioMs: null,
  lateFrames: 0,
});

const isAbort = (error: unknown): boolean =>
  (error instanceof AiProviderError && error.details.aborted === true) ||
  (error instanceof Error && error.name === 'AbortError');

/**
 * One call's conversation: history, a single in-flight turn, and the STT -> LLM -> TTS -> play pipeline.
 *
 * - One call, one session: history, tasks and audio never cross sessions.
 * - Newest caller turn wins: a new utterance cancels the turn in progress (including speech already
 *   being played) and any utterances that arrive while it winds down are merged into one turn, so a
 *   caller turn can never produce two responses.
 * - close() cancels every outstanding provider request and playback.
 */
export class ConversationSession {
  readonly callId: string;
  private readonly config: AiConfig;
  private providers: ProviderSet;
  private readonly sink: AgentAudioSink;
  private readonly emit: (event: ConversationEvent) => void;
  private readonly traceFn: (event: TraceInput) => void;
  private passive: boolean;

  private readonly history: ChatMessage[] = [];
  private readonly lifetime = new AbortController();
  private current: { id: number; controller: AbortController; done: Promise<TurnResult> } | null = null;
  private seq = 0;
  private latest = 0;
  private pendingPcm: Buffer[] = [];
  private pendingCaptures = 0;
  private currentPhase: AiConversationPhase = 'listening';
  private phaseStartedAt = Date.now();
  private speaking = false;
  private guardUntil = 0;
  private errorRecord: { stage: string; message: string; at: string } | null = null;
  private latestTranscript: { text: string; at: number; turnId: number } | null = null;
  private readonly seen = new Set<string>();
  private closedReason: string | null = null;
  private consecutiveFailures = 0;
  private degraded = false;
  private degradedAt = 0;
  readonly totals: SessionTotals = {
    turns: 0,
    completed: 0,
    skipped: 0,
    cancelled: 0,
    failed: 0,
    sttAudioSeconds: 0,
    ttsChars: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
  };

  constructor(deps: ConversationDeps) {
    this.callId = deps.callId;
    this.config = deps.config;
    this.providers = deps.providers;
    this.sink = deps.sink;
    this.emit = deps.emit ?? (() => {});
    this.traceFn = deps.trace ?? (() => {});
    this.passive = deps.passive ?? false;
  }

  /** Most recent voiced transcript of this call, for the operator-triggered test response. Not exposed by any API. */
  get lastTranscript(): { text: string; at: number } | null {
    return this.latestTranscript ? { text: this.latestTranscript.text, at: this.latestTranscript.at } : null;
  }

  /** The pipeline stage right now (listening between turns). */
  get phase(): AiConversationPhase {
    return this.currentPhase;
  }
  get phaseSince(): number {
    return this.phaseStartedAt;
  }
  get lastError(): { stage: string; message: string; at: string } | null {
    return this.errorRecord;
  }

  /**
   * Half-duplex: true while the agent is playing audio and for a short guard afterwards. Caller audio in this
   * window is the agent's own voice returning (or the caller talking over it), and is not to be transcribed.
   */
  isDeaf(now = Date.now()): boolean {
    if (!this.config.halfDuplex) return false;
    return this.speaking || now < this.guardUntil;
  }

  private setPhase(phase: AiConversationPhase): void {
    if (this.currentPhase !== phase) {
      this.currentPhase = phase;
      this.phaseStartedAt = Date.now();
    }
  }

  private beginSpeaking(): void {
    this.speaking = true;
    this.setPhase('speaking');
  }

  /** The turn is over, however it ended: stop deafness after the guard, and go back to listening. */
  private endTurnPhase(): void {
    if (this.current !== null) return; // another turn already took over
    if (this.speaking) {
      this.speaking = false;
      this.guardUntil = Date.now() + this.config.playbackGuardMs;
    }
    this.setPhase('listening');
  }

  /** Give a passive (transcribe-only) session the LLM and TTS providers it needs to talk. */
  upgradeProviders(providers: ProviderSet): void {
    this.providers = providers;
  }

  get isPassive(): boolean {
    return this.passive;
  }

  /** Takes effect from the next caller utterance; a turn already running finishes in the mode it started in. */
  setPassive(passive: boolean): void {
    this.passive = passive;
  }

  private trace(
    turnId: number | string | null,
    stage: TraceInput['stage'],
    status: TraceInput['status'],
    extra: Partial<Pick<TraceInput, 'latencyMs' | 'detail' | 'data' | 'text' | 'role'>> = {}
  ): void {
    try {
      this.traceFn({ turnId: turnId === null ? null : `${this.callId}:t${turnId}`, stage, status, ...extra });
    } catch {
      // An inspector problem must never affect the conversation.
    }
  }

  get isClosed(): boolean {
    return this.closedReason !== null;
  }
  get isDegraded(): boolean {
    return this.degraded;
  }
  get isBusy(): boolean {
    return this.current !== null;
  }
  getHistory(): ChatMessage[] {
    return this.history.map((m) => ({ ...m }));
  }

  private get format(): AudioFormat {
    return this.sink.format;
  }

  /** Cancel the turn in progress (caller barge-in). Safe to call at any time. */
  interrupt(): void {
    this.current?.controller.abort();
  }

  /** Stop everything for this call. Idempotent. */
  async close(reason: string): Promise<void> {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.lifetime.abort();
    this.pendingPcm = [];
    const running = this.current;
    if (running) await running.done.catch(() => {});
    this.history.length = 0;
    this.latestTranscript = null;
    this.seen.clear();
  }

  /** Speak a fixed line (the greeting) without calling the LLM. */
  async say(text: string): Promise<TurnResult> {
    if (this.passive) {
      // Passive mode never produces or sends audio, whoever asks.
      return this.finish({ turnId: 0, status: 'skipped', reason: 'passive-mode', endRequested: false, metrics: emptyMetrics(0) }, false);
    }
    return this.runExclusive(async (turnId, signal) => {
      const started = performance.now();
      const metrics = emptyMetrics(0);
      const result = await this.speakFixed(turnId, text, signal, metrics, started);
      return result;
    });
  }

  /**
   * Process one caller utterance. `utteranceId` makes redelivery harmless: the same id is processed once.
   */
  async handleUtterance(pcm: Buffer, utteranceId?: string): Promise<TurnResult> {
    const skipped = (reason: string): TurnResult => this.finish(
      { turnId: 0, status: 'skipped', reason, endRequested: false, metrics: emptyMetrics(0) },
      false
    );
    if (this.closedReason !== null) return skipped('session-closed');
    if (this.degraded) {
      // Half-open: after the cool-down, one trial turn is allowed. If it fails the breaker closes again
      // for another cool-down; if it succeeds the failure count is cleared by the completed turn.
      const sinceMs = Date.now() - this.degradedAt;
      if (sinceMs < this.config.automation.recoveryCooldownMs) return skipped('degraded');
      this.degraded = false;
      this.consecutiveFailures = Math.max(0, this.config.limits.maxConsecutiveFailures - 1);
      this.emit({ type: 'recovering', callId: this.callId, afterMs: sinceMs });
      this.trace(null, 'call', 'ok', { detail: `trying again after ${Math.round(sinceMs / 1000)} s of provider failures` });
    }
    if (utteranceId !== undefined) {
      if (this.seen.has(utteranceId)) return skipped('duplicate');
      this.seen.add(utteranceId);
      if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value as string);
    }

    // Newest wins: queue this audio, cancel whatever is running, and let only the latest call proceed.
    const mine = ++this.latest;
    this.pendingPcm.push(pcm);
    this.pendingCaptures++;
    // Utterances that pile up while a turn is cancelled are merged, but never beyond ~30 s of audio: the oldest goes first.
    const maxPendingBytes = this.format.sampleRate * 2 * MAX_PENDING_SECONDS;
    let pendingBytes = this.pendingPcm.reduce((n, b) => n + b.length, 0);
    while (pendingBytes > maxPendingBytes && this.pendingPcm.length > 1) {
      pendingBytes -= this.pendingPcm.shift()!.length;
    }
    const running = this.current;
    if (running) {
      running.controller.abort();
      await running.done.catch(() => {});
    }
    if (this.closedReason !== null) return skipped('session-closed');
    if (this.latest !== mine) return skipped('merged-into-newer-utterance');

    const audio = Buffer.concat(this.pendingPcm);
    const captures = this.pendingCaptures;
    this.pendingPcm = [];
    this.pendingCaptures = 0;
    return this.runExclusive((turnId, signal) => this.runTurn(turnId, audio, signal, captures));
  }

  // ---------------------------------------------------------------------------

  private async runExclusive(work: (turnId: number, signal: AbortSignal) => Promise<TurnResult>): Promise<TurnResult> {
    const turnId = ++this.seq;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const done = (async (): Promise<TurnResult> => {
      try {
        return await work(turnId, signal);
      } catch (error) {
        // Nothing may escape a turn: a provider bug must not become an unhandled rejection.
        const message = error instanceof Error ? error.message : 'unknown error';
        this.emit({ type: 'error', callId: this.callId, stage: 'internal', message });
        return this.finish(
          { turnId, status: 'failed', reason: 'internal-error', endRequested: false, metrics: emptyMetrics(0) },
          true
        );
      }
    })();
    this.current = { id: turnId, controller, done };
    try {
      return await done;
    } finally {
      if (this.current?.id === turnId) this.current = null;
      this.endTurnPhase();
    }
  }

  private finish(result: TurnResult, countFailure: boolean): TurnResult {
    this.totals.turns++;
    this.totals[result.status]++;
    if (result.status === 'completed') this.consecutiveFailures = 0;
    if (result.status === 'failed' && countFailure) {
      this.consecutiveFailures++;
      if (!this.degraded && this.consecutiveFailures >= this.config.limits.maxConsecutiveFailures) {
        this.degraded = true;
        this.degradedAt = Date.now();
        this.emit({ type: 'degraded', callId: this.callId, consecutiveFailures: this.consecutiveFailures });
      }
    }
    this.emit({ type: 'turn', callId: this.callId, result });
    return result;
  }

  private reportError(stage: 'stt' | 'llm' | 'tts' | 'sink', error: unknown): void {
    const message = error instanceof Error ? error.message : 'unknown error';
    this.errorRecord = { stage, message, at: new Date().toISOString() };
    this.emit({ type: 'error', callId: this.callId, stage, message });
  }

  private pushHistory(message: ChatMessage): void {
    const last = this.history[this.history.length - 1];
    // Two caller turns in a row (the first got no reply) read as one message.
    if (last && last.role === message.role && message.role === 'user') {
      last.content = `${last.content} ${message.content}`;
    } else {
      this.history.push({ ...message });
    }
    const max = this.config.limits.maxHistoryMessages;
    while (this.history.length > max) this.history.shift();
    while (this.history.length > 0 && this.history[0].role !== 'user') this.history.shift();
  }

  private async speakFixed(
    turnId: number,
    text: string,
    signal: AbortSignal,
    metrics: TurnMetrics,
    started: number
  ): Promise<TurnResult> {
    const t = performance.now();
    let pcm: Buffer;
    try {
      pcm = await this.providers.tts.synthesize(text, this.format, signal);
    } catch (error) {
      metrics.totalMs = performance.now() - started;
      if (isAbort(error) || signal.aborted) return this.finish({ turnId, status: 'cancelled', reason: 'aborted', endRequested: false, metrics }, false);
      this.reportError('tts', error);
      this.trace(turnId, 'tts-generated', 'failed', { detail: error instanceof Error ? error.message : 'text-to-speech failed' });
      return this.finish({ turnId, status: 'failed', reason: 'tts-failed', endRequested: false, metrics }, true);
    }
    metrics.ttsFirstMs = metrics.ttsTotalMs = performance.now() - t;
    metrics.ttsChars = text.length;
    this.totals.ttsChars += text.length;
    this.trace(turnId, 'tts-generated', 'ok', {
      latencyMs: metrics.ttsTotalMs,
      text,
      role: 'agent',
      data: { chars: text.length, bytes: pcm.length, greeting: true },
    });
    metrics.firstAudioMs ??= performance.now() - started;
    this.beginSpeaking();
    // Playback problems are reported as playback problems, never as a text-to-speech failure.
    let played: PlayResult;
    try {
      played = await this.sink.play(pcm, signal);
    } catch (error) {
      metrics.totalMs = performance.now() - started;
      if (isAbort(error) || signal.aborted) return this.finish({ turnId, status: 'cancelled', reason: 'aborted', endRequested: false, metrics }, false);
      this.reportError('sink', error);
      this.trace(turnId, 'playback', 'failed', { detail: error instanceof Error ? error.message : 'playback failed' });
      return this.finish({ turnId, status: 'failed', reason: 'sink-error', endRequested: false, metrics }, true);
    }
    metrics.playMs = performance.now() - t - metrics.ttsTotalMs;
    metrics.lateFrames += played.lateFrames ?? 0;
    const lost = played.stoppedBy === 'not-written';
    if (lost) this.reportError('sink', new Error(NOT_WRITTEN_MESSAGE));
    this.trace(turnId, 'playback', played.completed ? 'ok' : lost ? 'failed' : 'cancelled', {
      latencyMs: metrics.playMs,
      detail: playbackDetail(played),
      data: { bytesWritten: played.bytesWritten, bytes: pcm.length, lateFrames: played.lateFrames ?? 0, maxLateMs: played.maxLateMs ?? 0 },
    });
    metrics.totalMs = performance.now() - started;
    if (played.completed) this.pushHistory({ role: 'assistant', content: text });
    return this.finish(
      {
        turnId,
        status: played.completed ? 'completed' : lost ? 'failed' : 'cancelled',
        reason: lost ? 'sink-error' : (played.stoppedBy ?? undefined),
        replyChars: text.length,
        endRequested: false,
        metrics,
      },
      lost
    );
  }

  private async runTurn(turnId: number, pcm: Buffer, signal: AbortSignal, captures = 1): Promise<TurnResult> {
    const started = performance.now();
    const format = this.format;
    const utteranceMs = (pcm.length / 2 / format.sampleRate) * 1000;
    const metrics = emptyMetrics(utteranceMs);
    const cfg = this.config;
    const outcome = (partial: Partial<TurnResult> & { status: TurnStatus }, countFailure = false): TurnResult => {
      metrics.totalMs = performance.now() - started;
      return this.finish({ turnId, endRequested: false, metrics, ...partial }, countFailure);
    };

    // 1. Is this audio worth paying a provider for?
    const passive = this.passive;
    this.trace(turnId, 'pcm-capture', 'ok', {
      data: { bytes: pcm.length, durationMs: Math.round(utteranceMs), utterances: captures },
    });
    const notRun = (stages: TraceInput['stage'][], detail: string): void => {
      for (const stage of stages) this.trace(turnId, stage, 'not-run', { detail });
    };
    const check = checkPcmBuffer(pcm, format);
    if (!check.ok) {
      this.trace(turnId, 'pcm-validation', 'failed', { detail: check.reason });
      notRun(['stt-submit', 'stt-result', 'llm-request', 'llm-response', 'tts-generated', 'playback'], 'audio failed validation');
      return outcome({ status: 'skipped', reason: `invalid-audio: ${check.reason}` });
    }
    const assessment = assessUtterance(pcm, format, { minDurationMs: cfg.utterance.minDurationMs });
    const assessData = {
      durationMs: Math.round(assessment.durationMs),
      rms: Math.round(assessment.rms * 10000) / 10000,
      peak: Math.round(assessment.peak * 10000) / 10000,
      voicedRatio: Math.round(assessment.voicedRatio * 100) / 100,
      decision: assessment.decision,
    };
    const rejectedBeforeStt =
      assessment.decision === 'too-short' ||
      assessment.decision === 'silent' ||
      (assessment.decision === 'unlikely-speech' && cfg.utterance.skipUnlikelySpeech);
    if (rejectedBeforeStt) {
      this.trace(turnId, 'pcm-validation', 'skipped', {
        detail: `not sent to STT: ${assessment.decision}`,
        data: assessData,
      });
      notRun(['stt-submit', 'stt-result', 'llm-request', 'llm-response', 'tts-generated', 'playback'], 'audio was not submitted');
      return outcome({ status: 'skipped', reason: assessment.decision, assessment });
    }
    this.trace(turnId, 'pcm-validation', 'ok', {
      detail: assessment.decision === 'unlikely-speech' ? 'plausible audio, but little voiced content' : undefined,
      data: assessData,
    });

    // 2. Speech to text.
    let transcript: string;
    this.trace(turnId, 'stt-submit', 'ok', {
      data: { seconds: Math.round(utteranceMs) / 1000, bytes: pcm.length, provider: this.providers.stt.name },
    });
    this.setPhase('transcribing');
    const sttStarted = performance.now();
    try {
      this.totals.sttAudioSeconds += utteranceMs / 1000;
      transcript = (await this.providers.stt.transcribe(pcm, format, signal)).text.trim();
      metrics.sttMs = performance.now() - sttStarted;
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        this.trace(turnId, 'stt-result', 'cancelled', { latencyMs: performance.now() - sttStarted, detail: 'cancelled before the transcript arrived' });
        notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'turn cancelled');
        return outcome({ status: 'cancelled', reason: 'aborted-during-stt', assessment });
      }
      this.reportError('stt', error);
      this.trace(turnId, 'stt-result', 'failed', {
        latencyMs: performance.now() - sttStarted,
        detail: error instanceof Error ? error.message : 'speech-to-text failed',
      });
      notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'speech-to-text failed');
      return outcome({ status: 'failed', reason: 'stt-failed', assessment }, true);
    }
    if (!hasSpeechContent(transcript)) {
      this.trace(turnId, 'stt-result', 'skipped', { latencyMs: metrics.sttMs, detail: 'provider returned no words' });
      notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'empty transcript');
      return outcome({ status: 'skipped', reason: 'empty-transcript', assessment });
    }
    // Kept in memory only, and only when the audio passed the voiced-content check; the operator-triggered test response answers it.
    if (assessment.decision === 'ok') this.latestTranscript = { text: transcript, at: Date.now(), turnId };
    this.trace(turnId, 'stt-result', 'ok', {
      latencyMs: metrics.sttMs,
      text: transcript,
      role: 'caller',
      data: { chars: transcript.length },
    });
    if (passive) {
      notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'passive mode: nothing is generated or sent to the caller');
      return outcome({
        status: 'completed',
        reason: 'passive-transcription',
        assessment,
        transcriptChars: transcript.length,
        transcript: cfg.logTranscripts ? transcript : undefined,
      });
    }
    this.pushHistory({ role: 'user', content: transcript });
    this.setPhase('generating');

    // 3. LLM -> sentences -> TTS (in parallel with playback) -> sink.
    const filter = new ProtocolTextFilter();
    const splitter = new SentenceSplitter();
    const queue = new AsyncQueue<{ text: string; audio: Promise<Buffer> }>();
    const llmController = new AbortController();
    const llmSignal = AbortSignal.any([signal, llmController.signal]);
    let endRequested = false;
    let replyChars = 0;
    let llmError: unknown = null;
    let spokenText = '';
    let playbackStopped: string | null = null;
    let ttsFailed = false;

    const enqueue = (sentence: string): void => {
      if (endRequested) return; // nothing is spoken after END_CALL
      const cleaned = extractEndCall(sentence);
      if (cleaned.endRequested) endRequested = true;
      if (!hasSpeechContent(cleaned.text)) return;
      if (replyChars + cleaned.text.length > cfg.limits.maxResponseChars && replyChars > 0) {
        llmController.abort(); // enough: stop paying for more tokens
        return;
      }
      replyChars += cleaned.text.length;
      const ttsStart = performance.now();
      const audio = this.providers.tts.synthesize(cleaned.text, format, signal).then((data) => {
        const took = performance.now() - ttsStart;
        metrics.ttsFirstMs ??= took;
        metrics.ttsTotalMs += took;
        this.trace(turnId, 'tts-generated', 'ok', {
          latencyMs: took,
          text: cleaned.text,
          role: 'agent',
          data: { chars: cleaned.text.length, bytes: data.length },
        });
        return data;
      });
      audio.catch(() => {}); // the consumer observes the failure; this only prevents an unhandled rejection
      metrics.ttsChars += cleaned.text.length;
      this.totals.ttsChars += cleaned.text.length;
      queue.push({ text: cleaned.text, audio });
    };

    const producer = (async () => {
      this.trace(turnId, 'llm-request', 'ok', {
        data: { historyMessages: this.history.length, provider: this.providers.llm.name },
      });
      try {
        const llmStart = performance.now();
        for await (const chunk of this.providers.llm.stream(
          { system: cfg.systemPrompt, messages: this.history.map((m) => ({ ...m })) },
          llmSignal
        )) {
          if (chunk.usage) {
            metrics.usage = chunk.usage;
          }
          if (!chunk.delta) continue;
          metrics.llmFirstTokenMs ??= performance.now() - llmStart;
          const safe = filter.feed(chunk.delta);
          if (safe) for (const sentence of splitter.push(safe)) enqueue(sentence);
          if (endRequested) break;
        }
        const tail = filter.finish();
        if (tail) for (const sentence of splitter.push(tail)) enqueue(sentence);
        for (const sentence of splitter.flush()) enqueue(sentence);
        metrics.llmTotalMs = performance.now() - llmStart;
        this.trace(turnId, 'llm-response', 'ok', {
          latencyMs: metrics.llmFirstTokenMs,
          data: {
            totalMs: Math.round(metrics.llmTotalMs),
            chars: replyChars,
            promptTokens: metrics.usage?.promptTokens ?? null,
            completionTokens: metrics.usage?.completionTokens ?? null,
          },
        });
      } catch (error) {
        if (!(llmController.signal.aborted && !signal.aborted)) llmError = error;
        this.trace(turnId, 'llm-response', signal.aborted ? 'cancelled' : llmController.signal.aborted ? 'ok' : 'failed', {
          latencyMs: metrics.llmFirstTokenMs,
          detail: signal.aborted ? 'cancelled' : llmController.signal.aborted ? 'stopped early (reply length limit or playback stopped)' : error instanceof Error ? error.message : 'LLM failed',
        });
      } finally {
        queue.close();
      }
    })();

    const consumer = (async () => {
      for (;;) {
        const item = await queue.next();
        if (!item) return;
        if (signal.aborted) {
          playbackStopped = 'aborted';
          return;
        }
        let audio: Buffer;
        try {
          audio = await item.audio;
        } catch (error) {
          if (isAbort(error) || signal.aborted) {
            playbackStopped = 'aborted';
          } else {
            ttsFailed = true;
            this.reportError('tts', error);
            this.trace(turnId, 'tts-generated', 'failed', {
              detail: error instanceof Error ? error.message : 'text-to-speech failed',
            });
            this.trace(turnId, 'playback', 'not-run', { detail: 'no audio was generated' });
          }
          return;
        }
        const t = performance.now();
        try {
          metrics.firstAudioMs ??= performance.now() - started;
          this.beginSpeaking();
          const played = await this.sink.play(audio, signal);
          metrics.playMs += performance.now() - t;
          metrics.lateFrames += played.lateFrames ?? 0;
          const lost = played.stoppedBy === 'not-written';
          if (lost) this.reportError('sink', new Error(NOT_WRITTEN_MESSAGE));
          this.trace(turnId, 'playback', played.completed ? 'ok' : lost ? 'failed' : 'cancelled', {
            latencyMs: performance.now() - t,
            detail: playbackDetail(played),
            data: { bytesWritten: played.bytesWritten, bytes: audio.length, lateFrames: played.lateFrames ?? 0, maxLateMs: played.maxLateMs ?? 0 },
          });
          if (!played.completed) {
            // A port that stopped accepting bytes mid-reply is a failure of the line, not a caller interruption.
            playbackStopped = lost ? 'sink-error' : (played.stoppedBy ?? 'stopped');
            return;
          }
          spokenText += (spokenText ? ' ' : '') + item.text;
        } catch (error) {
          this.reportError('sink', error);
          this.trace(turnId, 'playback', 'failed', { detail: error instanceof Error ? error.message : 'playback failed' });
          playbackStopped = 'sink-error';
          return;
        }
      }
    })();

    await consumer;
    if (playbackStopped !== null || ttsFailed) llmController.abort(); // stop generating text nobody will hear
    await producer;

    if (metrics.usage) {
      this.totals.llmPromptTokens += metrics.usage.promptTokens;
      this.totals.llmCompletionTokens += metrics.usage.completionTokens;
    }
    if (spokenText) this.pushHistory({ role: 'assistant', content: spokenText });

    const common = {
      assessment,
      transcriptChars: transcript.length,
      replyChars: spokenText.length,
      transcript: cfg.logTranscripts ? transcript : undefined,
      reply: cfg.logTranscripts ? spokenText : undefined,
    };

    if (signal.aborted) return outcome({ status: 'cancelled', reason: 'interrupted', ...common });
    if (llmError && !spokenText) {
      this.reportError('llm', llmError);
      return outcome({ status: 'failed', reason: 'llm-failed', ...common }, true);
    }
    if (llmError) {
      this.reportError('llm', llmError);
      return outcome({ status: 'failed', reason: 'llm-failed-mid-reply', ...common }, true);
    }
    if (ttsFailed) return outcome({ status: 'failed', reason: 'tts-failed', ...common }, true);
    if (playbackStopped !== null) {
      return outcome({ status: playbackStopped === 'sink-error' ? 'failed' : 'cancelled', reason: playbackStopped, ...common }, playbackStopped === 'sink-error');
    }

    const result = outcome({ status: 'completed', endRequested, ...common });
    if (endRequested) this.emit({ type: 'end-requested', callId: this.callId, reason: 'agent-end-call' });
    return result;
  }
}
