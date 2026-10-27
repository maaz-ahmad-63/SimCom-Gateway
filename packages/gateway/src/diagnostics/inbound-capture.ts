import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioFrame, IAudioAdapter, ICallSessionManager } from '@sim-gateway/shared';
import { createLogger } from '../core/logger.js';
import {
  analyzePcm,
  buildWav,
  CANDIDATE_FORMATS,
  PcmFormat,
  speechIndicators,
} from './pcm-tools.js';
import { CAPTURE_MAX_BYTES, CAPTURE_MAX_MS } from './usb-pcm-verification.js';

/** Where capture bundles go: packages/gateway/diagnostics/captures/<timestamp>/ */
export const DEFAULT_CAPTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'diagnostics',
  'captures'
);

export const MAX_START_DELAY_MS = 20_000;

export type InboundStopReason = 'duration' | 'byte-limit' | 'call-ended' | 'aborted' | 'audio-error';

export interface CandidateReport {
  label: string;
  format: PcmFormat;
  wavFile: string | null;
  /** Bytes of the capture used for this candidate (a trailing partial sample is not used). */
  usedBytes: number;
  droppedTrailingBytes: number;
  calculatedDurationMs: number;
  rms: number;
  peak: number;
  silentRatio: number;
  /** Only meaningful for a steady tone; speech scores low in every format. */
  toneConcentration: number;
  voicedRatio: number | null;
  medianPitchHz: number | null;
  note: string;
  error: string | null;
}

export interface CaptureBundle {
  directory: string;
  binFile: string;
  reportFile: string;
  readmeFile: string;
  candidates: CandidateReport[];
}

export interface BundleInput {
  data: Buffer;
  outputRoot: string;
  timestamp: string;
  captureDurationMs: number;
  stopReason: InboundStopReason;
  isSimulated: boolean;
  callIdHash?: string;
}

const label = (f: PcmFormat): string =>
  `${f.sampleRate / 1000}k_${f.bitDepth}bit_${f.channels === 1 ? 'mono' : f.channels + 'ch'}${
    f.bitDepth === 16 ? (f.endianness === 'little-endian' ? '_LE' : '_BE') : ''
  }`;

const round = (n: number, d = 4): number => Number(n.toFixed(d));

/**
 * Writes the raw capture, one WAV per candidate format, report.json and README.txt. Pure file output (no modem, no
 * logging of audio). The WAV wrapper is only a container for listening: nothing here marks a format as verified.
 */
