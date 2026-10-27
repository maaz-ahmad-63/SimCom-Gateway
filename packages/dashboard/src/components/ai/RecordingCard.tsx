'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { formatDuration, recorderState, recordingSummary, RecordingsResponse } from '../../lib/recordings';
import { Badge, Card } from './ui';

/** Presentational so it can be rendered and tested without a gateway. */
export function RecordingPanel({
  data,
  error,
  onDownload,
}: {
  data: RecordingsResponse | null;
  error: string | null;
  onDownload: (callId: string, track: 'caller' | 'agent') => void;
}) {
  const state = recorderState(data?.status ?? null);
  return (
    <Card
      title="Call recordings"
      subtitle="Complete-call recordings (caller and agent tracks as WAV), separate from the diagnostic captures. Recording needs CALL_RECORDING_ENABLED and an acknowledgement that you have handled notice and consent."
      actions={<Badge tone={state.tone}>{state.label}</Badge>}
    >
      <p className="text-xs text-slate-300">{state.detail}</p>
      {error && (
        <p role="alert" className="text-xs text-rose-300 font-mono">
          {error}
        </p>
      )}
      {data && data.recordings.length === 0 && <p className="text-xs text-slate-500">No recordings yet.</p>}
      <ul className="space-y-2">
        {data?.recordings.slice(0, 10).map((r) => (
          <li key={r.callId} className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 text-xs space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-slate-200">
              <span>{new Date(r.startedAt).toLocaleString()}</span>
              <span>
                {r.direction} · caller {formatDuration(r.tracks.caller.durationMs)} · agent {formatDuration(r.tracks.agent.durationMs)}
              </span>
            </div>
            <p className="text-slate-400">{recordingSummary(r)}</p>
            <div className="flex gap-2">
              {(['caller', 'agent'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onDownload(r.callId, t)}
                  className="rounded bg-slate-800 px-2 py-1 text-[11px] text-white hover:bg-slate-700"
                >
                  Download {t}.wav
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function RecordingCard() {
  const [data, setData] = useState<RecordingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await apiClient.getRecordings());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const download = async (callId: string, track: 'caller' | 'agent') => {
    try {
      const blob = await apiClient.downloadRecording(callId, track);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${callId}-${track}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return <RecordingPanel data={data} error={error} onDownload={download} />;
}
