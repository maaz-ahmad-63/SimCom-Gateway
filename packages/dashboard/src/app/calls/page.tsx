'use client';

import React from 'react';
import { CallHistoryTable } from '../../components/calls/CallHistoryTable';
import { History } from 'lucide-react';

export default function CallsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800/80 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            <History className="w-5 h-5 text-purple-400" />
            Call History & Events
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Complete audit trail of all inbound, outbound, and simulated cellular calls stored in SQLite.
          </p>
        </div>
      </div>

      <CallHistoryTable />
    </div>
  );
}
