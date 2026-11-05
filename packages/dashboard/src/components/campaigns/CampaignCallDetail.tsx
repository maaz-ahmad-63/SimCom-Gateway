'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import {
  CampaignCallDetail,
  CORRECTABLE_OUTCOMES,
  CorrectionDraft,
  correctionPatch,
  costText,
  draftFromOverride,
  durationText,
  Interest,
  Outcome,
  OUTCOME_LABELS,
  outcomeTone,
  sentimentTone,
  sourceText,
  statusLabel,
  TranscriptLine,
  transcriptText,
} from '../../lib/campaign-calls';
import { recordingAvailability, RecordingInfo } from '../../lib/recordings';
import { formatDate } from '../../lib/utils';
import { ActionNote, Badge, Button, Select, TextArea, useAction } from '../ai/ui';
import { RecordingPlayer } from '../calls/RecordingPlayer';

const unavailable = <span className="text-slate-500">Not recorded</span>;

/** The saved transcript, speaker by speaker, exactly as stored (any language). A missing or failed transcript says so. */
export function TranscriptView({ lines, storedOff }: { lines: TranscriptLine[]; storedOff?: boolean }) {
  if (lines.length === 0) {
    return (
      <p role="status" className="text-xs text-slate-400" data-testid="transcript-missing">
        {storedOff ? 'No transcript was saved for this call because transcripts were switched off on the gateway.' : 'There is no transcript for this call: nothing was said that the agent could transcribe, or the call never connected.'}
      </p>
    );
  }
  return (
    <ol className="space-y-2" data-testid="transcript-lines">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-3 text-xs">
          <span className="w-14 shrink-0 text-[10px] font-mono text-slate-500 pt-0.5">{new Date(l.at).toLocaleTimeString('en-GB', { hour12: false })}</span>
          <span className={`w-14 shrink-0 font-semibold ${l.speaker === 'Agent' ? 'text-cyan-300' : 'text-emerald-300'}`}>{l.speaker}</span>
          <span lang="und" className="text-slate-200 whitespace-pre-wrap break-words min-w-0">
            {l.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className="bg-[#0f172a] border border-slate-800 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-white">{title}</h2>
            {subtitle && <p className="text-[11px] text-slate-500 font-mono mt-0.5 break-all">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-5 text-xs">{children}</div>
      </div>
    </div>
  );
}

/** The full transcript of one call (Read more in the table). */
export function TranscriptModal({ campaignId, attemptId, name, onClose }: { campaignId: string; attemptId: number; name: string; onClose: () => void }) {
  const [call, setCall] = useState<CampaignCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiClient
      .getCampaignCall(campaignId, attemptId)
      .then((r) => alive && setCall(r.call))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [campaignId, attemptId]);
  const copy = () => void navigator.clipboard?.writeText(transcriptText(call?.transcriptLines ?? [])).catch(() => undefined);
  return (
    <Modal title={`Transcript: ${name}`} subtitle={call?.callId ?? undefined} onClose={onClose}>
      {error && (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      )}
      {!call && !error && <p className="text-slate-400">Loading…</p>}
      {call && (
        <>
          <TranscriptView lines={call.transcriptLines} storedOff={call.transcript.storedOff} />
          {call.transcriptLines.length > 0 && <Button onClick={copy}>Copy transcript</Button>}
        </>
      )}
    </Modal>
  );
}

const list = (items: string[]) =>
  items.length === 0 ? (
    unavailable
  ) : (
    <ul className="list-disc ml-4 space-y-0.5">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-1.5 border-b border-slate-800/60">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 text-slate-200 break-words">{children}</dd>
    </div>
  );
}

export interface DetailBodyProps {
  call: CampaignCallDetail;
  recording: { state: 'loading' } | ReturnType<typeof recordingAvailability>;
  showPlayer: boolean;
  onTogglePlayer: () => void;
  canAnalyze: boolean;
  analyzeState: Parameters<typeof ActionNote>[0]['state'];
  onAnalyze: () => void;
  draft: CorrectionDraft;
  onDraft: (d: CorrectionDraft) => void;
  correctState: Parameters<typeof ActionNote>[0]['state'];
  onSaveCorrection: () => void;
  onRemoveCorrection: () => void;
}

