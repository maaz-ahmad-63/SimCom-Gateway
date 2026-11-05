'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Plus, Sparkles } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import {
  chooseModel,
  describeGenerated,
  generateProblem,
  generationSignature,
  GeneratedInfo,
  suggestName,
  TtsOptions,
  voicesOf,
  wavBlobFromBase64,
  wavFileName,
} from '../../lib/ivr-generate';
import { ActionNote, ActionState, Badge, Button, Field, Select, TextArea, TextInput, useAction } from '../ai/ui';

export interface GeneratedResult {
  url: string;
  info: GeneratedInfo;
  signature: string;
}

export interface GenerateFormProps {
  options: TtsOptions | null;
  optionsError: string | null;
  text: string;
  modelKey: string;
  providerModel: string;
  voice: string;
  name: string;
  onText: (v: string) => void;
  onModel: (key: string) => void;
  onProviderModel: (v: string) => void;
  onVoice: (v: string) => void;
  onName: (v: string) => void;
  generateState: ActionState;
  onGenerate: () => void;
  result: GeneratedResult | null;
  /** The audio was added to the library (true: it was already there). */
  added: { duplicate: boolean } | null;
  addState: ActionState;
  onAdd: () => void;
}

/** The form and its results, with no state of its own (the stateful wrapper below owns it), so every state can be drawn and tested. */
export function GenerateAudioForm(p: GenerateFormProps) {
  const model = p.options?.models.find((m) => m.key === p.modelKey);
  const voices = voicesOf(model);
  /** A dropdown when the Model Hub names the voices; otherwise (voice ids, custom voices) the operator types it, starting from the default. */
  const listedVoices = (model?.voices.length ?? 0) > 0;
  const problem = generateProblem({ text: p.text, modelKey: p.modelKey, options: p.options });
  const stale = p.result !== null && p.result.signature !== generationSignature({ text: p.text, modelKey: p.modelKey, providerModel: p.providerModel, voice: p.voice });
  const fileName = wavFileName(p.name || 'announcement');

  return (
    <div className="space-y-3 border border-slate-800 rounded-lg p-3" aria-label="Generate audio from text">
      <div>
        <p className="text-xs text-slate-200 font-medium">Generate audio from text</p>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          The gateway makes the speech with a voice model from the Model Hub and converts it to the IVR format ({p.options ? `${p.options.sampleRate} Hz` : '8 kHz'}, mono, 16-bit WAV). Nothing is played on a call and nothing is saved until you add it to the library.
        </p>
      </div>

      {p.optionsError && <p role="alert" className="text-xs text-rose-300">{p.optionsError}</p>}
      {!p.options && !p.optionsError && <p className="text-xs text-slate-500">Loading voice models…</p>}

      {p.options && (
        <>
          <Field label="Announcement text" hint={`${p.text.trim().length} / ${p.options.maxChars} characters`}>
            <TextArea value={p.text} maxLength={p.options.maxChars + 200} onChange={(e) => p.onText(e.target.value)} placeholder="Thank you for calling. For sales press 1, for support press 2." aria-label="Announcement text" />
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Voice model" hint={model && !model.available ? model.unavailableReason : model ? `${model.provider}${model.current ? ' · used by the AI agent' : ''}` : undefined}>
              <Select value={p.modelKey} onChange={(e) => p.onModel(e.target.value)} aria-label="Voice model">
                {p.modelKey === '' && <option value="">Choose…</option>}
                {p.options.models.map((m) => (
                  <option key={m.key} value={m.key} disabled={!m.available}>
                    {m.available ? m.label : `${m.label} (unavailable)`}
                  </option>
                ))}
              </Select>
            </Field>
            {model && model.models.length > 1 ? (
              <Field label="Provider model" hint="The provider's own model id">
                <Select value={p.providerModel} onChange={(e) => p.onProviderModel(e.target.value)} aria-label="Provider model">
                  {model.models.map((id, i) => (
                    <option key={id} value={i === 0 ? '' : id}>
                      {i === 0 ? `${id} (default)` : id}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <div aria-hidden="true" className="hidden md:block" />
            )}
            <Field label="Voice" hint={listedVoices ? undefined : 'Type the provider voice name or id'}>
              {listedVoices ? (
                <Select value={p.voice} onChange={(e) => p.onVoice(e.target.value)} aria-label="Voice">
                  {!voices.some((v) => v.name === p.voice) && p.voice !== '' && <option value={p.voice}>{p.voice}</option>}
                  {voices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <TextInput value={p.voice} maxLength={120} onChange={(e) => p.onVoice(e.target.value)} placeholder={model?.defaultVoice || 'voice'} aria-label="Voice" />
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={p.onGenerate} disabled={problem !== null} busy={p.generateState.status === 'running'} title={problem ?? 'Generate the speech'}>
              <Sparkles className="w-3.5 h-3.5" /> Generate
            </Button>
            <span className="text-[11px] text-slate-500">{problem ?? `Sends the text to ${model?.provider ?? 'the provider'}, which may bill for it.`}</span>
          </div>
        </>
      )}
      <ActionNote state={p.generateState} />

      {p.result && (
        <div className="space-y-2 border-t border-slate-800 pt-3" aria-label="Generated audio">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-slate-200 font-medium">Generated audio</p>
            {stale && <Badge tone="warn">text or voice changed: generate again</Badge>}
          </div>
          <p className="text-[11px] text-slate-500 font-mono">{describeGenerated(p.result.info)}</p>
          <audio controls src={p.result.url} className="h-8 max-w-full" aria-label="Generated audio preview" />
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3 items-end">
            <Field label="Name in the library">
              <TextInput value={p.name} maxLength={80} onChange={(e) => p.onName(e.target.value)} placeholder="Welcome message" aria-label="Name in the library" />
            </Field>
            <a
              href={p.result.url}
              download={fileName}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
              aria-label={`Download ${fileName}`}
            >
              <Download className="w-3.5 h-3.5" /> Download WAV
            </a>
            <Button variant="primary" onClick={p.onAdd} disabled={!p.name.trim() || p.added !== null} busy={p.addState.status === 'running'}>
              <Plus className="w-3.5 h-3.5" /> Add to library
            </Button>
          </div>
          {p.added && (
            <p role="status" className="text-xs text-emerald-300">
              {p.added.duplicate ? 'This exact audio was already in the library, so nothing new was added.' : 'Added to the library. Pick it in the menu below.'}
            </p>
          )}
          {!p.added && p.addState.status === 'error' && <ActionNote state={p.addState} />}
        </div>
      )}
    </div>
  );
}

/** The generate form with its state: loads the voice models, makes the speech, previews it, and hands the WAV to the library's own upload. */
export function GenerateAudio({ onUpload, uploadState }: { onUpload: (wav: Blob, name: string) => Promise<unknown>; uploadState: ActionState }) {
  const [options, setOptions] = useState<TtsOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [providerModel, setProviderModel] = useState('');
  const [voice, setVoice] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [result, setResult] = useState<GeneratedResult | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [added, setAdded] = useState<{ duplicate: boolean } | null>(null);
  const [generateState, runGenerate] = useAction();
  const urlRef = useRef<string | null>(null);

  const dropResult = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setResult(null);
    setBlob(null);
    setAdded(null);
  }, []);
  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), []);

  useEffect(() => {
    let alive = true;
    apiClient
      .getIvrTtsOptions()
      .then((loaded) => {
        if (!alive) return;
        setOptions(loaded);
        const key = chooseModel(loaded);
        setModelKey(key);
        setVoice(loaded.models.find((m) => m.key === key)?.defaultVoice ?? '');
      })
      .catch((error: Error) => alive && setOptionsError(`Could not load the voice models: ${error.message}`));
    return () => {
      alive = false;
    };
  }, []);

  const chooseModelKey = (key: string) => {
    setModelKey(key);
    setProviderModel('');
    setVoice(options?.models.find((m) => m.key === key)?.defaultVoice ?? '');
  };
  const changeText = (value: string) => {
    setText(value);
    if (!nameTouched) setName(suggestName(value));
  };

  const generate = async () => {
    const response = await runGenerate(
      () => apiClient.generateIvrAudio({ text: text.trim(), model: modelKey, ...(providerModel ? { providerModel } : {}), ...(voice ? { voice } : {}), confirmBilling: true }),
      'Audio generated. Listen to it before adding it to the library.'
    );
    if (!response) return;
    dropResult();
    const wav = wavBlobFromBase64(response.audioWavBase64);
    const url = URL.createObjectURL(wav);
    urlRef.current = url;
    setBlob(wav);
    setResult({ url, info: response.info, signature: generationSignature({ text, modelKey, providerModel, voice }) });
  };

  const add = async () => {
    if (!blob || !name.trim()) return;
    const outcome = (await onUpload(blob, name.trim())) as { duplicate?: boolean } | undefined;
    if (outcome) setAdded({ duplicate: outcome.duplicate === true });
  };

  return (
    <GenerateAudioForm
      options={options}
      optionsError={optionsError}
      text={text}
      modelKey={modelKey}
      providerModel={providerModel}
      voice={voice}
      name={name}
      onText={changeText}
      onModel={chooseModelKey}
      onProviderModel={setProviderModel}
      onVoice={setVoice}
      onName={(v) => (setNameTouched(true), setName(v))}
      generateState={generateState}
      onGenerate={generate}
      result={result}
      added={added}
      addState={uploadState}
      onAdd={add}
    />
  );
}
