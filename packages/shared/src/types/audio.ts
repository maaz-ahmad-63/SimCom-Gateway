import { Readable, Writable } from 'node:stream';

/**
 * Audio interface definitions.
 * NOTE: The SIM7600EI COM13 virtual audio stream receives data during calls,
 * but audio encoding, framing, and bidirectional transfer are unverified.
 * The audio layer treats data as raw byte streams with zero formatting assumptions
 * until validated on physical hardware.
 */

export interface AudioFormatSpec {
  /** Target sample rate in Hz (e.g., 8000 for standard GSM/PSTN) */
  sampleRate: number;
  /** Number of channels (1 for mono) */
  channels: number;
  /** Bit depth (typically 16-bit linear PCM or 8-bit A-law/u-law) */
  bitDepth: number;
  /** Endianness */
  endianness: 'little-endian' | 'big-endian';
  /** Known or suspected codec: 'raw-pcm' | 'alaw' | 'mulaw' | 'amr' | 'unvalidated' */
  codec: 'raw-pcm' | 'alaw' | 'mulaw' | 'amr' | 'unvalidated';
}

export interface AudioFrame {
  /** Sequential frame sequence index */
  sequenceNumber: number;
  /** Milliseconds duration represented by this frame (e.g. 20ms) */
  frameDurationMs: number;
  /** Raw binary data received from the audio port or synthesized */
  data: Buffer;
  /** High-resolution timestamp */
  timestamp: number;
  /** Calculated RMS level (0.0 to 1.0) for live VU meters */
  rmsLevel: number;
  isSimulated: boolean;
}

export interface AudioStreamStats {
  bytesReceived: number;
  bytesSent: number;
  framesReceived: number;
  framesSent: number;
  currentRmsInbound: number;
  currentRmsOutbound: number;
  droppedFrames: number;
  isStreaming: boolean;
}

export interface AudioDumpOptions {
  enabled: boolean;
  destinationDir: string;
  callId: string;
}

/**
 * Pluggable audio adapter interface for hardware (COM13) and mock generators.
 */
export interface IAudioAdapter {
  readonly isSimulated: boolean;
  
  /** Start audio capture and playback for a given call */
  startSession(callId: string): Promise<void>;
  
  /** Stop active audio session and close streams */
  stopSession(): Promise<void>;
  
  /** Write raw PCM/binary audio chunk to the modem playback line */
  writeAudioChunk(chunk: Buffer): Promise<void>;

  /** Get live audio stream statistics */
  getStats(): AudioStreamStats;

  /** Readable stream of incoming audio from remote caller */
  getInboundStream(): Readable | null;

  /** Writable stream for outgoing audio to remote caller */
  getOutboundStream(): Writable | null;

  /** Event listeners */
  on(event: 'audio_frame', listener: (frame: AudioFrame) => void): this;
  on(event: 'stats', listener: (stats: AudioStreamStats) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
