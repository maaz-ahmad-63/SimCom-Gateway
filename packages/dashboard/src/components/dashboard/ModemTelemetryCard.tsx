'use client';

import React from 'react';
import { useGateway } from '../../lib/context/GatewayContext';
import { formatDuration } from '../../lib/utils';
import { Cpu, HardDrive, Radio, Signal, Server } from 'lucide-react';

export function ModemTelemetryCard() {
  const { health, telemetry, isSimulated } = useGateway();

  const model = health?.modem?.info?.model || 'SIMCOM_SIM7600EI';
  const firmware = health?.modem?.info?.firmwareRevision || 'SIM7600M21-A_V1.1';
  const carrier = telemetry.network?.operatorName || health?.modem?.network?.operatorName || 'Vi India';
  const regStatus = telemetry.network?.registration || health?.modem?.network?.registration || 'REGISTERED_HOME';
  const signal = telemetry.signal || health?.modem?.signal;
  const uptime = health?.uptimeSeconds ? formatDuration(health.uptimeSeconds) : '—';
  const memoryMb = health?.system?.memoryUsageMb ?? 0;
  const platform = health?.system?.platform ?? '—';

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-emerald-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Modem & Gateway Telemetry
          </h3>
        </div>

        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
          v0.1.0
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        {/* Hardware Model */}
        <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80">
          <div className="text-[10px] text-slate-500 uppercase font-mono flex items-center gap-1.5">
            <Cpu className="w-3 h-3 text-slate-400" /> Device Model
          </div>
          <div className="font-mono font-semibold text-white mt-1 truncate">{model}</div>
          <div className="text-[10px] text-slate-400 font-mono mt-0.5">{firmware}</div>
        </div>

        {/* Carrier & Registration */}
        <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80">
          <div className="text-[10px] text-slate-500 uppercase font-mono flex items-center gap-1.5">
            <Radio className="w-3 h-3 text-cyan-400" /> Cellular Carrier
          </div>
          <div className="font-mono font-semibold text-white mt-1">{carrier}</div>
          <div className="text-[10px] text-emerald-400 font-mono mt-0.5">
            {regStatus.replace('_', ' ')}
          </div>
        </div>

        {/* Signal Quality */}
        <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80">
          <div className="text-[10px] text-slate-500 uppercase font-mono flex items-center gap-1.5">
            <Signal className="w-3 h-3 text-amber-400" /> Signal Quality
          </div>
          <div className="font-mono font-semibold text-white mt-1">
            RSSI {signal?.rssi ?? '—'} / 31
          </div>
          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
            {signal?.dBm !== null ? `${signal?.dBm} dBm (${signal?.bars}/5 bars)` : 'No signal'}
          </div>
        </div>

        {/* Host System & Ports */}
        <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80">
          <div className="text-[10px] text-slate-500 uppercase font-mono flex items-center gap-1.5">
            <HardDrive className="w-3 h-3 text-purple-400" /> Host & Runtime
          </div>
          <div className="font-mono font-semibold text-white mt-1 capitalize">{platform} host</div>
          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
            Uptime: {uptime} &bull; {memoryMb}MB RSS
          </div>
        </div>
      </div>
    </div>
  );
}
