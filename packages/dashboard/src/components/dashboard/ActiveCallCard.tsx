'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useGateway } from '../../lib/context/GatewayContext';
import { formatDuration } from '../../lib/utils';
import { Phone, PhoneOff, PhoneIncoming, PhoneOutgoing, Hash } from 'lucide-react';

export function ActiveCallCard() {
  const { activeCall, hangup } = useGateway();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isHangingUp, setIsHangingUp] = useState(false);

  useEffect(() => {
    if (!activeCall) {
      setElapsedSeconds(0);
      return;
    }

    const computeElapsed = () => {
      const startTime = activeCall.answeredAt || activeCall.startedAt;
      if (!startTime) return 0;
      const startMs = new Date(startTime).getTime();
      return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    };

    setElapsedSeconds(computeElapsed());
    const timer = setInterval(() => {
      setElapsedSeconds(computeElapsed());
    }, 1000);

    return () => clearInterval(timer);
  }, [activeCall]);

  if (!activeCall || activeCall.state === 'IDLE') {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col items-center justify-center text-center min-h-[190px]">
        <div className="h-10 w-10 rounded-full bg-slate-800/80 border border-slate-700/60 flex items-center justify-center text-slate-500 mb-2">
          <Phone className="w-5 h-5" />
        </div>
        <h3 className="text-sm font-semibold text-slate-300">No Active Call</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-xs">
          Gateway is idle and ready for incoming calls or outbound dialing.
        </p>
        <Link
          href="/dialer"
          className="mt-3 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
        >
          Open Dialer
        </Link>
      </div>
    );
  }

  const handleHangup = async () => {
    try {
      setIsHangingUp(true);
      await hangup('Operator requested hangup from dashboard');
    } catch (err) {
      console.error('Hangup failed:', err);
    } finally {
      setIsHangingUp(false);
    }
  };

  const isCallActive = activeCall.state === 'ACTIVE';

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {activeCall.direction === 'inbound' ? (
            <PhoneIncoming className="w-4 h-4 text-cyan-400" />
          ) : (
            <PhoneOutgoing className="w-4 h-4 text-emerald-400" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {activeCall.direction === 'inbound' ? 'Inbound Call' : 'Outbound Call'}
          </span>
          {activeCall.isSimulated && (
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
              MOCK
            </span>
          )}
        </div>

        <span
          className={`text-xs font-mono px-2 py-0.5 rounded font-semibold border ${
            isCallActive
              ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/80'
              : 'bg-amber-950/80 text-amber-400 border-amber-800/80 animate-pulse'
          }`}
        >
          {activeCall.state}
        </span>
      </div>

      {/* Main Info */}
      <div className="flex items-baseline justify-between border-y border-slate-800/60 py-3">
        <div>
          <div className="text-[11px] text-slate-500 uppercase font-mono">Remote Party</div>
          <div className="text-xl font-bold font-mono text-white mt-0.5">
            {activeCall.remoteNumber}
          </div>
        </div>

        <div className="text-right">
          <div className="text-[11px] text-slate-500 uppercase font-mono">Duration</div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-0.5">
            {formatDuration(elapsedSeconds)}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleHangup}
          disabled={isHangingUp}
          className="flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-sm transition flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <PhoneOff className="w-4 h-4" />
          <span>{isHangingUp ? 'Terminating...' : 'End Call'}</span>
        </button>

        <Link
          href="/dialer"
          className="py-2 px-3 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center justify-center gap-1.5"
          title="Open Keypad for DTMF tones"
        >
          <Hash className="w-4 h-4 text-slate-400" />
          <span>Keypad</span>
        </Link>
      </div>
    </div>
  );
}
