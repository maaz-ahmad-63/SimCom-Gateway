'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { keyFileProblem, modelToolsNote, sheetsPatch, SheetsConfig, SheetsStatus, SheetsTestResult, spreadsheetIdFrom, validateSheetsDraft } from '../../lib/integrations';
import { formatDate } from '../../lib/utils';
import { StorageNotice } from './StorageNotice';
import { ActionNote, Badge, Button, Card, Field, SaveBar, TextArea, TextInput, Toggle, useAction } from './ui';

export function CredentialCard({ status, onChange }: { status: SheetsStatus; onChange: (s: SheetsStatus) => void }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [action, run, reset] = useAction();
  const problem = keyFileProblem(text);
  const stored = status.credential.stored;

  const save = async () => {
    const next = await run(() => apiClient.saveGoogleSheetsCredential(text), 'Key stored encrypted on the gateway. It will not be shown again.');
    if (next) {
      setText(''); // the key never stays in the page once it has been sent
      setEditing(false);
      onChange(next);
    }
  };
  const remove = async () => {
    const next = await run(() => apiClient.deleteGoogleSheetsCredential(), 'Key removed. Saving to Google Sheets is switched off.');
    if (next) onChange(next);
  };

  return (
    <Card
      title="Service account key"
      subtitle="Create a service account in Google Cloud, enable the Google Sheets API for its project, download its JSON key, and share your spreadsheet with the account's email as an Editor. The key is stored encrypted on the gateway, never shown here again, never logged."
      actions={<Badge tone={status.credential.undecryptable ? 'bad' : stored ? 'good' : 'neutral'}>{status.credential.undecryptable ? 'cannot be decrypted' : stored ? 'stored' : 'not set'}</Badge>}
    >
      <StorageNotice storageAvailable={status.secretStorageAvailable} />
      {stored && status.credential.serviceAccountEmail && (
        <div className="text-xs text-slate-300 space-y-1">
          <p>
            Share the spreadsheet with: <span className="font-mono text-cyan-300 select-all">{status.credential.serviceAccountEmail}</span>
          </p>
        </div>
      )}
      {status.credential.undecryptable && <p className="text-xs text-rose-300">A key is stored but cannot be decrypted (its encryption key is missing or was replaced). Paste the key file again.</p>}

      {editing || !stored ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text && !problem) void save();
          }}
        >
          <TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the whole service account JSON key file"
            aria-label="Service account JSON key file"
            className="min-h-[120px] font-mono"
            disabled={!status.secretStorageAvailable}
          />
          {problem && <p className="text-[11px] text-amber-300">{problem}</p>}
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={!text || !!problem || !status.secretStorageAvailable} busy={action.status === 'running'}>
              Store key
            </Button>
            {stored && (
              <Button
                onClick={() => {
                  setText('');
                  setEditing(false);
                  reset();
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="flex gap-2">
          <Button onClick={() => setEditing(true)}>Replace key</Button>
          <Button variant="danger" onClick={() => void remove()} busy={action.status === 'running'}>
            Remove
          </Button>
        </div>
      )}
      <ActionNote state={action} />
    </Card>
  );
}

