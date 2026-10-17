'use client';

import React, { useEffect, useState } from 'react';
import { AiRecording, AiSttRecordingResult, apiClient } from '../../lib/api-client';
import { credentialBadges } from '../../lib/ai-secrets';
import { formatLatency } from '../../lib/ai-inspector';
import { useAi } from '../../lib/context/AiContext';
import { formatTimeOnly } from '../../lib/utils';
import { MeterCard } from './OverviewTab';
import { unique } from '../../lib/ai-settings-form';
import { ActionNote, Badge, Button, Card, Field, SaveBar, Select, Tile, TextInput, useAction } from './ui';
import { useSettingsDraft } from './useSettingsDraft';

function RecordingTest() {
  const [recordings, setRecordings] = useState<AiRecording[]>([]);
  const [file, setFile] = useState('');
  const [start, setStart] = useState('0');
  const [seconds, setSeconds] = useState('20');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AiSttRecordingResult | null>(null);
  const [action, run] = useAction();
  const [listing, runList] = useAction();

  useEffect(() => {
    void runList(async () => {
      const { recordings } = await apiClient.listAiRecordings();
      setRecordings(recordings);
      if (recordings[0]) setFile((f) => f || recordings[0].name);
      return recordings;
    }, 'Recordings loaded');
  }, [runList]);

  return (
    <Card
      title="Test with an existing recording"
      subtitle="Sends part of a saved capture to the selected speech-to-text provider. This is separate from live calls: it uses no call, writes nothing to the modem, and does not count as proof that live audio works."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Recording (audio-dumps folder)">
          <Select value={file} onChange={(e) => setFile(e.target.value)} disabled={recordings.length === 0}>
            {recordings.length === 0 && <option value="">No recordings found</option>}
            {recordings.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} ({(r.bytes / 1024).toFixed(0)} KB{r.seconds !== null ? `, ${r.seconds.toFixed(0)} s` : ''})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start at (seconds)">
          <TextInput inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Length (1–60 s)">
          <TextInput inputMode="numeric" value={seconds} onChange={(e) => setSeconds(e.target.value)} />
        </Field>
      </div>
      <p className="text-[11px] text-slate-500">Raw .bin captures are read at the configured gateway sample rate; .wav files use their own header.</p>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button
              variant="primary"
              busy={action.status === 'running'}
              onClick={async () => {
                setConfirming(false);
                const r = await run(
                  () => apiClient.testAiStt({ file, startSeconds: Number(start) || 0, durationSeconds: Number(seconds) || 20 }),
                  'Transcription finished'
                );
                if (r) setResult(r);
              }}
            >
              Send to provider (may be billed)
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={!file}>
            Transcribe this recording…
          </Button>
        )}
      </div>
      <ActionNote state={listing.status === 'error' ? listing : { status: 'idle' }} />
      <ActionNote state={action} />
      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Audio">{result.seconds} s from {result.startSeconds} s</Tile>
            <Tile label="Provider latency">{formatLatency(result.sttMs)}</Tile>
            <Tile label="Pre-check">{result.assessment.decision}</Tile>
            <Tile label="Estimated cost">{result.estimatedCostUsd === null ? 'n/a' : `$${result.estimatedCostUsd.toFixed(5)}`}</Tile>
          </div>
          <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
            <p className="text-[10px] uppercase font-mono text-slate-500 mb-1">Transcript{result.mock ? ' (offline mock provider)' : ''}</p>
            <p className="text-sm text-slate-100">{result.transcript || '(the provider returned no words)'}</p>
          </div>
          <p className="text-[11px] text-slate-500">{result.note}</p>
        </div>
      )}
    </Card>
  );
}

