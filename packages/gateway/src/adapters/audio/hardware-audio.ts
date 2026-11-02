import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  AudioDumpOptions,
  AudioFormatSpec,
  AudioFrame,
  AudioStreamStats,
  IAudioAdapter,
} from '@sim-gateway/shared';
import { describeClose, ISerialTransport, NodeSerialTransport, SerialCloseInfo } from '../modem/serial-transport.js';
import { createLogger, Logger } from '../../core/logger.js';

export interface HardwareAudioOptions {
  /** COM port of the USB audio interface. Required: Windows reassigns COM numbers, so none is assumed. */
  audioPort: string;
  audioBaudRate?: number;
  sampleRate?: number;
  enableDumps?: boolean;
  dumpDir?: string;
  transport?: ISerialTransport;
  /**
   * Automatic port discovery: asked for the USB audio port just before the port is opened for a call, so a renumbered COM
   * port is followed. Never asked while the port is open, so an active call is never moved or interrupted.
   */
  resolvePort?: () => Promise<string>;
}

/**
 * Hardware Audio Adapter for SIM7600EI COM13 virtual USB audio stream.
 * 
 * NOTE: The SIM7600EI COM13 virtual audio stream receives data during calls,
 * but audio encoding, framing, and bidirectional transfer are unverified.
 * The audio layer treats data as a raw byte stream with zero formatting assumptions
 * until validated on physical Windows hardware.
 */
export class Sim7600HardwareAudioAdapter extends EventEmitter implements IAudioAdapter {
  readonly isSimulated = false;

  private transport: ISerialTransport;
  private isStreaming = false;
  private currentCallId: string | null = null;
  private dumpWriteStream: fs.WriteStream | null = null;
  private inboundStream: PassThrough | null = null;
  private outboundStream: Writable | null = null;
  private sequenceNumber = 0;
  private stats: AudioStreamStats;
  private readonly options: Required<Omit<HardwareAudioOptions, 'resolvePort'>>;
  private readonly resolvePort?: () => Promise<string>;
  private portPath: string;
  private readonly logger: Logger;

  constructor(options: HardwareAudioOptions) {
    super();

    this.options = {
      audioPort: options.audioPort,
      audioBaudRate: options.audioBaudRate ?? 115200,
      sampleRate: options.sampleRate ?? 8000,
      // Unrestricted whole-call dumping is opt-in; use the bounded PCM capture test instead.
      enableDumps: options.enableDumps ?? false,
      dumpDir: options.dumpDir ?? './audio-dumps',
      transport:
        options.transport ??
        new NodeSerialTransport({
          path: options.audioPort,
          baudRate: options.audioBaudRate ?? 115200,
          lock: true,
        }),
    };

    this.transport = this.options.transport;
    this.resolvePort = options.resolvePort;
    this.portPath = this.options.audioPort;
    this.logger = createLogger(this.resolvePort ? 'Audio' : `Audio:${this.options.audioPort}`);
    this.logger.info(
      `Raw whole-call audio dump is ${this.options.enableDumps ? 'ENABLED (unbounded)' : 'disabled'}`
    );

    this.stats = {
      lastFrameAt: null,
      bytesReceived: 0,
      bytesSent: 0,
      framesReceived: 0,
      framesSent: 0,
      currentRmsInbound: 0,
      currentRmsOutbound: 0,
      droppedFrames: 0,
      isStreaming: false,
    };

    this.transport.on('data', (chunk: Buffer) => {
      this.handleIncomingRawAudio(chunk);
    });

    this.transport.on('error', (err: Error) => {
      this.logger.error(`Audio transport error: ${err.message}`);
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
    });

    this.transport.on('close', (info?: SerialCloseInfo) => {
      this.handleUnexpectedClose(info);
    });
  }

  /**
   * The port closing while a session is streaming (USB reset, driver drop) used to be silent:
   * isStreaming stayed true, no frames arrived, and writes were skipped without any error.
   * stopSession() clears isStreaming before it closes the port, so a normal stop never lands here.
   */
  private handleUnexpectedClose(info?: SerialCloseInfo): void {
    if (!this.isStreaming) return;
    this.markNotStreaming();
    const message = `Audio port '${this.portPath}' ${describeClose(info)} while the session was streaming`;
    this.logger.error(message);
    if (this.listenerCount('error') > 0) {
      this.emit('error', new Error(message));
    }
  }

  private markNotStreaming(): void {
    this.isStreaming = false;
    this.stats.isStreaming = false;
  }

  async startSession(callId: string): Promise<void> {
    this.currentCallId = callId;
    this.sequenceNumber = 0;
    this.isStreaming = true;
    this.stats.isStreaming = true;
    this.inboundStream = new PassThrough();
    this.outboundStream = new Writable({
      write: (chunk, _encoding, callback) => {
        this.writeAudioChunk(Buffer.from(chunk)).then(
          () => callback(),
          (error: Error) => callback(error)
        );
      },
    });

    // Open audio COM port if not already open
    try {
      await this.openPort();
      this.logger.info(`Audio transport '${this.portPath}' opened for call ${callId}`);
    } catch (err) {
      // Audio open failure shouldn't crash the voice call session, but the session is not streaming
      this.markNotStreaming();
      if (this.listenerCount('error') > 0) {
        this.emit(
          'error',
          new Error(`Could not open audio port ${this.portPath}: ${(err as Error).message}`)
        );
      }
      this.logger.error(`Could not open audio port ${this.portPath}: ${(err as Error).message}`);
    }

    // Initialize raw diagnostic file dump if enabled
    if (this.options.enableDumps) {
      try {
        fs.mkdirSync(this.options.dumpDir, { recursive: true });
        const filePath = path.join(
          this.options.dumpDir,
          `unvalidated_raw_audio_${callId}_${Date.now()}.bin`
        );
        this.dumpWriteStream = fs.createWriteStream(filePath);
      } catch (dumpErr) {
        // Continue even if dump file creation fails
      }
    }
  }

