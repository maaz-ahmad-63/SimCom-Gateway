'use client';

import React from 'react';
import { Megaphone } from 'lucide-react';
import { CampaignsView } from '../../components/campaigns/CampaignsView';

export default function CampaignsPage() {
  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800/80 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-cyan-400" />
          Campaigns
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Call a list of contacts one at a time with the voice agent, giving it each person&apos;s details. Uploading and previewing never place a call; a campaign only starts after your explicit confirmation.
        </p>
      </div>
      <CampaignsView />
    </div>
  );
}