export function TestResultView({ result }: { result: SheetsTestResult }) {
  return (
    <div className="space-y-2" role="status" aria-label="Connection test result">
      <div className="flex items-center gap-2">
        <Badge tone={result.ok ? 'good' : 'bad'}>{result.ok ? 'connection works' : 'connection failed'}</Badge>
        <span className="text-[11px] text-slate-500">{formatDate(result.at)}</span>
      </div>
      <ul className="space-y-1">
        {result.steps.map((step) => (
          <li key={step.name} className="text-xs flex gap-2">
            <span className={step.ok ? 'text-emerald-400' : 'text-rose-400'} aria-hidden>
              {step.ok ? '✓' : '✗'}
            </span>
            <span>
              <span className="text-slate-200">{step.name}</span>
              <span className="text-slate-400"> — {step.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {result.advice && <p className="text-xs text-amber-300">{result.advice}</p>}
    </div>
  );
}

export function IntegrationsTab() {
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [draft, setDraft] = useState<SheetsConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveAction, runSave, resetSave] = useAction();
  const [testAction, runTest] = useAction();
  const [testResult, setTestResult] = useState<SheetsTestResult | null>(null);

  const adopt = useCallback((next: SheetsStatus) => {
    setStatus(next);
    setDraft(next.config);
    setTestResult(next.lastTest);
  }, []);

  useEffect(() => {
    let alive = true;
    apiClient
      .getGoogleSheets()
      .then((s) => alive && adopt(s))
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [adopt]);

  if (loadError) {
    return (
      <p role="alert" className="text-xs text-rose-300">
        Could not load the integration settings: {loadError}
      </p>
    );
  }
  if (!status || !draft) return <p className="text-xs text-slate-500">Loading…</p>;

  const patch = sheetsPatch(status.config, draft);
  const dirty = Object.keys(patch).length > 0;
  const problems = validateSheetsDraft(draft, status.credential.stored);
  const set = (p: Partial<SheetsConfig>) => setDraft({ ...draft, ...p });
  const note = modelToolsNote(status.modelTools, draft.enabled && (draft.inboundTools || draft.outboundTools));

  const save = async () => {
    const next = await runSave(() => apiClient.saveGoogleSheets(patch), 'Saved. It applies from the next reply on any call.');
    if (next) adopt(next);
  };
  const test = async () => {
    const out = await runTest(() => apiClient.testGoogleSheets(), 'Test finished.');
    if (out) {
      setTestResult(out.result);
      setStatus(out.status);
    }
  };

  return (
    <div className="space-y-6">
      <CredentialCard status={status} onChange={adopt} />

      <Card
        title="Google Sheets"
        subtitle="The agent can save a caller's confirmed name, phone number and email to a sheet, and each finished campaign call can log its outcome. A detail is saved only after the caller has agreed to it when read back, and the agent is told it worked only after Google confirms the row was written."
        actions={<Badge tone={status.config.enabled ? 'good' : 'neutral'}>{status.config.enabled ? 'on' : 'off'}</Badge>}
      >
        <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Save to Google Sheets" hint="Off: the agent is never given the save tool and nothing is sent to Google." />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Spreadsheet" hint="Paste the sheet's link or its ID (the part between /d/ and /edit).">
            <TextInput
              value={draft.spreadsheetId}
              onChange={(e) => set({ spreadsheetId: spreadsheetIdFrom(e.target.value) })}
              spellCheck={false}
              autoComplete="off"
              placeholder="1AbC…"
              aria-label="Spreadsheet ID"
            />
          </Field>
          <Field label="Tab" hint="Use an empty tab. The first row is written as the column header; a tab that already holds other data is refused so nothing is overwritten.">
            <TextInput value={draft.sheetName} maxLength={100} onChange={(e) => set({ sheetName: e.target.value })} aria-label="Tab name" />
          </Field>
        </div>

        <div className="space-y-3 border-t border-slate-800 pt-4">
          <p className="text-xs font-medium text-slate-200">Where the agent may save details</p>
          <Toggle checked={draft.inboundTools} onChange={(v) => set({ inboundTools: v })} label="Inbound calls" hint="Callers who ring in and give their details." />
          <Toggle
            checked={draft.outboundTools}
            onChange={(v) => set({ outboundTools: v })}
            label="Outbound campaign calls"
            hint="Never for a person on the do-not-call list or who has asked not to be called, and nothing after they ask."
          />
          <Toggle
            checked={draft.logOutcomes}
            onChange={(v) => set({ logOutcomes: v })}
            label="Log a campaign outcome row for every finished call"
            hint="Answered, no answer, busy, failed or opted out. A person who opted out is logged with no name or number."
          />
          <p className={`text-xs ${note.tone === 'warn' ? 'text-amber-300' : note.tone === 'good' ? 'text-emerald-300' : 'text-slate-400'}`} role={note.tone === 'warn' ? 'alert' : 'status'}>
            {note.text}
          </p>
        </div>
        <SaveBar dirty={dirty} problems={problems} action={saveAction} onSave={save} onCancel={() => { setDraft(status.config); resetSave(); }} />
      </Card>

      <Card
        title="Connection test"
        subtitle="Signs in to Google and opens your sheet to check it. It only reads: it never writes to your sheet, and it cannot prove the account may edit it (the first saved record does)."
        actions={
          <Button onClick={() => void test()} busy={testAction.status === 'running'} disabled={!status.credential.stored || dirty}>
            Test connection
          </Button>
        }
      >
        {dirty && <p className="text-[11px] text-slate-500">Save your changes first: the test uses what is saved.</p>}
        {testAction.status === 'error' && <ActionNote state={testAction} />}
        {testResult ? <TestResultView result={testResult} /> : <p className="text-xs text-slate-500">Not tested yet.</p>}
      </Card>

      <Card title="What is written" subtitle="One row per record, in these columns. Saving the same record again corrects its row instead of adding another.">
        <p className="text-[11px] font-mono text-slate-400 leading-relaxed">{status.columns.join('  ·  ')}</p>
        <ul className="text-xs text-slate-400 list-disc pl-4 space-y-1 leading-relaxed">
          <li>Only details the caller confirmed. Anything missing stays an empty cell: nothing is guessed or filled in.</li>
          <li>Values are stored as plain text, so a phone number keeps its leading zeros and nothing is treated as a formula.</li>
          <li>A campaign contact has one contact row for the whole campaign; each call has its own outcome row.</li>
        </ul>
      </Card>
    </div>
  );
}
