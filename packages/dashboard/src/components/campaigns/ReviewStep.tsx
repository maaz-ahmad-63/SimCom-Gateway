'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { Campaign, Review, startBlockers } from '../../lib/campaigns';
import { ActionNote, Badge, Button, Card, TextInput, Tile, useAction } from '../ai/ui';

/** `restart`: the campaign has finished (completed or stopped) and is run again on its current contact list. Same checks, same confirmation. */
export function ReviewStep({ campaign, contactsVersion, onStarted, restart = false }: { campaign: Campaign; contactsVersion: number; onStarted: () => void; restart?: boolean }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acks, setAcks] = useState({ realCalls: false, regulations: false, consent: false });
  const [typed, setTyped] = useState('');
  const [action, run] = useAction();

  const load = useCallback(async () => {
    try {
      setError(null);
      setReview(await apiClient.getCampaignReview(campaign.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the review');
    }
  }, [campaign.id]);
  useEffect(() => {
    void load();
  }, [load, contactsVersion, campaign.updatedAt]);

  const blockers = review ? startBlockers({ campaignName: campaign.name, typedName: typed, acknowledgements: acks, review }) : ['Loading…'];

  const start = async () => {
    const started = await run(() => (restart ? apiClient.restartCampaign(campaign.id, typed.trim()) : apiClient.startCampaign(campaign.id, typed.trim())), restart ? 'Campaign running again' : 'Campaign started');
    if (started) {
      setConfirming(false);
      onStarted();
    }
  };

  return (
    <Card
      title={restart ? 'Run this campaign again' : '3. Review and start'}
      subtitle={restart ? 'Runs the campaign again on its current contact list (for example after uploading a new CSV above). Only contacts still waiting are called; contacts already called are not called again unless they are queued for a retry. Earlier calls, recordings and results are kept. Nothing is called until you confirm below.' : 'Check what will happen. Nothing is called until you confirm below.'}
    >
      {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
      {!error && !review && <p className="text-xs text-slate-400">Loading the review…</p>}
      {review && (
        <div className="space-y-4" data-testid="review">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Tile label="Contacts in the file">{review.counts.total}</Tile>
            <Tile label="Will be called">{review.willCall}</Tile>
            <Tile label="Skipped when started">{review.willSkipAtStart}</Tile>
            <Tile label="Already set aside">{review.counts.skipped}</Tile>
          </div>
          {Object.keys(review.skipReasons).length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-white mb-1">Why contacts are not called</h3>
              <ul className="text-[11px] font-mono text-slate-400 space-y-0.5">
                {Object.entries(review.skipReasons).map(([reason, n]) => (
                  <li key={reason}>
                    {n} × {reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-xs text-slate-300 space-y-1">
            <p>
              Pacing: {campaign.settings.interCallDelaySeconds} s between calls, one at a time · up to {campaign.settings.maxAttempts} attempt(s), retry after {campaign.settings.retryDelayMinutes} min · calling hours {campaign.settings.callingHours.start}–{campaign.settings.callingHours.end} {campaign.settings.callingHours.timeZone}.
            </p>
            {!review.insideCallingHoursNow && <p className="text-amber-300/90">It is outside the calling hours now: calls will wait until they open.</p>}
          </div>
          {review.blockers.length > 0 && (
            <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-3 text-xs space-y-1" data-testid="ai-blockers">
              <p className="text-rose-200 font-semibold">The AI agent cannot take outbound calls yet:</p>
              <ul className="list-disc ml-4 text-rose-200/90">
                {review.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {restart && review.willCall <= 0 && (
            <p className="text-xs text-amber-300" data-testid="nothing-waiting">
              No contacts are waiting to be called. Upload a new contact list in the “Contact list” card below, then come back here.
            </p>
          )}
          {review.anotherRunning && <p className="text-xs text-amber-300">Another campaign (“{review.anotherRunning.name}”) is running. Only one can run at a time.</p>}

          {!confirming ? (
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={review.willCall <= 0 || review.blockers.length > 0 || !!review.anotherRunning}>
              {restart ? 'Run again…' : 'Start campaign…'}
            </Button>
          ) : (
            <div className="rounded-lg border border-amber-800/70 bg-amber-950/20 p-4 space-y-3" role="dialog" aria-label="Confirm campaign start" data-testid="confirm-start">
              <p className="text-sm text-white font-semibold">This will place real phone calls to {review.willCall} people through your SIM.</p>
              <label className="flex items-start gap-2 text-xs text-slate-200">
                <input type="checkbox" className="mt-0.5 accent-cyan-500" checked={acks.realCalls} onChange={(e) => setAcks({ ...acks, realCalls: e.target.checked })} />
                I understand this places real calls, which may cost money and cannot be undone.
              </label>
              <label className="flex items-start gap-2 text-xs text-slate-200">
                <input type="checkbox" className="mt-0.5 accent-cyan-500" checked={acks.regulations} onChange={(e) => setAcks({ ...acks, regulations: e.target.checked })} />
                I will follow the calling rules that apply to these contacts (calling hours, do-not-call registries, recording and disclosure rules).
              </label>
              <label className="flex items-start gap-2 text-xs text-slate-200">
                <input type="checkbox" className="mt-0.5 accent-cyan-500" checked={acks.consent} onChange={(e) => setAcks({ ...acks, consent: e.target.checked })} />
                I have the right to contact these people, and anyone who opted out is marked as such.
              </label>
              <label className="block">
                <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Type the campaign name to confirm: {campaign.name}</span>
                <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Campaign name" autoComplete="off" />
              </label>
              {blockers.length > 0 && (
                <ul className="text-[11px] text-slate-400 list-disc ml-4" data-testid="start-blockers">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <Button variant="danger" onClick={() => void start()} disabled={blockers.length > 0} busy={action.status === 'running'}>
                  Place calls now
                </Button>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
                <Badge tone="warn">no call is placed until you press this</Badge>
              </div>
              <ActionNote state={action} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
