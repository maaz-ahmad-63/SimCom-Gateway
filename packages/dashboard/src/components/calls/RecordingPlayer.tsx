'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, MicOff, Pause, Play, RotateCcw } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import { formatPosition, loadRecordingUrl, progressPercent, RecordingAvailability, RecordingInfo, recordingSummary } from '../../lib/recordings';

export type PlayerPhase = 'loading' | 'ready' | 'error';

export interface PlayerViewProps {
  phase: PlayerPhase;
  /** Why loading or playing failed (phase 'error'), in a sentence. */
  error: string | null;
  playing: boolean;
  position: number;
  duration: number;
  /** What the call history knows about the recording, for the one-line description. */
  recording?: RecordingInfo | null;
  fileName: string;
  /** The browser's copy of the recording (an object URL), once loaded. */
  url: string | null;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onRetry: () => void;
}

/** What the player shows, with no state of its own, so every state (loading, ready, playing, paused, failed) can be drawn and tested. */
export function RecordingPlayerView(p: PlayerViewProps) {
  const percent = progressPercent(p.position, p.duration);
  return (
    <div className="flex flex-col gap-2 text-xs" aria-label="Recording player">
      {p.phase === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the recording…
        </p>
      )}
      {p.phase === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-rose-300">
          <span>{p.error ?? 'The recording could not be played.'}</span>
          <button type="button" onClick={p.onRetry} className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700">
            <RotateCcw className="w-3 h-3" /> Try again
          </button>
        </div>
      )}
      {p.phase === 'ready' && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={p.onToggle}
            aria-label={p.playing ? 'Pause recording' : 'Play recording'}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cyan-700 hover:bg-cyan-600 text-primary-foreground"
          >
            {p.playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={p.duration > 0 ? p.duration : 1}
            step={0.1}
            value={Math.min(p.position, p.duration > 0 ? p.duration : 1)}
            onChange={(e) => p.onSeek(Number(e.target.value))}
            aria-label="Playback position"
            aria-valuetext={formatPosition(p.position, p.duration)}
            className="flex-1 min-w-[140px] accent-cyan-500"
          />
          <span className="font-mono text-slate-300 tabular-nums" aria-label="Playback time">{formatPosition(p.position, p.duration)}</span>
          <div role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className="sr-only" />
          {p.url && (
            <a href={p.url} download={p.fileName} className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700" aria-label={`Download ${p.fileName}`}>
              <Download className="w-3 h-3" /> Download
            </a>
          )}
        </div>
      )}
      {p.recording && <p className="text-[11px] text-slate-500">{recordingSummary(p.recording)}</p>}
    </div>
  );
}

export interface PlayerHandle {
  toggle: () => void;
}

/**
 * The call history's button for one call, in the Actions column beside the View icon: Play (or Pause while this call's recording is
 * playing) when there is a recording, and a muted "no recording" icon, whose tooltip and click say why, when there is not.
 */
export function RecordingActionButton({
  availability,
  open,
  playing,
  onClick,
}: {
  availability: RecordingAvailability;
  /** This call's player is open. */
  open: boolean;
  playing: boolean;
  onClick: () => void;
}) {
  if (availability.state === 'none') {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="p-1 rounded text-slate-600 hover:bg-slate-800 hover:text-slate-400 transition"
        title={availability.reason}
        aria-label="No recording for this call"
        aria-expanded={open}
      >
        <MicOff className="w-3.5 h-3.5" />
      </button>
    );
  }
  const showPause = open && playing;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="p-1 rounded hover:bg-slate-700 text-cyan-400 hover:text-cyan-300 transition"
      title={showPause ? 'Pause the recording' : 'Play the recording of this call'}
      aria-label={showPause ? 'Pause recording' : 'Play recording'}
      aria-expanded={open}
    >
      {showPause ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
    </button>
  );
}

/**
 * Plays one call's recording. The file is fetched with the API key (the gateway never serves a recording without it), kept as a copy in
 * the browser, and played from there; closing the player releases the copy. Pause, resume and seeking work on that copy.
 */
export function RecordingPlayer({
  callId,
  recording,
  handleRef,
  onPlayingChange,
}: {
  callId: string;
  recording?: RecordingInfo | null;
  /** The call history's Play button drives pause and resume through this. */
  handleRef?: React.MutableRefObject<PlayerHandle | null>;
  onPlayingChange?: (playing: boolean) => void;
}) {
  const [phase, setPhase] = useState<PlayerPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(recording ? recording.durationMs / 1000 : 0);
  const audio = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);
  const attempt = useRef(0);

  const setPlayingState = useCallback(
    (next: boolean) => {
      setPlaying(next);
      onPlayingChange?.(next);
    },
    [onPlayingChange]
  );

  const load = useCallback(async () => {
    const mine = ++attempt.current;
    setPhase('loading');
    setError(null);
    setPlayingState(false);
    setPosition(0);
    try {
      const loaded = await loadRecordingUrl(callId, { download: (id) => apiClient.downloadRecording(id), createObjectUrl: (blob) => URL.createObjectURL(blob) });
      if (mine !== attempt.current) {
        URL.revokeObjectURL(loaded.url); // closed, or another attempt started: nobody will play this copy
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = loaded.url;
      setUrl(loaded.url);
      setPhase('ready');
    } catch (e) {
      if (mine !== attempt.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [callId, setPlayingState]);

  useEffect(() => {
    void load();
    return () => {
      attempt.current++;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [load]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch((e: Error) => {
        // A browser may refuse to start sound on its own (an autoplay policy): the recording is loaded, so just leave it paused for the
        // person to press Play. Anything else is a real failure and is said.
        if (e.name === 'NotAllowedError' || e.name === 'AbortError') return;
        setError(`The browser would not start playback: ${e.message}`);
        setPhase('error');
      });
    } else {
      el.pause();
    }
  }, []);

  useEffect(() => {
    if (handleRef) handleRef.current = { toggle };
    return () => {
      if (handleRef) handleRef.current = null;
    };
  }, [handleRef, toggle]);

  // Start as soon as the copy is in the browser (the person pressed Play).
  useEffect(() => {
    if (phase === 'ready') toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === 'ready' && url]);

  return (
    <>
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="auto"
          onPlay={() => setPlayingState(true)}
          onPause={() => setPlayingState(false)}
          onEnded={() => setPlayingState(false)}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          onError={() => {
            setError('The browser could not play this recording (the file may be damaged or in a format it does not support).');
            setPhase('error');
            setPlayingState(false);
          }}
        />
      )}
      <RecordingPlayerView
        phase={phase}
        error={error}
        playing={playing}
        position={position}
        duration={duration}
        recording={recording}
        fileName={`call-${callId.slice(0, 8)}.wav`}
        url={url}
        onToggle={toggle}
        onSeek={(seconds) => {
          if (audio.current) audio.current.currentTime = seconds;
          setPosition(seconds);
        }}
        onRetry={() => void load()}
      />
    </>
  );
}
