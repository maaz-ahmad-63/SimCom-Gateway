'use client';

import React from 'react';
import { useGateway } from '../../lib/context/GatewayContext';
import { Activity, Volume2 } from 'lucide-react';

export function VuMeter() {
  const { activeCall, audioLevel, health } = useGateway();

  const isStreaming = activeCall?.state === 'ACTIVE' || health?.audioStreaming;
  const inboundRms = audioLevel.inboundRms;
  const outboundRms = audioLevel.outboundRms;

  // Convert RMS (0 to 1) to percentage (0 to 100)
  const inboundPercent = Math.min(100, Math.round(inboundRms * 140));
  const outboundPercent = Math.min(100, Math.round(outboundRms * 140));

  const totalSegments = 16;
  const activeInboundSegments = Math.round((inboundPercent / 100) * totalSegments);
  const activeOutboundSegments = Math.round((outboundPercent / 100) * totalSegments);

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Audio Stream (COM19)
          </h3>
        </div>

        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold border ${
            isStreaming
              ? 'bg-cyan-950/80 text-cyan-400 border-cyan-800/80 animate-pulse'
              : 'bg-slate-800 text-slate-500 border-slate-700/60'
          }`}
        >
          {isStreaming ? 'STREAMING' : 'STANDBY'}
        </span>
      </div>

      <p className="text-[11px] text-slate-400">
        Live RMS audio power levels sampled from the modem USB audio interface.
      </p>

      {/* Meter Bars */}
      <div className="space-y-3 pt-1">
        {/* Inbound RX Meter */}
        <div>
          <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
            <span className="text-slate-400 flex items-center gap-1.5">
              <Volume2 className="w-3 h-3 text-cyan-400" /> RX (Inbound Caller)
            </span>
            <span className="text-slate-300 font-semibold">{inboundPercent}%</span>
          </div>

          <div className="flex gap-1 h-3 bg-slate-950 rounded p-0.5 border border-slate-800/80">
            {Array.from({ length: totalSegments }).map((_, idx) => {
              const isLit = idx < activeInboundSegments;
              let color = 'bg-emerald-500';
              if (idx >= 11 && idx < 14) color = 'bg-amber-400';
              if (idx >= 14) color = 'bg-rose-500';

              return (
                <div
                  key={idx}
                  className={`flex-1 rounded-[1px] transition-colors duration-75 ${
                    isLit ? color : 'bg-slate-800/40'
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Outbound TX Meter */}
        <div>
          <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
            <span className="text-slate-400 flex items-center gap-1.5">
              <Volume2 className="w-3 h-3 text-blue-400" /> TX (Outbound Mic / AI)
            </span>
            <span className="text-slate-300 font-semibold">{outboundPercent}%</span>
          </div>

          <div className="flex gap-1 h-3 bg-slate-950 rounded p-0.5 border border-slate-800/80">
            {Array.from({ length: totalSegments }).map((_, idx) => {
              const isLit = idx < activeOutboundSegments;
              let color = 'bg-blue-500';
              if (idx >= 11 && idx < 14) color = 'bg-amber-400';
              if (idx >= 14) color = 'bg-rose-500';

              return (
                <div
                  key={idx}
                  className={`flex-1 rounded-[1px] transition-colors duration-75 ${
                    isLit ? color : 'bg-slate-800/40'
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
