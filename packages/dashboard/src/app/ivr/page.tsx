'use client';

import React from 'react';
import { PhoneForwarded } from 'lucide-react';
import { IvrView } from '../../components/ivr/IvrView';

export default function IvrPage() {
  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800/80 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <PhoneForwarded className="w-5 h-5 text-cyan-400" />
          IVR menu
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Play a recorded menu (&ldquo;press 1 to talk to our assistant&rdquo;) to the person you call, as soon as they answer, before or instead of the AI. It applies to outgoing calls only: incoming calls are never touched by the IVR. Nothing here affects a call until you publish a menu and turn the IVR on. It is off by default.
        </p>
      </div>
      <IvrView />
    </div>
  );
}
