'use client';

import React, { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { Campaign, cleanMapping, ColumnMapping, CONTACT_FIELDS, csvRequestProblem, CsvPreview, ImportResult, isReservedColumn, MAX_CSV_BYTES, mappingProblems } from '../../lib/campaigns';
import { ActionNote, Badge, Button, Card, Select, Tile, useAction } from '../ai/ui';

export function SummaryTiles({ summary }: { summary: ImportResult['summary'] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="import-summary">
      <Tile label="Rows in the file">{summary.total}</Tile>
      <Tile label="Will be called">{summary.callable}</Tile>
      <Tile label="Invalid number">{summary.invalidNumber}</Tile>
      <Tile label="Duplicate number">{summary.duplicate}</Tile>
      <Tile label="Opted out in file">{summary.optedOut}</Tile>
      <Tile label="Do-not-call list">{summary.doNotCall}</Tile>
      <Tile label="Consent declined">{summary.consentDeclined}</Tile>
      <Tile label="No consent value">{summary.consentUnknown}</Tile>
    </div>
  );
}

/** Upload, preview, map and import. Nothing here places a call: it parses the file and stores contacts. */
export function ContactsStep({ campaign, existing, onImported }: { campaign: Campaign; existing: number; onImported: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [reading, runRead] = useAction();
  const [importing, runImport] = useAction();

  const onFile = async (file: File | undefined) => {
    setResult(null);
    setPreview(null);
    setCsv(null);
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      await runRead(async () => {
        throw new Error(`The file is ${Math.round(file.size / 1000)} KB; the limit is ${Math.round(MAX_CSV_BYTES / 1000)} KB (about 5,000 contacts).`);
      }, '');
      return;
    }
    setFileName(file.name);
    const text = await file.text();
    const tooBig = csvRequestProblem(text);
    if (tooBig) {
      await runRead(async () => {
        throw new Error(tooBig);
      }, '');
      return;
    }
    const p = await runRead(() => apiClient.previewCampaignCsv(text), 'File read');
    if (p) {
      setCsv(text);
      setPreview(p);
      setMapping({ ...p.suggestedMapping });
    }
  };

  const problems = preview ? mappingProblems(mapping, preview.headers) : [];
  const usedColumns = new Set<string>([...CONTACT_FIELDS.map((f) => mapping[f.key]).filter((v): v is string => !!v), ...(mapping.extra ?? [])]);
  const toggleExtra = (column: string) => {
    const extra = new Set(mapping.extra ?? []);
    if (extra.has(column)) extra.delete(column);
    else extra.add(column);
    setMapping({ ...mapping, extra: Array.from(extra) });
  };

  const doImport = async () => {
    if (!preview || !csv) return;
    const clean = cleanMapping(mapping, preview.headers);
    if (!clean) return;
    const r = await runImport(() => apiClient.importCampaignContacts(campaign.id, csv, clean), 'Contacts imported. Nobody has been called.');
    if (r) {
      setResult(r);
      onImported();
    }
  };

  return (
    <Card
      title="1. Contacts"
      subtitle="Upload a CSV, check how its columns map to contact fields, then import. Importing only stores the rows; it never places a call."
    >
      {existing > 0 && !result && (
        <p className="text-xs text-slate-300" data-testid="existing-contacts">
          This campaign already has {existing} contacts. Uploading another file replaces them.
        </p>
      )}
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        aria-label="CSV file"
        onChange={(e) => void onFile(e.target.files?.[0])}
        className="block text-xs text-slate-300 file:mr-3 file:rounded-md file:border file:border-slate-700 file:bg-slate-800 file:px-3 file:py-1.5 file:text-slate-200"
      />
      <ActionNote state={reading} />

      {preview && (
        <div className="space-y-4" data-testid="csv-preview">
          <p className="text-xs text-slate-400">
            <span className="font-mono">{fileName}</span>: {preview.totalRows} contact row(s), {preview.headers.length} columns, separator “{preview.delimiter === '\t' ? 'tab' : preview.delimiter}”.
          </p>
          {preview.warnings.length > 0 && (
            <ul className="text-[11px] text-amber-300/90 list-disc ml-4">
              {preview.warnings.slice(0, 5).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="overflow-x-auto border border-slate-800 rounded-lg">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800">
                  {preview.headers.map((h) => (
                    <th key={h} className="py-1.5 px-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i} className="border-b border-slate-800/50">
                    {row.map((cell, c) => (
                      <td key={c} className="py-1 px-2 text-slate-300 whitespace-nowrap max-w-[16rem] truncate">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">First {preview.sample.length} of {preview.totalRows} rows.</p>

          <div>
            <h3 className="text-xs font-semibold text-white mb-2">Map columns to contact fields</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {CONTACT_FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">
                    {f.label}
                    {f.required ? ' *' : ''}
                  </span>
                  <Select value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })} aria-label={f.label}>
                    <option value="">{f.required ? 'Choose a column…' : 'Not in the file'}</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h} disabled={usedColumns.has(h) && mapping[f.key] !== h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                  {f.hint && <span className="block text-[11px] text-slate-500 mt-1">{f.hint}</span>}
                </label>
              ))}
            </div>
            <div className="mt-3">
              <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Other columns to give the agent as labelled facts (up to 8)</span>
              <div className="flex flex-wrap gap-2">
                {preview.headers.filter((h) => !CONTACT_FIELDS.some((f) => mapping[f.key] === h)).map((h) => (
                  <label key={h} className="flex items-center gap-1.5 text-xs text-slate-300" title={isReservedColumn(h) ? 'This name is reserved for the agent\'s own fields or instructions: rename the column in the file to use it.' : undefined}>
                    <input type="checkbox" checked={(mapping.extra ?? []).includes(h)} disabled={isReservedColumn(h)} onChange={() => toggleExtra(h)} className="accent-cyan-500" />
                    {h}
                    {isReservedColumn(h) && <span className="text-[10px] text-amber-400">reserved name</span>}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {problems.length > 0 && (
            <ul className="text-xs text-rose-300 list-disc ml-4" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={() => void doImport()} disabled={problems.length > 0} busy={importing.status === 'running'}>
              Validate and import
            </Button>
            <span className="text-[11px] text-slate-500">Phone numbers are checked and normalised; duplicates and opted-out contacts are set aside, not called.</span>
          </div>
          <ActionNote state={importing} />
        </div>
      )}

      {result && (
        <div className="space-y-3" data-testid="import-result">
          <SummaryTiles summary={result.summary} />
          {result.summary.consentUnknown > 0 && (
            <p className="text-[11px] text-amber-300/90">
              {result.summary.consentUnknown} contact(s) have no consent value. With “consent from the file” (Settings) they are skipped when the campaign starts.
            </p>
          )}
          {result.problems.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-white mb-1">Rows that will not be called ({result.problems.length}{result.problems.length >= 100 ? '+' : ''})</h3>
              <div className="max-h-56 overflow-y-auto border border-slate-800 rounded-lg">
                <table className="w-full text-[11px] font-mono">
                  <tbody>
                    {result.problems.map((p) => (
                      <tr key={p.rowNumber} className="border-b border-slate-800/50">
                        <td className="py-1 px-2 text-slate-500 whitespace-nowrap">row {p.rowNumber}</td>
                        <td className="py-1 px-2 text-slate-300">{p.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <Badge tone="good">{result.counts.queued} ready to call</Badge>
        </div>
      )}
    </Card>
  );
}
