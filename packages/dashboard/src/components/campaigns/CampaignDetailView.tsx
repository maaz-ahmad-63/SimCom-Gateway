'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiClient } from '../../lib/api-client';
import { Campaign, Counts, RunnerStatus, statusTone } from '../../lib/campaigns';
import { Badge, Button, Card, useAction, ActionNote } from '../ai/ui';
import { ContactsStep } from './ContactsStep';
import { ReviewStep } from './ReviewStep';
import { RunPanel } from './RunPanel';
import { SettingsStep } from './SettingsStep';

interface Loaded {
  campaign: Campaign;
  counts: Counts;
  runner: RunnerStatus | null;
}

export function CampaignDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contactsVersion, setContactsVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [action, run] = useAction();

  const load = useCallback(async () => {
    try {
      const res = await apiClient.getCampaign(id);
      setData({ campaign: res.campaign, counts: res.counts, runner: res.runner });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the campaign');
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const live = data?.campaign.status === 'running' || data?.campaign.status === 'paused';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [live, load]);

  if (error && !data) {
    return (
      <Card title="Campaign">
        <p className="text-xs text-rose-300" role="alert">{error}</p>
        <div className="flex gap-2">
          <Button onClick={() => void load()}>Try again</Button>
          <Link href="/campaigns" className="text-xs text-cyan-400 hover:underline self-center">Back to campaigns</Link>
        </div>
      </Card>
    );
  }
  if (!data) return <p className="text-xs text-slate-400">Loading the campaign…</p>;

  const { campaign, counts, runner } = data;
  const deletable = campaign.status !== 'running' && campaign.status !== 'paused';
  const remove = async () => {
    const ok = await run(() => apiClient.deleteCampaign(campaign.id), 'Deleted');
    if (ok) router.push('/campaigns');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/campaigns" className="text-[11px] text-cyan-400 hover:underline">← All campaigns</Link>
          <h2 className="text-lg font-bold text-white flex items-center gap-2 mt-1">
            {campaign.name}
            <Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>
          </h2>
          <p className="text-[11px] text-slate-500 font-mono">{campaign.id}</p>
        </div>
        {deletable && (
          <div className="flex items-center gap-2">
            {!confirmDelete ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete…</Button>
            ) : (
              <>
                <span className="text-xs text-slate-300">Delete this campaign and its contact list? Call logs are kept.</span>
                <Button variant="danger" onClick={() => void remove()}>Yes, delete</Button>
                <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </>
            )}
          </div>
        )}
      </div>
      <ActionNote state={action} />

      {campaign.status === 'draft' ? (
        <>
          <ContactsStep
            campaign={campaign}
            existing={counts.total}
            onImported={() => {
              setContactsVersion((v) => v + 1);
              void load();
            }}
          />
          <SettingsStep campaign={campaign} onSaved={() => void load()} />
          <ReviewStep campaign={campaign} contactsVersion={contactsVersion} onStarted={() => void load()} />
        </>
      ) : (
        <>
          <RunPanel campaign={campaign} counts={counts} runner={runner} onChanged={() => void load()} />
          <SettingsStep campaign={campaign} onSaved={() => void load()} />
        </>
      )}
    </div>
  );
}
