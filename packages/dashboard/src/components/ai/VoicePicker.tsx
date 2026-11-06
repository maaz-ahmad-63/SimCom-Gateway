'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import { filterVoices, TtsVoicesResponse, voiceDetails, voiceListNotice } from '../../lib/tts-voices';
import { Button, Label, TextInput } from './ui';

/**
 * Choose a text-to-speech voice from the provider's own list (fetched by the gateway with the stored key). Searchable; shows language,
 * gender and description when the provider reports them. The list reloads when the provider or model changes. A voice that is not in the
 * list (a custom or cloned voice) can still be typed.
 */
export function VoicePicker({ tts, model, value, onChange }: { tts: string; model: string | null; value: string; onChange: (voice: string) => void }) {
  const [res, setRes] = useState<TtsVoicesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setFailed(null);
    try {
      setRes(await apiClient.getTtsVoices(tts, { model, refresh }));
    } catch (e) {
      setRes(null);
      setFailed((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setRes(null);
    setQuery('');
    setLoading(true);
    setFailed(null);
    apiClient
      .getTtsVoices(tts, { model })
      .then((r) => alive && setRes(r))
      .catch((e: Error) => alive && setFailed(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tts, model]);

  const voices = res?.voices ?? [];
  const shown = useMemo(() => filterVoices(voices, query).slice(0, 300), [voices, query]);
  const selected = voices.find((v) => v.id === value) ?? null;
  const notice = voiceListNotice(res);
  const listless = !loading && voices.length === 0;

  return (
    <div className="space-y-2" data-testid="voice-picker">
      <div className="flex items-center justify-between gap-2">
        <Label>Voice</Label>
        <Button onClick={() => void load(true)} busy={loading} title="Ask the provider for its voice list again" aria-label="Reload voices">
          {!loading && <RefreshCw className="w-3.5 h-3.5" />} Reload
        </Button>
      </div>

      <div className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs">
        <span className="text-slate-500">Selected: </span>
        <span className="font-mono text-slate-200">{value || 'none'}</span>
        {selected && selected.name !== selected.id && <span className="text-slate-400"> ({selected.name})</span>}
        {value && voices.length > 0 && !selected && <span className="text-amber-300"> (not in this provider&apos;s list; it may be a custom voice)</span>}
      </div>

      {loading && <p className="text-xs text-slate-400" role="status">Loading voices…</p>}
      {failed && <p className="text-xs text-rose-300" role="alert">Could not load voices: {failed}</p>}
      {notice && !loading && <p className={`text-xs ${notice.tone === 'good' ? 'text-emerald-300' : notice.tone === 'warn' ? 'text-amber-300' : 'text-slate-400'}`}>{notice.text}</p>}

      {!listless && (
        <>
          <TextInput type="search" placeholder="Search by name, language, gender…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search voices" />
          <ul role="listbox" aria-label="Voices" className="max-h-64 overflow-y-auto rounded-md border border-slate-800 divide-y divide-slate-800/70">
            {shown.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">No voice matches “{query}”.</li>}
            {shown.map((v) => (
              <li key={v.id} role="option" aria-selected={v.id === value}>
                <button
                  type="button"
                  onClick={() => onChange(v.id)}
                  className={`w-full text-left px-3 py-2 text-xs transition ${v.id === value ? 'bg-cyan-950/60 text-white' : 'text-slate-200 hover:bg-slate-900'}`}
                >
                  <span className="font-medium">{v.name}</span>
                  {v.name !== v.id && <span className="ml-2 font-mono text-[11px] text-slate-500">{v.id}</span>}
                  {voiceDetails(v) && <span className="block text-[11px] text-slate-400 mt-0.5">{voiceDetails(v)}</span>}
                </button>
              </li>
            ))}
          </ul>
          {filterVoices(voices, query).length > shown.length && <p className="text-[11px] text-slate-500">Showing the first {shown.length}; search to narrow the list.</p>}
        </>
      )}

      {(listless || typing) && (
        <TextInput aria-label="Voice id" placeholder="Voice id" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {!listless && !typing && (
        <button type="button" className="text-[11px] text-cyan-400 hover:underline" onClick={() => setTyping(true)}>
          Use a voice id that is not listed
        </button>
      )}
    </div>
  );
}