export function writeCaptureBundle(input: BundleInput): CaptureBundle {
  if (input.data.length > CAPTURE_MAX_BYTES) {
    throw new Error(`Refusing to write ${input.data.length} bytes: above the ${CAPTURE_MAX_BYTES}-byte capture limit`);
  }
  const directory = path.join(input.outputRoot, input.timestamp);
  fs.mkdirSync(directory, { recursive: true });
  const binFile = path.join(directory, 'capture_raw.bin');
  fs.writeFileSync(binFile, input.data);

  const candidates: CandidateReport[] = CANDIDATE_FORMATS.map((format) => {
    const name = label(format);
    const blockAlign = (format.bitDepth / 8) * format.channels;
    const usedBytes = input.data.length - (input.data.length % blockAlign);
    const dropped = input.data.length - usedBytes;
    const base: CandidateReport = {
      label: name,
      format,
      wavFile: null,
      usedBytes,
      droppedTrailingBytes: dropped,
      calculatedDurationMs: round((usedBytes / blockAlign / format.sampleRate) * 1000, 1),
      rms: 0,
      peak: 0,
      silentRatio: 0,
      toneConcentration: 0,
      voicedRatio: null,
      medianPitchHz: null,
      note:
        format.bitDepth === 8
          ? 'Bytes read as UNSIGNED 8-bit (the WAV 8-bit convention). If the modem sends signed 8-bit this will sound wrong.'
          : format.endianness === 'big-endian'
            ? 'Bytes were swapped to little-endian for the WAV container (WAV is always little-endian).'
            : 'Bytes copied as little-endian 16-bit.',
      error: null,
    };
    try {
      if (usedBytes === 0) throw new Error('capture shorter than one sample: nothing to convert');
      const aligned = input.data.subarray(0, usedBytes);
      const a = analyzePcm(aligned, format); // on the aligned bytes so the figures match the WAV
      base.rms = round(a.rms);
      base.peak = round(a.peak);
      base.silentRatio = round(a.silentRatio);
      base.toneConcentration = round(a.toneConcentration);
      if (format.bitDepth === 16) {
        const s = speechIndicators(aligned, format);
        base.voicedRatio = round(s.voicedRatio);
        base.medianPitchHz = s.medianPitchHz === null ? null : round(s.medianPitchHz, 1);
      }
      // Container only: the flag satisfies buildWav's guard and is NOT a statement that the format is verified.
      const wav = buildWav(aligned, { ...format, verified: true });
      base.wavFile = `candidate_${name}.wav`;
      fs.writeFileSync(path.join(directory, base.wavFile), wav);
    } catch (error) {
      base.error = (error as Error).message;
    }
    return base;
  });

  const reportFile = path.join(directory, 'report.json');
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      {
        timestamp: input.timestamp,
        formatVerified: false,
        captureDurationMs: input.captureDurationMs,
        byteCount: input.data.length,
        stopReason: input.stopReason,
        isSimulated: input.isSimulated,
        limits: { maxMs: CAPTURE_MAX_MS, maxBytes: CAPTURE_MAX_BYTES },
        truncationNote:
          'Each candidate drops trailing bytes that do not complete a sample; see droppedTrailingBytes. The .bin keeps every byte.',
        caution:
          'None of these formats is verified. Scores cannot establish intelligibility: listen to the WAVs. A tone score is only meaningful for a steady tone.',
        candidates,
      },
      null,
      2
    )
  );

  const readmeFile = path.join(directory, 'README.txt');
  fs.writeFileSync(
    readmeFile,
    [
      'SIM7600 incoming-call audio capture (UNVERIFIED FORMAT)',
      '',
      'capture_raw.bin   exactly the bytes received from the audio port.',
      'candidate_*.wav   the same bytes wrapped as each candidate format, so you can listen.',
      'report.json       duration, byte count and measurements for every candidate.',
      '',
      'What to listen to, in this order:',
      '  1. candidate_8k_16bit_mono_LE.wav   (the modem documentation says 8 kHz, 16-bit linear)',
      '  2. candidate_16k_16bit_mono_LE.wav  (if #1 sounds too fast / high-pitched or too slow, the rate is wrong)',
      '  3. candidate_8k_16bit_mono_BE.wav and candidate_16k_16bit_mono_BE.wav (only if the above are noise/static)',
      '  4. candidate_8k_8bit_mono.wav       (last resort; also assumes unsigned bytes)',
      '',
      'The right file is the one where the voice is clear at normal speed and pitch.',
      'Wrong byte order sounds like loud harsh static. A wrong rate sounds sped up or slowed down.',
      'The numbers in report.json cannot tell you which is right; only listening can.',
      'If the file has nothing but silence, nobody spoke during the capture window, or the line carried no audio.',
      '',
      'Nothing here marks the format verified. Do not set AI_AUDIO_SAMPLE_RATE from this alone.',
      'Captured audio is a real caller\'s voice: treat these files as private and delete them when done.',
      '',
    ].join('\n')
  );

  return { directory, binFile, reportFile, readmeFile, candidates };
}

export interface InboundCaptureStatus {
  state: 'idle' | 'armed' | 'delaying' | 'capturing' | 'done' | 'failed';
  armedAt?: string;
  bytes?: number;
  directory?: string;
  stopReason?: InboundStopReason;
  error?: string;
}

export interface InboundCaptureTapOptions {
  audio: IAudioAdapter;
  callManager: ICallSessionManager;
  outputRoot?: string;
}

