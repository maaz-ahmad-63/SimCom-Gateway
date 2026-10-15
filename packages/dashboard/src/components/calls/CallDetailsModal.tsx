'use client';

import React, { useEffect, useState } from 'react';
import { CallSession } from '@sim-gateway/shared';
import { apiClient, CallEventRecord } from '../../lib/api-client';
import { formatDate, formatDuration, getOutcomeBadge } from '../../lib/utils';
import { X, Clock, FileAudio, AlertCircle } from 'lucide-react';

interface CallDetailsModalProps {
  callId: string | null;
  onClose: () => void;
}

export function CallDetailsModal({ callId, onClose }: CallDetailsModalProps) {
  const [session, setSession] = useState<CallSession | null>(null);
  const [events, setEvents] = useState<CallEventRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) return;

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    apiClient
      .getCallById(callId)
      .then((res) => {
        if (isMounted) {
          setSession(res.call);
          setEvents(res.events);
        }
      })
      .catch((err) => {
        if (isMounted) setError(err.message);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [callId]);

  if (!callId) return null;

  const outcomeBadge = getOutcomeBadge(session?.outcome);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0f172a] border border-slate-800 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white font-mono flex items-center gap-2">
              <span>Call Details</span>
              {session?.isSimulated && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                  MOCK
                </span>
              )}
            </h2>
            <p className="text-[11px] text-slate-500 font-mono mt-0.5">{callId}</p>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-5 text-xs">
          {isLoading ? (
            <div className="py-12 text-center text-slate-500 font-mono">
              Loading call session timeline...
            </div>
          ) : error ? (
            <div className="p-3 rounded bg-rose-950/60 border border-rose-800 text-rose-400 font-mono flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : session ? (
            <>
              {/* Summary Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-slate-900/80 rounded-lg p-2.5 border border-slate-800/80">
                  <div className="text-[10px] text-slate-500 font-mono uppercase">Remote Party</div>
                  <div className="font-mono font-bold text-white mt-0.5 truncate">
                    {session.remoteNumber}
                  </div>
                </div>

                <div className="bg-slate-900/80 rounded-lg p-2.5 border border-slate-800/80">
                  <div className="text-[10px] text-slate-500 font-mono uppercase">Direction</div>
                  <div className="font-mono font-semibold text-slate-200 mt-0.5 capitalize">
                    {session.direction}
                  </div>
                </div>

                <div className="bg-slate-900/80 rounded-lg p-2.5 border border-slate-800/80">
                  <div className="text-[10px] text-slate-500 font-mono uppercase">Duration</div>
                  <div className="font-mono font-bold text-emerald-400 mt-0.5">
                    {formatDuration(session.durationSeconds)}
                  </div>
                </div>

                <div className="bg-slate-900/80 rounded-lg p-2.5 border border-slate-800/80">
                  <div className="text-[10px] text-slate-500 font-mono uppercase">Outcome</div>
                  <div className="mt-0.5">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono border ${outcomeBadge.className}`}
                    >
                      {outcomeBadge.label}
                    </span>
                  </div>
                </div>
              </div>

              {/* Timestamps */}
              <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-800/80 space-y-1.5 font-mono text-[11px]">
                <div className="flex justify-between">
                  <span className="text-slate-500">Initiated / Ring:</span>
                  <span className="text-slate-300">{formatDate(session.startedAt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Answered:</span>
                  <span className="text-slate-300">{formatDate(session.answeredAt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Terminated:</span>
                  <span className="text-slate-300">{formatDate(session.endedAt)}</span>
                </div>
                {session.terminationReason && (
                  <div className="flex justify-between border-t border-slate-800/60 pt-1.5">
                    <span className="text-slate-500">Reason:</span>
                    <span className="text-slate-400">{session.terminationReason}</span>
                  </div>
                )}
                {session.audioDumpPath && (
                  <div className="flex justify-between border-t border-slate-800/60 pt-1.5 items-center">
                    <span className="text-slate-500 flex items-center gap-1">
                      <FileAudio className="w-3.5 h-3.5" /> Audio Dump:
                    </span>
                    <span className="text-cyan-400 truncate max-w-xs">{session.audioDumpPath}</span>
                  </div>
                )}
              </div>

              {/* Event Timeline */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase font-mono tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" /> Chronological Event Timeline
                </h4>

                <div className="border border-slate-800/80 rounded-lg divide-y divide-slate-800/60 bg-slate-950/40 font-mono text-[11px]">
                  {events.length === 0 ? (
                    <div className="p-3 text-center text-slate-600">No events logged</div>
                  ) : (
                    events.map((evt) => (
                      <div key={evt.id} className="p-2.5 flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-slate-200">{evt.eventType}</div>
                          {evt.previousState && evt.currentState && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {evt.previousState} &rarr; {evt.currentState}
                            </div>
                          )}
                          {evt.payload && (
                            <pre className="text-[10px] text-slate-400 mt-1 max-w-md overflow-x-auto">
                              {JSON.stringify(evt.payload)}
                            </pre>
                          )}
                        </div>

                        <span className="text-[10px] text-slate-500 whitespace-nowrap shrink-0">
                          {formatDate(evt.timestamp)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