export function SttTab() {
  const { draft, setDraft, dirty, problems, action, save, cancel, catalog, state } = useSettingsDraft();
  const { inspector } = useAi();
  if (!draft || !catalog || !state) return <p className="text-xs text-slate-500">Loading…</p>;
  const option = catalog.stt.find((o) => o.key === draft.stt);
  const keyName = option?.provider === 'groq' ? 'GROQ_API_KEY' : 'DEEPGRAM_API_KEY';
  const key = state.credentials.find((c) => c.name === keyName);
  const badges = key ? credentialBadges(key) : null;
  const session = state.sessions[0];
  const recent = inspector.turns
    .filter((t) => t.stages['stt-result'].status !== 'pending')
    .slice(-8)
    .reverse();

  return (
    <div className="space-y-6">
      <Card title="Speech-to-text" subtitle="Which provider turns caller audio into text.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Provider and model" hint={option?.priceNote ?? undefined}>
            <Select value={draft.stt} onChange={(e) => setDraft({ ...draft, stt: e.target.value })}>
              {catalog.stt.map((o) => (
                <option key={o.key} value={o.key} disabled={!o.implemented}>
                  {o.label}
                  {o.model ? ` · ${o.model}` : ''}
                  {o.implemented ? '' : ' (not ported yet)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Language" hint="Providers differ in what they support; a wrong language shows up as poor transcripts, not an error.">
            <Select value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })}>
              {unique([draft.language, ...catalog.languages]).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Request timeout (ms)">
            <TextInput
              inputMode="numeric"
              value={draft.params.sttTimeoutMs}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, sttTimeoutMs: Number(e.target.value) || 0 } })}
            />
          </Field>
          <Field label="Speech level threshold (RMS, fraction of full scale)" hint="Audio quieter than this is never sent to the provider. Captures from this modem were very quiet (about 0.005 RMS), so compare with the RMS in the live meters before raising it.">
            <TextInput
              inputMode="decimal"
              value={draft.params.vadRmsThreshold}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, vadRmsThreshold: Number(e.target.value) || 0 } })}
            />
          </Field>
          <Field label="Silence that ends a caller turn (ms)" hint="Longer waits make the agent slower to answer; shorter ones can cut people off.">
            <TextInput
              inputMode="numeric"
              value={draft.params.vadMinSilenceMs}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, vadMinSilenceMs: Number(e.target.value) || 0 } })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile label="Mode">Batch (per utterance)</Tile>
          <Tile label="Partial transcripts">Not available</Tile>
          <Tile label="Input format">
            {draft.audioSampleRate ? `${draft.audioSampleRate} Hz 16-bit mono LE` : 'not configured'}
          </Tile>
          <Tile label="API key">
            {badges ? (
              <span className="flex flex-wrap gap-1">
                <Badge tone={badges.presence.tone}>{badges.presence.label}</Badge>
                <Badge tone={badges.check.tone}>{badges.check.label}</Badge>
              </span>
            ) : (
              '—'
            )}
          </Tile>
        </div>
        <p className="text-[11px] text-slate-500">
          Each finished utterance is sent as one request, so text appears after the caller pauses, not while they speak. Manage keys on the API Keys tab.
        </p>
        <SaveBar dirty={dirty} problems={problems} action={action} onSave={save} onCancel={cancel} />
      </Card>

      <Card title="Live diagnostics" subtitle="What the speech-to-text stage is receiving and returning right now.">
        {session ? <MeterCard session={session} /> : <p className="text-xs text-slate-500">No AI session is attached to a call.</p>}
        <div>
          <p className="text-[10px] uppercase font-mono text-slate-500 mb-1">Recent results</p>
          {recent.length === 0 ? (
            <p className="text-xs text-slate-500">Nothing transcribed yet.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-800/70">
                {recent.map((t) => {
                  const s = t.stages['stt-result'];
                  return (
                    <tr key={t.turnId}>
                      <td className="py-1.5 pr-2 font-mono text-slate-500 whitespace-nowrap">{formatTimeOnly(s.at)}</td>
                      <td className="py-1.5 pr-2">
                        <Badge tone={s.status === 'ok' ? 'good' : s.status === 'failed' ? 'bad' : 'warn'}>{s.status}</Badge>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-slate-300 whitespace-nowrap">{formatLatency(s.latencyMs)}</td>
                      <td className="py-1.5 text-slate-200">
                        {t.callerText ?? <span className="text-slate-500">{s.detail ?? (t.textHidden ? 'text hidden (transcript display is off)' : '—')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <RecordingTest />
    </div>
  );
}
