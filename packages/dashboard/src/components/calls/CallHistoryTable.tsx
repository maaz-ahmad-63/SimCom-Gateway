'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CallSession } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { formatDate, formatDuration, getOutcomeBadge } from '../../lib/utils';
import { nextRecordingAction, NotRecordedInfo, recordingAvailability, RecordingInfo } from '../../lib/recordings';
import { CallDetailsModal } from './CallDetailsModal';
import { PlayerHandle, RecordingActionButton, RecordingPlayer } from './RecordingPlayer';
import {
  PhoneIncoming,
  PhoneOutgoing,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Eye,
  Filter,
} from 'lucide-react';

export function CallHistoryTable() {
  const [calls, setCalls] = useState<CallSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [limit] = useState(15);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('ALL');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  // What the gateway says about each call's recording on this page (null: it did not answer, so Play simply tries).
  const [recordings, setRecordings] = useState<Map<string, RecordingInfo> | null>(null);
  // Why a connected call was not recorded (recording off, consent missing, failed to start), as the gateway noted it.
  const [notRecorded, setNotRecorded] = useState<Map<string, NotRecordedInfo> | null>(null);
  // The call whose recording row is open under it (a player, or the reason there is no recording), and whether its audio is playing.
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const player = useRef<PlayerHandle | null>(null);

  const loadRecordings = async (ids: string[]) => {
    try {
      const res = await apiClient.getRecordings(ids);
      setRecordings(new Map(res.recordings.map((r) => [r.callId, r])));
      setNotRecorded(new Map((res.notRecorded ?? []).map((n) => [n.callId, n])));
    } catch {
      setRecordings(null); // not known: Play is offered and reports what happens when pressed
      setNotRecorded(null);
    }
  };

  /** Play (or pause/resume) this call's recording; a call with no recording opens its reason instead. */
  const onRecordingAction = (callId: string) => {
    const action = nextRecordingAction(openCallId, callId, recordingAvailability(calls.find((c) => c.id === callId) ?? { id: callId }, recordings, notRecorded));
    if (action === 'toggle') {
      player.current?.toggle();
    } else if (action === 'close') {
      setOpenCallId(null);
    } else {
      setPlaying(false);
      setOpenCallId(callId);
    }
  };

  const fetchCalls = async () => {
    try {
      setIsLoading(true);
      const res = await apiClient.listCalls({
        limit,
        offset: page * limit,
      });
      setCalls(res.calls);
      setTotal(res.total);
      setOpenCallId(null);
      void loadRecordings(res.calls.map((c) => c.id));
    } catch (err) {
      console.error('Failed to load call history:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCalls();
  }, [page]);

  // Client-side filtering across current page
  const filteredCalls = calls.filter((call) => {
    const matchesSearch =
      searchQuery === '' ||
      call.remoteNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      call.id.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesOutcome =
      outcomeFilter === 'ALL' ||
      (outcomeFilter === 'COMPLETED' && call.outcome === 'completed') ||
      (outcomeFilter === 'MISSED' && call.outcome === 'missed') ||
      (outcomeFilter === 'REJECTED' && (call.outcome === 'rejected' || call.outcome === 'busy_rejected')) ||
      (outcomeFilter === 'BUSY' && call.outcome === 'busy');

    return matchesSearch && matchesOutcome;
  });

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-surface border border-slate-800 rounded-lg p-3">
        {/* Search */}
        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search number or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
          />
        </div>

        {/* Filter & Refresh */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-xs font-mono text-slate-300">
            <Filter className="w-3 h-3 text-slate-500" />
            <select
              value={outcomeFilter}
              onChange={(e) => setOutcomeFilter(e.target.value)}
              className="bg-transparent border-none text-xs text-slate-300 focus:outline-none cursor-pointer"
            >
              <option value="ALL">All Outcomes</option>
              <option value="COMPLETED">Completed</option>
              <option value="MISSED">Missed</option>
              <option value="REJECTED">Rejected</option>
              <option value="BUSY">Busy</option>
            </select>
          </div>

          <button
            onClick={() => fetchCalls()}
            disabled={isLoading}
            className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-white transition disabled:opacity-50"
            title="Refresh History"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="border border-slate-800 rounded-lg bg-slate-900/40 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/70 text-[11px] uppercase tracking-wide font-medium tracking-wider text-slate-400">
                <th className="py-3 px-4">Remote Number</th>
                <th className="py-3 px-3">Direction</th>
                <th className="py-3 px-3">Duration</th>
                <th className="py-3 px-3">Outcome</th>
                <th className="py-3 px-3">Timestamp</th>
                <th className="py-3 px-3">Mode</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Loading call history...
                  </td>
                </tr>
              ) : filteredCalls.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    No calls found matching current filters.
                  </td>
                </tr>
              ) : (
                filteredCalls.map((call) => {
                  const isInbound = call.direction === 'inbound';
                  const outcomeBadge = getOutcomeBadge(call.outcome);
                  const availability = recordingAvailability(call, recordings, notRecorded);
                  const isOpen = openCallId === call.id;

                  return (
                    <React.Fragment key={call.id}>
                    <tr
                      className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                      onClick={() => setSelectedCallId(call.id)}
                    >
                      <td className="py-3 px-4 font-semibold text-white">
                        {call.remoteNumber}
                      </td>

                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] capitalize border ${
                            isInbound
                              ? 'bg-cyan-950/60 text-cyan-400 border-cyan-800/60'
                              : 'bg-emerald-950/60 text-emerald-400 border-emerald-800/60'
                          }`}
                        >
                          {isInbound ? (
                            <PhoneIncoming className="w-3 h-3" />
                          ) : (
                            <PhoneOutgoing className="w-3 h-3" />
                          )}
                          <span>{call.direction}</span>
                        </span>
                      </td>

                      <td className="py-3 px-3 text-slate-300">
                        {formatDuration(call.durationSeconds)}
                      </td>

                      <td className="py-3 px-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] border ${outcomeBadge.className}`}
                        >
                          {outcomeBadge.label}
                        </span>
                      </td>

                      <td className="py-3 px-3 text-slate-400">
                        {formatDate(call.startedAt)}
                      </td>

                      <td className="py-3 px-3">
                        {call.isSimulated ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950/80 text-cyan-400 border border-cyan-800/60">
                            MOCK
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
                            HW
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <RecordingActionButton availability={availability} open={isOpen} playing={playing} onClick={() => onRecordingAction(call.id)} />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedCallId(call.id);
                            }}
                            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition"
                            title="Inspect Call Timeline"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-950/50">
                        <td colSpan={7} className="px-4 py-3 font-sans">
                          {availability.state === 'none' ? (
                            <p role="status" className="text-xs text-slate-400">{availability.reason}</p>
                          ) : (
                            <RecordingPlayer
                              key={call.id}
                              callId={call.id}
                              recording={availability.state === 'available' ? availability.recording : null}
                              handleRef={player}
                              onPlayingChange={setPlaying}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="px-4 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between text-xs font-mono text-slate-400">
          <div>
            Total Calls: <span className="text-white font-semibold">{total}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 rounded bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-900 transition"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>

            <span>
              Page {page + 1} of {Math.max(1, totalPages)}
            </span>

            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= totalPages}
              className="p-1 rounded bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-900 transition"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Call Details Modal */}
      {selectedCallId && (
        <CallDetailsModal
          callId={selectedCallId}
          onClose={() => setSelectedCallId(null)}
        />
      )}
    </div>
  );
}
