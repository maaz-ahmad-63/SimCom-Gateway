'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CallSession } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { useGateway } from '../../lib/context/GatewayContext';
import { formatDuration, formatDate, getOutcomeBadge } from '../../lib/utils';
import { History, PhoneIncoming, PhoneOutgoing, ArrowRight } from 'lucide-react';

export function RecentCallsList() {
  const { lastCallEnded, activeCall } = useGateway();
  const [calls, setCalls] = useState<CallSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadRecentCalls = async () => {
    try {
      const res = await apiClient.listCalls({ limit: 5, offset: 0 });
      setCalls(res.calls);
    } catch {
      // Continue gracefully if offline
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadRecentCalls();
  }, [lastCallEnded, activeCall?.state]);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-purple-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Recent Calls
          </h3>
        </div>

        <Link
          href="/calls"
          className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1 transition"
        >
          <span>View All</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-xs text-slate-500 font-mono">
          Loading recent calls...
        </div>
      ) : calls.length === 0 ? (
        <div className="py-6 text-center text-xs text-slate-500 font-mono">
          No calls recorded yet.
        </div>
      ) : (
        <div className="divide-y divide-slate-800/60">
          {calls.map((call) => {
            const outcomeBadge = getOutcomeBadge(call.outcome);
            const isInbound = call.direction === 'inbound';

            return (
              <div key={call.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${
                      isInbound
                        ? 'bg-cyan-950/80 text-cyan-400 border border-cyan-800/60'
                        : 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60'
                    }`}
                  >
                    {isInbound ? (
                      <PhoneIncoming className="w-3.5 h-3.5" />
                    ) : (
                      <PhoneOutgoing className="w-3.5 h-3.5" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="font-mono font-medium text-white truncate">
                      {call.remoteNumber}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {formatDate(call.startedAt)}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono text-slate-300 text-[11px]">
                    {formatDuration(call.durationSeconds)}
                  </span>

                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border ${outcomeBadge.className}`}
                  >
                    {outcomeBadge.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
