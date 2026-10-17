'use client';

import React, { useEffect, useState } from 'react';
import { AiTtsCompatibility, AiTtsPreviewResult, apiClient } from '../../lib/api-client';
import { formatLatency } from '../../lib/ai-inspector';
import { credentialBadges } from '../../lib/ai-secrets';
import { selectTtsProvider, voicesFor } from '../../lib/ai-settings-form';
import { unique } from '../../lib/ai-settings-form';
import { ActionNote, Badge, Button, Card, Field, SaveBar, Select, Tile, TextInput, useAction } from './ui';
import { useSettingsDraft } from './useSettingsDraft';

const COMMON_RATES = [8000, 16000];

function Compatibility({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<AiTtsCompatibility | null>(null);
  const [action, run] = useAction();
  useEffect(() => {
    void run(async () => {
      const result = await apiClient.getAiTtsCompatibility();
      setData(result);
      return result;
    }, 'Checked');
  }, [refreshKey, run]);
  return (
    <Card title="Compatibility with the phone line" subtitle="Whether this voice can be delivered over the modem’s audio path, and what is still unproven.">
      {action.status === 'error' && <ActionNote state={action} />}
      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge tone={data.providerSupportsGatewayRate === true ? 'good' : data.providerSupportsGatewayRate === false ? 'bad' : 'neutral'}>
              {data.providerSupportsGatewayRate === null ? 'format unknown' : data.providerSupportsGatewayRate ? 'provider supports gateway format' : 'provider cannot match gateway format'}
            </Badge>
            <Badge tone={data.outboundPathVerified ? 'good' : 'warn'}>{data.outboundPathVerified ? 'outbound path confirmed by you' : 'outbound path unverified'}</Badge>
          </div>
          <ul className="text-xs text-slate-300 list-disc pl-4 space-y-1">
            {data.statements.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Preview() {
  const [text, setText] = useState('Hello, thanks for calling. How can I help you today?');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AiTtsPreviewResult | null>(null);
  const [action, run] = useAction();
  return (
    <Card
      title="Preview the voice in this browser"
      subtitle="Generates speech and plays it here only. It is never written to the modem or sent to a caller, and it says nothing about whether a caller could hear it."
    >
      <Field label="Text (up to 300 characters)">
        <TextInput value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button
              variant="primary"
              busy={action.status === 'running'}
              onClick={async () => {
                setConfirming(false);
                const r = await run(() => apiClient.previewAiTts(text.trim()), 'Preview generated');
                if (r) setResult(r);
              }}
            >
              Generate (may be billed)
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={text.trim().length === 0}>
            Generate preview…
          </Button>
        )}
      </div>
      <ActionNote state={action} />
      {result && (
        <div className="space-y-3">
          <audio controls src={`data:audio/wav;base64,${result.audioWavBase64}`} className="w-full" />
          <div className="flex flex-wrap gap-2">
            <Badge tone="good">generated</Badge>
            <Badge tone="warn">not transmitted to any caller</Badge>
            {result.mock && <Badge>offline mock tone, not real speech</Badge>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Generation time">{formatLatency(result.generationMs)}</Tile>
            <Tile label="Audio">{result.seconds} s</Tile>
            <Tile label="Format">{result.format}</Tile>
            <Tile label="Characters / cost">
              {result.chars} / {result.estimatedCostUsd === null ? 'n/a' : `$${result.estimatedCostUsd.toFixed(5)}`}
            </Tile>
          </div>
        </div>
      )}
    </Card>
  );
}

export function TtsTab() {
  const { draft, setDraft, dirty, problems, action, save, cancel, catalog, state } = useSettingsDraft();
  if (!draft || !catalog || !state) return <p className="text-xs text-slate-500">Loading…</p>;
  const option = catalog.tts.find((o) => o.key === draft.tts);
  const voices = voicesFor(catalog, draft.tts);
  const key = state.credentials.find((c) => c.name === (draft.tts === 'deepgram' ? 'DEEPGRAM_API_KEY' : 'CARTESIA_API_KEY'));
  const badges = key ? credentialBadges(key) : null;
  const rates = unique([...(draft.audioSampleRate ? [draft.audioSampleRate] : []), ...COMMON_RATES]);

  return (
    <div className="space-y-6">
      <Card title="Text-to-speech" subtitle="Which voice speaks the agent’s replies, and the audio format it must produce for the phone line.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Provider" hint={option?.priceNote ?? undefined}>
            <Select value={draft.tts} onChange={(e) => setDraft(selectTtsProvider(draft, catalog, e.target.value))}>
              {catalog.tts.map((o) => (
                <option key={o.key} value={o.key} disabled={!o.implemented}>
                  {o.label}
                  {o.implemented ? '' : ' (not ported yet)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Voice" hint={draft.tts === 'deepgram' ? 'Aura voice ids end in -en and start with aura-.' : undefined}>
            {voices.length > 0 ? (
              <Select value={draft.ttsVoice} onChange={(e) => setDraft({ ...draft, ttsVoice: e.target.value })}>
                {!voices.some((v) => v.id === draft.ttsVoice) && draft.ttsVoice && <option value={draft.ttsVoice}>{draft.ttsVoice} (current)</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput value={draft.ttsVoice} onChange={(e) => setDraft({ ...draft, ttsVoice: e.target.value })} />
            )}
          </Field>
          <Field label="Language">
            <Select value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })}>
              {unique([draft.language, ...catalog.languages]).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Gateway audio sample rate"
            hint="Raw 16-bit mono little-endian PCM. Changing it removes your audio confirmations, because they were made under the old format."
          >
            <Select
              value={draft.audioSampleRate ?? ''}
              onChange={(e) => setDraft({ ...draft, audioSampleRate: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">not configured</option>
              {rates.map((r) => (
                <option key={r} value={r}>
                  {r} Hz
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Request timeout (ms)">
            <TextInput
              inputMode="numeric"
              value={draft.params.ttsTimeoutMs}
              onChange={(e) => setDraft({ ...draft, params: { ...draft.params, ttsTimeoutMs: Number(e.target.value) || 0 } })}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          Output: raw PCM at the gateway rate. API key:
          {badges && (
            <>
              <Badge tone={badges.presence.tone}>{badges.presence.label}</Badge>
              <Badge tone={badges.check.tone}>{badges.check.label}</Badge>
            </>
          )}
        </div>
        <SaveBar dirty={dirty} problems={problems} action={action} onSave={save} onCancel={cancel} />
      </Card>

      <Compatibility refreshKey={`${state.settings.tts}|${state.settings.ttsVoice}|${state.settings.audioSampleRate}|${state.settings.attestations.outbound.confirmed}`} />
      <Preview />
    </div>
  );
}