/** Everything the gateway recorded about one campaign call. Nothing here is estimated: a value that was not recorded says so. */
export function CallDetailBody(p: DetailBodyProps) {
  const { call } = p;
  const c = call.classification;
  const ai = call.analysisDetail.original;
  const patch = correctionPatch(p.draft);
  return (
    <>
      <section aria-label="Conclusion" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={outcomeTone(c.outcome)}>{OUTCOME_LABELS[c.outcome]}</Badge>
          {c.interest && <Badge tone="neutral">{`Interest: ${c.interest}`}</Badge>}
          {call.sentiment && <Badge tone={sentimentTone(call.sentiment)}>{`Sentiment: ${call.sentiment}`}</Badge>}
          {c.quotationRequested && <Badge tone="good">Quotation requested</Badge>}
          {c.demoRequested && <Badge tone="good">Demo requested</Badge>}
          {c.callbackRequested && <Badge tone="good">Callback requested</Badge>}
        </div>
        <p className="text-sm text-white" data-testid="conclusion">
          {c.summary}
        </p>
        <p className="text-[11px] text-slate-500" data-testid="conclusion-source">
          {sourceText(c)}
        </p>
      </section>

      <section aria-label="Sales analysis">
        <h3 className="text-xs font-semibold text-white mb-1">AI sales analysis</h3>
        <dl>
          <Row label="Recommended next action">{c.nextAction ?? unavailable}</Row>
          <Row label="Extracted requirements">{list(c.requirements)}</Row>
          <Row label="Objections">{list(c.objections)}</Row>
          <Row label="Callback">{c.callback ? (c.callback.requested ? `Requested${c.callback.when ? `: ${c.callback.when}` : ''}${c.callback.note ? ` (${c.callback.note})` : ''}` : 'Not requested') : unavailable}</Row>
          <Row label="Quotation / demo">{c.source === 'rule' ? unavailable : `${c.quotationRequested ? 'Quotation requested' : 'No quotation request'} · ${c.demoRequested ? 'Demo requested' : 'No demo request'}`}</Row>
        </dl>
        {call.analysis.status === 'failed' && (
          <p role="alert" className="text-amber-300 mt-2">
            The last analysis attempt failed: {call.analysis.error}
          </p>
        )}
        {call.analysis.status === 'pending' && <p className="text-slate-400 mt-2">This conversation has not been analysed yet.</p>}
        {call.analysis.status === 'not_needed' && <p className="text-slate-500 mt-2">Only a real conversation is analysed. This call was classified from how it ended.</p>}
        <div className="mt-2 flex items-center gap-3">
          {p.canAnalyze && (
            <Button onClick={p.onAnalyze} busy={p.analyzeState.status === 'running'}>
              {ai ? 'Analyse again' : 'Analyse this call'}
            </Button>
          )}
          <span className="text-[11px] text-slate-500">Uses the campaign's model on the saved transcript. Earlier results are kept.</span>
        </div>
        <ActionNote state={p.analyzeState} />
      </section>

      <section aria-label="Correction" className="space-y-2" data-testid="correction">
        <h3 className="text-xs font-semibold text-white">Correct the classification</h3>
        <p className="text-[11px] text-slate-500">A correction is laid over the result for the table, the counts and the export. The AI's original answer stays saved{ai ? ` (${OUTCOME_LABELS[ai.outcome]}, ${call.analysisDetail.ranAt ? formatDate(call.analysisDetail.ranAt) : ''})` : ''}.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Outcome</span>
            <Select value={p.draft.outcome} onChange={(e) => p.onDraft({ ...p.draft, outcome: e.target.value as Outcome | '' })} aria-label="Outcome">
              <option value="">Keep the current result</option>
              {CORRECTABLE_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Interest</span>
            <Select value={p.draft.interest} onChange={(e) => p.onDraft({ ...p.draft, interest: e.target.value as Interest | '' })} aria-label="Interest">
              <option value="">Keep the current result</option>
              {(['high', 'medium', 'low', 'none'] as Interest[]).map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <TextArea value={p.draft.summary} onChange={(e) => p.onDraft({ ...p.draft, summary: e.target.value })} rows={2} aria-label="Corrected summary" placeholder="Corrected summary (optional)" maxLength={700} />
        <TextArea value={p.draft.nextAction} onChange={(e) => p.onDraft({ ...p.draft, nextAction: e.target.value })} rows={1} aria-label="Corrected next action" placeholder="Corrected next action (optional)" maxLength={300} />
        <TextArea value={p.draft.note} onChange={(e) => p.onDraft({ ...p.draft, note: e.target.value })} rows={1} aria-label="Note" placeholder="Why this was corrected (optional)" maxLength={1000} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={p.onSaveCorrection} disabled={patch === null} busy={p.correctState.status === 'running'}>
            Save correction
          </Button>
          {call.analysisDetail.override && <Button onClick={p.onRemoveCorrection}>Remove correction</Button>}
        </div>
        <ActionNote state={p.correctState} />
      </section>

      <section aria-label="Recording" className="space-y-2">
        <h3 className="text-xs font-semibold text-white">Recording</h3>
        {p.recording.state === 'loading' && <p className="text-slate-400">Checking for a recording…</p>}
        {p.recording.state === 'none' && (
          <p role="status" className="text-slate-400" data-testid="recording-unavailable">
            {p.recording.reason}
          </p>
        )}
        {(p.recording.state === 'available' || p.recording.state === 'unknown') && call.callId && (
          <>
            {!p.showPlayer && <Button onClick={p.onTogglePlayer}>Play the recording</Button>}
            {p.showPlayer && <RecordingPlayer key={call.callId} callId={call.callId} recording={p.recording.state === 'available' ? p.recording.recording : null} />}
          </>
        )}
      </section>

      <section aria-label="Transcript" className="space-y-2">
        <h3 className="text-xs font-semibold text-white">Full transcript</h3>
        <TranscriptView lines={call.transcriptLines} storedOff={call.transcript.storedOff} />
      </section>

      <section aria-label="Tool calls" className="space-y-2">
        <h3 className="text-xs font-semibold text-white">Tool calls</h3>
        {call.tools.length === 0 ? (
          <p className="text-slate-500" data-testid="no-tools">
            The agent did not call any tools on this call.
          </p>
        ) : (
          <ul className="space-y-1" data-testid="tool-calls">
            {call.tools.map((t, i) => (
              <li key={i} className="font-mono">
                {t.tool}: {t.ok ? 'worked' : `did not work${t.code ? ` (${t.code})` : ''}`}
                <span className="text-slate-500"> · {new Date(t.at).toLocaleTimeString('en-GB', { hour12: false })}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-slate-500">Only whether each tool worked is recorded, never the details given to it.</p>
      </section>

      <section aria-label="Call record">
        <h3 className="text-xs font-semibold text-white mb-1">Call record</h3>
        <dl>
          <Row label="Call ID">{call.callId ? <span className="font-mono">{call.callId}</span> : 'No call was placed for this attempt'}</Row>
          <Row label="Attempt">{call.attempt}</Row>
          <Row label="Contact">
            {call.contact.name || unavailable}
            {call.contactDetails.designation ? `, ${call.contactDetails.designation}` : ''}
            {call.contactDetails.company ? `, ${call.contactDetails.company}` : ''}
          </Row>
          {Object.entries(call.contact.extra).map(([k, v]) => (
            <Row key={k} label={k}>
              {v}
            </Row>
          ))}
          <Row label="Contact notes">{call.contactDetails.notes || unavailable}</Row>
          <Row label="Called number">
            <span className="font-mono">{call.calledTo}</span>
            {call.contactDetails.phoneAsWritten && call.contactDetails.phoneAsWritten !== call.calledTo ? ` (written as ${call.contactDetails.phoneAsWritten})` : ''}
          </Row>
          <Row label="SIM / modem number">{call.sipNumber ?? unavailable}</Row>
          <Row label="Direction">Outbound</Row>
          <Row label="Started">{formatDate(call.startedAt)}</Row>
          <Row label="Answered">{call.answeredAt ? formatDate(call.answeredAt) : 'Not answered'}</Row>
          <Row label="Ended">{call.endedAt ? formatDate(call.endedAt) : unavailable}</Row>
          <Row label="Duration">{durationText(call.durationSeconds)}</Row>
          <Row label="Technical status">
            {statusLabel(call.status)}
            {call.terminationReason ? ` · ${call.terminationReason}` : ''}
            {call.error ? ` · ${call.error}` : ''}
          </Row>
          <Row label="Agent">{`Campaign agent${call.promptVersion ? `, config version ${call.promptVersion}${call.promptSha ? ` (prompt ${call.promptSha})` : ''}` : ' (no campaign prompt: the gateway outbound agent)'}`}</Row>
          <Row label="Language model">{call.models.llm ?? unavailable}</Row>
          <Row label="Speech-to-text">{call.models.stt ?? unavailable}</Row>
          <Row label="Text-to-speech">{call.models.tts ?? unavailable}</Row>
          <Row label="Tokens">{call.usage.turns > 0 ? `${call.usage.inputTokens.toLocaleString('en-US')} in / ${call.usage.outputTokens.toLocaleString('en-US')} out over ${call.usage.turns} turns` : unavailable}</Row>
          <Row label="Cost">
            {costText(call.cost)}
            {call.cost.note ? <span className="block text-[11px] text-slate-500">{call.cost.note}</span> : null}
          </Row>
        </dl>
      </section>
    </>
  );
}

/** One campaign call, in full. */
export function CampaignCallDetailModal({ campaignId, attemptId, canAnalyze, onClose, onChanged }: { campaignId: string; attemptId: number; canAnalyze: boolean; onClose: () => void; onChanged: () => void }) {
  const [call, setCall] = useState<CampaignCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<DetailBodyProps['recording']>({ state: 'loading' });
  const [showPlayer, setShowPlayer] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft>(draftFromOverride(null));
  const [analyzeState, runAnalyze] = useAction();
  const [correctState, runCorrect] = useAction();

  const apply = (next: CampaignCallDetail) => {
    setCall(next);
    setDraft(draftFromOverride(next.analysisDetail.override));
    onChanged();
  };

  useEffect(() => {
    let alive = true;
    apiClient
      .getCampaignCall(campaignId, attemptId)
      .then((r) => {
        if (!alive) return;
        setCall(r.call);
        setDraft(draftFromOverride(r.call.analysisDetail.override));
        if (!r.call.callId) return setRecording({ state: 'none', reason: 'No call was placed for this attempt, so there is nothing to record.' });
        const id = r.call.callId;
        apiClient
          .getRecordings([id])
          .then((res) => alive && setRecording(recordingAvailability({ id, answeredAt: r.call.answeredAt, outcome: r.call.status }, new Map(res.recordings.map((x: RecordingInfo) => [x.callId, x])))))
          .catch(() => alive && setRecording({ state: 'unknown' }));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [campaignId, attemptId]);

  return (
    <Modal title={call ? `Call details: ${call.contact.name || call.calledTo}` : 'Call details'} subtitle={call?.callId ?? undefined} onClose={onClose}>
      {error && (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      )}
      {!call && !error && <p className="text-slate-400">Loading…</p>}
      {call && (
        <CallDetailBody
          call={call}
          recording={recording}
          showPlayer={showPlayer}
          onTogglePlayer={() => setShowPlayer((v) => !v)}
          canAnalyze={canAnalyze}
          analyzeState={analyzeState}
          onAnalyze={() => void runAnalyze(() => apiClient.analyzeCampaignCall(campaignId, attemptId), 'Analysis finished.').then((r) => r && apply(r.call))}
          draft={draft}
          onDraft={setDraft}
          correctState={correctState}
          onSaveCorrection={() => {
            const patch = correctionPatch(draft);
            if (patch) void runCorrect(() => apiClient.correctCampaignCall(campaignId, attemptId, patch), 'Correction saved. The original result is kept.').then((r) => r && apply(r.call));
          }}
          onRemoveCorrection={() => void runCorrect(() => apiClient.clearCampaignCallCorrection(campaignId, attemptId), 'Correction removed.').then((r) => r && apply(r.call))}
        />
      )}
    </Modal>
  );
}
