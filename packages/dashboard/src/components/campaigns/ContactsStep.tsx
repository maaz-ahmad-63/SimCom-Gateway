'use client';

import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { CsvAnalysis, detectionQuestions } from '../../lib/campaign-config';
import { Campaign, cleanMapping, ColumnMapping, CONTACT_FIELDS, csvRequestProblem, CsvPreview, ImportResult, MAX_CSV_BYTES, mappingProblems } from '../../lib/campaigns';
import { ActionNote, Badge, Button, Card, Select, Tile, useAction } from '../ai/ui';

export function SummaryTiles({ summary }: { summary: ImportResult['summary'] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="import-summary">
      <Tile label="Rows in the file">{summary.total}</Tile>
      <Tile label="Will be called">{summary.callable}</Tile>
      <Tile label="Invalid number">{summary.invalidNumber}</Tile>
      <Tile label="Missing name">{summary.missingName ?? 0}</Tile>
      <Tile label="Duplicate number">{summary.duplicate}</Tile>
      <Tile label="Opted out in file">{summary.optedOut}</Tile>
      <Tile label="Do-not-call list">{summary.doNotCall}</Tile>
      <Tile label="Consent declined">{summary.consentDeclined}</Tile>
      <Tile label="No consent value">{summary.consentUnknown}</Tile>
    </div>
  );
}

