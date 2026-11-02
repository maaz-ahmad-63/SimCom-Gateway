'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { apiClient } from '../../lib/api-client';
import { formatDate, formatDuration } from '../../lib/utils';
import { CallFilters, CallRow, dayBoundary, ms, Overview, PAGE_SIZE, pct, pickLabel, Stat, statusLabel, statusTone, STATUS_OPTIONS } from '../../lib/observability';
import { Badge, Button, Card, Field, Select, Tile, TextInput } from '../ai/ui';
import { callSummaryLine, RequestGate, searchWithCall, selectedCallFromSearch } from '../../lib/call-logs';
import { CallDetailPanel } from './CallDetailPanel';

interface Draft {
  from: string;
  to: string;
  status: string;
  direction: string;
  provider: string;
  model: string;
  q: string;
  simulated: string;
}
const EMPTY: Draft = { from: '', to: '', status: '', direction: '', provider: '', model: '', q: '', simulated: '' };

function toFilters(d: Draft): CallFilters {
  return {
    from: dayBoundary(d.from, 'start'),
    to: dayBoundary(d.to, 'end'),
    status: d.status || undefined,
    direction: d.direction === 'inbound' || d.direction === 'outbound' ? d.direction : undefined,
    provider: d.provider.trim() || undefined,
    model: d.model.trim() || undefined,
    q: d.q.trim() || undefined,
    simulated: d.simulated === 'only' || d.simulated === 'exclude' ? d.simulated : undefined,
  };
}

function StatTile({ label, stat, hint }: { label: string; stat: Stat; hint?: string }) {
  return (
    <Tile label={label}>
      <div>{ms(stat.avg)}</div>
      <div className="text-[10px] text-slate-500 font-sans mt-0.5">
        {stat.n === 0 ? 'no measurements' : `p50 ${ms(stat.p50)} · p95 ${ms(stat.p95)} · n=${stat.n}`}
      </div>
      {hint && <div className="text-[10px] text-slate-600 font-sans">{hint}</div>}
    </Tile>
  );
}

