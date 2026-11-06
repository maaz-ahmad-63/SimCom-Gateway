'use client';

import React, { Suspense } from 'react';
import { Activity } from 'lucide-react';
import { ObservabilityView } from '../../components/observability/ObservabilityView';

export default function ObservabilityPage() {
  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800/80 pb-4">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2">
          <Activity className="w-5 h-5 text-cyan-400" />
          Call Logs & Observability
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Per-call, per-turn timings and errors recorded by the gateway as calls happen. A missing figure means it was not measured, not that it was zero.
        </p>
      </div>
      <Suspense fallback={<p className="text-xs text-slate-400">Loading call logs…</p>}>
        <ObservabilityView />
      </Suspense>
    </div>
  );
}
