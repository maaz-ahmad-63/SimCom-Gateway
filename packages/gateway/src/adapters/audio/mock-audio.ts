import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { AudioFrame, AudioStreamStats, IAudioAdapter } from '@sim-gateway/shared';

export interface MockAudioOptions {
  sampleRate?: number;
  frameDurationMs?: number;
  generateTone?: boolean;
}

export class MockAudioAdapter extends EventEmitter implements IAudioAdapter {
  readonly isSimulated = true;

  private activeCallId: string | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private sequenceNumber = 0;
  private inboundStream: PassThrough | null = null;
  private outboundStream: PassThrough | null = null;

  private stats: AudioStreamStats = {
    bytesReceived: 0,
    bytesSent: 0,
    framesReceived: 0,
    framesSent: 0,
    currentRmsInbound: 0,
    currentRmsOutbound: 0,
    droppedFrames: 0,
    isStreaming: false,
  };

  private readonly sampleRate: number;
  private readonly frameDurationMs: number;
  private readonly frameByteLength: number;
  private readonly generateTone: boolean;

  constructor(options: MockAudioOptions = {}) {
    super();
    this.sampleRate = options.sampleRate ?? 8000;
    this.frameDurationMs = options.frameDurationMs ?? 20; // 20ms standard frame
    this.generateTone = options.generateTone ?? true;

    // 8000 Hz * 2 bytes (16-bit) * 0.020s = 320 bytes per frame
    this.frameByteLength = Math.round((this.sampleRate * 2 * this.frameDurationMs) / 1000);
  }

  async startSession(callId: string): Promise<void> {
    this.activeCallId = callId;
    this.sequenceNumber = 0;
    this.inboundStream = new PassThrough();
    this.outboundStream = new PassThrough();
    this.stats.isStreaming = true;

    // Stream generation loop: emits audio frame every frameDurationMs
    let sampleCounter = 0;
    this.intervalTimer = setInterval(() => {
      if (!this.stats.isStreaming) return;

      const buffer = Buffer.alloc(this.frameByteLength);
      // Generate 440 Hz test sine wave tone if enabled, else quiet low noise
      for (let i = 0; i < this.frameByteLength; i += 2) {
        let sample = 0;
        if (this.generateTone) {
          const t = sampleCounter / this.sampleRate;
          sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000); // 440Hz A tone
        }
        buffer.writeInt16LE(sample, i);
        sampleCounter++;
      }

      const rms = this.calculateRms(buffer);
      this.stats.bytesReceived += buffer.length;
      this.stats.framesReceived++;
      this.stats.currentRmsInbound = rms;

      const frame: AudioFrame = {
        sequenceNumber: this.sequenceNumber++,
        frameDurationMs: this.frameDurationMs,
        data: buffer,
        timestamp: Date.now(),
        rmsLevel: rms,
        isSimulated: true,
      };

      this.emit('audio_frame', frame);
      this.inboundStream?.write(buffer);

      // Periodically emit stats
      if (this.sequenceNumber % 10 === 0) {
        this.emit('stats', { ...this.stats });
      }
    }, this.frameDurationMs);
  }

  async stopSession(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.stats.isStreaming = false;
    this.stats.currentRmsInbound = 0;
    this.stats.currentRmsOutbound = 0;

    this.inboundStream?.end();
    this.outboundStream?.end();
    this.inboundStream = null;
    this.outboundStream = null;
    this.activeCallId = null;

    this.emit('stats', { ...this.stats });
  }

  async writeAudioChunk(chunk: Buffer): Promise<void> {
    if (!this.stats.isStreaming) return;
    this.stats.bytesSent += chunk.length;
    this.stats.framesSent++;
    this.stats.currentRmsOutbound = this.calculateRms(chunk);
    this.outboundStream?.write(chunk);
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

  private calculateRms(buffer: Buffer): number {
    let sum = 0;
    const samples = buffer.length / 2;
    for (let i = 0; i < buffer.length; i += 2) {
      const val = buffer.readInt16LE(i) / 32768;
      sum += val * val;
    }
    return Math.min(1.0, Math.sqrt(sum / samples));
  }
}
