'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiClient } from '../../lib/api-client';
import { Campaign, Counts, progressPercent, statusTone } from '../../lib/campaigns';
import { formatDate } from '../../lib/utils';
import { ActionNote, Badge, Button, Card, Field, TextInput, useAction } from '../ai/ui';

type Row = Campaign & { counts: Counts };

function DoNotCallPanel() {
  const [items, setItems] = useState<Array<{ phone: string; reason: string | null; source: string; addedAt: string }>>([]);
  const [total, setTotal] = useState(0);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [loadAction, runLoad] = useAction();
  const [action, run] = useAction();
  const load = useCallback(() => {
    void runLoad(async () => {
      const r = await apiClient.listDoNotCall();
      setItems(r.items);
      setTotal(r.total);
      return r;
    }, 'Loaded');
  }, [runLoad]);
  useEffect(load, [load]);
  return (
    <Card title="Do-not-call list" subtitle="A number here is never called by any campaign, present or future, and is skipped immediately in campaigns that still have it queued.">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => apiClient.addDoNotCall(phone, reason), 'Added');
          if (r) {
            setPhone('');
            setReason('');
            load();
          }
        }}
      >
        <Field label="Phone number (with +country code)">
          <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" />
        </Field>
        <Field label="Reason (optional)">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <Button variant="primary" type="submit" disabled={phone.trim() === ''}>Add</Button>
      </form>
      <ActionNote state={action} />
      {loadAction.status === 'error' && <ActionNote state={loadAction} />}
      {total === 0 && loadAction.status !== 'running' && <p className="text-xs text-slate-500">No numbers are on the list.</p>}
      {items.length > 0 && (
        <ul className="text-xs font-mono text-slate-300 space-y-1" data-testid="dnc-list">
          {items.map((i) => (
            <li key={i.phone} className="flex items-center gap-3">
              <span>{i.phone}</span>
              <span className="text-slate-500">{i.reason ?? ''}</span>
              <span className="text-slate-600 text-[10px]">{i.source} · {formatDate(i.addedAt)}</span>
              <button
                type="button"
                className="text-rose-300 hover:underline text-[11px]"
                onClick={async () => {
                  if (await run(() => apiClient.removeDoNotCall(i.phone), 'Removed')) load();
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function CampaignsView() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [action, run] = useAction();

  const load = useCallback(async () => {
    try {
      setRows((await apiClient.listCampaigns()).campaigns);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load campaigns');
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await run(() => apiClient.createCampaign(name.trim()), 'Campaign created');
    if (res) router.push(`/campaigns/${res.campaign.id}`);
  };

  return (
    <div className="space-y-6">
      <Card title="New campaign" subtitle="Create it, upload your contacts, set the rules and review it. Nothing is called until you confirm the start.">
        <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
          <Field label="Campaign name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Spring follow-ups" aria-label="Campaign name" />
          </Field>
          <Button variant="primary" type="submit" disabled={name.trim() === ''} busy={action.status === 'running'}>Create campaign</Button>
        </form>
        <ActionNote state={action} />
      </Card>

      <Card title="Campaigns">
        {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
        {!error && !rows && <p className="text-xs text-slate-400">Loading campaigns…</p>}
        {rows && rows.length === 0 && <p className="text-xs text-slate-400" data-testid="no-campaigns">No campaigns yet. Create one above.</p>}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800 text-[11px] uppercase tracking-wide font-medium">
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Contacts</th>
                  <th className="py-2 pr-3">Queued / done / failed / skipped</th>
                  <th className="py-2 pr-3">Progress</th>
                  <th className="py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                    <td className="py-2 pr-3"><Link href={`/campaigns/${c.id}`} className="text-cyan-400 hover:underline">{c.name}</Link></td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
                    <td className="py-2 pr-3 font-mono text-slate-300">{c.counts.total}</td>
                    <td className="py-2 pr-3 font-mono text-slate-400">{c.counts.queued} / {c.counts.completed} / {c.counts.failed} / {c.counts.skipped}</td>
                    <td className="py-2 pr-3 font-mono text-slate-300">{progressPercent(c.counts)}%</td>
                    <td className="py-2 text-slate-400">{formatDate(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <DoNotCallPanel />
    </div>
  );
}