/** What an import would do, before anything is saved: the counts, the columns kept as custom fields, and the first contacts as they will be stored. */
export function AnalysisPreview({ analysis }: { analysis: CsvAnalysis }) {
  return (
    <div className="space-y-3" data-testid="analysis-preview">
      <h3 className="text-xs font-semibold text-white">What importing this file would do (nothing is saved yet)</h3>
      <SummaryTiles summary={analysis.summary} />
      <p className="text-[11px] text-slate-400" data-testid="custom-columns">
        {analysis.customColumns.length > 0 ? (
          <>
            Kept as custom fields on every contact (the agent can use them naturally): <span className="font-mono text-slate-300">{analysis.customColumns.join(', ')}</span>
          </>
        ) : (
          'The file has no columns besides the ones mapped above.'
        )}
      </p>
      {analysis.contacts.length > 0 && (
        <div className="overflow-x-auto border border-slate-800 rounded-lg">
          <table className="w-full text-[11px] font-mono" data-testid="analysis-contacts">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-800">
                <th className="py-1.5 px-2">Row</th>
                <th className="py-1.5 px-2">Name</th>
                <th className="py-1.5 px-2">Phone (as written → saved as)</th>
                <th className="py-1.5 px-2">Result</th>
                <th className="py-1.5 px-2">Custom fields</th>
              </tr>
            </thead>
            <tbody>
              {analysis.contacts.map((c) => (
                <tr key={c.rowNumber} className="border-b border-slate-800/50 align-top">
                  <td className="py-1 px-2 text-slate-500">{c.rowNumber}</td>
                  <td className="py-1 px-2 text-slate-200">{c.name || '—'}</td>
                  <td className="py-1 px-2 text-slate-300 whitespace-nowrap">
                    {c.phoneRaw || '—'}
                    {c.phoneE164 ? ` → ${c.phoneE164}` : ''}
                  </td>
                  <td className="py-1 px-2">{c.status === 'queued' ? <span className="text-emerald-300">will be called</span> : <span className="text-amber-300">{c.skipReason ?? 'set aside'}</span>}</td>
                  <td className="py-1 px-2 text-slate-400 max-w-[22rem] break-words">
                    {Object.entries(c.customFields)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {analysis.problems.length > 0 && (
        <details className="text-[11px] text-slate-400">
          <summary className="cursor-pointer">Rows that will not be called ({analysis.problems.length}
            {analysis.problems.length >= 50 ? '+' : ''})</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {analysis.problems.map((p) => (
              <li key={p.rowNumber}>
                row {p.rowNumber}: {p.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Upload, detect, preview, map and import. Only the contact name and the phone number are required; every other column is kept as
 * custom fields. When the detection is not sure, the person chooses before importing. Nothing here places a call. After the campaign
 * has started, importing REPLACES the live list but keeps the earlier contacts and every call made to them as history.
 */
export function ContactsStep({ campaign, existing, onImported }: { campaign: Campaign; existing: number; onImported: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [analysis, setAnalysis] = useState<CsvAnalysis | null>(null);
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [reading, runRead] = useAction();
  const [importing, runImport] = useAction();
  const ticket = useRef(0);

  const replacing = campaign.status !== 'draft';
  const running = campaign.status === 'running';

  const onFile = async (file: File | undefined) => {
    setResult(null);
    setPreview(null);
    setCsv(null);
    setAnalysis(null);
    setConfirmed(false);
    setConfirmingReplace(false);
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
    const p = await runRead(() => apiClient.previewCampaignCsv(text, { campaignId: campaign.id }), 'File read');
    if (p) {
      setCsv(text);
      setPreview(p);
      setMapping({ ...p.suggestedMapping });
    }
  };

  const clean = preview ? cleanMapping(mapping, preview.headers) : null;
  const problems = preview ? mappingProblems(mapping, preview.headers) : [];
  const questions = preview ? detectionQuestions(preview.detection) : [];
  const needsConfirmation = questions.length > 0 && !confirmed;
  const usedColumns = new Set<string>(CONTACT_FIELDS.map((f) => mapping[f.key]).filter((v): v is string => !!v));
  const keptColumns = preview ? preview.headers.filter((h) => !usedColumns.has(h)) : [];

  // Whenever the mapping is usable, ask the gateway what an import would do. Nothing is stored by asking.
  const mappingKey = clean ? JSON.stringify(clean) : '';
  useEffect(() => {
    if (!csv || !clean) {
      setAnalysis(null);
      return;
    }
    const mine = ++ticket.current;
    const timer = setTimeout(() => {
      apiClient
        .previewCampaignCsv(csv, { mapping: clean, campaignId: campaign.id })
        .then((res) => {
          if (mine !== ticket.current) return;
          setMappingErrors(res.mappingErrors ?? []);
          setAnalysis(res.analysis ?? null);
        })
        .catch(() => mine === ticket.current && setAnalysis(null));
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csv, mappingKey, campaign.id]);

  const choose = (key: keyof ColumnMapping, column: string) => {
    setMapping({ ...mapping, [key]: column || undefined });
    if (key === 'name' || key === 'phone') setConfirmed(true); // the person chose it: that settles the question
  };

  const doImport = async () => {
    if (!preview || !csv || !clean) return;
    const r = await runImport(
      () => apiClient.importCampaignContacts(campaign.id, csv, clean),
      replacing ? 'Contact list replaced. The earlier list and its calls are kept as history. Nobody has been called.' : 'Contacts imported. Nobody has been called.'
    );
    setConfirmingReplace(false);
    if (r) {
      setResult(r);
      onImported();
    }
  };

  const fieldSelect = (f: (typeof CONTACT_FIELDS)[number]) => (
    <label key={f.key} className="block">
      <span className="block text-[10px] text-slate-500 uppercase font-mono mb-1">
        {f.label}
        {f.required ? ' * (required)' : ' (detected from the file)'}
      </span>
      <Select value={mapping[f.key] ?? ''} onChange={(e) => choose(f.key, e.target.value)} aria-label={f.label}>
        <option value="">{f.required ? 'Choose a column…' : 'Not in the file'}</option>
        {preview?.headers.map((h) => (
          <option key={h} value={h} disabled={usedColumns.has(h) && mapping[f.key] !== h}>
            {h}
          </option>
        ))}
      </Select>
      {f.hint && <span className="block text-[11px] text-slate-500 mt-1">{f.hint}</span>}
    </label>
  );

  const importDisabled = problems.length > 0 || needsConfirmation || running || !clean;

  return (
    <Card
      title={replacing ? 'Contact list' : '1. Contacts'}
      subtitle={
        replacing
          ? 'Upload a new CSV to replace the live contact list. The earlier contacts, and every call, recording, transcript and outcome made for them, are kept as history. Replacing never starts, resumes or reopens the campaign.'
          : 'Upload a CSV with any columns you like. Only a contact name and a phone number are required; every other column is kept as custom fields the agent can use. Importing only stores the rows; it never places a call.'
      }
    >
      {existing > 0 && !result && (
        <p className="text-xs text-slate-300" data-testid="existing-contacts">
          {replacing ? `The live list has ${existing} contacts. Uploading another file replaces it (the earlier contacts stay as history).` : `This campaign already has ${existing} contacts. Uploading another file replaces them.`}
        </p>
      )}
      {running && (
        <p className="text-xs text-amber-300" data-testid="running-note">
          Pause the campaign before replacing its contact list.
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

          {questions.length > 0 && (
            <div role="alert" className="border border-amber-700/60 bg-amber-950/30 rounded-lg p-3 space-y-2" data-testid="detection-questions">
              <p className="text-xs font-semibold text-amber-200">Please check the columns before importing</p>
              <ul className="text-xs text-amber-100/90 list-disc ml-4">
                {questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input type="checkbox" className="accent-cyan-500" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                The columns chosen below are right
              </label>
            </div>
          )}
          {questions.length === 0 && preview.detection && (
            <p className="text-[11px] text-emerald-300/90" data-testid="detected-ok">
              Detected the contact name column “{preview.detection.name.column}” and the phone column “{preview.detection.phone.column}”. Change them below if that is wrong.
            </p>
          )}

          <div>
            <h3 className="text-xs font-semibold text-white mb-2">Which column is which</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {CONTACT_FIELDS.filter((f) => f.required || mapping[f.key]).map((f) => fieldSelect(f))}
            </div>
            <p className="text-[11px] text-slate-500 mt-3" data-testid="kept-columns">
              {keptColumns.length > 0 ? (
                <>
                  Every other column is kept as a custom field: <span className="font-mono text-slate-300">{keptColumns.join(', ')}</span>.
                </>
              ) : (
                'There are no other columns.'
              )}
            </p>
          </div>

          {problems.length > 0 && (
            <ul className="text-xs text-rose-300 list-disc ml-4" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {mappingErrors.length > 0 && (
            <ul className="text-xs text-rose-300 list-disc ml-4" role="alert">
              {mappingErrors.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {analysis && <AnalysisPreview analysis={analysis} />}

          <div className="flex flex-wrap items-center gap-3">
            {replacing && confirmingReplace ? (
              <>
                <span className="text-xs text-slate-300">
                  Replace the live list of {existing} contacts with this file? The earlier list and every call to it stay as history, and the campaign is not restarted.
                </span>
                <Button variant="danger" onClick={() => void doImport()} busy={importing.status === 'running'}>
                  Yes, replace the list
                </Button>
                <Button onClick={() => setConfirmingReplace(false)}>Cancel</Button>
              </>
            ) : (
              <>
                <Button variant="primary" onClick={() => (replacing ? setConfirmingReplace(true) : void doImport())} disabled={importDisabled} busy={importing.status === 'running'}>
                  {replacing ? 'Replace the contact list…' : 'Validate and import'}
                </Button>
                <span className="text-[11px] text-slate-500">
                  {needsConfirmation ? 'Confirm the columns first.' : 'Phone numbers are checked and normalised (the original is kept); duplicates and opted-out contacts are set aside, not called.'}
                </span>
              </>
            )}
          </div>
          <ActionNote state={importing} />
        </div>
      )}

      {result && (
        <div className="space-y-3" data-testid="import-result">
          <SummaryTiles summary={result.summary} />
          {result.customColumns && result.customColumns.length > 0 && (
            <p className="text-[11px] text-slate-400">
              Custom fields kept: <span className="font-mono text-slate-300">{result.customColumns.join(', ')}</span>
            </p>
          )}
          {result.replacedEarlierList && (
            <p className="text-[11px] text-slate-300" data-testid="replaced-note">
              The earlier list is kept as history. The campaign is still <strong>{result.status}</strong>; the new contacts are not called unless you run the campaign.
            </p>
          )}
          {result.summary.consentUnknown > 0 && (
            <p className="text-[11px] text-amber-300/90">
              {result.summary.consentUnknown} contact(s) have no consent value. With “consent from the file” (Settings) they are skipped when the campaign starts.
            </p>
          )}
          <Badge tone="good">{result.counts.total} contacts in the live list</Badge>
        </div>
      )}
    </Card>
  );
}
