import fs from 'node:fs';
import path from 'node:path';
import { AudioFrame, CallSession, CallStateChangeEvent, IAudioAdapter } from '@sim-gateway/shared';
import { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import { RecordingConfig } from './config.js';
import { WavFileWriter } from './wav.js';

const RECORDING_KIND = 'complete-call-recording';
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A chunk that starts later than this after the previous one ended is a real gap and is filled with silence. */
const GAP_MS = 60;
const HEADER_REFRESH_MS = 5000;

export type RecordingTrackName = 'caller' | 'agent';

export interface RecordingTrackMeta {
  file: string;
  bytes: number;
  durationMs: number;
  /** False when nothing was ever received for this track (the file is then an empty, valid WAV). */
  hasAudio: boolean;
}

export interface RecordingMeta {
  kind: typeof RECORDING_KIND;
  callId: string;
  direction: string;
  startedAt: string;
  endedAt: string | null;
  /** True once the files were closed with exact headers. False while recording, or after an unclean stop. */
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
  tracks: Record<RecordingTrackName, RecordingTrackMeta>;
  note: string;
  error?: string;
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

export interface CallRecorderDeps {
  audio: IAudioAdapter;
  eventBus: GatewayEventBus;
  config: RecordingConfig;
  /** The PCM rate of the audio path (16-bit mono). */
  sampleRate: () => number;
  now?: () => number;
}

/**
 * Complete-call recording: the audio the caller sent and the audio the gateway wrote back, as two playable mono
 * WAV files per call. This is NOT the diagnostic capture feature (bounded raw captures under AUDIO_DUMP_DIRECTORY).
 *
 * "Agent" is what was written to the audio port. A successful write does not prove the caller heard it.
 * Off by default, and it also needs CALL_RECORDING_CONSENT_ACKNOWLEDGED=true.
 */
export class CallRecorder {
  private readonly logger = createLogger('CallRecorder');
  private active: ActiveRecording | null = null;
  private started = false;
  private lastError: string | null = null;
  private readonly now: () => number;

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
    this.purgeExpired();
  }

  /** Finalize anything in progress. Safe to call more than once; used at shutdown. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.eventBus.off('call:state_changed', this.onState);
    this.deps.eventBus.off('call:ended', this.onEnded);
    this.deps.audio.off('audio_frame', this.onFrame);
    this.deps.audio.off('audio_out', this.onOut);
    if (this.active) this.finish(this.active.callId, null, 'The gateway stopped while the call was being recorded');
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

  list(limit = 200): RecordingMeta[] {
    const out: RecordingMeta[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.config.dir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!CALL_ID.test(name)) continue;
      const meta = this.readMeta(name);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  /** The absolute path of one track, only for a call id and track name that are valid and exist. */
  trackFile(callId: string, track: string): string | null {
    if (!CALL_ID.test(callId) || (track !== 'caller' && track !== 'agent')) return null;
    const meta = this.readMeta(callId);
    if (!meta) return null;
    const file = path.join(path.resolve(this.deps.config.dir), callId, meta.tracks[track].file);
    return fs.existsSync(file) ? file : null;
  }

  // ---- recording ----------------------------------------------------------------------------------

  private begin(session: CallSession): void {
    if (this.inactiveReason) return;
    if (this.active) {
      if (this.active.callId === session.id) return; // a repeated ACTIVE event: one recording per call
      this.finish(this.active.callId, null, 'A new call started before this one was closed');
    }
    const rate = this.deps.sampleRate();
    const dir = path.join(path.resolve(this.deps.config.dir), session.id);
    try {
      const callerWriter = new WavFileWriter(path.join(dir, 'caller.wav'), rate);
      const agentWriter = new WavFileWriter(path.join(dir, 'agent.wav'), rate);
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
        tracks: {
          caller: { file: 'caller.wav', bytes: 0, durationMs: 0, hasAudio: false },
          agent: { file: 'agent.wav', bytes: 0, durationMs: 0, hasAudio: false },
        },
        note: 'Complete-call recording. "caller" is audio received from the modem; "agent" is audio written to the modem (a successful write does not prove the caller heard it). The sample rate is the configured gateway rate.',
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
      // Both tracks span the whole call, so they can be played together from the same start.
      a.caller.padTo(elapsed);
      a.agent.padTo(elapsed);
    } catch {
      // padding is best effort
    }
    for (const [name, track, received] of [
      ['caller', a.caller, a.callerReceived],
      ['agent', a.agent, a.agentReceived],
    ] as const) {
      try {
        track.writer.close();
      } catch (e) {
        a.meta.error = `${name}: ${(e as Error).message}`;
        this.lastError = a.meta.error;
      }
      const t = a.meta.tracks[name];
      t.bytes = track.writer.dataBytes;
      t.durationMs = Math.round((track.samples / a.meta.sampleRate) * 1000);
      t.hasAudio = received;
    }
    a.meta.endedAt = new Date(this.now()).toISOString();
    a.meta.outcome = session?.outcome ?? null;
    a.meta.truncated = a.caller.truncated || a.agent.truncated;
    a.meta.complete = !a.failed && !error && !a.meta.error;
    if (error) a.meta.error = error;
    if (!a.meta.tracks.caller.hasAudio) a.meta.note += ' No audio was received from the modem for this call.';
    try {
      this.writeMeta(a.meta);
    } catch (e) {
      this.fail(`Could not write the recording metadata for ${callId}: ${(e as Error).message}`);
    }
    this.logger.info(`Recording of call ${callId} finished (complete=${a.meta.complete}, caller ${a.meta.tracks.caller.durationMs} ms, agent ${a.meta.tracks.agent.durationMs} ms)`);
    this.purgeExpired();
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
    return path.join(path.resolve(this.deps.config.dir), callId, 'recording.json');
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
      return meta.kind === RECORDING_KIND && meta.callId === callId ? meta : null;
    } catch {
      return null;
    }
  }

  /** Deletes only finished recordings this feature made, and only when a retention period was configured. */
  private purgeExpired(): void {
    const days = this.deps.config.retentionDays;
    if (days <= 0) return;
    const cutoff = this.now() - days * 86_400_000;
    for (const meta of this.list(100000)) {
      if (!meta.complete || !meta.endedAt || Date.parse(meta.endedAt) >= cutoff) continue;
      try {
        fs.rmSync(path.join(path.resolve(this.deps.config.dir), meta.callId), { recursive: true, force: true });
        this.logger.info(`Deleted recording ${meta.callId}: older than the ${days}-day retention period`);
      } catch (error) {
        this.fail(`Could not delete expired recording ${meta.callId}: ${(error as Error).message}`);
      }
    }
  }
}
