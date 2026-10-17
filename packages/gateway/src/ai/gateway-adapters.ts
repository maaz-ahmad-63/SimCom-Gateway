import { AudioFrame, IAudioAdapter } from '@sim-gateway/shared';
import { playPcmPaced } from '../adapters/audio/paced-playback.js';
import { AgentAudioSink, AudioFormat, CallerAudioSource, PlayResult } from './audio.js';

/**
 * The only two places the AI engine touches the SIM7600EI audio transport. Both go through the
 * gateway's existing IAudioAdapter (the single open COM26 handle) and add nothing to it: no extra
 * port handle, no AT commands, no change to the USB audio registration.
 *
 * `verified` is whatever the operator has established by listening/hearing (AI_AUDIO_*_VERIFIED);
 * these classes never infer it from bytes flowing.
 */
export class GatewayAudioSource implements CallerAudioSource {
  constructor(
    private readonly audio: IAudioAdapter,
    readonly format: AudioFormat,
    readonly verified: boolean,
    /** Frames are dropped unless this is true, so audio can only reach the session of the live call. */
    private readonly accept: () => boolean
  ) {}

  onAudio(listener: (pcm: Buffer) => void): () => void {
    const handler = (frame: AudioFrame) => {
      if (this.accept()) listener(Buffer.from(frame.data));
    };
    this.audio.on('audio_frame', handler);
    return () => this.audio.off('audio_frame', handler);
  }
}

export class GatewayAudioSink implements AgentAudioSink {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly audio: IAudioAdapter,
    readonly format: AudioFormat,
    readonly verified: boolean,
    private readonly isCallActive: () => boolean
  ) {}

  /** Plays are serialized: two sentences never interleave on the port. */
  play(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    const run = this.writing.then(() => this.playNow(pcm, signal));
    this.writing = run.catch(() => {});
    return run;
  }

  private async playNow(pcm: Buffer, signal: AbortSignal): Promise<PlayResult> {
    if (!this.audio.getStats().isStreaming) {
      throw new Error('Audio port is not streaming; refusing to write playback');
    }
    const before = this.audio.getStats().bytesSent;
    const result = await playPcmPaced((chunk) => this.audio.writeAudioChunk(chunk), pcm, {
      sampleRate: this.format.sampleRate,
      shouldStop: () => (signal.aborted ? 'aborted' : !this.isCallActive() ? 'call-ended' : null),
    });
    // Counted from the adapter, so a chunk it dropped silently is not reported as played.
    const bytesWritten = this.audio.getStats().bytesSent - before;
    const completed = result.stoppedBy === null && bytesWritten === pcm.length;
    return {
      bytesWritten,
      completed,
      stoppedBy: completed ? null : (result.stoppedBy ?? 'not-written'),
      lateFrames: result.lateFrames,
      maxLateMs: Math.round(result.maxLateMs),
    };
  }
}
