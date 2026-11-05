import fs from 'node:fs';
import path from 'node:path';
import { AudioFrame, CallSession, CallStateChangeEvent, IAudioAdapter } from '@sim-gateway/shared';
import { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import { RecordingConfig } from './config.js';
import { Mixdown, MixResult, toDbfs } from './mixdown.js';
import { WavFileWriter } from './wav.js';

const RECORDING_KIND = 'complete-call-recording';
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A chunk that starts later than this after the previous one ended is a real gap and is filled with silence. */
const GAP_MS = 60;
const HEADER_REFRESH_MS = 5000;

/** The one file a call is played from. */
export const COMBINED_FILE = 'recording.wav';
/** What is written while the call runs: the two sides, each on the call's own timeline. They are removed once the combined file exists. */
const WORK_CALLER = 'caller.work.wav';
const WORK_AGENT = 'agent.work.wav';
/** Recordings made before the combined format kept the two sides as these files; they are mixed into the combined file when first asked for. */
const LEGACY_CALLER = 'caller.wav';
const LEGACY_AGENT = 'agent.wav';
const PARTIAL = `${COMBINED_FILE}.partial`;

export interface RecordingMix {
  /** The one gain applied to the caller's side, and what it was measured from. */
  callerGainDb: number;
  callerVoicedFrames: number;
  /** Level of the caller's speech and of the agent's, before the gain (the 90th percentile of speech frames), in dBFS. */
  callerSpeechDbfs: number | null;
  agentSpeechDbfs: number | null;
  callerPeak: number;
  agentPeak: number;
  /** Samples the sum had to clamp because both sides were loud at once. */
  clippedSamples: number;
}

/** What older recordings (two files per call) said about each side. */
export interface LegacyTrackMeta {
  file: string;
  bytes: number;
  durationMs: number;
  hasAudio: boolean;
}

export interface RecordingMeta {
  kind: typeof RECORDING_KIND;
  callId: string;
  direction: string;
  startedAt: string;
  endedAt: string | null;
  /** True once the combined file was written with an exact header and nothing went wrong. False while recording or finishing, or after an unclean stop. */
  complete: boolean;
  outcome: string | null;
  sampleRate: number;
  /** The rate is the configured gateway rate, not something the module reported for this call. */
  sampleRateSource: 'configured';
  channels: 1;
  bitsPerSample: 16;
  format: 'wav-pcm-s16le';
  isSimulated: boolean;
  consentAcknowledged: boolean;
  truncated: boolean;
  /** The combined recording, once it exists (null while the call is being recorded or the file is being finished). */
  file: string | null;
  bytes: number;
  durationMs: number;
  /** Whether ANY audio was received from the modem / written to it. Not a claim that anyone spoke. */
  hasCallerAudio: boolean;
  hasAgentAudio: boolean;
  mix: RecordingMix | null;
  note: string;
  error?: string;
  /** Present only on recordings made before the combined format. */
  tracks?: { caller: LegacyTrackMeta; agent: LegacyTrackMeta };
}

/** A recording as listed: its metadata plus whether it can be played right now. */
export interface ListedRecording extends RecordingMeta {
  available: boolean;
}

export interface RecorderStatus {
  enabled: boolean;
  consentAcknowledged: boolean;
  /** Why nothing will be recorded, or null when recording is armed. */
  inactiveReason: string | null;
  dir: string;
  active: { callId: string; startedAt: string; callerBytes: number; agentBytes: number } | null;
  lastError: string | null;
  retentionDays: number;
}

/** One direction of the call: fills real-time gaps with silence so the file's length matches the call. */
class Track {
  samples = 0;
  private carry: Buffer | null = null;
  truncated = false;

  constructor(
    readonly writer: WavFileWriter,
    private readonly rate: number,
    private readonly maxSamples: number
  ) {}

  /** `arrivalMs` is when the chunk arrived (inbound) or was written (outbound), relative to the start of the call. */
  add(chunk: Buffer, arrivalMs: number, arrivedAtEnd: boolean): void {
    let pcm = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = null;
    if (pcm.length % 2 === 1) {
      this.carry = pcm.subarray(pcm.length - 1);
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (pcm.length === 0) return;
    const chunkSamples = pcm.length / 2;
    const startExpected = Math.round((arrivalMs * this.rate) / 1000) - (arrivedAtEnd ? chunkSamples : 0);
    const gap = startExpected - this.samples;
    if (gap > (GAP_MS * this.rate) / 1000) this.pad(gap);
    if (this.samples >= this.maxSamples) {
      this.truncated = true;
      return;
    }
    const room = this.maxSamples - this.samples;
    if (chunkSamples > room) {
      pcm = pcm.subarray(0, room * 2);
      this.truncated = true;
    }
    this.writer.append(pcm);
    this.samples += pcm.length / 2;
  }

  /** Bring the track up to `toMs` with silence (used when the call ends so both tracks span the whole call). */
  padTo(toMs: number): void {
    const gap = Math.round((toMs * this.rate) / 1000) - this.samples;
    if (gap > 0) this.pad(gap);
  }

  private pad(samples: number): void {
    const room = this.maxSamples - this.samples;
    let left = Math.max(0, Math.min(samples, room));
    if (samples > room) this.truncated = true;
    while (left > 0) {
      const n = Math.min(left, this.rate); // at most one second per buffer
      this.writer.append(Buffer.alloc(n * 2));
      this.samples += n;
      left -= n;
    }
  }
}

interface ActiveRecording {
  callId: string;
  startedAtMs: number;
  meta: RecordingMeta;
  caller: Track;
  agent: Track;
  callerReceived: boolean;
  agentReceived: boolean;
  timer: NodeJS.Timeout;
  failed: boolean;
}

/** The mixdown of one call, running in steps between other work. */
interface MixJob {
  callId: string;
  meta: RecordingMeta;
  mixer: Mixdown;
  /** Delete the two input files once the combined one exists (the working files; never the old recordings' files). */
  deleteInputs: string[];
  /** Nothing went wrong: the combined file may be marked complete. */
  clean: boolean;
  completed: boolean;
  done: Promise<void>;
}

export interface CallRecorderDeps {
  audio: IAudioAdapter;
  eventBus: GatewayEventBus;
  config: RecordingConfig;
  /** The PCM rate of the audio path (16-bit mono). */
  sampleRate: () => number;
  now?: () => number;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Complete-call recording: ONE mono WAV per call with what the caller sent and what the gateway wrote back, on one timeline.
 * This is NOT the diagnostic capture feature (bounded raw captures under AUDIO_DUMP_DIRECTORY).
 *
 * While the call runs the two sides are kept apart, each filled with silence wherever nothing arrived (so both span the whole call);
 * when the call ends they are mixed into `recording.wav` (see mixdown.ts for exactly what the mix does) and the working files are
 * removed. If the gateway stops mid-call, or before the mix finished, the working files are mixed the next time it starts.
 *
 * "Agent" is what was written to the audio port. A successful write does not prove the caller heard it, and the agent's audio is
 * placed where it was WRITTEN, which is up to the audio sink's write-ahead (150 ms) earlier than it plays.
 * Off by default, and it also needs CALL_RECORDING_CONSENT_ACKNOWLEDGED=true.
 */
export class CallRecorder {
  private readonly logger = createLogger('CallRecorder');
  private active: ActiveRecording | null = null;
  private started = false;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly jobs = new Set<MixJob>();
  /** Old two-file recordings being turned into a combined file, so two requests for the same call share one mix. */
  private readonly legacy = new Map<string, Promise<string | null>>();

  private readonly onFrame = (frame: AudioFrame) => this.handleInbound(frame);
  private readonly onOut = (chunk: Buffer) => this.handleOutbound(chunk);
  private readonly onState = (event: CallStateChangeEvent) => {
    if (event.currentState === 'ACTIVE') this.begin(event.session);
  };
  private readonly onEnded = (session: CallSession) => this.finish(session.id, session);

  constructor(private readonly deps: CallRecorderDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get inactiveReason(): string | null {
    const { config } = this.deps;
    if (!config.enabled) return 'call recording is off (CALL_RECORDING_ENABLED)';
    if (!config.consentAcknowledged) return 'recording is enabled but CALL_RECORDING_CONSENT_ACKNOWLEDGED is not true, so nothing is recorded';
    if (config.errors.length > 0) return `recording configuration is invalid: ${config.errors[0]}`;
    return null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { config } = this.deps;
    if (config.enabled && this.inactiveReason) this.logger.warn(`Call recording is NOT active: ${this.inactiveReason}`);
    if (this.inactiveReason) return;
    this.logger.info(`Call recording armed; recordings are saved under ${path.resolve(config.dir)}`);
    this.deps.eventBus.on('call:state_changed', this.onState);
    this.deps.eventBus.on('call:ended', this.onEnded);
    this.deps.audio.on('audio_frame', this.onFrame);
    this.deps.audio.on('audio_out', this.onOut);
    this.recoverUnfinished();
    this.purgeExpired();
  }

  /** Finalize anything in progress, including mixes still running. Safe to call more than once; used at shutdown. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.eventBus.off('call:state_changed', this.onState);
    this.deps.eventBus.off('call:ended', this.onEnded);
    this.deps.audio.off('audio_frame', this.onFrame);
    this.deps.audio.off('audio_out', this.onOut);
    if (this.active) this.finish(this.active.callId, null, 'The gateway stopped while the call was being recorded');
    // Shutdown is the one place the mix is finished in a single go: nothing will be around to finish it afterwards.
    for (const job of [...this.jobs]) {
      if (job.completed) continue;
      try {
        job.mixer.runToEnd();
        this.complete(job);
      } catch (error) {
        this.failJob(job, error as Error);
      }
    }
  }

  /** Resolves when no mix is running. For shutdown, tests, and anything that must see the finished file. */
  async whenIdle(): Promise<void> {
    while (this.jobs.size > 0 || this.legacy.size > 0) {
      await Promise.all([...[...this.jobs].map((j) => j.done), ...this.legacy.values()].map((p) => p.catch(() => undefined)));
    }
  }

  getStatus(): RecorderStatus {
    const a = this.active;
    return {
      enabled: this.deps.config.enabled,
      consentAcknowledged: this.deps.config.consentAcknowledged,
      inactiveReason: this.inactiveReason,
      dir: this.deps.config.dir,
      active: a
        ? { callId: a.callId, startedAt: a.meta.startedAt, callerBytes: a.caller.writer.dataBytes, agentBytes: a.agent.writer.dataBytes }
        : null,
      lastError: this.lastError,
      retentionDays: this.deps.config.retentionDays,
    };
  }

  list(limit = 200): ListedRecording[] {
    const out: ListedRecording[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.config.dir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!CALL_ID.test(name)) continue;
      const meta = this.readMeta(name);
      if (meta) out.push({ ...meta, available: this.isAvailable(meta) });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  /** One call's recording, or null when there is none (or the id is not a call id). */
  get(callId: string): ListedRecording | null {
    if (!CALL_ID.test(callId)) return null;
    const meta = this.readMeta(callId);
    return meta ? { ...meta, available: this.isAvailable(meta) } : null;
  }

  /** The absolute path of a call's combined recording if it exists now, only for a valid call id. */
  combinedFile(callId: string): string | null {
    if (!CALL_ID.test(callId)) return null;
    const file = path.join(this.callDir(callId), COMBINED_FILE);
    return fs.existsSync(file) ? file : null;
  }

  /**
   * The combined recording of a call, for playback. A call recorded before the combined format has two files; they are mixed into the
   * combined one the first time it is asked for (the old files are left as they are). Null when the call has no recording, is still
   * being recorded, or the combined file cannot be made.
   */
  async ensureCombined(callId: string): Promise<string | null> {
    if (!CALL_ID.test(callId)) return null;
    const ready = this.combinedFile(callId);
    if (ready) return ready;
    const meta = this.readMeta(callId);
    if (!meta) return null;
    const running = [...this.jobs].find((j) => j.callId === callId);
    if (running) {
      await running.done.catch(() => undefined);
      return this.combinedFile(callId);
    }
    if (this.active?.callId === callId) return null;
    const dir = this.callDir(callId);
    const caller = path.join(dir, LEGACY_CALLER);
    const agent = path.join(dir, LEGACY_AGENT);
    if (!fs.existsSync(caller) && !fs.existsSync(agent)) return null;
    let pending = this.legacy.get(callId);
    if (!pending) {
      pending = (async () => {
        try {
          const job = this.startMix({ meta, callerPath: fs.existsSync(caller) ? caller : null, agentPath: fs.existsSync(agent) ? agent : null, clean: meta.complete, deleteInputs: [] });
          await job.done;
        } finally {
          this.legacy.delete(callId);
        }
        return this.combinedFile(callId);
      })();
      this.legacy.set(callId, pending);
    }
    return pending;
  }

  // ---- recording ----------------------------------------------------------------------------------

  private callDir(callId: string): string {
    return path.join(path.resolve(this.deps.config.dir), callId);
  }

  private begin(session: CallSession): void {
    if (this.inactiveReason) return;
    if (this.active) {
      if (this.active.callId === session.id) return; // a repeated ACTIVE event: one recording per call
      this.finish(this.active.callId, null, 'A new call started before this one was closed');
    }
    const rate = this.deps.sampleRate();
    const dir = this.callDir(session.id);
    try {
      const callerWriter = new WavFileWriter(path.join(dir, WORK_CALLER), rate);
      const agentWriter = new WavFileWriter(path.join(dir, WORK_AGENT), rate);
      callerWriter.open();
      agentWriter.open();
      const max = this.deps.config.maxSeconds * rate;
      const meta: RecordingMeta = {
        kind: RECORDING_KIND,
        callId: session.id,
        direction: session.direction,
        startedAt: new Date(this.now()).toISOString(),
        endedAt: null,
        complete: false,
        outcome: null,
        sampleRate: rate,
        sampleRateSource: 'configured',
        channels: 1,
        bitsPerSample: 16,
        format: 'wav-pcm-s16le',
        isSimulated: session.isSimulated,
        consentAcknowledged: this.deps.config.consentAcknowledged,
        truncated: false,
        file: null,
        bytes: 0,
        durationMs: 0,
        hasCallerAudio: false,
        hasAgentAudio: false,
        mix: null,
        note: 'Complete-call recording, still in progress. The combined WAV is written when the call ends.',
      };
      this.writeMeta(meta);
      const rec: ActiveRecording = {
        callId: session.id,
        startedAtMs: this.now(),
        meta,
        caller: new Track(callerWriter, rate, max),
        agent: new Track(agentWriter, rate, max),
        callerReceived: false,
        agentReceived: false,
        failed: false,
        timer: setInterval(() => this.refresh(), HEADER_REFRESH_MS),
      };
      rec.timer.unref?.();
      this.active = rec;
      this.logger.info(`Recording call ${session.id} (${rate} Hz, 16-bit mono)`);
    } catch (error) {
      this.fail(`Could not start recording call ${session.id}: ${(error as Error).message}`);
    }
  }

  private handleInbound(frame: AudioFrame): void {
    const a = this.active;
    if (!a || a.failed) return;
    try {
      a.callerReceived = true;
      a.caller.add(frame.data, this.now() - a.startedAtMs, true);
    } catch (error) {
      this.failActive(a, error as Error);
    }
  }

  private handleOutbound(chunk: Buffer): void {
    const a = this.active;
    if (!a || a.failed) return;
    try {
      a.agentReceived = true;
      a.agent.add(chunk, this.now() - a.startedAtMs, false);
    } catch (error) {
      this.failActive(a, error as Error);
    }
  }

  private refresh(): void {
    const a = this.active;
    if (!a || a.failed) return;
    try {
      a.caller.writer.refreshHeader();
      a.agent.writer.refreshHeader();
    } catch (error) {
      this.failActive(a, error as Error);
    }
  }

  private finish(callId: string, session: CallSession | null, error?: string): void {
    const a = this.active;
    if (!a || a.callId !== callId) return;
    this.active = null;
    clearInterval(a.timer);
    const elapsed = this.now() - a.startedAtMs;
    try {
      // Both sides span the whole call, so the mix is exactly as long as the call.
      a.caller.padTo(elapsed);
      a.agent.padTo(elapsed);
    } catch {
      // padding is best effort
    }
    for (const [name, track] of [
      ['caller', a.caller],
      ['agent', a.agent],
    ] as const) {
      try {
        track.writer.close();
      } catch (e) {
        a.meta.error = `${name}: ${(e as Error).message}`;
        this.lastError = a.meta.error;
      }
    }
    a.meta.endedAt = new Date(this.now()).toISOString();
    a.meta.outcome = session?.outcome ?? null;
    a.meta.truncated = a.caller.truncated || a.agent.truncated;
    a.meta.hasCallerAudio = a.callerReceived;
    a.meta.hasAgentAudio = a.agentReceived;
    a.meta.note = 'Complete-call recording, being finished: the combined WAV is written from the two sides.';
    const clean = !a.failed && !error && !a.meta.error;
    if (error) a.meta.error = error;
    try {
      this.writeMeta(a.meta);
    } catch (e) {
      this.fail(`Could not write the recording metadata for ${callId}: ${(e as Error).message}`);
    }
    const dir = this.callDir(callId);
    this.startMix({ meta: a.meta, callerPath: path.join(dir, WORK_CALLER), agentPath: path.join(dir, WORK_AGENT), clean, deleteInputs: [path.join(dir, WORK_CALLER), path.join(dir, WORK_AGENT)] });
  }

  // ---- the mixdown --------------------------------------------------------------------------------

  private startMix(input: { meta: RecordingMeta; callerPath: string | null; agentPath: string | null; clean: boolean; deleteInputs: string[] }): MixJob {
    const dir = this.callDir(input.meta.callId);
    const mixer = new Mixdown({ callerPath: input.callerPath, agentPath: input.agentPath, outPath: path.join(dir, PARTIAL), sampleRate: input.meta.sampleRate });
    const job: MixJob = { callId: input.meta.callId, meta: input.meta, mixer, deleteInputs: input.deleteInputs, clean: input.clean, completed: false, done: Promise.resolve() };
    this.jobs.add(job);
    job.done = this.drive(job);
    return job;
  }

  /** One block per turn of the event loop, so a long call's mix never holds the gateway up (and the audio path with it). */
  private async drive(job: MixJob): Promise<void> {
    try {
      while (!job.completed && !job.mixer.step()) await yieldToLoop();
      this.complete(job);
    } catch (error) {
      this.failJob(job, error as Error);
    }
  }

  private complete(job: MixJob): void {
    if (job.completed) return;
    job.completed = true;
    this.jobs.delete(job);
    const { meta } = job;
    const dir = this.callDir(meta.callId);
    const result = job.mixer.finished();
    const final = path.join(dir, COMBINED_FILE);
    try {
      fs.renameSync(path.join(dir, PARTIAL), final);
      meta.file = COMBINED_FILE;
      meta.bytes = fs.statSync(final).size;
      meta.durationMs = Math.round((result.samples / meta.sampleRate) * 1000);
      meta.mix = describeMix(result);
      meta.complete = job.clean && !meta.error;
      meta.hasCallerAudio = meta.hasCallerAudio || (meta.tracks?.caller.hasAudio ?? false);
      meta.hasAgentAudio = meta.hasAgentAudio || (meta.tracks?.agent.hasAudio ?? false);
      meta.note = noteFor(meta);
      this.writeMeta(meta);
      for (const file of job.deleteInputs) fs.rmSync(file, { force: true });
      this.logger.info(
        `Recording of call ${meta.callId} finished (complete=${meta.complete}, ${meta.durationMs} ms, caller gain ${result.callerGainDb} dB${result.clippedSamples ? `, ${result.clippedSamples} clipped samples` : ''})`
      );
    } catch (error) {
      this.failJob(job, error as Error, true);
      return;
    }
    this.purgeExpired();
  }

  /** The combined file could not be made. The two working files are kept, and the next start tries again. */
  private failJob(job: MixJob, error: Error, alreadyCompleted = false): void {
    if (job.completed && !alreadyCompleted) return;
    job.completed = true;
    this.jobs.delete(job);
    job.mixer.abort();
    const dir = this.callDir(job.meta.callId);
    fs.rmSync(path.join(dir, PARTIAL), { force: true });
    job.meta.complete = false;
    job.meta.error = `Could not build the combined recording: ${error.message}`;
    try {
      this.writeMeta(job.meta);
    } catch {
      // the error is reported below either way
    }
    this.fail(`Recording of call ${job.meta.callId} could not be finished: ${error.message}`);
  }

  /**
   * Working files left by a stop that was not clean (a crash, or the process killed mid-call, or mid-mix) are mixed into the combined
   * file now. A call that was still recording is marked incomplete and says why; one that had finished but not been mixed is complete.
   */
  private recoverUnfinished(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.config.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!CALL_ID.test(name) || this.active?.callId === name || [...this.jobs].some((j) => j.callId === name)) continue;
      const meta = this.readMeta(name);
      if (!meta || meta.file) continue;
      const dir = this.callDir(name);
      const caller = path.join(dir, WORK_CALLER);
      const agent = path.join(dir, WORK_AGENT);
      const haveCaller = fs.existsSync(caller);
      const haveAgent = fs.existsSync(agent);
      if (!haveCaller && !haveAgent) continue;
      try {
        if (!meta.endedAt) {
          const last = Math.max(...[caller, agent].filter((f) => fs.existsSync(f)).map((f) => fs.statSync(f).mtimeMs));
          meta.endedAt = new Date(last).toISOString();
          meta.error = 'The gateway stopped while the call was being recorded';
        }
        this.logger.warn(`Recovering the recording of call ${name}: it was not finished when the gateway last stopped`);
        this.startMix({ meta, callerPath: haveCaller ? caller : null, agentPath: haveAgent ? agent : null, clean: !meta.error, deleteInputs: [caller, agent] });
      } catch (error) {
        this.fail(`Could not recover the recording of call ${name}: ${(error as Error).message}`);
      }
    }
  }

  private failActive(a: ActiveRecording, error: Error): void {
    a.failed = true;
    a.meta.error = error.message;
    this.fail(`Recording of call ${a.callId} failed: ${error.message}`);
  }

  private fail(message: string): void {
    this.lastError = message;
    this.logger.error(message);
  }

  // ---- files --------------------------------------------------------------------------------------

  private metaPath(callId: string): string {
    return path.join(this.callDir(callId), 'recording.json');
  }

  private writeMeta(meta: RecordingMeta): void {
    const file = this.metaPath(meta.callId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
  }

  private readMeta(callId: string): RecordingMeta | null {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath(callId), 'utf8')) as RecordingMeta;
      if (meta.kind !== RECORDING_KIND || meta.callId !== callId) return null;
      return normalize(meta);
    } catch {
      return null;
    }
  }

  /** Can this recording be played now? The combined file exists, or it is an older recording whose two files can be mixed on request. */
  private isAvailable(meta: RecordingMeta): boolean {
    const dir = this.callDir(meta.callId);
    if (fs.existsSync(path.join(dir, COMBINED_FILE))) return true;
    if (this.active?.callId === meta.callId || [...this.jobs].some((j) => j.callId === meta.callId)) return false;
    return fs.existsSync(path.join(dir, LEGACY_CALLER)) || fs.existsSync(path.join(dir, LEGACY_AGENT));
  }

  /** Deletes only finished recordings this feature made, and only when a retention period was configured. */
  private purgeExpired(): void {
    const days = this.deps.config.retentionDays;
    if (days <= 0) return;
    const cutoff = this.now() - days * 86_400_000;
    for (const meta of this.list(100000)) {
      if (!meta.complete || !meta.endedAt || Date.parse(meta.endedAt) >= cutoff) continue;
      try {
        fs.rmSync(this.callDir(meta.callId), { recursive: true, force: true });
        this.logger.info(`Deleted recording ${meta.callId}: older than the ${days}-day retention period`);
      } catch (error) {
        this.fail(`Could not delete expired recording ${meta.callId}: ${(error as Error).message}`);
      }
    }
  }
}

function describeMix(r: MixResult): RecordingMix {
  return {
    callerGainDb: r.callerGainDb,
    callerVoicedFrames: r.caller.voicedFrames,
    callerSpeechDbfs: toDbfs(r.caller.p90Rms),
    agentSpeechDbfs: toDbfs(r.agent.p90Rms),
    callerPeak: r.caller.peak,
    agentPeak: r.agent.peak,
    clippedSamples: r.clippedSamples,
  };
}

/** One sentence that says what the file is, without claiming more than it proves. */
function noteFor(meta: RecordingMeta): string {
  const parts = ['One mono WAV: what the caller sent (from the modem) and what was written to the modem, on one timeline.'];
  if (meta.mix && meta.mix.callerGainDb > 0) {
    parts.push(`The caller's side was raised by ${meta.mix.callerGainDb} dB in the mix (the modem delivers it quieter than the agent's voice); nothing else was changed.`);
  }
  if (!meta.hasCallerAudio) parts.push('No audio was received from the modem for this call.');
  if (!meta.hasAgentAudio) parts.push('Nothing was written to the caller.');
  parts.push('A successful write does not prove the caller heard it.');
  return parts.join(' ');
}

/** Older recordings (two files per call) have no combined-file fields: fill them in from what they did record. */
function normalize(meta: RecordingMeta): RecordingMeta {
  const out = { ...meta };
  out.file ??= null;
  out.mix ??= null;
  if (out.tracks) {
    out.durationMs ??= Math.max(out.tracks.caller.durationMs, out.tracks.agent.durationMs);
    out.bytes ??= 0;
    out.hasCallerAudio ??= out.tracks.caller.hasAudio;
    out.hasAgentAudio ??= out.tracks.agent.hasAudio;
  } else {
    out.durationMs ??= 0;
    out.bytes ??= 0;
    out.hasCallerAudio ??= false;
    out.hasAgentAudio ??= false;
  }
  return out;
}
