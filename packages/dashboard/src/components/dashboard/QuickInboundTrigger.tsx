'use client';

import React, { useState } from 'react';
import { useGateway } from '../../lib/context/GatewayContext';
import { PhoneIncoming, Play, AlertCircle, CheckCircle2 } from 'lucide-react';

export function QuickInboundTrigger() {
  const { isSimulated, triggerMockInbound, activeCall } = useGateway();
  const [phoneNumber, setPhoneNumber] = useState('+919876543210');
  const [ringCount, setRingCount] = useState(5);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!isSimulated) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 text-xs text-slate-500 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-slate-600 shrink-0" />
        <span>Mock simulation triggers are disabled when connected to physical modem hardware.</span>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    setIsLoading(true);

    try {
      await triggerMockInbound({
        phoneNumber,
        ringCount,
      });
      setStatusMessage({
        type: 'success',
        text: `Simulated inbound call ringing from ${phoneNumber}...`,
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: (err as Error).message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const isCallInProgress = Boolean(activeCall && activeCall.state !== 'IDLE');

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PhoneIncoming className="w-4 h-4 text-cyan-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Mock Inbound Call Simulator
          </h3>
        </div>

        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
          DEV TOOL
        </span>
      </div>

      <p className="text-[11px] text-slate-400">
        Trigger an emulated GSM incoming call with caller ID to test the gateway state machine and audio streaming.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="sm:col-span-2">
            <label className="block text-[10px] font-mono uppercase text-slate-500 mb-1">
              Caller Phone Number (E.164)
            </label>
            <input
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+919876543210"
              className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-1.5 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              required
            />
          </div>

          <div>
            <label className="block text-[10px] font-mono uppercase text-slate-500 mb-1">
              Max Rings
            </label>
            <input
              type="number"
              min="1"
              max="15"
              value={ringCount}
              onChange={(e) => setRingCount(parseInt(e.target.value, 10) || 5)}
              className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={isLoading || isCallInProgress}
          className="w-full py-2 px-3 rounded-md text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white transition flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          <span>
            {isLoading
              ? 'Triggering...'
              : isCallInProgress
              ? 'Gateway Busy (Call Active)'
              : 'Trigger Inbound Ring'}
          </span>
        </button>
      </form>

      {statusMessage && (
        <div
          className={`text-[11px] font-mono p-2 rounded flex items-center gap-2 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/60'
              : 'bg-rose-950/60 text-rose-400 border border-rose-800/60'
          }`}
        >
          {statusMessage.type === 'success' ? (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}
    </div>
  );
}
