import { performance } from 'node:perf_hooks';
import type { AiConversationPhase, AiInspectorEvent } from '@sim-gateway/shared';
import { AgentAudioSink, AudioFormat, checkPcmBuffer, PlayResult } from './audio.js';
import { countWords, detectHearingComplaint } from './call-audio-verifier.js';
import { ChunkQueue } from './chunk-queue.js';
import { AiConfig } from './config.js';
import { assessUtterance, UtteranceAssessment } from './endpointer.js';
import type { LoopLag } from './loop-lag.js';
import { runWithObsContext } from './obs-context.js';
import { AiProviderError, ChatMessage, LlmMessage, LlmToolCall, LlmUsage, ProviderSet, SttResult, SttStream } from './providers/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { TOOL_RULES } from './tools/rules.js';
import type { ToolMode } from './tools/types.js';
import { formatKnowledge, KNOWLEDGE_RULES, KnowledgeHit, KnowledgeProvider } from './knowledge.js';
import { resetSyncIo, slowestSyncIo } from '../core/sync-io-watch.js';
import { ContactDetails } from './contact-details.js';
import { CallNotes } from './memory.js';
import { detectOptOut } from './opt-out.js';
import { extractEndCall, hasSpeechContent, ProtocolTextFilter, SentenceSplitter } from './text.js';

export type TurnStatus = 'completed' | 'skipped' | 'cancelled' | 'failed';

export interface TurnMetrics {
  sttMs: number | null;
  llmFirstTokenMs: number | null;
  llmTotalMs: number | null;
  ttsFirstMs: number | null;
  ttsTotalMs: number;
  /** Synthesis requests made this turn (one per sentence; a greeting counts as one) and the time they spent queued behind earlier ones. */
  ttsRequests: number;
  ttsQueuedMs: number;
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
  /** Frames written later than the write-ahead could cover: an audible gap is possible (a subset of lateFrames in spirit). */
  riskFrames: number;
  /** Agent audio bytes the audio adapter accepted for this turn (summed over its playbacks). Delivery to the modem only. */
  bytesWritten?: number;
  /** Underruns while streaming this turn's reply, as counted by the paced player. */
  underruns?: number;
  slowWrites?: number;
  /** False when any playback of this turn was cut short; null when nothing was played. */
  playbackCompleted?: boolean | null;
  /** Why the first cut-short playback stopped ('not-written', 'aborted', 'call-ended', ...). */
  playbackStoppedBy?: string | null;
  /**
   * What the caller waited: from the moment they stopped talking to the first reply audio written to the audio port.
   * Null when the endpointer supplied no end-of-speech time or no audio was written. A write is not a sound heard:
   * the line, the network and the caller's phone add delay that cannot be measured here.
   */
  perceivedFirstAudioMs: number | null;
  /** Every stage as an offset in ms from the end of the caller's speech (see TurnTimeline). */
  timeline: TurnTimeline | null;
  /** How long this turn actually waited for the transcript (0 when a speculative one was already done). */
  sttWaitedMs: number | null;
  /** True when the transcript came from the speculative request started during the caller's pause. */
  speculativeStt: boolean;
  /** Largest lateness, in ms, of any audio frame written this turn (playback jitter). */
  maxLateMs: number;
  /** Longest event-loop stall during this turn, in ms; null when it was not measured. Tells a stalled loop from a slow network. */
  loopLagMaxMs: number | null;
  /** Longest garbage-collection pause during this turn (one cause of a stalled loop); null when not measured. */
  gcMaxMs: number | null;
  /** Longest single write to the audio port this turn: a slow port, not a slow loop. */
  maxWriteMs: number;
  /** The slowest synchronous disk operation of the turn and what it was (a call recording write, a telemetry write). */
  syncIoMaxMs: number;
  syncIoLabel: string | null;
  /** Why the speech-to-text stream's words were not used this turn, in plain words; null when they were or streaming is off. */
  sttFallbackReason: string | null;
  /** Replies that came back with no text this turn (each one is asked for again once, then the turn fails). */
  llmEmptyReplies: number;
  /** Whether the model streams, so llmFirstTokenMs is a real time-to-first-token. Null when no model request was made. */
  tftAvailable: boolean | null;
  /** What sttMs measured; null when no transcript was produced. */
  sttMode: 'batch' | 'speculative' | 'stream' | null;
  /** Absolute monotonic marks the timeline is computed from (internal). */
  marks: TurnMarks;
  /** Passages retrieved for this turn; null when no knowledge base is configured or the turn never reached the model. */
  knowledgeHits: number | null;
}

/** Offsets in ms from the end of the caller's speech. Null where a stage did not happen in this turn. */
export interface TurnTimeline {
  /** How long the endpointer waited in silence before deciding the caller had finished. */
  endpointMs: number | null;
  turnStartMs: number | null;
  sttDoneMs: number | null;
  llmFirstTokenMs: number | null;
  ttsFirstAudioMs: number | null;
  firstWriteMs: number | null;
  /** The model had finished its reply. */
  llmDoneMs: number | null;
  /** The last audio of the reply had been written. */
  playbackDoneMs: number | null;
  /** What the caller waited before the reply started (the same instant as firstWriteMs, named for what it means). */
  firstAudioLatencyMs: number | null;
  /** How long the reply took to play, from its first write to its last: speaking time, not waiting time. */
  playbackMs: number | null;
  turnEndMs: number | null;
}

export interface TurnMarks {
  speechEnd?: number;
  endpointed?: number;
  turnStart?: number;
  sttDone?: number;
  llmFirst?: number;
  ttsFirst?: number;
  firstWrite?: number;
  llmDone?: number;
  /** When the last audio write of the turn completed. */
  playbackDone?: number;
  end?: number;
}

/** When the caller's utterance really ended and was detected, and the speculative transcript (if any) to reuse. */
export interface UtteranceTiming {
  speechEndedAt?: number;
  endpointedAt?: number;
  speculativeId?: number;
  /** This utterance began as an interruption of the agent, so it is checked against what the agent had just said. */
  afterBargeIn?: boolean;
  /**
   * The audio of this same utterance, already being transcribed by a streaming recognizer. Only its FINAL text is
   * used, and only here, at the confirmed end of the utterance. The session closes it; if it fails or returns nothing
   * the batch provider transcribes the audio instead.
   */
  stream?: SttStream;
}

/**
 * Who cancelled a turn. 'caller-speech': the caller started talking while the agent was working or speaking.
 * 'endpoint-continuation': the caller finished another stretch of speech while the turn was still running, so the
 * earlier endpoint was premature. 'manual': an operator action. 'teardown': the call or the session ended.
 */
export type CancelSource = 'caller-speech' | 'endpoint-continuation' | 'manual' | 'teardown';

export interface TurnResult {
  turnId: number;
  status: TurnStatus;
  reason?: string;
  /** Set on a cancelled turn: what cancelled it. */
  cancelSource?: CancelSource;
  assessment?: UtteranceAssessment;
  transcriptChars?: number;
  /** Words in the final transcript (a count; the text is only present when transcript logging is on). */
  transcriptWords?: number;
  /** The speech-to-text provider's confidence for the final transcript, when it reports one. */
  sttConfidence?: number | null;
  /** An in-memory phrase check found the caller saying they cannot hear the agent (the text is not kept). */
  callerReportsNotHearing?: boolean;
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
  | { type: 'opt-out'; callId: string }
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
  /**
   * Shared across calls: fixed lines (the greeting, "are you still there?") are synthesized once and replayed from
   * memory afterwards. Owned by the caller (the orchestrator), so it is empty for every new orchestrator.
   */
  fixedAudioCache?: Map<string, Buffer>;
  /** Verified company knowledge, retrieved per question (see knowledge.ts). Absent means none is configured. */
  knowledge?: KnowledgeProvider | null;
  /** Event-loop stall monitor; reset at the start of every turn and read when it ends. */
  loopLag?: LoopLag;
  /** Structured details about the person on this call (a campaign contact), added to this call's system prompt only. */
  callContext?: string | null;
  /** Names the campaign version's shared prompt prefix on every model request of this call (see LlmRequest.cacheKey). */
  promptCacheKey?: string | null;
  /**
   * Functions the model may call on this call. Offered only when the selected model supports them and the registry has a tool for
   * this call's mode; otherwise the conversation is exactly what it was without tools.
   */
  tools?: ConversationTools | null;
}

