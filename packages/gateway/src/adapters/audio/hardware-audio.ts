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
import { ISerialTransport, NodeSerialTransport } from '../modem/serial-transport.js';
import { createLogger, Logger } from '../../core/logger.js';

export interface HardwareAudioOptions {
  audioPort?: string;
  audioBaudRate?: number;
  sampleRate?: number;
  enableDumps?: boolean;
  dumpDir?: string;
  transport?: ISerialTransport;
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
  private readonly options: Required<HardwareAudioOptions>;
  private readonly logger: Logger;

  constructor(options: HardwareAudioOptions = {}) {
    super();

    this.options = {
      audioPort: options.audioPort ?? 'COM19',
      audioBaudRate: options.audioBaudRate ?? 115200,
      sampleRate: options.sampleRate ?? 8000,
      enableDumps: options.enableDumps ?? true,
      dumpDir: options.dumpDir ?? './audio-dumps',
      transport:
        options.transport ??
        new NodeSerialTransport({
          path: options.audioPort ?? 'COM19',
          baudRate: options.audioBaudRate ?? 115200,
          lock: true,
        }),
    };

    this.transport = this.options.transport;
    this.logger = createLogger(`Audio:${this.options.audioPort}`);

    this.stats = {
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
      if (!this.transport.isOpen()) {
        await this.transport.open({
          path: this.options.audioPort,
          baudRate: this.options.audioBaudRate,
        });
      }
      this.logger.info(`Audio transport '${this.options.audioPort}' opened for call ${callId}`);
    } catch (err) {
      // Audio open failure shouldn't crash the voice call session
      if (this.listenerCount('error') > 0) {
        this.emit(
          'error',
          new Error(`Could not open audio port ${this.options.audioPort}: ${(err as Error).message}`)
        );
      }
      this.logger.error(`Could not open audio port ${this.options.audioPort}: ${(err as Error).message}`);
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

    this.stats.bytesSent += chunk.length;
    this.stats.framesSent++;
    this.logger.debug(`Outbound audio write bytes=${chunk.length} timestamp=${new Date().toISOString()}`);

    try {
      await this.transport.write(chunk);
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
