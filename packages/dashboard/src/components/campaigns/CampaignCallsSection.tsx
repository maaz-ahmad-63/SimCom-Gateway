'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Eye, PhoneOutgoing, RefreshCw, Search } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import {
  CallAnalytics,
  CallFilter,
  CallList,
  CallSort,
  CampaignCallRow,
  costText,
  durationText,
  FILTER_OPTIONS,
  filterLabel,
  metricTiles,
  nextSort,
  OUTCOME_LABELS,
  outcomeTone,
  PAGE_SIZES,
  pageCount,
  sentimentTone,
  statusLabel,
} from '../../lib/campaign-calls';
import { nextRecordingAction, NotRecordedInfo, recordingAvailability, RecordingInfo } from '../../lib/recordings';
import { formatDate } from '../../lib/utils';
import { Badge, Card } from '../ai/ui';
import { PlayerHandle, RecordingActionButton, RecordingPlayer } from '../calls/RecordingPlayer';
import { CampaignCallDetailModal, TranscriptModal } from './CampaignCallDetail';

const dash = <span className="text-slate-600">—</span>;

/** The counts, each a button that shows exactly those calls below. The numbers come from the same records and the same filters as the table. */
export function MetricTiles({ analytics, active, onPick }: { analytics: CallAnalytics | null; active: CallFilter; onPick: (f: CallFilter) => void }) {
  if (!analytics) return <p className="text-xs text-slate-400">Loading the counts…</p>;
  return (
    <div className="space-y-2" data-testid="call-metrics">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
        {metricTiles(analytics).map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => onPick(m.key === active ? 'all' : m.key)}
            aria-pressed={m.key === active}
            title={`Show the ${m.count} call(s) counted here`}
            className={`text-left rounded-lg border px-3 py-2 transition ${m.key === active ? 'border-cyan-600 bg-cyan-950/40' : 'border-slate-800 bg-slate-950/60 hover:border-slate-600'}`}
          >
            <span className="block text-[10px] uppercase tracking-wide font-medium text-slate-500">{m.label}</span>
            <span className="block text-lg font-mono font-bold text-white">{m.count}</span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500" data-testid="analysis-coverage">
        {analytics.totalCalls} call record(s) · {analytics.analysed} analysed by the AI · {analytics.awaitingAnalysis} conversation(s) waiting for analysis · {analytics.corrected} corrected by a person. Counts follow the table's own classification and overlap (a call can be both interested and a quotation request).
      </p>
    </div>
  );
}

export interface TableProps {
  items: CampaignCallRow[];
  loading: boolean;
  error: string | null;
  sort: CallSort;
  dir: 'asc' | 'desc';
  onSort: (s: CallSort) => void;
  recordings: Map<string, RecordingInfo> | null;
  /** Why a connected call was not recorded (optional; absent from an older gateway). */
  notRecorded?: Map<string, NotRecordedInfo> | null;
  openCallId: string | null;
  playing: boolean;
  player: React.MutableRefObject<PlayerHandle | null>;
  onRecording: (row: CampaignCallRow) => void;
  onPlayingChange: (v: boolean) => void;
  onTranscript: (row: CampaignCallRow) => void;
  onDetails: (row: CampaignCallRow) => void;
}

const COLUMNS: Array<{ label: string; sort?: CallSort }> = [
  { label: 'Date & time', sort: 'startedAt' },
  { label: 'Called to', sort: 'name' },
  { label: 'SIP number' },
  { label: 'Duration', sort: 'duration' },
  { label: 'Direction' },
  { label: 'Status', sort: 'status' },
  { label: 'Agent' },
  { label: 'Sentiment', sort: 'sentiment' },
  { label: 'Price / cost', sort: 'cost' },
  { label: 'Tool calls' },
  { label: 'Recording' },
  { label: 'Details' },
  { label: 'Summary / AI conclusion' },
  { label: 'Transcript' },
  { label: 'Campaign sales outcome', sort: 'outcome' },
];