export function OverviewCards({ o }: { o: Overview }) {
  return (
    <div className="space-y-3" data-testid="overview">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Tile label="Total calls">{o.calls.total}</Tile>
        <Tile label="Successful">{o.calls.successful}</Tile>
        <Tile label="Failed">
          {o.calls.failed}
          <div className="text-[10px] text-slate-500 font-sans">{o.calls.failureRate === null ? 'no calls' : `${pct(o.calls.failureRate)} of calls`}</div>
        </Tile>
        <Tile label="AI turn error rate">
          {pct(o.turns.errorRatePercent)}
          <div className="text-[10px] text-slate-500 font-sans">
            {o.turns.failed} failed of {o.turns.completed + o.turns.failed + o.turns.cancelled} answered · {o.calls.withAiErrors} calls affected
          </div>
        </Tile>
        <Tile label="Turns recorded">{o.turns.total}</Tile>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <StatTile label="End-to-end" stat={o.latencyMs.endToEnd} hint="speech end → reply audio written to modem" />
        <StatTile label="Time to first token" stat={o.latencyMs.tft} hint="streaming models only" />
        <StatTile
          label="STT"
          stat={o.latencyMs.stt}
          hint={Object.keys(o.sttModes ?? {}).length > 0 ? Object.entries(o.sttModes).map(([m, n]) => `${m} ${n}`).join(' · ') : undefined}
        />
        <StatTile label="LLM completion" stat={o.latencyMs.llmTotal} />
        <StatTile label="TTS first audio" stat={o.latencyMs.ttsFirstAudio} />
      </div>
      <p className="text-[11px] text-slate-500" data-testid="playback-summary">
        Playback: {o.playback.turnsWithLateFrames} turn(s) with late frames, {o.playback.turnsWithGapRisk} past the write-ahead
        {o.playback.maxLateMs.n > 0 ? ` · worst frame lateness p95 ${ms(o.playback.maxLateMs.p95)}` : ''}
        {o.playback.loopLagMs.n > 0 ? ` · event-loop stall p95 ${ms(o.playback.loopLagMs.p95)}` : ''}
        {' · '}Cancelled: {o.cancellations.total} ({o.cancellations.afterAudioStarted} after audio started
        {Object.keys(o.cancellations.bySource).length > 0 ? `; ${Object.entries(o.cancellations.bySource).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}). Cancelled turns are excluded from end-to-end.
      </p>
      {o.simulatedTurns > 0 && <p className="text-[11px] text-amber-400">{o.simulatedTurns} turn(s) used simulated providers; filter them out with “Simulated: hide”.</p>}
    </div>
  );
}

export function ObservabilityView() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [applied, setApplied] = useState<CallFilters>({});
  const [page, setPage] = useState(1);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<CallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The call on screen is whatever the URL says: a click, a shared link, the back button and a refresh all agree.
  const selected = selectedCallFromSearch(searchParams.toString());
  const select = useCallback(
    (id: string | null) => router.push(`${pathname}${searchWithCall(searchParams.toString(), id)}`, { scroll: false }),
    [router, pathname, searchParams]
  );
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && select(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, select]);
  const [status, setStatus] = useState<{ events: number; oldestAt: string | null; failedWrites: number; retention: { retentionDays: number; maxEvents: number } | null } | null>(null);
  const gate = useRef(new RequestGate());

  const load = useCallback(async () => {
    const mine = gate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const [o, list] = await Promise.all([apiClient.getObservabilityOverview(applied), apiClient.listObservabilityCalls(applied, { page, pageSize: PAGE_SIZE })]);
      if (!gate.current.isCurrent(mine)) return; // a newer request superseded this one
      setOverview(o);
      setRows(list.items);
      setTotal(list.total);
    } catch (e) {
      if (!gate.current.isCurrent(mine)) return;
      setError(e instanceof Error ? e.message : 'Could not load call logs');
    } finally {
      if (gate.current.isCurrent(mine)) setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    apiClient.getObservabilityStatus().then(setStatus).catch(() => setStatus(null)); // informational only
  }, [rows]);

  const apply = () => {
    setPage(1);
    setApplied(toFilters(draft));
  };
  const reset = () => {
    setDraft(EMPTY);
    setPage(1);
    setApplied({});
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });

  return (
    <div className="space-y-6">
      {overview && <OverviewCards o={overview} />}

      <Card title="Filters" actions={<Button onClick={() => void load()} busy={loading}>Refresh</Button>}>
        <form
          className="grid grid-cols-2 md:grid-cols-4 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Field label="From (local day)"><TextInput type="date" value={draft.from} onChange={set('from')} /></Field>
          <Field label="To (local day)"><TextInput type="date" value={draft.to} onChange={set('to')} /></Field>
          <Field label="Status">
            <Select value={draft.status} onChange={set('status')}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={draft.direction} onChange={set('direction')}>
              <option value="">Incoming and outgoing</option>
              <option value="inbound">Incoming</option>
              <option value="outbound">Outgoing</option>
            </Select>
          </Field>
          <Field label="Provider">
            <TextInput list="obs-providers" value={draft.provider} onChange={set('provider')} placeholder="deepgram, groq-qwen, cartesia…" />
            <datalist id="obs-providers">
              {['deepgram', 'deepgram-flux', 'groq', 'groq-qwen', 'openai', 'gemini', 'telnyx', 'cartesia', 'elevenlabs', 'murf_falcon_2', 'inworld', 'soniox'].map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field label="Model"><TextInput value={draft.model} onChange={set('model')} placeholder="nova-3, sonic-3…" /></Field>
          <Field label="Call / session ID"><TextInput value={draft.q} onChange={set('q')} placeholder="id or its first characters" /></Field>
          <Field label="Simulated calls">
            <Select value={draft.simulated} onChange={set('simulated')}>
              <option value="">Show</option>
              <option value="exclude">Hide</option>
              <option value="only">Only simulated</option>
            </Select>
          </Field>
          <div className="col-span-2 md:col-span-4 flex gap-2">
            <Button variant="primary" type="submit">Apply filters</Button>
            <Button onClick={reset}>Reset</Button>
          </div>
        </form>
      </Card>

      <Card title="Call history" subtitle={`${total} call${total === 1 ? '' : 's'} match`}>
        {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
        {!error && loading && rows.length === 0 && <p className="text-xs text-slate-400">Loading…</p>}
        {!error && !loading && rows.length === 0 && (
          <p className="text-xs text-slate-400" data-testid="empty">
            No calls match. Calls appear here as the gateway handles them; AI timings are recorded only for calls the AI attached to.
          </p>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800 text-[11px] uppercase font-mono">
                  <th className="py-2 pr-3">Started</th>
                  <th className="py-2 pr-3">Dir</th>
                  <th className="py-2 pr-3">Duration</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">STT</th>
                  <th className="py-2 pr-3">LLM</th>
                  <th className="py-2 pr-3">TTS</th>
                  <th className="py-2 pr-3">Turns</th>
                  <th className="py-2">End-to-end</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => select(r.id)} onKeyDown={(e) => e.key === 'Enter' && select(r.id)} tabIndex={0} aria-selected={selected === r.id} data-call-id={r.id} className={`border-b border-slate-800/60 cursor-pointer hover:bg-slate-800/40 ${selected === r.id ? 'bg-slate-800/70 ring-1 ring-inset ring-cyan-700' : ''}`}>
                    <td className="py-2 pr-3 text-slate-300 whitespace-nowrap">{formatDate(r.startedAt)}</td>
                    <td className="py-2 pr-3 text-slate-400">{r.direction === 'inbound' ? 'in' : 'out'}</td>
                    <td className="py-2 pr-3 font-mono text-slate-300">{formatDuration(r.durationSeconds)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                      {r.simulated && <span className="ml-1 text-[10px] text-amber-400">sim</span>}
                      {r.failedTurns > 0 && <span className="ml-1 text-[10px] text-rose-400">{r.failedTurns} AI err</span>}
                      {r.campaign && <span className="ml-1 text-[10px] text-cyan-400">campaign</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-400">{pickLabel(r.selection.stt)}</td>
                    <td className="py-2 pr-3 font-mono text-slate-400">{pickLabel(r.selection.llm)}</td>
                    <td className="py-2 pr-3 font-mono text-slate-400">{pickLabel(r.selection.tts)}</td>
                    <td className="py-2 pr-3 font-mono text-slate-300" title={callSummaryLine(r)}>{r.turns}</td>
                    <td className="py-2 font-mono text-slate-300">{ms(r.latency.endToEndMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-xs text-slate-400">
            <Button disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</Button>
            <span>Page {page} of {pages}</span>
            <Button disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </Card>

      {status && (
        <p className="text-[11px] text-slate-500" data-testid="retention">
          {status.events} trace events kept
          {status.retention ? (status.retention.retentionDays > 0 ? `, ${status.retention.retentionDays} days (max ${status.retention.maxEvents.toLocaleString()})` : ', no age limit') : ''}.
          Call records and turn timings are never deleted by retention.
          {status.failedWrites > 0 && <span className="text-amber-400"> {status.failedWrites} telemetry write(s) failed since the gateway started.</span>}
        </p>
      )}

      {selected && (
        <aside className="fixed inset-y-0 right-0 z-40 w-full md:w-[760px] max-w-full overflow-y-auto bg-[#0b1020] border-l border-slate-800 shadow-2xl p-4" data-testid="call-drawer" aria-label="Call detail">
          {/* key: a different call is a different component, so nothing of the previous call can remain */}
          <CallDetailPanel key={selected} callId={selected} onClose={() => select(null)} />
        </aside>
      )}
    </div>
  );
}
