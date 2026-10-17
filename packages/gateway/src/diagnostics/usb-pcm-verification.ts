import fs from 'node:fs';
import path from 'node:path';
import { AudioFrame, IAudioAdapter, ICallSessionManager } from '@sim-gateway/shared';
import { createLogger } from '../core/logger.js';
import { generateTone, PcmEndianness } from './pcm-tools.js';
import { playPcmPaced } from '../adapters/audio/paced-playback.js';

/** Hard limits. They are enforced here, not configurable at request time. */
export const CAPTURE_MAX_MS = 5000;
/** Ceiling for 5 s of 16 kHz 16-bit mono; a safety cap, not an assumed format. */
export const CAPTURE_MAX_BYTES = 160_000;
export const TONE_MAX_MS = 1000;
export const TONE_MAX_BYTES = 16_000;
export const TONE_MAX_AMPLITUDE = 0.1;
const TONE_CHUNK_MS = 20;

export type StopReason =
  | 'duration'
  | 'byte-limit'
  | 'call-ended'
  | 'audio-error'
  | 'aborted'
  /** Capture: the window elapsed and the audio port delivered zero bytes. */
  | 'no-data'
  /** Tone: the loop finished but the adapter did not write every byte to the port. */
  | 'not-written';

export interface CaptureResult {
  filePath: string;
  metadataPath: string;
  bytes: number;
  durationMs: number;
  stopReason: StopReason;
  callId: string;
  /** Always false: the stream format is never verified by this code. */
  formatVerified: false;
}

export interface ToneRequest {
  /** Unverified assumption about the port's format, stated explicitly by the operator. */
  assumedFormat: { sampleRate: number; endianness: PcmEndianness };
  frequencyHz?: number;
  durationMs?: number;
  amplitude?: number;
}

export interface ToneResult {
  bytesWritten: number;
  chunksWritten: number;
  /** Chunks dispatched more than one frame after their deadline (0 expected on a healthy host). */
  lateFrames: number;
  maxLateMs: number;
  durationMs: number;
  stopReason: StopReason | 'completed';
  callId: string;
  /** Always false: a successful write does not prove audible transmission. */
  audibleTransmissionVerified: false;
}

export interface UsbPcmVerifierOptions {
  audio: IAudioAdapter;
  callManager: ICallSessionManager;
  outputDir: string;
  captureEnabled: boolean;
  outboundToneEnabled: boolean;
  /** Return a reason while something else (the AI agent) owns the audio port; the tests then refuse to run. */
  externalBusyReason?: () => string | null;
}

export class UsbPcmTestError extends Error {
  constructor(message: string, readonly status: number = 409) {
    super(message);
    this.name = 'UsbPcmTestError';
  }
}

/**
 * Opt-in USB PCM verification tests. Both reuse the audio adapter's already-open port
 * (frames in via 'audio_frame', bytes out via writeAudioChunk) and never open a second handle.
 */
export class UsbPcmVerifier {
  private readonly logger = createLogger('UsbPcmVerifier');
  private busy = false;
  private abortCurrent: (() => void) | null = null;

  constructor(private readonly options: UsbPcmVerifierOptions) {}