/**
 * Read-only tap: one listener on the existing 'audio_frame' event. It never opens, writes to, or configures the audio
 * port, so it can run beside the AI agent (which keeps the port). Captures once, then goes back to idle.
 */
export class InboundCaptureTap {
  private readonly logger = createLogger('InboundCaptureTap');
  private current: InboundCaptureStatus = { state: 'idle' };
  private cleanup: (() => void) | null = null;
  private finishNow: ((reason: InboundStopReason) => void) | null = null;

  constructor(private readonly options: InboundCaptureTapOptions) {}

  status(): InboundCaptureStatus {
    return { ...this.current };
  }

  disarm(): void {
    if (this.current.state === 'capturing') this.finishNow?.('aborted');
    else {
      this.cleanup?.();
      this.current = { state: 'idle' };
    }
  }

  /** Wait for the next ACTIVE call whose audio is streaming, then capture up to the existing limits. */
  arm(request: { startDelayMs?: number } = {}): InboundCaptureStatus {
    if (this.current.state === 'armed' || this.current.state === 'delaying' || this.current.state === 'capturing') {
      throw new Error('An inbound capture is already armed or running');
    }
    const delay = Math.min(Math.max(Math.floor(request.startDelayMs ?? 0) || 0, 0), MAX_START_DELAY_MS);
    const { audio, callManager } = this.options;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let startedAt = 0;
    let activeSince = 0;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;

    const finish = (reason: InboundStopReason): void => {
      if (finished) return;
      finished = true;
      this.cleanup?.();
      if (bytes === 0) {
        this.current = {
          state: 'failed',
          stopReason: reason,
          error:
            reason === 'aborted' && startedAt === 0
              ? 'Disarmed before any audio was captured'
              : 'No audio frames arrived while the call was active',
        };
        return;
      }
      try {
        const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
        const bundle = writeCaptureBundle({
          data: Buffer.concat(chunks),
          outputRoot: this.options.outputRoot ?? DEFAULT_CAPTURES_DIR,
          timestamp,
          captureDurationMs: Date.now() - startedAt,
          stopReason: reason,
          isSimulated: audio.isSimulated,
        });
        this.current = { state: 'done', bytes, directory: bundle.directory, stopReason: reason };
        // Metadata only: audio content, call ids and numbers are never logged.
        this.logger.info(`Inbound capture saved: bytes=${bytes} reason=${reason}`);
      } catch (error) {
        this.current = { state: 'failed', error: (error as Error).message, stopReason: reason };
      }
    };

    const onFrame = (frame: AudioFrame): void => {
      const call = callManager.getCurrentCall();
      if (!call || call.state !== 'ACTIVE') return;
      const now = Date.now();
      if (activeSince === 0) activeSince = now;
      if (now - activeSince < delay) {
        this.current = { ...this.current, state: 'delaying' };
        return;
      }
      if (startedAt === 0) {
        startedAt = now;
        this.current = { ...this.current, state: 'capturing' };
        timer = setTimeout(() => finish('duration'), CAPTURE_MAX_MS);
      }
      const room = CAPTURE_MAX_BYTES - bytes;
      const slice = frame.data.length > room ? frame.data.subarray(0, room) : frame.data;
      chunks.push(Buffer.from(slice));
      bytes += slice.length;
      if (bytes >= CAPTURE_MAX_BYTES) finish('byte-limit');
    };
    const onError = (): void => {
      if (startedAt !== 0) finish('audio-error');
    };
    const onEnded = (): void => {
      if (startedAt !== 0) finish('call-ended');
      else activeSince = 0;
    };

    this.cleanup = () => {
      if (timer) clearTimeout(timer);
      audio.off('audio_frame', onFrame);
      audio.off('error', onError);
      callManager.off('call:ended', onEnded);
      this.cleanup = null;
      this.finishNow = null;
    };
    this.finishNow = finish;
    audio.on('audio_frame', onFrame);
    audio.on('error', onError);
    callManager.on('call:ended', onEnded);
    this.current = { state: 'armed', armedAt: new Date().toISOString() };
    return this.status();
  }
}
