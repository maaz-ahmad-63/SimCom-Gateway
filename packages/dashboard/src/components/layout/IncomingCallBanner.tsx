'use client';

import React, { useState } from 'react';
import { useGateway } from '../../lib/context/GatewayContext';
import { PhoneIncoming, PhoneOff, Phone } from 'lucide-react';

export function IncomingCallBanner() {
  const { activeCall, answer, hangup } = useGateway();
  const [isProcessing, setIsProcessing] = useState(false);

  if (!activeCall || activeCall.state !== 'INBOUND_RINGING') {
    return null;
  }

  const handleAnswer = async () => {
    try {
      setIsProcessing(true);
      await answer();
    } catch (err) {
      console.error('Failed to answer call:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDecline = async () => {
    try {
      setIsProcessing(true);
      await hangup('Call declined by operator');
    } catch (err) {
      console.error('Failed to decline call:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="bg-gradient-to-r from-amber-950/90 via-slate-900 to-amber-950/90 border-b border-amber-500/40 px-4 py-2.5 shadow-lg flex flex-col sm:flex-row items-center justify-between gap-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center">
          <PhoneIncoming className="w-4 h-4 animate-bounce" />
        </div>
        <div>
          <div className="text-xs font-semibold text-amber-300 uppercase tracking-wider flex items-center gap-2">
            Incoming Cellular Call
            {activeCall.isSimulated && (
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                MOCK
              </span>
            )}
          </div>
          <div className="text-sm font-mono font-bold text-white">
            {activeCall.remoteNumber}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button
          onClick={handleDecline}
          disabled={isProcessing}
          className="flex-1 sm:flex-initial px-3 py-1.5 rounded-md text-xs font-semibold bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800 transition flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <PhoneOff className="w-3.5 h-3.5" />
          <span>Decline</span>
        </button>

        <button
          onClick={handleAnswer}
          disabled={isProcessing}
          className="flex-1 sm:flex-initial px-4 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <Phone className="w-3.5 h-3.5" />
          <span>Answer</span>
        </button>
      </div>
    </div>
  );
}