  abort(): void {
    this.abortCurrent?.();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private assertReady(): string {
    const call = this.options.callManager.getCurrentCall();
    if (!call || call.state !== 'ACTIVE') {
      throw new UsbPcmTestError('USB PCM tests require an ACTIVE call');
    }
    if (this.options.callManager.isUsbAudioDiagnosticActive?.() !== true) {
      throw new UsbPcmTestError('USB audio diagnostic (AT+CPCMREG=1) must be activated first');
    }
    if (this.options.audio.getStats().isStreaming !== true) {
      throw new UsbPcmTestError(
        'Audio session is not streaming: the audio COM port was never opened or has closed'
      );
    }
    const external = this.options.externalBusyReason?.();
    if (external) {
      throw new UsbPcmTestError(external);
    }
    if (this.busy) {
      throw new UsbPcmTestError('Another USB PCM test is already running');
    }
    return call.id;
  }

  async captureInbound(): Promise<CaptureResult> {
    if (!this.options.captureEnabled) {
      throw new UsbPcmTestError('USB PCM capture test is disabled', 404);
    }
    const callId = this.assertReady();
    this.busy = true;

    const { audio, callManager } = this.options;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const startedAt = Date.now();

    try {
      const windowReason = await new Promise<StopReason>((resolve) => {
        const finish = (reason: StopReason) => {
          clearTimeout(timer);
          audio.off('audio_frame', onFrame);
          audio.off('error', onError);
          callManager.off('call:ended', onEnded);
          this.abortCurrent = null;
          resolve(reason);
        };
        const onFrame = (frame: AudioFrame) => {
          const room = CAPTURE_MAX_BYTES - bytes;
          const slice = frame.data.length > room ? frame.data.subarray(0, room) : frame.data;
          chunks.push(Buffer.from(slice));
          bytes += slice.length;
          if (bytes >= CAPTURE_MAX_BYTES) finish('byte-limit');
        };
        const onError = () => finish('audio-error');
        const onEnded = () => finish('call-ended');
        const timer = setTimeout(() => finish('duration'), CAPTURE_MAX_MS);
        this.abortCurrent = () => finish('aborted');
        audio.on('audio_frame', onFrame);
        audio.on('error', onError);
        callManager.on('call:ended', onEnded);
      });

      // A full window with zero bytes is a failed capture, not a successful empty one.
      const stopReason: StopReason = windowReason === 'duration' && bytes === 0 ? 'no-data' : windowReason;

      fs.mkdirSync(this.options.outputDir, { recursive: true });
      const base = path.join(this.options.outputDir, `usb_pcm_capture_${callId}_${startedAt}`);
      const filePath = `${base}.bin`;
      const metadataPath = `${base}.json`;
      fs.writeFileSync(filePath, Buffer.concat(chunks));
      const durationMs = Date.now() - startedAt;
      fs.writeFileSync(
        metadataPath,
        JSON.stringify(
          {
            callId,
            bytes,
            durationMs,
            stopReason,
            isSimulated: audio.isSimulated,
            formatVerified: false,
            note: 'Raw bytes as received. Sample rate, bit depth, channels and byte order are unverified.',
          },
          null,
          2
        )
      );
      // Metadata only: audio content is never logged.
      this.logger.info(`USB PCM capture finished: bytes=${bytes} durationMs=${durationMs} reason=${stopReason}`);
      return { filePath, metadataPath, bytes, durationMs, stopReason, callId, formatVerified: false };
    } finally {
      this.busy = false;
    }
  }

  async playOutboundTone(request: ToneRequest): Promise<ToneResult> {
    if (!this.options.outboundToneEnabled) {
      throw new UsbPcmTestError('USB PCM outbound tone test is disabled', 404);
    }
    const { sampleRate, endianness } = request.assumedFormat ?? ({} as ToneRequest['assumedFormat']);
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      throw new UsbPcmTestError('assumedFormat.sampleRate must be an integer between 8000 and 48000', 400);
    }
    if (endianness !== 'little-endian' && endianness !== 'big-endian') {
      throw new UsbPcmTestError("assumedFormat.endianness must be 'little-endian' or 'big-endian'", 400);
    }
    const frequencyHz = request.frequencyHz ?? 1000;
    const durationMs = request.durationMs ?? 500;
    const amplitude = request.amplitude ?? 0.05;
    if (!(frequencyHz >= 300 && frequencyHz <= 3400)) {
      throw new UsbPcmTestError('frequencyHz must be between 300 and 3400', 400);
    }
    if (!(durationMs > 0 && durationMs <= TONE_MAX_MS)) {
      throw new UsbPcmTestError(`durationMs must be > 0 and <= ${TONE_MAX_MS}`, 400);
    }
    if (!(amplitude > 0 && amplitude <= TONE_MAX_AMPLITUDE)) {
      throw new UsbPcmTestError(`amplitude must be > 0 and <= ${TONE_MAX_AMPLITUDE}`, 400);
    }
    const totalBytes = Math.round((sampleRate * durationMs) / 1000) * 2;
    if (totalBytes > TONE_MAX_BYTES) {
      throw new UsbPcmTestError(`tone would exceed the ${TONE_MAX_BYTES} byte limit`, 400);
    }

    const callId = this.assertReady();
    this.busy = true;

    const { audio, callManager } = this.options;
    const tone = generateTone(
      { sampleRate, channels: 1, bitDepth: 16, endianness },
      frequencyHz,
      durationMs,
      amplitude
    );
    let stopReason: ToneResult['stopReason'] = 'completed';
    let pacing = { lateFrames: 0, maxLateMs: 0 };
    // Counted from the adapter's own stats, so a chunk the adapter silently drops (session
    // already stopped by a hangup) is not reported as written.
    const statsBefore = audio.getStats();
    const startedAt = Date.now();

    const stop = (reason: StopReason) => {
      if (stopReason === 'completed') stopReason = reason;
    };
    const onEnded = () => stop('call-ended');
    const onError = () => stop('audio-error');
    this.abortCurrent = () => stop('aborted');
    callManager.on('call:ended', onEnded);
    audio.on('error', onError);

    try {
      try {
        // Deadline-scheduled writes: a per-chunk setTimeout(20) runs slow on Windows and underruns.
        pacing = await playPcmPaced((chunk) => audio.writeAudioChunk(chunk), tone, {
          sampleRate,
          frameMs: TONE_CHUNK_MS,
          shouldStop: () => {
            if (stopReason !== 'completed') return stopReason;
            const current = callManager.getCurrentCall();
            if (!current || current.id !== callId || current.state !== 'ACTIVE') {
              stop('call-ended');
              return 'call-ended';
            }
            return null;
          },
        });
      } catch {
        stop('audio-error');
      }
    } finally {
      callManager.off('call:ended', onEnded);
      audio.off('error', onError);
      this.abortCurrent = null;
      this.busy = false;
    }

    const statsAfter = audio.getStats();
    const bytesWritten = statsAfter.bytesSent - statsBefore.bytesSent;
    const chunksWritten = statsAfter.framesSent - statsBefore.framesSent;
    // The adapter skips writes silently when its session or port is gone; never call that "completed".
    if (stopReason === 'completed' && bytesWritten !== tone.length) {
      stopReason = 'not-written';
    }
    this.logger.info(
      `USB PCM tone finished: bytes=${bytesWritten} chunks=${chunksWritten} reason=${stopReason} lateFrames=${pacing.lateFrames} maxLateMs=${Math.round(pacing.maxLateMs)}`
    );
    return {
      bytesWritten,
      chunksWritten,
      lateFrames: pacing.lateFrames,
      maxLateMs: Math.round(pacing.maxLateMs),
      durationMs: Date.now() - startedAt,
      stopReason,
      callId,
      audibleTransmissionVerified: false,
    };
  }
}