function availabilityOf(row: CampaignCallRow, lookup: Map<string, RecordingInfo> | null, notRecorded?: Map<string, NotRecordedInfo> | null) {
  if (!row.callId) return { state: 'none' as const, reason: 'No call was placed for this attempt, so there is nothing to record.' };
  return recordingAvailability({ id: row.callId, answeredAt: row.status === 'answered' ? row.startedAt : null, outcome: row.status }, lookup, notRecorded);
}

/** The table. It has no state of its own, so every state of it can be drawn and tested. */
export function CampaignCallsTable(p: TableProps) {
  return (
    <div className="border border-slate-800 rounded-lg bg-slate-900/40 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs" data-testid="campaign-calls-table">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-950/70 text-[11px] uppercase tracking-wide font-medium tracking-wider text-slate-400">
              {COLUMNS.map((c) => (
                <th key={c.label} className="py-3 px-3 whitespace-nowrap" aria-sort={c.sort && c.sort === p.sort ? (p.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sort ? (
                    <button type="button" onClick={() => p.onSort(c.sort!)} className="uppercase hover:text-white">
                      {c.label}
                      {c.sort === p.sort ? (p.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {p.error ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-10 text-center text-rose-300" role="alert">
                  {p.error}
                </td>
              </tr>
            ) : p.loading && p.items.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-10 text-center text-slate-500">
                  Loading calls…
                </td>
              </tr>
            ) : p.items.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-10 text-center text-slate-500" data-testid="no-calls">
                  No calls match.
                </td>
              </tr>
            ) : (
              p.items.map((row) => {
                const availability = availabilityOf(row, p.recordings, p.notRecorded);
                const open = p.openCallId === String(row.attemptId);
                const c = row.classification;
                return (
                  <React.Fragment key={row.attemptId}>
                    <tr className="hover:bg-slate-800/30 align-top">
                      <td className="py-3 px-3 whitespace-nowrap text-slate-300 font-mono">{formatDate(row.startedAt)}</td>
                      <td className="py-3 px-3 min-w-[10rem]">
                        <button type="button" onClick={() => p.onDetails(row)} className="block text-left font-semibold text-cyan-300 hover:text-cyan-200 hover:underline" title="Open the full call details">
                          {row.contact.name || row.calledTo}
                        </button>
                        <span className="block font-mono text-[11px] text-slate-400">{row.calledTo}</span>
                        {row.contact.company && <span className="block text-[11px] text-slate-500">{row.contact.company}</span>}
                      </td>
                      <td className="py-3 px-3 text-slate-400">{row.sipNumber ?? <span title="The number of the SIM that placed the call is not stored with a call">Not recorded</span>}</td>
                      <td className="py-3 px-3 font-mono text-slate-300">{durationText(row.durationSeconds)}</td>
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border bg-emerald-950/60 text-emerald-400 border-emerald-800/60">
                          <PhoneOutgoing className="w-3 h-3" />
                          outbound
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <Badge tone={row.status === 'answered' ? 'good' : row.status === 'failed' ? 'bad' : 'warn'}>{statusLabel(row.status)}</Badge>
                      </td>
                      <td className="py-3 px-3 text-slate-300">
                        <span className="block">{row.agent.configVersion ? `Config v${row.agent.configVersion}` : 'Outbound agent'}</span>
                        <span className="block text-[11px] text-slate-500 font-mono">{row.agent.llmKey ?? 'model not recorded'}</span>
                      </td>
                      <td className="py-3 px-3">{row.sentiment ? <Badge tone={sentimentTone(row.sentiment)}>{row.sentiment}</Badge> : dash}</td>
                      <td className="py-3 px-3 text-slate-300 whitespace-nowrap" title={row.cost.note ?? undefined}>
                        {costText(row.cost)}
                      </td>
                      <td className="py-3 px-3 text-slate-300" title={row.toolCalls.items.map((t) => `${t.tool}: ${t.ok ? 'worked' : 'failed'}`).join('\n')}>
                        {row.toolCalls.count}
                      </td>
                      <td className="py-3 px-3">
                        <RecordingActionButton availability={availability} open={open} playing={p.playing} onClick={() => p.onRecording(row)} />
                      </td>
                      <td className="py-3 px-3">
                        <button type="button" onClick={() => p.onDetails(row)} className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300" aria-label={`Details for ${row.contact.name || row.calledTo}`}>
                          <Eye className="w-3.5 h-3.5" /> Details
                        </button>
                      </td>
                      <td className="py-3 px-3 min-w-[16rem] max-w-[22rem] text-slate-200">
                        <span className="block">{c.summary}</span>
                        {c.nextAction && <span className="block text-[11px] text-slate-500 mt-1">Next: {c.nextAction}</span>}
                        {c.source === 'manual' && <span className="block text-[10px] text-amber-300 mt-1">Corrected by a person</span>}
                        {row.analysis.status === 'failed' && <span className="block text-[10px] text-amber-300 mt-1">Analysis failed</span>}
                      </td>
                      <td className="py-3 px-3 min-w-[14rem] max-w-[18rem]">
                        {row.transcript.available ? (
                          <>
                            <span lang="und" className="block text-slate-300 break-words">
                              {row.transcript.preview}
                            </span>
                            <button type="button" onClick={() => p.onTranscript(row)} className="text-cyan-400 hover:text-cyan-300 text-[11px] mt-1">
                              Read more
                            </button>
                          </>
                        ) : (
                          <span className="text-slate-500" title={row.transcript.storedOff ? 'Transcripts were switched off for this call' : undefined}>
                            {row.transcript.storedOff ? 'Not saved (transcripts off)' : 'No transcript'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <Badge tone={outcomeTone(c.outcome)}>{OUTCOME_LABELS[c.outcome]}</Badge>
                        {c.interest && <span className="block text-[11px] text-slate-500 mt-1">Interest: {c.interest}</span>}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-950/50">
                        <td colSpan={COLUMNS.length} className="px-4 py-3">
                          {availability.state === 'none' ? (
                            <p role="status" className="text-xs text-slate-400">
                              {availability.reason}
                            </p>
                          ) : (
                            <RecordingPlayer key={row.callId!} callId={row.callId!} recording={availability.state === 'available' ? availability.recording : null} handleRef={p.player} onPlayingChange={p.onPlayingChange} />
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The campaign's own call history: counts you can click, then the full table with search, filters, sorting, paging and export. */
export function CampaignCallsSection({ campaignId, refreshKey = 0, analysisAvailable = true }: { campaignId: string; refreshKey?: number; analysisAvailable?: boolean }) {
  const [filter, setFilter] = useState<CallFilter>('all');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [order, setOrder] = useState<{ sort: CallSort; dir: 'asc' | 'desc' }>({ sort: 'startedAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [data, setData] = useState<CallList | null>(null);
  const [analytics, setAnalytics] = useState<CallAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Map<string, RecordingInfo> | null>(null);
  const [notRecorded, setNotRecorded] = useState<Map<string, NotRecordedInfo> | null>(null);
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [transcriptFor, setTranscriptFor] = useState<CampaignCallRow | null>(null);
  const [detailFor, setDetailFor] = useState<CampaignCallRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const player = useRef<PlayerHandle | null>(null);
  const ticket = useRef(0);

  // A typed search waits a moment, so it asks the gateway once and not for every key.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(typed);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    setLoading(true);
    try {
      const [list, counts] = await Promise.all([apiClient.listCampaignCalls(campaignId, { filter, search, sort: order.sort, dir: order.dir, page, pageSize }), apiClient.getCampaignAnalytics(campaignId)]);
      if (mine !== ticket.current) return;
      setData(list);
      setAnalytics(counts);
      setError(null);
      setOpenCallId(null);
      const ids = list.items.map((i) => i.callId).filter((x): x is string => !!x);
      apiClient
        .getRecordings(ids)
        .then((res) => {
          if (mine !== ticket.current) return;
          setRecordings(new Map(res.recordings.map((r) => [r.callId, r])));
          setNotRecorded(new Map((res.notRecorded ?? []).map((n) => [n.callId, n])));
        })
        .catch(() => mine === ticket.current && setRecordings(null));
    } catch (e) {
      if (mine === ticket.current) setError(e instanceof Error ? e.message : 'Could not load the calls');
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, [campaignId, filter, search, order, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load, refreshKey, tick]);

  const onRecording = (row: CampaignCallRow) => {
    const key = String(row.attemptId);
    const action = nextRecordingAction(openCallId, key, availabilityFor(row, recordings, notRecorded));
    if (action === 'toggle') player.current?.toggle();
    else if (action === 'close') setOpenCallId(null);
    else {
      setPlaying(false);
      setOpenCallId(key);
    }
  };

  const pick = (f: CallFilter) => {
    setFilter(f);
    setPage(1);
    if (typeof document !== 'undefined') document.getElementById('campaign-call-table')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await apiClient.downloadCampaignCallsCsv(campaignId, { filter, search, sort: order.sort, dir: order.dir });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `campaign-calls${filter === 'all' ? '' : `-${filter}`}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Could not export');
    } finally {
      setExporting(false);
    }
  };

  const total = data?.total ?? 0;
  const pages = pageCount(total, pageSize);

  return (
    <Card title="Call history" subtitle="Every call made for this campaign, from the saved call records. The counts, the table and the export all use the same records and the same classification. Click a count to see exactly those calls.">
      <MetricTiles analytics={analytics} active={filter} onPick={pick} />

      <div id="campaign-call-table" className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-2">
        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search name, number, summary or transcript…"
            aria-label="Search calls"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filter}
            onChange={(e) => pick(e.target.value as CallFilter)}
            aria-label="Filter calls"
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
          >
            {FILTER_OPTIONS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
                {analytics ? ` (${f.key === 'all' ? analytics.totalCalls : (analytics.counts[f.key] ?? 0)})` : ''}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setTick((t) => t + 1)} disabled={loading} aria-label="Refresh" className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={() => void exportCsv()} disabled={exporting || total === 0} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50">
            <Download className="w-3.5 h-3.5" /> Export CSV{filter === 'all' ? '' : ` (${filterLabel(filter)})`}
          </button>
        </div>
      </div>
      {exportError && (
        <p role="alert" className="text-xs text-rose-300">
          {exportError}
        </p>
      )}

      <CampaignCallsTable
        items={data?.items ?? []}
        loading={loading}
        error={error}
        sort={order.sort}
        dir={order.dir}
        onSort={(s) => {
          setOrder(nextSort(order, s));
          setPage(1);
        }}
        recordings={recordings}
        notRecorded={notRecorded}
        openCallId={openCallId}
        playing={playing}
        player={player}
        onRecording={onRecording}
        onPlayingChange={setPlaying}
        onTranscript={setTranscriptFor}
        onDetails={setDetailFor}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-slate-400" data-testid="calls-pager">
        <span>
          {total} call(s){filter !== 'all' ? ` · ${filterLabel(filter)}` : ''}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            Rows
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              aria-label="Rows per page"
              className="bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-xs text-slate-200"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setPage((n) => Math.max(1, n - 1))} disabled={page <= 1} aria-label="Previous page" className="p-1 rounded bg-slate-900 border border-slate-800 disabled:opacity-40">
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button type="button" onClick={() => setPage((n) => Math.min(pages, n + 1))} disabled={page >= pages} aria-label="Next page" className="p-1 rounded bg-slate-900 border border-slate-800 disabled:opacity-40">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {transcriptFor && <TranscriptModal campaignId={campaignId} attemptId={transcriptFor.attemptId} name={transcriptFor.contact.name || transcriptFor.calledTo} onClose={() => setTranscriptFor(null)} />}
      {detailFor && <CampaignCallDetailModal campaignId={campaignId} attemptId={detailFor.attemptId} canAnalyze={analysisAvailable} onClose={() => setDetailFor(null)} onChanged={() => setTick((t) => t + 1)} />}
    </Card>
  );
}

function availabilityFor(row: CampaignCallRow, lookup: Map<string, RecordingInfo> | null, notRecorded?: Map<string, NotRecordedInfo> | null) {
  return availabilityOf(row, lookup, notRecorded);
}
