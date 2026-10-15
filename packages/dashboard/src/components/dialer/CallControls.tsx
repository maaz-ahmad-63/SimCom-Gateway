'use client';

import React from 'react';
import { useGateway } from '../../lib/context/GatewayContext';
import { Phone, PhoneCall, PhoneIncoming, PhoneOff } from 'lucide-react';

interface CallControlsProps {
  onDial: () => void;
  isValidNumber: boolean;
  isSubmitting: boolean;
}

export function CallControls({ onDial, isValidNumber, isSubmitting }: CallControlsProps) {
  const { activeCall, answer, hangup } = useGateway();

  const state = activeCall?.state ?? 'IDLE';

  if (state === 'IDLE') {
    return (
      <button
        type="button"
        onClick={onDial}
        disabled={!isValidNumber || isSubmitting}
        className="w-full h-12 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition flex items-center justify-center gap-2.5 disabled:opacity-40 disabled:hover:bg-emerald-600"
      >
        <Phone className="w-4 h-4 fill-current" />
        <span>{isSubmitting ? 'Dialing...' : 'Initiate Call'}</span>
      </button>
    );
  }

  if (state === 'DIALING' || state === 'OUTBOUND_RINGING') {
    return (
      <div className="space-y-2">
        <div className="text-center font-mono text-xs text-amber-400 animate-pulse font-semibold">
          {state === 'DIALING' ? 'Dialing cellular carrier...' : 'Remote phone is ringing...'}
        </div>
        <button
          type="button"
          onClick={() => hangup('User cancelled call before answer')}
          disabled={isSubmitting}
          className="w-full h-12 rounded-xl text-sm font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-md transition flex items-center justify-center gap-2.5 disabled:opacity-50"
        >
          <PhoneOff className="w-4 h-4" />
          <span>Cancel Call</span>
        </button>
      </div>
    );
  }

  if (state === 'INBOUND_RINGING') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => hangup('Operator declined incoming call')}
          disabled={isSubmitting}
          className="h-12 rounded-xl text-sm font-semibold bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800 transition flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <PhoneOff className="w-4 h-4" />
          <span>Decline</span>
        </button>

        <button
          type="button"
          onClick={() => answer()}
          disabled={isSubmitting}
          className="h-12 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md transition flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <PhoneCall className="w-4 h-4" />
          <span>Answer</span>
        </button>
      </div>
    );
  }

  if (state === 'ACTIVE') {
    return (
      <button
        type="button"
        onClick={() => hangup('User ended active call')}
        disabled={isSubmitting}
        className="w-full h-12 rounded-xl text-sm font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-md transition flex items-center justify-center gap-2.5 disabled:opacity-50"
      >
        <PhoneOff className="w-4 h-4" />
        <span>End Call</span>
      </button>
    );
  }

  // TERMINATING
  return (
    <button
      type="button"
      disabled
      className="w-full h-12 rounded-xl text-sm font-semibold bg-slate-800 text-slate-500 transition flex items-center justify-center gap-2.5"
    >
      <PhoneOff className="w-4 h-4" />
      <span>Terminating Call...</span>
    </button>
  );
}
