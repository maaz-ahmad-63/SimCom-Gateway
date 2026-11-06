'use client';

import React, { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { useAi } from '../../lib/context/AiContext';
import { ACTION_LABEL, defaultSelection, CredentialImportPreview, CredentialImportResult, importSummary } from '../../lib/env-import';
import { ActionNote, Badge, Button, Card, TextArea, useAction } from '../ai/ui';

/**
 * Paste a .env once; every recognised provider key is shown (masked) for review, then stored encrypted on confirmation. The pasted text
 * lives only in this component's memory (never localStorage or sessionStorage) and is cleared after importing or cancelling.
 */
export function EnvImport() {
  const { refresh } = useAi();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CredentialImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<CredentialImportResult | null>(null);
  const [action, run, reset] = useAction();

  const clear = () => {
    setText('');
    setPreview(null);
    setSelected([]);
  };

  const doPreview = async () => {
    setResult(null);
    const p = await run(() => apiClient.previewCredentialImport(text), 'Review the keys below, then confirm.');
    if (p) {
      setPreview(p);
      setSelected(defaultSelection(p));
    }
  };

  const doApply = async () => {
    const r = await run(() => apiClient.applyCredentialImport(text, selected), 'Import finished.');
    if (r) {
      setResult(r);
      clear(); // the secrets never stay in the page after they are sent
      await refresh();
    }
  };

  const toggle = (name: string) => setSelected((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));
  const changing = preview ? preview.recognized.filter((r) => selected.includes(r.name) && r.action !== 'unchanged').length : 0;

  return (
    <Card
      title="Import from a .env file"
      subtitle="Paste the contents of your .env once. Every API key for a supported provider is recognised and shown masked for review; nothing is saved until you confirm. Other settings in the text are ignored, and the gateway's own .env file is never changed."
    >
      {!preview && (
        <div className="space-y-2">
          <TextArea
            aria-label=".env contents"
            className="min-h-[220px]"
            placeholder={'GROQ_API_KEY=...\nDEEPGRAM_API_KEY=...\nINWORLD_API_KEY=...'}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void doPreview()} disabled={!text.trim()} busy={action.status === 'running'}>
              Preview import
            </Button>
            <Button onClick={() => { clear(); reset(); }} disabled={!text}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {preview && (
        <div className="space-y-4" data-testid="import-review">
          {!preview.secretStorageAvailable && (
            <p className="text-xs text-rose-300" role="alert">Key storage is not enabled on this gateway, so keys cannot be saved here. Nothing will be imported.</p>
          )}
          {preview.recognized.length === 0 ? (
            <p className="text-xs text-amber-300">No supported provider API key was found in the pasted text.</p>
          ) : (
            <table className="w-full text-xs" aria-label="Keys to import">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1.5 pr-2 font-medium w-8"><span className="sr-only">Import</span></th>
                  <th className="py-1.5 pr-2 font-medium">Provider</th>
                  <th className="py-1.5 pr-2 font-medium">Variable</th>
                  <th className="py-1.5 pr-2 font-medium">Key</th>
                  <th className="py-1.5 font-medium">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {preview.recognized.map((r) => (
                  <tr key={r.name}>
                    <td className="py-1.5 pr-2">
                      <input type="checkbox" aria-label={`Import ${r.name}`} checked={selected.includes(r.name)} disabled={r.action === 'unchanged'} onChange={() => toggle(r.name)} className="accent-cyan-500" />
                    </td>
                    <td className="py-1.5 pr-2 text-slate-200">{r.provider}</td>
                    <td className="py-1.5 pr-2 font-mono text-slate-400">
                      {r.name}
                      {r.from && <span className="block font-sans text-[11px] text-slate-500">from {r.from}</span>}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-slate-400">{r.masked}</td>
                    <td className="py-1.5">
                      <Badge tone={r.action === 'add' ? 'good' : r.action === 'update' ? 'warn' : 'neutral'}>{ACTION_LABEL[r.action]}</Badge>
                      {r.overridesEnv && <span className="ml-2 text-[11px] text-slate-500">takes priority over the .env value</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.invalid.length > 0 && (
            <div>
              <p className="text-xs text-amber-300">Not imported ({preview.invalid.length}):</p>
              <ul className="text-[11px] text-slate-400 list-disc pl-4">
                {preview.invalid.map((p) => (
                  <li key={`${p.line}-${p.name}`}>
                    line {p.line}{p.name ? ` (${p.name})` : ''}: {p.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.duplicates.length > 0 && <p className="text-[11px] text-slate-400">Given more than once (the last value is used): {preview.duplicates.join(', ')}</p>}
          {preview.unrecognized.length > 0 && (
            <details className="text-[11px] text-slate-500">
              <summary className="cursor-pointer">{preview.unrecognized.length} other variable{preview.unrecognized.length === 1 ? '' : 's'} ignored (not provider API keys)</summary>
              <p className="mt-1 font-mono">{preview.unrecognized.map((u) => u.name).join(', ')}</p>
            </details>
          )}

          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void doApply()} disabled={!preview.secretStorageAvailable || changing === 0} busy={action.status === 'running'}>
              {changing === 0 ? 'Nothing to change' : `Save ${changing} key${changing === 1 ? '' : 's'}`}
            </Button>
            <Button onClick={() => { clear(); reset(); }}>Cancel</Button>
          </div>
        </div>
      )}

      <ActionNote state={action} />
      {result && (
        <div className="text-xs text-slate-300 space-y-1" data-testid="import-result" role="status">
          <p>{importSummary(result)}</p>
          {[...result.added, ...result.updated].length > 0 && (
            <p className="text-slate-400">
              Saved: {[...result.added, ...result.updated].map((k) => `${k.provider} (${k.masked})`).join(', ')}. They are in use now; no restart is needed.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