export interface ConversationTools {
  registry: ToolRegistry;
  mode: ToolMode;
  /** Set for a campaign call only. */
  campaignId: string | null;
  contactId: number | null;
  /** A standing reason nothing may be recorded for this call's person (do-not-call list, declined consent); null when none. */
  restriction: () => string | null;
}

/** A reply being synthesized and downloaded while it plays. */
interface TtsStreamHandle {
  chunks: AsyncIterable<Buffer>;
  /** The provider's failure, once it has happened (the same object that the chunk iterator throws). */
  error: () => unknown;
  /** The whole audio, only when requested up front and the stream completed. */
  audio: () => Buffer | null;
  /** Bytes of audio that have arrived so far, and whether the download has finished. */
  received: () => number;
  completed: () => boolean;
}

const MAX_FIXED_LINES = 24;

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
/** Merged audio longer than this is not replayed through a stream: it only waits for the batch provider. */
const MAX_REPLAY_SECONDS = 19; // the stream queues at most 20 s of audio while it connects
/** A replay stream opens a new connection first (1.3 s or more to the AU endpoint), so it gets longer than a live stream to answer. */
const REPLAY_FINALIZE_MS = 3500;
/** Cancelled-turn audio is only worth merging with speech that follows soon after it. */
const REQUEUE_MAX_AGE_MS = 10_000;

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

/** Fold one playback call into the turn's totals: late frames, frames past the write-ahead (audible-gap risk), worst lateness. */
function notePlayback(metrics: TurnMetrics, played: PlayResult): void {
  metrics.lateFrames += played.lateFrames ?? 0;
  metrics.riskFrames += played.riskFrames ?? 0;
  metrics.maxLateMs = Math.max(metrics.maxLateMs, played.maxLateMs ?? 0);
  metrics.maxWriteMs = Math.max(metrics.maxWriteMs, played.maxWriteMs ?? 0);
  metrics.bytesWritten = (metrics.bytesWritten ?? 0) + played.bytesWritten;
  metrics.underruns = (metrics.underruns ?? 0) + (played.underruns ?? 0);
  metrics.slowWrites = (metrics.slowWrites ?? 0) + (played.slowWrites ?? 0);
  metrics.playbackCompleted = (metrics.playbackCompleted ?? true) && played.completed;
  if (!played.completed && !metrics.playbackStoppedBy) metrics.playbackStoppedBy = played.stoppedBy ?? 'unknown';
  if (played.bytesWritten > 0) metrics.marks.playbackDone = performance.now();
}

/** A reply with no text is asked for once more, then the turn fails: never more than this many requests per turn. */
const MAX_LLM_REQUESTS_FOR_EMPTY_REPLY = 2;
/** Rounds of tool calls in one reply, and calls honoured per round: a model that keeps asking is cut off and made to answer. */
const MAX_TOOL_ROUNDS = 2;
const MAX_TOOL_CALLS_PER_ROUND = 3;

const emptyMetrics = (utteranceMs: number): TurnMetrics => ({
  sttMs: null,
  llmFirstTokenMs: null,
  llmTotalMs: null,
  tftAvailable: null,
  llmEmptyReplies: 0,
  sttMode: null,
  maxLateMs: 0,
  loopLagMaxMs: null,
  gcMaxMs: null,
  maxWriteMs: 0,
  syncIoMaxMs: 0,
  syncIoLabel: null,
  sttFallbackReason: null,
  ttsFirstMs: null,
  ttsTotalMs: 0,
  ttsRequests: 0,
  ttsQueuedMs: 0,
  playMs: 0,
  totalMs: 0,
  utteranceMs,
  ttsChars: 0,
  usage: null,
  firstAudioMs: null,
  lateFrames: 0,
  riskFrames: 0,
  bytesWritten: 0,
  underruns: 0,
  slowWrites: 0,
  playbackCompleted: null,
  playbackStoppedBy: null,
  perceivedFirstAudioMs: null,
  timeline: null,
  sttWaitedMs: null,
  speculativeStt: false,
  marks: {},
  knowledgeHits: null,
});