  private async openPort(): Promise<void> {
    if (!this.transport.isOpen()) {
      if (this.resolvePort) {
        const path = await this.resolvePort();
        if (path !== this.portPath) this.logger.info(`USB audio port discovered: ${path}`);
        this.portPath = path;
      }
      await this.transport.open({
        path: this.portPath,
        baudRate: this.options.audioBaudRate,
      });
    }
  }

  /**
   * Reopen the audio port for the session in progress after the port closed under it (for example
   * a USB drop). One attempt, no retry: on failure it throws and the session stays not-streaming.
   * Reopening the port does not re-register the module's USB audio (AT+CPCMREG); the caller must
   * verify that separately.
   */
  async recoverSession(): Promise<void> {
    if (!this.currentCallId) {
      throw new Error('No audio session to recover');
    }
    // Mark first so closing a stale handle is not reported as an unexpected close.
    this.markNotStreaming();
    if (this.transport.isOpen()) {
      await this.transport.close();
    }
    await this.openPort();
    this.isStreaming = true;
    this.stats.isStreaming = true;
    this.logger.info(`Audio transport '${this.portPath}' reopened for call ${this.currentCallId}`);
  }

  async stopSession(): Promise<void> {
    if (!this.isStreaming && !this.currentCallId) {
      return;
    }

    this.isStreaming = false;
    this.stats.isStreaming = false;
    this.currentCallId = null;
    this.inboundStream?.end();
    this.outboundStream?.end();
    this.inboundStream = null;
    this.outboundStream = null;

    if (this.dumpWriteStream) {
      this.dumpWriteStream.end();
      this.dumpWriteStream = null;
    }

    if (this.transport.isOpen()) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close error during teardown
      }
    }

    this.stats.currentRmsInbound = 0;
    this.stats.currentRmsOutbound = 0;
    this.emit('stats', this.getStats());
  }

  /**
   * NOTE: Bidirectional audio transmission on COM13 is UNVERIFIED on hardware.
   * Outbound audio writing is non-operational until two-way audio format qualification in Phase 5.
   */
  async writeAudioChunk(chunk: Buffer): Promise<void> {
    if (!this.isStreaming || !this.transport.isOpen()) {
      return;
    }

    this.logger.debug(`Outbound audio write bytes=${chunk.length} timestamp=${new Date().toISOString()}`);

    try {
      await this.transport.write(chunk);
      // Counted only after the serial write succeeded, so failed writes never inflate the totals.
      this.stats.bytesSent += chunk.length;
      this.stats.framesSent++;
      this.emit('audio_out', chunk);
    } catch (writeErr) {
      this.stats.droppedFrames++;
      if (this.listenerCount('error') > 0) {
        this.emit('error', writeErr as Error);
      }
      throw writeErr;
    }
  }

  getStats(): AudioStreamStats {
    return { ...this.stats };
  }

  getInboundStream(): Readable | null {
    return this.inboundStream;
  }

  getOutboundStream(): Writable | null {
    return this.outboundStream;
  }

  private handleIncomingRawAudio(chunk: Buffer): void {
    if (!this.isStreaming) return;

    this.stats.bytesReceived += chunk.length;
    this.stats.framesReceived++;
    this.stats.lastFrameAt = Date.now();
    this.logger.debug(`Inbound audio chunk bytes=${chunk.length} timestamp=${new Date().toISOString()}`);

    // Write to raw diagnostic file dump (clearly labeled as unvalidated raw stream)
    if (this.dumpWriteStream) {
      this.dumpWriteStream.write(chunk);
    }
    this.inboundStream?.write(chunk);

    // Heuristic raw byte stream energy metric for visual activity indicators.
    // Note: Does NOT assume linear PCM format or perform speculative decoding.
    const activityLevel = this.estimateByteStreamActivity(chunk);
    this.stats.currentRmsInbound = activityLevel;

    const frame: AudioFrame = {
      sequenceNumber: ++this.sequenceNumber,
      frameDurationMs: 20,
      data: chunk,
      timestamp: Date.now(),
      rmsLevel: activityLevel,
      isSimulated: false,
    };

    this.emit('audio_frame', frame);
    this.emit('stats', this.getStats());
  }

  /**
   * Heuristic byte-energy calculation for diagnostic activity indicators only.
   * Does NOT decode or assume 16-bit linear PCM format.
   */
  private estimateByteStreamActivity(buffer: Buffer): number {
    if (buffer.length === 0) return 0;

    let sumDeviation = 0;
    for (let i = 0; i < buffer.length; i++) {
      // Normalize raw byte [0..255] around center 128
      const val = (buffer[i] - 128) / 128.0;
      sumDeviation += val * val;
    }

    return Math.min(1.0, Math.sqrt(sumDeviation / buffer.length));
  }
}
