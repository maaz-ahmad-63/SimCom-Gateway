'use client';

import React, { useRef, useState } from 'react';
import { Sparkles, Trash2, Upload } from 'lucide-react';
import { formatBytes, formatDuration, IvrAssetMeta, IvrAudioRules } from '../../lib/ivr';
import { ActionNote, ActionState, Badge, Button, Card, Field, TextInput } from '../ai/ui';
import { AudioPlayer } from './AudioPlayer';
import { GenerateAudio } from './GenerateAudio';

/** The audio rules in one sentence, from the gateway's own numbers. */
export function audioRulesText(rules: IvrAudioRules): string {
  return `WAV, uncompressed PCM, mono, 16-bit, ${rules.sampleRate} Hz, ${formatDuration(rules.minDurationMs)} to ${formatDuration(rules.maxDurationMs)}, up to ${formatBytes(rules.maxBytes)}. The gateway plays the file exactly as uploaded: it never converts, resamples or changes the volume, so a file that does not match is refused with the reason.`;
}

export function AudioLibrary({
  assets,
  rules,
  inUse,
  state,
  onUpload,
  onDelete,
}: {
  assets: IvrAssetMeta[];
  rules: IvrAudioRules;
  /** Ids the draft or the published configuration uses (they cannot be deleted). */
  inUse: Set<string>;
  state: ActionState;
  onUpload: (file: Blob, name: string) => Promise<unknown>;
  onDelete: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [generating, setGenerating] = useState(false);

  const choose = (f: File | null) => {
    setFile(f);
    if (f) setName((current) => current || f.name.replace(/\.wav$/i, '').slice(0, 80));
  };
  const upload = async () => {
    if (!file || !name.trim()) return;
    const result = await onUpload(file, name.trim());
    if (result) {
      setFile(null);
      setName('');
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Card title="Audio library" subtitle={audioRulesText(rules)} actions={<Badge tone="neutral">{assets.length} file{assets.length === 1 ? '' : 's'}</Badge>}>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <Field label="WAV file">
          <input
            ref={input}
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-md file:border file:border-slate-700 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
            aria-label="Choose a WAV file to upload"
          />
        </Field>
        <Field label="Name" hint="Shown in the pickers below">
          <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Welcome message" />
        </Field>
        <Button variant="primary" onClick={upload} disabled={!file || !name.trim()} busy={state.status === 'running'}>
          <Upload className="w-3.5 h-3.5" /> Upload
        </Button>
      </div>
      <ActionNote state={state} />
      <div>
        <Button onClick={() => setGenerating((open) => !open)} aria-expanded={generating}>
          <Sparkles className="w-3.5 h-3.5" /> {generating ? 'Hide audio generator' : 'Generate audio from text'}
        </Button>
      </div>
      {generating && <GenerateAudio onUpload={onUpload} uploadState={state} />}
      {assets.length === 0 ? (
        <p className="text-xs text-slate-500">No audio yet. Upload the welcome and menu announcements first.</p>
      ) : (
        <ul className="divide-y divide-slate-800 border border-slate-800 rounded-lg" aria-label="Uploaded announcements">
          {assets.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-200 font-medium truncate">{a.name}</p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {formatDuration(a.durationMs)} · {a.sampleRate} Hz · {formatBytes(a.bytes)}
                </p>
              </div>
              {inUse.has(a.id) && <Badge tone="good">in use</Badge>}
              <AudioPlayer assetId={a.id} />
              <Button
                variant="danger"
                onClick={() => onDelete(a.id)}
                disabled={inUse.has(a.id)}
                title={inUse.has(a.id) ? 'Used by the draft or the published menu: remove it there first' : 'Delete this audio file'}
                aria-label={`Delete ${a.name}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
