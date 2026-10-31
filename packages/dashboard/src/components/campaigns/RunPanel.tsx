'use client';

import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiClient } from '../../lib/api-client';
import { callLogHref, RequestGate } from '../../lib/call-logs';
import { Attempt, Campaign, Contact, ContactStatus, Counts, nextRetryText, outcomeLabel, progressPercent, RunnerStatus, statusTone } from '../../lib/campaigns';
import { formatDate } from '../../lib/utils';
import { ActionNote, Badge, Button, Card, Select, Tile, TextInput, useAction } from '../ai/ui';

const FILTERS: Array<{ value: '' | ContactStatus; label: string }> = [
  { value: '', label: 'All contacts' },
  { value: 'queued', label: 'Queued' },
  { value: 'calling', label: 'Calling' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
];

export function ProgressBar({ counts }: { counts: Counts }) {
  const pct = progressPercent(counts);
  return (
    <div data-testid="progress">
      <div className="h-2 rounded bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-cyan-600" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-slate-400 mt-1">
        {pct}% finished · {counts.completed + counts.failed + counts.skipped} of {counts.total} contacts have reached a final state
      </p>
    </div>
  );
}

function ContactRow({ campaignId, contact, onOptOut }: { campaignId: string; contact: Contact; onOptOut: (c: Contact) => void }) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const toggle = async () => {
    setOpen(!open);
    if (!open) {
      try {
        setAttempts((await apiClient.getCampaignContact(campaignId, contact.id)).attempts);
      } catch {
        setAttempts([]);
      }
    }
  };
  return (
    <Fragment>
      <tr className="border-b border-slate-800/60 hover:bg-slate-800/30 cursor-pointer" onClick={() => void toggle()} data-contact-id={contact.id}>
        <td className="py-2 pr-3 text-slate-500 font-mono">{contact.rowNumber}</td>
        <td className="py-2 pr-3 text-slate-200">{contact.name || '—'}<div className="text-[10px] text-slate-500">{[contact.designation, contact.company].filter(Boolean).join(' · ')}</div></td>
        <td className="py-2 pr-3 font-mono text-slate-300">{contact.phoneE164 ?? contact.phoneRaw}</td>
        <td className="py-2 pr-3"><Badge tone={statusTone(contact.status)}>{contact.status}</Badge></td>
        <td className="py-2 pr-3 font-mono text-slate-300">{contact.attempts}</td>
        <td className="py-2 pr-3 text-slate-400 break-words max-w-[22rem]">
          {contact.skipReason ?? contact.lastError ?? outcomeLabel(contact.lastOutcome)}
          {nextRetryText(contact) && <div className="text-[10px] text-amber-300/80">{nextRetryText(contact)}</div>}
        </td>
        <td className="py-2 text-right whitespace-nowrap">
          {contact.callId && (
            <Link href={callLogHref(contact.callId)} onClick={(e) => e.stopPropagation()} className="text-cyan-400 hover:underline text-[11px]">
              call log
            </Link>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-slate-800/60 bg-slate-950/40">
          <td colSpan={7} className="p-3 text-[11px] font-mono text-slate-400 space-y-1" data-testid="attempts">
            {attempts === null && <p>Loading attempts…</p>}
            {attempts?.length === 0 && <p>No call has been placed for this contact.</p>}
            {attempts?.map((a) => (
              <p key={a.attempt}>
                Attempt {a.attempt} · {formatDate(a.startedAt)} · {a.outcome ? outcomeLabel(a.outcome) : 'in progress'}
                {a.error ? ` · ${a.error}` : ''}{' '}
                {a.callId && (
                  <Link href={callLogHref(a.callId)} className="text-cyan-400 hover:underline">
                    open call log
                  </Link>
                )}
              </p>
            ))}
            {contact.phoneE164 && contact.status !== 'completed' && (
              <Button
                variant="danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onOptOut(contact);
                }}
              >
                Mark as opted out (do not call again, in any campaign)
              </Button>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** A started campaign: controls, progress, and every contact with its status and call logs. Refreshes itself while it matters. */
export function RunPanel({ campaign, counts, runner, onChanged }: { campaign: Campaign; counts: Counts; runner: RunnerStatus | null; onChanged: () => void }) {
  const [filter, setFilter] = useState<'' | ContactStatus>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmStop, setConfirmStop] = useState(false);
  const [action, run] = useAction();
  const gate = useRef(new RequestGate());
  const pageSize = 25;
  const live = campaign.status === 'running' || campaign.status === 'paused';

  const load = useCallback(async () => {
    const ticket = gate.current.begin();
    try {
      const res = await apiClient.listCampaignContacts(campaign.id, { status: filter || undefined, q: q.trim() || undefined, page, pageSize });
      if (!gate.current.isCurrent(ticket)) return;
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (gate.current.isCurrent(ticket)) setError(e instanceof Error ? e.message : 'Could not load contacts');
    } finally {
      if (gate.current.isCurrent(ticket)) setLoading(false);
    }
  }, [campaign.id, filter, q, page]);

  useEffect(() => {
    void load();
  }, [load, counts.completed, counts.failed, counts.skipped, counts.queued, counts.calling]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [live, load]);

  const control = async (what: 'pause' | 'resume' | 'stop') => {
    const done = await run(() => apiClient.controlCampaign(campaign.id, what), what === 'pause' ? 'Paused (a call in progress finishes first)' : what === 'resume' ? 'Resumed' : 'Stopped');
    setConfirmStop(false);
    if (done) onChanged();
  };
  const optOut = async (c: Contact) => {
    const done = await run(() => apiClient.optOutCampaignContact(campaign.id, c.id), 'Added to the do-not-call list');
    if (done) {
      onChanged();
      void load();
    }
  };

  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="space-y-6">
      <Card
        title="Progress"
        subtitle={<span>Started {campaign.startedAt ? formatDate(campaign.startedAt) : '—'}{campaign.finishedAt ? ` · finished ${formatDate(campaign.finishedAt)}` : ''}</span>}
        actions={<Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>}
      >
        <ProgressBar counts={counts} />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2" data-testid="counts">
          <Tile label="Queued">{counts.queued}</Tile>
          <Tile label="Calling">{counts.calling}</Tile>
          <Tile label="Completed">{counts.completed}</Tile>
          <Tile label="Failed">{counts.failed}</Tile>
          <Tile label="Skipped">{counts.skipped}</Tile>
        </div>
        {campaign.pauseReason && campaign.status === 'paused' && <p className="text-xs text-amber-300" data-testid="pause-reason">Paused: {campaign.pauseReason}</p>}
        {campaign.status === 'running' && runner?.waiting && <p className="text-xs text-slate-400" data-testid="waiting">{runner.waiting}</p>}
        {campaign.status === 'running' && runner?.inFlight && <p className="text-xs text-slate-300">A call is in progress{runner.inFlight.callId ? <> · <Link className="text-cyan-400 hover:underline" href={callLogHref(runner.inFlight.callId)}>open its call log</Link></> : null}.</p>}
        {live && (
          <div className="flex flex-wrap items-center gap-2">
            {campaign.status === 'running' && <Button onClick={() => void control('pause')} busy={action.status === 'running'}>Pause</Button>}
            {campaign.status === 'paused' && <Button variant="primary" onClick={() => void control('resume')} busy={action.status === 'running'}>Resume</Button>}
            {!confirmStop ? (
              <Button variant="danger" onClick={() => setConfirmStop(true)}>Stop…</Button>
            ) : (
              <span className="flex items-center gap-2 text-xs text-slate-300">
                Stop for good? Waiting contacts are skipped; a call in progress is not hung up.
                <Button variant="danger" onClick={() => void control('stop')}>Yes, stop</Button>
                <Button onClick={() => setConfirmStop(false)}>Keep going</Button>
              </span>
            )}
          </div>
        )}
        <ActionNote state={action} />
      </Card>

      <Card title="Contacts" subtitle="Click a contact to see its attempts. Each call has its own call log.">
        <div className="flex flex-wrap gap-3">
          <Select value={filter} onChange={(e) => { setFilter(e.target.value as '' | ContactStatus); setPage(1); }} aria-label="Status filter" className="max-w-[12rem]">
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
          <TextInput value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, company or number" aria-label="Search contacts" className="max-w-xs" />
        </div>
        {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
        {!error && loading && <p className="text-xs text-slate-400">Loading contacts…</p>}
        {!error && !loading && items.length === 0 && <p className="text-xs text-slate-400" data-testid="no-contacts">No contacts match.</p>}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800 text-[11px] uppercase font-mono">
                  <th className="py-2 pr-3">Row</th>
                  <th className="py-2 pr-3">Contact</th>
                  <th className="py-2 pr-3">Number</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Tries</th>
                  <th className="py-2 pr-3">Result</th>
                  <th className="py-2 text-right">Logs</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <ContactRow key={c.id} campaignId={campaign.id} contact={c} onOptOut={(x) => void optOut(x)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > pageSize && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span>Page {page} of {pages} · {total} contacts</span>
            <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