/** Waits for a promise, but stops waiting (rejecting as a cancellation) when the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AiProviderError('turn', 'stt', 'cancelled', { aborted: true }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiProviderError('turn', 'stt', 'cancelled', { aborted: true }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

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
  /**
   * Audio of a turn that was cancelled before its transcript reached the history. Dropping it lost the caller's
   * words (the newer utterance only carries what was said after the cancel), so the next utterance is transcribed
   * together with it. A turn whose words are already in the history is never put back, so nothing is said twice.
   */
  private requeued: { pcm: Buffer; captures: number; at: number } | null = null;
  /** Who cancelled the turn in progress; the first cause wins. Reset when a turn starts. */
  private cancelSource: CancelSource | null = null;
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
    this.fixedAudio = deps.fixedAudioCache ?? null;
    this.knowledge = deps.knowledge ?? null;
    this.loopLag = deps.loopLag ?? null;
    this.callContext = deps.callContext ?? null;
    this.promptCacheKey = deps.promptCacheKey ?? null;
    this.tools = deps.tools ?? null;
    this.notes = new CallNotes({ enabled: deps.config.memory.callNotes });
    this.contact = new ContactDetails(deps.config.memory.contactDetails !== false);
  }

  private readonly knowledge: KnowledgeProvider | null;
  private readonly callContext: string | null;
  private readonly promptCacheKey: string | null;
  private readonly tools: ConversationTools | null;
  /** The caller asked, on this call, not to be contacted again. Tools refuse to record anything once this is set. */
  private optedOut = false;
  private readonly loopLag: LoopLag | null;
  private readonly notes: CallNotes;
  private readonly contact: ContactDetails;
  /** A transcript requested during the caller's pause, before the turn was certain to be over. */
  private spec: { id: number; controller: AbortController; promise: Promise<{ text: string; ms: number; doneAt: number } | null> } | null = null;
  /** How fast the agent speaks, in characters per second of audio, learned from sentences played to the end. */
  private charsPerSecond = 14;
  /** The last things the agent said, to recognise its own voice coming back as an "interruption". */
  private recentAgentText = '';

  private readonly fixedAudio: Map<string, Buffer> | null;

  /** Streaming needs both ends: a provider that can stream and a sink that can play a stream. */
  private canStream(): boolean {
    return typeof this.providers.tts.synthesizeStream === 'function' && typeof this.sink.playStream === 'function';
  }

  private fixedKey(text: string): string {
    return [this.providers.tts.name, this.config.tts.voice, this.format.sampleRate, text].join('|');
  }

  /**
   * Starts downloading one sentence now and returns immediately; the audio is buffered as it arrives so the player
   * can begin on the first bytes, and the next sentence can be requested while this one plays.
   */
  private startTtsStream(turnId: number, text: string, metrics: TurnMetrics, signal: AbortSignal, collect = false): TtsStreamHandle {
    const queue = new ChunkQueue();
    const parts: Buffer[] = [];
    let error: unknown = null;
    let complete = false;
    let received = 0;
    const startedAt = performance.now();
    // A provider's concurrency limit makes sentence 2 wait for sentence 1's download: that wait is queueing, not the provider's time.
    let slotAt = startedAt;
    const request = ++metrics.ttsRequests;
    void (async () => {
      let first = true;
      try {
        for await (const chunk of this.providers.tts.synthesizeStream!(text, this.format, signal, { onStart: () => (slotAt = performance.now()) })) {
          if (first) {
            first = false;
            const now = performance.now();
            const queuedMs = slotAt - startedAt;
            metrics.ttsQueuedMs += queuedMs;
            metrics.ttsFirstMs ??= now - startedAt;
            metrics.marks.ttsFirst ??= now;
            // latencyMs is the provider's own time to its first audio; what the sentence waited in the queue is reported beside it.
            this.trace(turnId, 'tts-generated', 'ok', {
              latencyMs: now - slotAt,
              text,
              role: 'agent',
              data: { chars: text.length, streamed: true, request, queuedMs: Math.round(queuedMs), sinceRequestMs: Math.round(now - startedAt) },
            });
          }
          received += chunk.length;
          if (collect) parts.push(chunk);
          queue.push(chunk);
        }
        if (first) throw new AiProviderError(this.providers.tts.name, 'tts', 'returned no audio');
        metrics.ttsTotalMs += performance.now() - startedAt;
        complete = true;
        queue.close();
      } catch (e) {
        error = e;
        queue.fail(e);
      }
    })();
    return { chunks: queue, error: () => error, audio: () => (collect && complete ? Buffer.concat(parts) : null), received: () => received, completed: () => complete };
  }

  private rememberFixed(key: string, pcm: Buffer): void {
    if (!this.fixedAudio) return;
    this.fixedAudio.set(key, pcm);
    while (this.fixedAudio.size > MAX_FIXED_LINES) {
      const oldest = this.fixedAudio.keys().next().value;
      if (oldest === undefined) break;
      this.fixedAudio.delete(oldest);
    }
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

  /**
   * The caller interrupted: stop being deaf now instead of after the guard, so what they are saying is heard.
   * Call interrupt() first; this only clears the half-duplex state.
   */
  resumeListening(): void {
    this.speaking = false;
    this.guardUntil = 0;
    if (this.current === null) this.setPhase('listening');
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
  /** The agent's audio is being played to the caller right now (not merely transcribing or thinking). */
  get isSpeaking(): boolean {
    return this.speaking;
  }
  /** A turn is running (including its queued speech) or audio is still being played: nothing else may speak. */
  get isAgentActive(): boolean {
    return this.current !== null || this.speaking;
  }
  getHistory(): ChatMessage[] {
    return this.history.map((m) => ({ ...m }));
  }

  private get format(): AudioFormat {
    return this.sink.format;
  }

  /**
   * Cancel the turn in progress. Safe to call at any time. The cause is recorded on the cancelled turn
   * (TurnResult.cancelSource and the inspector); a caller-driven cancel before the transcript is committed also keeps
   * the turn's audio for the next utterance (see `requeued`).
   */
  interrupt(source: CancelSource = 'manual'): void {
    if (!this.current) return;
    this.cancelSource ??= source;
    this.current.controller.abort();
  }

  /** Stop everything for this call. Idempotent. */
  async close(reason: string): Promise<void> {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    if (this.current) this.cancelSource ??= 'teardown';
    this.lifetime.abort();
    this.pendingPcm = [];
    this.requeued = null;
    const running = this.current;
    if (running) await running.done.catch(() => {});
    this.history.length = 0;
    this.spec?.controller.abort();
    this.spec = null;
    this.notes.clear();
    this.latestTranscript = null;
    this.seen.clear();
  }

  /** Speak a fixed line (the greeting) without calling the LLM. */
  async say(text: string): Promise<TurnResult> {
    if (this.passive) {
      // Passive mode never produces or sends audio, whoever asks.
      return this.finish({ turnId: 0, status: 'skipped', reason: 'passive-mode', endRequested: false, metrics: emptyMetrics(0) }, false);
    }
    // A fixed line never runs beside another turn: it would replace the running turn's controller, so a barge-in could no
    // longer cancel that turn. The caller of say() (the idle check-in) just tries again later. No turn event is emitted.
    if (this.current !== null) return { turnId: 0, status: 'skipped', reason: 'turn-active', endRequested: false, metrics: emptyMetrics(0) };
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
  async handleUtterance(pcm: Buffer, utteranceId?: string, timing?: UtteranceTiming): Promise<TurnResult> {
    try {
      return await this.handleUtteranceInner(pcm, utteranceId, timing);
    } finally {
      // However this utterance ended (answered, skipped, merged, cancelled), its streaming recognizer is released.
      timing?.stream?.close();
    }
  }

  private async handleUtteranceInner(pcm: Buffer, utteranceId?: string, timing?: UtteranceTiming): Promise<TurnResult> {
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

    // A sound that is not speech (a noise, a breath, a click) must not cost the caller the answer that is being prepared: while a
    // turn is running, such audio is dropped here, BEFORE anything is cancelled. Only real speech replaces the running turn below.
    if (this.current !== null) {
      const quick = assessUtterance(pcm, this.format, { minDurationMs: this.config.utterance.minDurationMs });
      if (quick.decision === 'too-short' || quick.decision === 'silent' || (quick.decision === 'unlikely-speech' && this.config.utterance.skipUnlikelySpeech)) {
        this.trace(null, 'pcm-validation', 'skipped', { detail: `ignored while the agent was answering: ${quick.decision}; the answer continues` });
        return skipped(quick.decision);
      }
    }

    // Newest wins: queue this audio, cancel whatever is running, and let only the latest call proceed.
    const mine = ++this.latest;
    this.pendingPcm.push(pcm);
    this.pendingCaptures++;
    this.trimPending();
    // A new stretch of speech finished while a turn was still running: that turn's endpoint came too early. Loop in case
    // another turn took over while this one was waiting.
    for (let running = this.current; running; running = this.current) {
      this.cancelSource ??= 'endpoint-continuation';
      running.controller.abort();
      await running.done.catch(() => {});
      if (this.current?.id === running.id) break;
    }
    if (this.closedReason !== null) return skipped('session-closed');
    if (this.latest !== mine) return skipped('merged-into-newer-utterance');

    // The cancelled turn's audio, if its words never reached the history, goes first so the sentence is heard whole.
    const back = this.requeued;
    this.requeued = null;
    if (back && Date.now() - back.at <= REQUEUE_MAX_AGE_MS) {
      this.pendingPcm.unshift(back.pcm);
      this.pendingCaptures += back.captures;
      this.trimPending();
    }
    const audio = Buffer.concat(this.pendingPcm);
    const captures = this.pendingCaptures;
    this.pendingPcm = [];
    this.pendingCaptures = 0;
    return this.runExclusive((turnId, signal) => this.runTurn(turnId, audio, signal, captures, timing));
  }

  /** Utterances that pile up while a turn is cancelled are merged, but never beyond ~30 s of audio: the oldest goes first. */
  private trimPending(): void {
    const maxPendingBytes = this.format.sampleRate * 2 * MAX_PENDING_SECONDS;
    let pendingBytes = this.pendingPcm.reduce((n, b) => n + b.length, 0);
    while (pendingBytes > maxPendingBytes && this.pendingPcm.length > 1) {
      pendingBytes -= this.pendingPcm.shift()!.length;
    }
  }

  /**
   * A turn was cancelled before its transcript was committed. If the caller cancelled it (they spoke again), keep its
   * audio for the utterance that follows; cancels by an operator or by the call ending do not keep anything.
   */
  private requeueUncommitted(pcm: Buffer, captures: number): void {
    if (this.closedReason !== null) return;
    if (this.cancelSource !== 'caller-speech' && this.cancelSource !== 'endpoint-continuation') return;
    this.requeued = { pcm, captures, at: Date.now() };
  }

  // ---------------------------------------------------------------------------

  // ---- speculative transcription -----------------------------------------------------------------------------

  /**
   * The caller paused long enough that they may be done. Start transcribing what they have said so far; if they are in
   * fact finished, the turn reuses the result and the transcription time overlaps the rest of the silence wait. It can
   * never start a turn: only handleUtterance does, once per utterance id.
   */
  beginSpeculative(pcm: Buffer, id: number): void {
    if (this.closedReason !== null || this.degraded) return;
    const assessment = assessUtterance(pcm, this.format, { minDurationMs: this.config.utterance.minDurationMs });
    if (assessment.decision === 'too-short' || assessment.decision === 'silent') return;
    if (assessment.decision === 'unlikely-speech' && this.config.utterance.skipUnlikelySpeech) return;
    this.spec?.controller.abort(); // one at a time: a newer pause replaces an older one
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const startedAt = performance.now();
    this.totals.sttAudioSeconds += assessment.durationMs / 1000;
    const promise = runWithObsContext({ callId: this.callId, turnId: null }, () => this.providers.stt.transcribe(pcm, this.format, signal)).then(
      (r) => ({ text: r.text.trim(), ms: performance.now() - startedAt, doneAt: performance.now() }),
      () => null
    );
    this.spec = { id, controller, promise };
  }

  /** The caller carried on: that transcript describes a sentence that was not the end of the turn. */
  cancelSpeculative(id: number): void {
    if (this.spec?.id !== id) return;
    this.spec.controller.abort();
    this.spec = null;
  }

  /** The words of a speculative request, once they arrive; null if there is none or it failed. */
  async speculativeText(id: number): Promise<string | null> {
    const spec = this.spec;
    if (!spec || spec.id !== id) return null;
    const result = await spec.promise;
    return result && result.text ? result.text : null;
  }

  private takeSpeculative(id: number | undefined): NonNullable<ConversationSession['spec']> | null {
    const spec = this.spec;
    if (id === undefined || !spec || spec.id !== id) return null;
    this.spec = null;
    return spec;
  }

  // ---- what the model is given -------------------------------------------------------------------------------

  /** The system prompt for this turn: the standing instructions, the verified passages that bear on it, the call notes. */
  private async buildSystem(transcript: string): Promise<{ system: string; hits: KnowledgeHit[]; notes: boolean }> {
    let system = this.config.systemPrompt;
    // Per-call context is appended to this call's copy; the stored prompt and every other call are untouched.
    if (this.callContext) system += `\n\n${this.callContext}`;
    let hits: KnowledgeHit[] = [];
    if (this.knowledge) {
      system += `\n\n${KNOWLEDGE_RULES}`;
      const lastAgent = [...this.history].reverse().find((m) => m.role === 'assistant')?.content ?? '';
      // A short reply ("yes, the second one") only means something next to the question it answers.
      const query = transcript.split(/\s+/).length < 5 ? `${lastAgent.slice(-160)} ${transcript}` : transcript;
      try {
        const lookup = this.knowledge.retrieve(query, { topK: this.config.knowledge.topK, maxChars: this.config.knowledge.maxChars });
        hits = await Promise.race([lookup, new Promise<KnowledgeHit[]>((resolve) => setTimeout(() => resolve([]), 150).unref?.())]);
      } catch {
        hits = [];
      }
      const block = formatKnowledge(hits);
      if (block) system += `\n\n${block}`;
    }
    const details = this.contact.promptBlock();
    if (details) system += `\n\n${details}`;
    if (this.toolSpecs().length > 0) system += `\n\n${TOOL_RULES}`;
    const withNotes = this.notes.withNotes(system);
    return { system: withNotes, hits, notes: withNotes !== system };
  }

  /** A fresh recognizer given merged audio all at once. Any failure to open one just means the batch provider is used. */
  private openReplayStream(pcm: Buffer, format: AudioFormat, signal: AbortSignal, speechLike: boolean): SttStream | undefined {
    const provider = this.providers.sttStream;
    if (!provider || !speechLike || pcm.length === 0 || pcm.length > format.sampleRate * 2 * MAX_REPLAY_SECONDS) return undefined;
    try {
      const stream = provider.open(format, signal);
      const step = Math.round(format.sampleRate * 0.1) * 2; // 100 ms of 16-bit samples
      for (let i = 0; i < pcm.length; i += step) stream.push(pcm.subarray(i, i + step));
      return stream;
    } catch {
      return undefined;
    }
  }

  /** The batch request, started early because the streaming recognizer is slow. Cancelled by the caller if the stream answers first. */
  private startHedge(pcm: Buffer, format: AudioFormat, signal: AbortSignal): { promise: Promise<SttResult>; cancel: () => void } {
    const controller = new AbortController();
    this.totals.sttAudioSeconds += pcm.length / (2 * format.sampleRate);
    const promise = this.providers.stt.transcribe(pcm, format, AbortSignal.any([signal, controller.signal]));
    promise.catch(() => {}); // observed where it is awaited; this only prevents an unhandled rejection when it is cancelled
    return { promise, cancel: () => controller.abort() };
  }

  /** The functions to offer the model this turn: none unless the selected model supports them and a tool is allowed in this call's mode. */
  private toolSpecs() {
    if (!this.tools || this.providers.llm.supportsTools !== true) return [];
    return this.tools.registry.specsFor(this.tools.mode);
  }

  /** The words of a sentence that went out before it was cut off, at a word boundary; empty when too little was said to matter. */
  private spokenPrefix(text: string, bytesWritten: number, totalBytes: number | null): string {
    if (bytesWritten <= 0) return '';
    const seconds = bytesWritten / (2 * this.format.sampleRate);
    const chars = totalBytes && totalBytes > 0 ? Math.floor(text.length * Math.min(1, bytesWritten / totalBytes)) : Math.floor(seconds * this.charsPerSecond);
    if (chars >= text.length) return '';
    const cut = text.slice(0, chars);
    const space = cut.lastIndexOf(' ');
    const prefix = (space > 8 ? cut.slice(0, space) : cut).trim();
    return prefix.length >= 6 ? prefix : '';
  }

  /** Nearly every word of the transcript is a word the agent has just said (and there are enough to be sure). */
  private soundsLikeAgent(transcript: string): boolean {
    const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
    const heard = words(transcript);
    if (heard.length < 4) return false;
    const said = new Set(words(this.recentAgentText));
    return heard.filter((w) => said.has(w)).length / heard.length >= 0.85;
  }

  private learnSpeechRate(text: string, audioBytes: number): void {
    const seconds = audioBytes / (2 * this.format.sampleRate);
    if (seconds < 0.5 || text.length < 10) return;
    this.charsPerSecond = Math.min(30, Math.max(6, this.charsPerSecond * 0.7 + (text.length / seconds) * 0.3));
  }

  // ---- timeline ------------------------------------------------------------------------------------------------

  private finalizeTimeline(result: TurnResult): void {
    const m = result.metrics;
    m.marks.end ??= performance.now();
    const origin = m.marks.speechEnd ?? m.marks.turnStart;
    if (origin === undefined) return;
    const off = (t: number | undefined): number | null => (t === undefined ? null : Math.round(t - origin));
    const firstWriteMs = off(m.marks.firstWrite);
    const playbackDoneMs = off(m.marks.playbackDone);
    m.timeline = {
      endpointMs: m.marks.speechEnd !== undefined && m.marks.endpointed !== undefined ? Math.round(m.marks.endpointed - m.marks.speechEnd) : null,
      turnStartMs: off(m.marks.turnStart),
      sttDoneMs: off(m.marks.sttDone),
      llmFirstTokenMs: off(m.marks.llmFirst),
      ttsFirstAudioMs: off(m.marks.ttsFirst),
      firstWriteMs,
      llmDoneMs: off(m.marks.llmDone),
      playbackDoneMs,
      firstAudioLatencyMs: firstWriteMs,
      playbackMs: firstWriteMs !== null && playbackDoneMs !== null ? Math.max(0, playbackDoneMs - firstWriteMs) : null,
      turnEndMs: off(m.marks.end),
    };
    // Only meaningful when the clock started at the end of the caller's speech.
    m.perceivedFirstAudioMs = m.marks.speechEnd !== undefined ? m.timeline.firstWriteMs : null;
    // One timeline per real turn (it reached the transcript), whether or not anything was played, so a turn with no reply
    // still shows where its time went.
    if (m.timeline.firstWriteMs === null && m.timeline.sttDoneMs === null) return;
    const t = m.timeline;
    const from = m.marks.speechEnd !== undefined ? 'the caller stopped talking' : 'the turn began';
    const stages =
      ` (silence wait ${t.endpointMs ?? '?'} ms, transcript ready at ${t.sttDoneMs ?? '?'} ms${m.speculativeStt ? ' (speculative)' : ''},` +
      ` first words from the model at ${t.llmFirstTokenMs ?? '?'} ms, model done at ${t.llmDoneMs ?? '?'} ms, first synthesized audio at ${t.ttsFirstAudioMs ?? '?'} ms)`;
    this.trace(result.turnId, 'call', 'ok', {
      latencyMs: t.firstWriteMs,
      detail:
        t.firstWriteMs !== null
          ? `First audio written ${t.firstWriteMs} ms after ${from}${stages}; the reply then played for ${t.playbackMs ?? '?'} ms. Written to the audio port, not proven heard.`
          : `No audio was played (${result.status}${result.reason ? `: ${result.reason}` : ''})${stages}.`,
      data: {
        ...t,
        perceivedFirstAudioMs: m.perceivedFirstAudioMs,
        speculativeStt: m.speculativeStt,
        sttMode: m.sttMode,
        sttFallbackReason: m.sttFallbackReason,
        ttsRequests: m.ttsRequests,
        ttsQueuedMs: Math.round(m.ttsQueuedMs),
        // Where a late frame came from: a stalled event loop (and how much of it was garbage collection) or a slow port write.
        loopLagMaxMs: m.loopLagMaxMs,
        gcMaxMs: m.gcMaxMs,
        syncIoMaxMs: m.syncIoMaxMs,
        syncIoLabel: m.syncIoLabel,
        maxWriteMs: Math.round(m.maxWriteMs),
        maxLateMs: Math.round(m.maxLateMs),
      },
    });
  }

  private async runExclusive(work: (turnId: number, signal: AbortSignal) => Promise<TurnResult>): Promise<TurnResult> {
    const turnId = ++this.seq;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    this.cancelSource = null; // a cancel recorded for the previous turn is not this turn's
    this.loopLag?.reset();
    resetSyncIo();
    const done = (async (): Promise<TurnResult> => {
      try {
        return await runWithObsContext({ callId: this.callId, turnId: `${this.callId}:t${turnId}` }, () => work(turnId, signal));
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
    if (result.turnId > 0) {
      result.metrics.loopLagMaxMs = this.loopLag?.maxMs() ?? null;
      result.metrics.gcMaxMs = this.loopLag?.gcMaxMs?.() ?? null;
      const io = slowestSyncIo();
      result.metrics.syncIoMaxMs = io.ms;
      result.metrics.syncIoLabel = io.label;
    }
    this.finalizeTimeline(result);
    if (result.status === 'cancelled' && this.cancelSource && result.turnId > 0) {
      result.cancelSource = this.cancelSource;
      this.trace(result.turnId, 'call', 'ok', {
        detail: `Turn cancelled by ${this.cancelSource.replace('-', ' ')} (${result.reason ?? 'cancelled'})`,
        data: { cancelSource: this.cancelSource, reason: result.reason ?? null, firstAudioWritten: result.metrics.firstAudioMs !== null },
      });
    }
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
    const dropped: ChatMessage[] = [];
    while (this.history.length > max) dropped.push(this.history.shift()!);
    const scrolledOut = dropped.length > 0;
    while (this.history.length > 0 && this.history[0].role !== 'user') dropped.push(this.history.shift()!);
    // Turns that scroll out of the size window are folded into the call notes instead of being forgotten. A lone
    // assistant message at the front (such as the greeting) is just tidied away and is not worth a summary.
    if (scrolledOut) this.notes.fold(dropped, this.providers.llm);
  }

  private async speakFixed(
    turnId: number,
    text: string,
    signal: AbortSignal,
    metrics: TurnMetrics,
    started: number
  ): Promise<TurnResult> {
    const t = performance.now();
    this.recentAgentText = `${this.recentAgentText} ${text}`.slice(-800);
    const key = this.fixedKey(text);
    const cached = this.fixedAudio?.get(key);
    if (!cached && this.canStream()) return this.speakFixedStreamed(turnId, text, signal, metrics, started, key);
    let pcm: Buffer;
    try {
      pcm = cached ?? (await this.providers.tts.synthesize(text, this.format, signal));
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
      data: { chars: text.length, bytes: pcm.length, greeting: true, cached: cached !== undefined },
    });
    metrics.firstAudioMs ??= performance.now() - started;
          metrics.marks.firstWrite ??= performance.now();
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
    notePlayback(metrics, played);
    const lost = played.stoppedBy === 'not-written';
    if (lost) this.reportError('sink', new Error(NOT_WRITTEN_MESSAGE));
    this.trace(turnId, 'playback', played.completed ? 'ok' : lost ? 'failed' : 'cancelled', {
      latencyMs: metrics.playMs,
      detail: playbackDetail(played),
      data: { bytesWritten: played.bytesWritten, bytes: pcm.length, lateFrames: played.lateFrames ?? 0, maxLateMs: played.maxLateMs ?? 0 },
    });
    metrics.totalMs = performance.now() - started;
    if (played.completed) {
      this.pushHistory({ role: 'assistant', content: text });
      if (!cached) this.rememberFixed(key, pcm);
    }
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

  /** A fixed line that is not cached yet: play it while it downloads, and keep it for the next call. */
  private async speakFixedStreamed(
    turnId: number,
    text: string,
    signal: AbortSignal,
    metrics: TurnMetrics,
    started: number,
    key: string
  ): Promise<TurnResult> {
    const t = performance.now();
    metrics.ttsChars = text.length;
    this.totals.ttsChars += text.length;
    const handle = this.startTtsStream(turnId, text, metrics, signal, true);
    let played: PlayResult;
    try {
      played = await this.sink.playStream!(handle.chunks, signal, {
        onFirstWrite: () => {
          metrics.firstAudioMs ??= performance.now() - started;
          metrics.marks.firstWrite ??= performance.now();
          this.beginSpeaking();
        },
      });
    } catch (error) {
      metrics.totalMs = performance.now() - started;
      if (isAbort(error) || signal.aborted) return this.finish({ turnId, status: 'cancelled', reason: 'aborted', endRequested: false, metrics }, false);
      if (error === handle.error()) {
        this.reportError('tts', error);
        this.trace(turnId, 'tts-generated', 'failed', { detail: error instanceof Error ? error.message : 'text-to-speech failed' });
        return this.finish({ turnId, status: 'failed', reason: 'tts-failed', endRequested: false, metrics }, true);
      }
      this.reportError('sink', error);
      this.trace(turnId, 'playback', 'failed', { detail: error instanceof Error ? error.message : 'playback failed' });
      return this.finish({ turnId, status: 'failed', reason: 'sink-error', endRequested: false, metrics }, true);
    }
    metrics.playMs = performance.now() - t;
    notePlayback(metrics, played);
    const lost = played.stoppedBy === 'not-written';
    if (lost) this.reportError('sink', new Error(NOT_WRITTEN_MESSAGE));
    this.trace(turnId, 'playback', played.completed ? 'ok' : lost ? 'failed' : 'cancelled', {
      latencyMs: metrics.playMs,
      detail: playbackDetail(played),
      data: { bytesWritten: played.bytesWritten, bytes: played.bytesWritten, lateFrames: played.lateFrames ?? 0, maxLateMs: played.maxLateMs ?? 0, streamed: true },
    });
    metrics.totalMs = performance.now() - started;
    if (played.completed) {
      this.pushHistory({ role: 'assistant', content: text });
      const audio = handle.audio();
      if (audio) this.rememberFixed(key, audio);
    }
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

  private async runTurn(turnId: number, pcm: Buffer, signal: AbortSignal, captures = 1, timing?: UtteranceTiming): Promise<TurnResult> {
    const started = performance.now();
    const format = this.format;
    const utteranceMs = (pcm.length / 2 / format.sampleRate) * 1000;
    const metrics = emptyMetrics(utteranceMs);
    metrics.marks.turnStart = started;
    if (timing?.speechEndedAt !== undefined) {
      metrics.marks.speechEnd = timing.speechEndedAt;
      metrics.marks.endpointed = timing.endpointedAt;
    }
    const cfg = this.config;
    const sttFacts: { words?: number; confidence: number | null; complaint: boolean } = { confidence: null, complaint: false };
    const outcome = (partial: Partial<TurnResult> & { status: TurnStatus }, countFailure = false): TurnResult => {
      metrics.totalMs = performance.now() - started;
      const facts =
        sttFacts.words === undefined ? {} : { transcriptWords: sttFacts.words, sttConfidence: sttFacts.confidence, ...(sttFacts.complaint ? { callerReportsNotHearing: true } : {}) };
      return this.finish({ turnId, endRequested: false, metrics, ...facts, ...partial }, countFailure);
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
    const assessStarted = performance.now();
    const assessment = assessUtterance(pcm, format, { minDurationMs: cfg.utterance.minDurationMs });
    const assessMs = Math.round((performance.now() - assessStarted) * 10) / 10; // synchronous time spent before the first speech-to-text byte
    const assessData = {
      assessMs,
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
    const speculative = this.takeSpeculative(timing?.speculativeId);
    // A streaming recognizer only covers this utterance, so it cannot stand in for audio merged from several. Merged audio goes to
    // the batch provider AT ONCE and, in parallel, to a fresh stream (Deepgram takes audio faster than real time). The stream got
    // the live 1.5 s window before, which is shorter than its connection time, so it never answered (calls 9da41342, 0710a7d4)
    // while Soniox batch alone took 6 to 8 s (call 114431fb turn 7: 7.86 s). Whichever answers first is used; the batch result is
    // the fallback, so a failed replay adds no waiting.
    const own = captures === 1 ? timing?.stream : undefined;
    const replay = !own && captures > 1 ? this.openReplayStream(pcm, format, signal, assessment.decision === 'ok') : undefined;
    const stream = own ?? replay;
    let streamOutcome: 'final' | 'fallback' | 'merged' | 'not-opened' | null = stream ? 'fallback' : null;
    // Why the stream's words were not used, in plain words, recorded on the turn (null when they were, or streaming is off).
    let streamReason: string | null = null;
    if (!stream && this.providers.sttStream) {
      if (captures > 1) {
        // A cancelled turn's audio was put back in front of this utterance: the stream only heard the second part.
        streamOutcome = 'merged';
        streamReason = 'audio from an interrupted turn was merged into this one; the stream had only heard the new part, so the whole audio was transcribed in one request';
      } else {
        streamOutcome = 'not-opened';
        streamReason = 'no stream was open for this utterance';
      }
    }
    this.trace(turnId, 'stt-submit', 'ok', {
      data: { seconds: Math.round(utteranceMs) / 1000, bytes: pcm.length, provider: this.providers.stt.name, ...(stream ? { streamProvider: this.providers.sttStream?.name ?? null } : {}), selectedProvider: this.providers.stt.name, speculative: speculative !== null, streaming: stream !== undefined, ...(replay ? { replayedMergedAudio: true } : {}) },
    });
    this.setPhase('transcribing');
    const sttStarted = performance.now();
    // The batch request started because the stream was slow to answer (see AI_STT_STREAM_HEDGE_MS). At most one per turn.
    let hedge: { promise: Promise<SttResult>; cancel: () => void } | null = null;
    try {
      let reused: { text: string; ms: number; doneAt: number } | null = null;
      if (speculative) {
        // The request was started during the caller's pause. It either already has the words or is nearly there.
        reused = await abortable(speculative.promise, signal);
        if (reused && !reused.text) reused = null;
      }
      let streamed: string | null = null;
      if (!reused && stream) {
        // FINAL text only, at the confirmed end of the utterance. Interim hypotheses are never used.
        this.totals.sttAudioSeconds += utteranceMs / 1000;
        // If the stream is slow, the batch request starts now rather than after the timeout; whichever is usable first is the
        // only one used, and the other is cancelled, so nothing is transcribed twice.
        const hedgeMs = this.config.sttStreaming.hedgeMs;
        if (replay) hedge = this.startHedge(pcm, format, signal); // merged audio: batch starts now, not after a timeout
        const hedgeTimer =
          !replay && hedgeMs > 0 && hedgeMs < this.config.sttStreaming.finalizeTimeoutMs
            ? setTimeout(() => {
                hedge = this.startHedge(pcm, format, signal);
              }, hedgeMs)
            : null;
        let result: SttResult | null;
        try {
          result = await abortable(stream.finalize(signal, replay ? REPLAY_FINALIZE_MS : undefined), signal);
        } finally {
          if (hedgeTimer) clearTimeout(hedgeTimer);
        }
        const how = stream.finalizeOutcome;
        const finalize = how ? `finalize ${how.how} after ${how.waitedMs} ms, ${how.finals} final segment(s)` : 'finalize';
        if (result) {
          const text = result.text.trim();
          // An empty answer for audio that looks like speech is not trusted: the batch provider decides, so speech the
          // streaming recognizer missed is not dropped. For audio that did not look like speech, empty is accepted.
          if (hasSpeechContent(text) || assessment.decision !== 'ok') {
            streamed = text;
            streamOutcome = 'final';
            sttFacts.confidence = typeof result.confidence === 'number' ? result.confidence : null;
          } else {
            streamReason = `the stream returned no words for audio that looks like speech (${finalize})`;
          }
        } else {
          streamReason = stream.error ? `the stream failed: ${stream.error.message} (${finalize})` : `no final text from the stream (${finalize})`;
        }
      }
      replay?.close(); // a replay stream belongs to this turn alone
      if (streamed !== null) (hedge as { cancel: () => void } | null)?.cancel();
      if (reused) {
        transcript = reused.text;
        metrics.sttMs = reused.ms;
        metrics.speculativeStt = true;
        metrics.sttMode = 'speculative';
        metrics.marks.sttDone = reused.doneAt;
        metrics.sttWaitedMs = Math.max(0, performance.now() - sttStarted);
      } else if (streamed !== null) {
        transcript = streamed;
        metrics.sttMode = 'stream';
        metrics.sttMs = performance.now() - sttStarted;
        metrics.sttWaitedMs = metrics.sttMs;
        metrics.marks.sttDone = performance.now();
      } else {
        // No stream, or it failed or timed out: the batch provider transcribes the whole utterance.
        const started = hedge as { promise: Promise<SttResult> } | null;
        if (!started) this.totals.sttAudioSeconds += utteranceMs / 1000;
        const batch = await (started ? started.promise : this.providers.stt.transcribe(pcm, format, signal));
        transcript = batch.text.trim();
        sttFacts.confidence = typeof batch.confidence === 'number' ? batch.confidence : null;
        metrics.sttMode = 'batch';
        metrics.sttMs = performance.now() - sttStarted;
        metrics.sttWaitedMs = metrics.sttMs;
        metrics.marks.sttDone = performance.now();
      }
    } catch (error) {
      (hedge as { cancel: () => void } | null)?.cancel();
      if (isAbort(error) || signal.aborted) {
        this.trace(turnId, 'stt-result', 'cancelled', { latencyMs: performance.now() - sttStarted, detail: 'cancelled before the transcript arrived' });
        notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'turn cancelled');
        // The words were never committed: keep the audio so the next stretch of speech is transcribed with it.
        this.requeueUncommitted(pcm, captures);
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
    // Facts about the final transcript for call-audio verification: a word count, the provider's confidence, and an in-memory
    // check for "I can't hear you". The text itself goes nowhere new.
    sttFacts.words = countWords(transcript);
    sttFacts.complaint = detectHearingComplaint(transcript);
    if (signal.aborted && (this.cancelSource === 'caller-speech' || this.cancelSource === 'endpoint-continuation')) {
      // The caller spoke again just as the words arrived and before they were committed: same as cancelled during
      // recognition, so the audio is transcribed together with what follows. (An operator or teardown cancel keeps
      // the words that already arrived, as before.)
      this.trace(turnId, 'stt-result', 'cancelled', { latencyMs: metrics.sttMs, detail: 'cancelled before the transcript was committed' });
      notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'turn cancelled');
      this.requeueUncommitted(pcm, captures);
      return outcome({ status: 'cancelled', reason: 'aborted-during-stt', assessment });
    }
    if (!hasSpeechContent(transcript)) {
      this.trace(turnId, 'stt-result', 'skipped', {
        latencyMs: metrics.sttMs,
        detail: 'provider returned no words',
        data: { streaming: streamOutcome ?? 'off', ...(streamReason ? { streamFallbackReason: streamReason } : {}) },
      });
      notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'empty transcript');
      return outcome({ status: 'skipped', reason: 'empty-transcript', assessment });
    }
    if (timing?.afterBargeIn && this.soundsLikeAgent(transcript)) {
      // The agent's own voice came back through the line and was taken for the caller: drop it, never answer it.
      this.trace(turnId, 'stt-result', 'skipped', { latencyMs: metrics.sttMs, detail: 'the words match what the agent had just said: its own voice, not the caller' });
      notRun(['llm-request', 'llm-response', 'tts-generated', 'playback'], 'echo of the agent');
      return outcome({ status: 'skipped', reason: 'echo', assessment });
    }
    // A campaign call: the caller clearly asking not to be called again is reported so the number is never called again.
    if (detectOptOut(transcript)) {
      this.optedOut = true;
      if (this.callContext) {
        this.trace(turnId, 'call', 'ok', { detail: 'The caller asked not to be called again' });
        this.emit({ type: 'opt-out', callId: this.callId });
      }
    }
    metrics.sttFallbackReason = streamOutcome === 'final' ? null : streamReason;
    // Kept in memory only, and only when the audio passed the voiced-content check; the operator-triggered test response answers it.
    if (assessment.decision === 'ok') this.latestTranscript = { text: transcript, at: Date.now(), turnId };
    this.trace(turnId, 'stt-result', 'ok', {
      latencyMs: metrics.sttMs,
      text: transcript,
      role: 'caller',
      // On the timeline itself, not only in the data: a stream that was not used says why, where the operator reads it.
      ...(streamReason && streamOutcome !== 'final' ? { detail: `Speech-to-text stream not used: ${streamReason}` } : {}),
      data: {
        chars: transcript.length,
        // Which provider was configured and which one actually supplied this transcript: the stream when its final text was used,
        // otherwise the selected (batch) provider. 'provider' on stt-submit is the selected one, never proof of who answered.
        selectedProvider: this.providers.stt.name,
        usedProvider: metrics.sttMode === 'stream' ? (this.providers.sttStream?.name ?? this.providers.stt.name) : this.providers.stt.name,
        speculative: metrics.speculativeStt,
        waitedMs: Math.round(metrics.sttWaitedMs ?? 0),
        streaming: streamOutcome ?? 'off',
        ...(streamReason && streamOutcome !== 'final' ? { streamFallbackReason: streamReason } : {}),
        ...(stream?.finalizeOutcome ? { streamFinalize: stream.finalizeOutcome.how, streamFinalizeMs: stream.finalizeOutcome.waitedMs } : {}),
        ...(stream ? { streamProvider: this.providers.sttStream?.name ?? null } : {}),
        ...(hedge ? { batchStartedEarly: true } : {}),
        // Numbers only: when the stream opened, how much audio it got, what the server answered and when (see SttStream).
        ...Object.fromEntries(Object.entries(stream?.finalizeOutcome?.diag ?? {}).map(([k, v]) => [`stream_${k}`, v])),
      },
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
    this.contact.noteCaller(transcript);
    this.setPhase('generating');

    // 3. LLM -> sentences -> TTS (in parallel with playback) -> sink.
    let filter = new ProtocolTextFilter();
    let splitter = new SentenceSplitter(24, cfg.limits.firstSentenceMinChars, cfg.limits.firstClauseMinChars);
    const queue = new AsyncQueue<{ text: string; audio?: Promise<Buffer>; stream?: TtsStreamHandle }>();
    const llmController = new AbortController();
    const llmSignal = AbortSignal.any([signal, llmController.signal]);
    // Synthesis requests stop with the turn: once nothing more will be played, no sentence keeps downloading.
    const ttsController = new AbortController();
    const ttsSignal = AbortSignal.any([signal, ttsController.signal]);
    const streaming = this.canStream();
    let endRequested = false;
    let replyChars = 0;
    let llmError: unknown = null;
    const llmEmpty: { detail: string | null } = { detail: null };
    let spokenText = '';
    let partialSpoken = '';
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
      this.recentAgentText = `${this.recentAgentText} ${cleaned.text}`.slice(-800);
      if (streaming) {
        metrics.ttsChars += cleaned.text.length;
        this.totals.ttsChars += cleaned.text.length;
        queue.push({ text: cleaned.text, stream: this.startTtsStream(turnId, cleaned.text, metrics, ttsSignal) });
        return;
      }
      const ttsStart = performance.now();
      const audio = this.providers.tts.synthesize(cleaned.text, format, ttsSignal).then((data) => {
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

    const built = await this.buildSystem(transcript);
    metrics.knowledgeHits = this.knowledge ? built.hits.length : null;
    if (signal.aborted) return outcome({ status: 'cancelled', reason: 'aborted', assessment });
    const producer = (async () => {
      this.trace(turnId, 'llm-request', 'ok', {
        data: { historyMessages: this.history.length, provider: this.providers.llm.name, knowledgeHits: built.hits.length, knowledgeSources: built.hits.map((h) => h.source).join(', '), callNotes: built.notes },
      });
      try {
        const llmStart = performance.now();
        metrics.tftAvailable = this.providers.llm.streaming !== false;
        // A reply with no text (on call 503ec8b2 a reasoning model used its whole token budget thinking) is never spoken and
        // never left hanging: it is asked for once more, and if that is empty too the turn fails with the reason.
        // Tool calls made during this reply, and the model's view of them. Within this turn only: the stored history keeps
        // just the words that were spoken.
        const toolSpecs = this.toolSpecs();
        const exchange: LlmMessage[] = [];
        let toolRounds = 0;
        for (let request = 1; request <= MAX_LLM_REQUESTS_FOR_EMPTY_REPLY; request++) {
          let finishReason: string | null = null;
          if (request > 1 || exchange.length > 0) {
            filter = new ProtocolTextFilter();
            splitter = new SentenceSplitter(24, cfg.limits.firstSentenceMinChars, cfg.limits.firstClauseMinChars);
          }
          const offerTools = toolSpecs.length > 0 && toolRounds < MAX_TOOL_ROUNDS;
          const calls: LlmToolCall[] = [];
          let roundText = '';
          for await (const chunk of this.providers.llm.stream(
            { system: built.system, messages: [...this.history.map((m) => ({ ...m })), ...exchange], ...(offerTools ? { tools: toolSpecs } : {}), ...(this.promptCacheKey ? { cacheKey: this.promptCacheKey } : {}) },
            llmSignal
          )) {
            if (chunk.usage) {
              metrics.usage = chunk.usage;
            }
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.toolCalls) calls.push(...chunk.toolCalls);
            if (chunk.delta) roundText += chunk.delta;
            if (!chunk.delta) continue;
            metrics.llmFirstTokenMs ??= performance.now() - llmStart;
            metrics.marks.llmFirst ??= performance.now();
            const safe = filter.feed(chunk.delta);
            if (safe) for (const sentence of splitter.push(safe)) enqueue(sentence);
            if (endRequested) break;
          }
          const tail = filter.finish();
          if (tail) for (const sentence of splitter.push(tail)) enqueue(sentence);
          for (const sentence of splitter.flush()) enqueue(sentence);
          if (calls.length > 0 && offerTools && this.tools && !endRequested && !llmSignal.aborted) {
            // The model asked for functions: run them (bounded, validated), give it the results, and let it answer in words.
            toolRounds++;
            const honoured = calls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
            exchange.push({ role: 'assistant', content: roundText, toolCalls: honoured });
            for (const call of honoured) {
              const run = await this.tools.registry.run(
                call,
                {
                  callId: this.callId,
                  mode: this.tools.mode,
                  campaignId: this.tools.campaignId,
                  contactId: this.tools.contactId,
                  contact: () => this.contact.snapshot,
                  optedOut: () => this.optedOut,
                  restriction: this.tools.restriction,
                },
                llmSignal
              );
              exchange.push({ role: 'tool', toolCallId: call.id, content: run.content });
              // The arguments hold personal details and are never logged; the tool, whether it worked and why not are.
              this.trace(turnId, 'call', run.ok ? 'ok' : 'failed', {
                latencyMs: run.durationMs,
                detail: `Tool ${call.name.slice(0, 40)}: ${run.ok ? 'ok' : (run.code ?? 'failed')}`,
                data: { tool: call.name.slice(0, 40), ok: run.ok, code: run.code, round: toolRounds },
              });
            }
            request--; // a tool round is not an empty reply: it does not use up the retry for one
            continue;
          }
          if (replyChars > 0 || endRequested || llmSignal.aborted) break;

          metrics.llmEmptyReplies++;
          const tokens = metrics.usage?.completionTokens ?? null;
          const why = finishReason === 'length' ? 'the token budget ran out before any reply text (usually hidden reasoning)' : `finish reason ${finishReason ?? 'not given'}`;
          const last = request === MAX_LLM_REQUESTS_FOR_EMPTY_REPLY;
          const detail = `The model returned no reply text (${why}; ${tokens ?? '?'} completion tokens)${last ? '. Nothing was spoken.' : '. Asking once more.'}`;
          this.trace(turnId, 'llm-response', 'failed', { detail, data: { emptyReply: true, request, finishReason, completionTokens: tokens } });
          if (last) llmEmpty.detail = detail;
        }
        metrics.llmTotalMs = performance.now() - llmStart;
        metrics.marks.llmDone = performance.now();
        if (llmEmpty.detail === null) this.trace(turnId, 'llm-response', 'ok', {
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
        if (item.stream) {
          const handle = item.stream;
          const t0 = performance.now();
          let played: PlayResult;
          try {
            played = await this.sink.playStream!(handle.chunks, signal, {
              onFirstWrite: () => {
                metrics.firstAudioMs ??= performance.now() - started;
          metrics.marks.firstWrite ??= performance.now();
                this.beginSpeaking();
              },
            });
          } catch (error) {
            if (isAbort(error) || signal.aborted) {
              playbackStopped = 'aborted';
            } else if (error === handle.error()) {
              ttsFailed = true;
              this.reportError('tts', error);
              this.trace(turnId, 'tts-generated', 'failed', { detail: error instanceof Error ? error.message : 'text-to-speech failed' });
            } else {
              this.reportError('sink', error);
              this.trace(turnId, 'playback', 'failed', { detail: error instanceof Error ? error.message : 'playback failed' });
              playbackStopped = 'sink-error';
            }
            return;
          }
          metrics.playMs += performance.now() - t0;
          notePlayback(metrics, played);
          const lost = played.stoppedBy === 'not-written';
          if (lost) this.reportError('sink', new Error(NOT_WRITTEN_MESSAGE));
          this.trace(turnId, 'playback', played.completed ? 'ok' : lost ? 'failed' : 'cancelled', {
            latencyMs: performance.now() - t0,
            detail: playbackDetail(played),
            data: { bytesWritten: played.bytesWritten, bytes: played.bytesWritten, lateFrames: played.lateFrames ?? 0, maxLateMs: played.maxLateMs ?? 0, streamed: true },
          });
          if (!played.completed) {
            // The caller cut this sentence off: history keeps the words that were actually spoken, marked as unfinished.
            if (played.stoppedBy === 'aborted') partialSpoken = this.spokenPrefix(item.text, played.bytesWritten, handle.completed() ? handle.received() : null);
            playbackStopped = lost ? 'sink-error' : (played.stoppedBy ?? 'stopped');
            return;
          }
          this.learnSpeechRate(item.text, handle.received());
          spokenText += (spokenText ? ' ' : '') + item.text;
          continue;
        }
        let audio: Buffer;
        try {
          audio = await item.audio!;
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
          metrics.marks.firstWrite ??= performance.now();
          this.beginSpeaking();
          const played = await this.sink.play(audio, signal);
          metrics.playMs += performance.now() - t;
          notePlayback(metrics, played);
          const lost = played.stoppedBy === 'not-written';
          if (lost) this.reportError('sink', new Error(NOT_WRITTEN_MESSAGE));
          this.trace(turnId, 'playback', played.completed ? 'ok' : lost ? 'failed' : 'cancelled', {
            latencyMs: performance.now() - t,
            detail: playbackDetail(played),
            data: { bytesWritten: played.bytesWritten, bytes: audio.length, lateFrames: played.lateFrames ?? 0, maxLateMs: played.maxLateMs ?? 0 },
          });
          if (!played.completed) {
            if (played.stoppedBy === 'aborted') partialSpoken = this.spokenPrefix(item.text, played.bytesWritten, audio.length);
            // A port that stopped accepting bytes mid-reply is a failure of the line, not a caller interruption.
            playbackStopped = lost ? 'sink-error' : (played.stoppedBy ?? 'stopped');
            return;
          }
          this.learnSpeechRate(item.text, audio.length);
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
    ttsController.abort(); // nothing more will be played: stop any sentence still being downloaded
    if (playbackStopped !== null || ttsFailed) llmController.abort(); // stop generating text nobody will hear
    await producer;

    if (metrics.usage) {
      this.totals.llmPromptTokens += metrics.usage.promptTokens;
      this.totals.llmCompletionTokens += metrics.usage.completionTokens;
    }
    // What goes into history is what was actually spoken: whole sentences played to the end, plus the words of an
    // interrupted sentence that went out before the interruption, marked with an ellipsis. Sentences that were never
    // played are not there, and the reply is ONE assistant message, never one per sentence.
    const said = [spokenText, partialSpoken ? `${partialSpoken}…` : ''].filter(Boolean).join(' ');
    if (said) {
      this.pushHistory({ role: 'assistant', content: said });
      this.contact.noteAgent(spokenText);
    }

    const common = {
      assessment,
      transcriptChars: transcript.length,
      replyChars: spokenText.length,
      transcript: cfg.logTranscripts ? transcript : undefined,
      reply: cfg.logTranscripts ? spokenText : undefined,
    };

    if (signal.aborted) return outcome({ status: 'cancelled', reason: 'interrupted', ...common });
    if (llmEmpty.detail !== null && !spokenText && !llmError) {
      this.reportError('llm', new Error(llmEmpty.detail));
      return outcome({ status: 'failed', reason: 'llm-empty', ...common }, true);
    }
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
