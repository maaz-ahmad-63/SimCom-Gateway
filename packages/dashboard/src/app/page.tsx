'use client';

import React from 'react';
import { useGateway } from '../lib/context/GatewayContext';
import { ActiveCallCard } from '../components/dashboard/ActiveCallCard';
import { VuMeter } from '../components/dashboard/VuMeter';
import { ModemTelemetryCard } from '../components/dashboard/ModemTelemetryCard';
import { QuickInboundTrigger } from '../components/dashboard/QuickInboundTrigger';
import { RecentCallsList } from '../components/dashboard/RecentCallsList';
import { AlertCircle, X } from 'lucide-react';

export default function DashboardPage() {
  const { recentAlerts, clearAlerts, error } = useGateway();

  return (
    <div className="space-y-6">
      {/* Page Title */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800/80 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            Gateway Operations
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time modem telemetry, live call monitoring, and audio diagnostics.
          </p>
        </div>
      </div>

      {/* Connection Error Banner */}
      {error && (
        <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs font-mono flex items-center gap-3">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
          <div className="flex-1">
            <span className="font-semibold">Gateway Connection Error: </span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Gateway System Alerts */}
      {recentAlerts.length > 0 && (
        <div className="space-y-2">
          {recentAlerts.slice(0, 2).map((alert, idx) => (
            <div
              key={idx}
              className="p-3 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-300 text-xs font-mono flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                <span>{alert.message}</span>
              </div>
              <button
                onClick={clearAlerts}
                className="text-amber-500 hover:text-amber-300 transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Responsive Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Column (2 cols) */}
        <div className="lg:col-span-2 space-y-6">
          <ActiveCallCard />
          <VuMeter />
          <RecentCallsList />
        </div>

        {/* Right Column (1 col) */}
        <div className="space-y-6">
          <ModemTelemetryCard />
          <QuickInboundTrigger />
        </div>
      </div>
    </div>
  );
}
