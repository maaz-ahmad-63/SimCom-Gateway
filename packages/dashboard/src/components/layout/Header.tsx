'use client';

import React from 'react';
import Link from 'next/link';
import { useGateway } from '../../lib/context/GatewayContext';
import { Radio, RefreshCw, Settings, ShieldCheck, Wifi, WifiOff } from 'lucide-react';

export function Header() {
  const { connectionState, health, telemetry, isSimulated, refreshHealth, isLoading } =
    useGateway();

  const signalBars = telemetry.signal?.bars ?? 0;
  const rssi = telemetry.signal?.rssi ?? 0;
  const dBm = telemetry.signal?.dBm ?? null;
  const carrier = telemetry.network?.operatorName ?? health?.modem?.network?.operatorName ?? 'Vi India';

  return (
    <header className="h-14 border-b border-slate-800 bg-[#090d16]/90 backdrop-blur sticky top-0 z-40 px-4 md:px-6 flex items-center justify-between">
      {/* Left: Branding & Driver Status */}
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 text-slate-100 hover:text-white transition">
          <div className="h-6 w-6 rounded bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center font-mono font-bold text-xs text-white shadow-sm">
            SIM
          </div>
          <span className="font-semibold text-sm tracking-tight hidden sm:inline">
            SIM7600EI Gateway
          </span>
        </Link>

        {/* Driver Type Badge */}
        {isSimulated ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-cyan-950/80 text-cyan-400 border border-cyan-800/60">
            MOCK SIMULATION
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
            PHYSICAL HARDWARE
          </span>
        )}
      </div>

      {/* Right: Network telemetry, Connection Status, Actions */}
      <div className="flex items-center gap-3 text-xs">
        {/* Carrier & Signal Quality */}
        <div className="hidden md:flex items-center gap-2.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono">
          <Radio className="w-3.5 h-3.5 text-cyan-400" />
          <span>{carrier}</span>
          <span className="text-slate-600">&bull;</span>
          {/* Signal Bars Visualizer */}
          <div className="flex items-end gap-0.5 h-3">
            {[1, 2, 3, 4, 5].map((bar) => (
              <div
                key={bar}
                className={`w-1 rounded-sm transition-all ${
                  bar <= signalBars
                    ? signalBars >= 3
                      ? 'bg-emerald-400'
                      : 'bg-amber-400'
                    : 'bg-slate-700'
                }`}
                style={{ height: `${bar * 20}%` }}
              />
            ))}
          </div>
          {dBm !== null && <span className="text-slate-400 text-[10px]">{dBm} dBm</span>}
        </div>

        {/* Socket.IO Connection State */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800 font-mono">
          {connectionState === 'connected' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400">ONLINE</span>
            </>
          ) : connectionState === 'connecting' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
              <span className="text-amber-400">CONNECTING</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3 h-3 text-rose-400" />
              <span className="text-rose-400">OFFLINE</span>
            </>
          )}
        </div>

        {/* Refresh Button */}
        <button
          onClick={() => refreshHealth()}
          disabled={isLoading}
          title="Refresh Gateway Health"
          className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>

        {/* Settings Link */}
        <Link
          href="/settings"
          title="Gateway Settings"
          className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
        >
          <Settings className="w-3.5 h-3.5" />
        </Link>
      </div>
    </header>
  );
}
