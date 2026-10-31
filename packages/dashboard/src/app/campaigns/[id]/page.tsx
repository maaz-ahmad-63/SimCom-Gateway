'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { CampaignDetailView } from '../../../components/campaigns/CampaignDetailView';

export default function CampaignPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  return <CampaignDetailView key={id} id={id} />;
}
