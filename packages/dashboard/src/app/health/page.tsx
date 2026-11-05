'use client';

import React from 'react';
import { HealthView } from '../../components/ops/HealthView';

export default function HealthPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-white">System health</h1>
        <p className="text-xs text-slate-400">Whether the gateway, the modem, the SIM, the AI services and the storage are all working.</p>
      </div>
      <HealthView />
    </div>
  );
}
