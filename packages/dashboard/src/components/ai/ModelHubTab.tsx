'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { useAi } from '../../lib/context/AiContext';
import {
  capabilityLabels,
  credentialNote,
  defaultBlocker,
  defaultKeyOf,
  diffRows,
  editableEntry,
  EntryKind,
  endpointNote,
  entryTemplate,
  formatIssues,
  HubModel,
  HubProvider,
  HubView,
  LLM_TEST_NOTICE,
  modelsOf,
  modelStatus,
  parseJsonObject,
  priceStatus,
  protocolOptions,
  providerOptions,
  ProposalDetail,
  removeAction,
  setJsonField,
  sourceCheckNote,
  Stage,
  STAGE_LABEL,
  TestResult,
  ValidationIssue,
  voicesOf,
  withoutVoice,
  withVoice,
} from '../../lib/model-hub';
import { ActionNote, Badge, Button, Card, Field, Select, TextArea, TextInput, Toggle, useAction } from './ui';

// ---------------------------------------------------------------------------------------------- presentational pieces

const defaultBadge = (builtin: boolean, modified: boolean) => (builtin ? modified ? <Badge tone="warn">default, edited</Badge> : <Badge>default</Badge> : <Badge tone="good">custom</Badge>);

export interface ModelRowActions {
  onDefault: (m: HubModel) => void;
  onTest: (m: HubModel) => void;
  onEdit: (m: HubModel) => void;
  onToggle: (m: HubModel) => void;
  onRemove: (m: HubModel) => void;
  busyId?: string | null;
}

/** The models of one stage, straight from the gateway's registry. Stateless, so what it shows is exactly what it was given. */
export function ModelsTable({ stage, view, actions }: { stage: Stage; view: HubView; actions?: ModelRowActions }) {
  const models = modelsOf(view, stage);
  const current = defaultKeyOf(view, stage);
  const providerName = (id: string) => view.providers.find((p) => p.id === id)?.name ?? id;
  if (models.length === 0) return <p className="text-xs text-slate-500">No {STAGE_LABEL[stage].toLowerCase()} are registered.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" aria-label={`${STAGE_LABEL[stage]} registry`}>
        <thead>
          <tr className="text-[10px] uppercase tracking-wide font-medium text-slate-500 text-left">
            <th className="py-1 pr-3 font-normal">Model</th>
            <th className="py-1 pr-3 font-normal">Provider and protocol</th>
            <th className="py-1 pr-3 font-normal">Status</th>
            <th className="py-1 pr-3 font-normal">What it can do</th>
            <th className="py-1 pr-3 font-normal">Price</th>
            <th className="py-1 font-normal">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {models.map((m) => {
            const status = modelStatus(m);
            const price = priceStatus(m.price);
            const blocker = defaultBlocker(m, current);
            const remove = removeAction(m);
            const cred = m.resolved ? credentialNote(m.resolved.credential) : null;
            return (
              <tr key={m.id} className="align-top" data-model-id={m.id}>
                <td className="py-2 pr-3">
                  <div className="text-slate-100 font-medium">{m.label}</div>
                  <div className="font-mono text-[11px] text-slate-500 break-all">{m.id}</div>
                  {m.model && <div className="font-mono text-[11px] text-slate-600 break-all">{m.model}</div>}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {defaultBadge(m.builtin, m.modified)}
                    {m.id === current && <Badge tone="good">in use</Badge>}
                  </div>
                </td>
                <td className="py-2 pr-3 text-slate-300">
                  {providerName(m.provider)}
                  <div className="font-mono text-[11px] text-slate-500">{m.protocol ?? 'no protocol'}</div>
                  <div className="font-mono text-[11px] text-slate-600 break-all max-w-[16rem]">{endpointNote(m)}</div>
                  {cred && <div className={`text-[11px] ${cred.tone === 'warn' ? 'text-amber-300' : 'text-slate-500'}`}>{cred.text}</div>}
                </td>
                <td className="py-2 pr-3">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {m.resolved?.unavailableReason && <div className="text-[11px] text-slate-500 mt-1 max-w-[16rem]">{m.resolved.unavailableReason}</div>}
                </td>
                <td className="py-2 pr-3">
                  {m.resolved?.facts ? (
                    <div className="flex flex-wrap gap-1 max-w-[18rem]">
                      {capabilityLabels(m.resolved.facts).map((c) => (
                        <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/70 text-slate-400">
                          {c}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="py-2 pr-3">
                  <Badge tone={price.tone}>{price.label}</Badge>
                  <div className="font-mono text-[11px] text-slate-400 mt-1 max-w-[14rem]">{m.price?.summary ?? 'unknown (never assumed free)'}</div>
                </td>
                <td className="py-2">
                  {actions && (
                    <div className="flex flex-wrap gap-1">
                      <Button disabled={blocker !== null || actions.busyId === m.id} title={blocker ?? 'Use this model for new calls'} onClick={() => actions.onDefault(m)}>
                        Use for new calls
                      </Button>
                      <Button onClick={() => actions.onTest(m)} busy={actions.busyId === m.id} title={m.stage === 'llm' ? 'Sends one very short real request (billed)' : 'Checks the key and the provider’s model list (nothing is generated)'}>
                        {m.stage === 'llm' ? 'Test (sends a request)' : 'Test'}
                      </Button>
                      <Button onClick={() => actions.onEdit(m)}>Edit</Button>
                      <Button onClick={() => actions.onToggle(m)}>{m.enabled ? 'Disable' : 'Enable'}</Button>
                      {remove && (
                        <Button variant="danger" onClick={() => actions.onRemove(m)}>
                          {remove.label}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- the entry editor

/**
 * Edits one provider or model as a form for its main fields and JSON for the rest. Every change is validated by the gateway as
 * saving would validate it, and the problems are shown before Save; Save stays off until there are none.
 */
export function EntryEditor({
  kind,
  initial,
  mode,
  view,
  onSaved,
  onCancel,
}: {
  kind: EntryKind;
  initial: Record<string, unknown>;
  mode: 'create' | 'edit';
  view: HubView;
  onSaved: (view: HubView) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [action, run] = useAction();
  const parsed = parseJsonObject(text);
  const seq = useRef(0);

  useEffect(() => {
    if (!parsed.value) {
      setIssues(null);
      return;
    }
    const entry = parsed.value;
    const ticket = ++seq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      apiClient
        .validateRegistryEntry(kind, entry)
        .then((r) => ticket === seq.current && setIssues(r.issues))
        .catch((e: Error) => ticket === seq.current && setIssues([{ collection: kind, id: null, path: '$', message: e.message }]))
        .finally(() => ticket === seq.current && setChecking(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [text, kind, parsed.value ? 1 : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const field = (name: string) => (parsed.value?.[name] as string | null | undefined) ?? '';
  const set = (name: string, value: unknown) => setText((t) => setJsonField(t, name, value));
  const stage = (parsed.value?.stage as Stage | undefined) ?? 'llm';
  const problems = parsed.error ? [parsed.error] : formatIssues(issues ?? []);
  const ok = parsed.value !== null && issues !== null && issues.length === 0 && !checking;

  const save = async () => {
    if (!parsed.value) return;
    const entry = parsed.value;
    const id = String(entry.id ?? '');
    const call = () =>
      kind === 'provider'
        ? mode === 'create'
          ? apiClient.createProvider(entry)
          : apiClient.updateProvider(id, entry)
        : mode === 'create'
          ? apiClient.createModel(entry)
          : apiClient.updateModel(stage, id, entry);
    const result = await run(call, 'Saved.');
    if (result) onSaved(result.registry);
  };

  return (
    <div className="space-y-4 border border-cyan-900/60 bg-slate-950/60 rounded-lg p-4" aria-label={`${mode === 'create' ? 'Add' : 'Edit'} ${kind}`}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Id" hint="The stable reference (lowercase letters, digits, _ - .). It cannot be changed later.">
          <TextInput value={field('id')} disabled={mode === 'edit'} onChange={(e) => set('id', e.target.value)} aria-label="Id" />
        </Field>
        <Field label={kind === 'provider' ? 'Name' : 'Label'}>
          <TextInput value={field(kind === 'provider' ? 'name' : 'label')} onChange={(e) => set(kind === 'provider' ? 'name' : 'label', e.target.value)} aria-label="Display name" />
        </Field>
        {kind === 'provider' ? (
          <>
            <Field label="Credential (variable name)" hint="The NAME of the variable that holds the key, such as TOGETHER_API_KEY. Store the key itself under API Keys, or in the gateway's environment; it never goes in this JSON.">
              <TextInput value={field('credential')} onChange={(e) => set('credential', e.target.value || null)} aria-label="Credential name" />
            </Field>
            <Field label="Key sent as" hint="How an OpenAI-compatible API wants the key: Bearer (the usual) or Basic (Inworld).">
              <Select value={field('authScheme') || 'bearer'} onChange={(e) => set('authScheme', e.target.value === 'basic' ? 'basic' : undefined)} aria-label="Key sent as">
                <option value="bearer">Authorization: Bearer</option>
                <option value="basic">Authorization: Basic</option>
              </Select>
            </Field>
            <Field label="Base URL (OpenAI-compatible APIs)" hint="https only; the API key is sent here. Models of this provider that use the openai-chat protocol connect to it. Leave empty for providers whose protocols have their own address.">
              <TextInput value={field('baseUrl')} onChange={(e) => set('baseUrl', e.target.value || null)} aria-label="Base URL" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Provider" hint="Add a provider first for a new service.">
              <Select value={field('provider')} onChange={(e) => set('provider', e.target.value)} aria-label="Provider">
                <option value="">Choose…</option>
                {providerOptions(view).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Protocol" hint="The wire format. A different model on a protocol listed here is configuration only; a protocol that is not listed needs code.">
              <Select value={field('protocol')} onChange={(e) => set('protocol', e.target.value || null)} aria-label="Protocol">
                <option value="">None (not implemented)</option>
                {protocolOptions(view, stage).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.id})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Provider's model id" hint="Sent to the provider exactly as written (for text-to-speech, the default model).">
              <TextInput value={field('model')} onChange={(e) => set('model', e.target.value || null)} aria-label="Model id" />
            </Field>
            <Field label="Endpoint (optional)" hint="Overrides where this model connects: the whole URL, or the base URL for openai-chat. wss:// for the protocols that stream over a WebSocket.">
              <TextInput value={field('endpoint')} onChange={(e) => set('endpoint', e.target.value || undefined)} aria-label="Endpoint" />
            </Field>
          </>
        )}
      </div>
      <Toggle checked={parsed.value?.enabled !== false} onChange={(v) => set('enabled', v)} label="Enabled" disabled={!parsed.value} />
      <Field label="Full entry (JSON)" hint={kind === 'model' ? 'Everything about this model, including its protocol settings under options (voices and sample rates for text-to-speech, request fields for chat). The form above edits the same text.' : 'Every field of the entry. The form above edits the same text.'}>
        <TextArea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={14} aria-label="Entry JSON" />
      </Field>
      <div className="text-xs" aria-live="polite">
        {checking && <p className="text-slate-500">Checking…</p>}
        {!checking && problems.length === 0 && ok && <p className="text-emerald-300">Valid: this can be saved.</p>}
        {problems.length > 0 && (
          <ul role="alert" className="list-disc pl-4 text-rose-300 font-mono text-[11px] space-y-0.5">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <ActionNote state={action} />
      <div className="flex gap-2">
        <Button variant="primary" disabled={!ok} busy={action.status === 'running'} onClick={save}>
          {mode === 'create' ? 'Add' : 'Save changes'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- panels

type Editing = { kind: EntryKind; mode: 'create' | 'edit'; initial: Record<string, unknown> } | null;

function ModelsPanel({ stage, view, onView }: { stage: Stage; view: HubView; onView: (v: HubView) => void }) {
  const { refresh } = useAi();
  const [editing, setEditing] = useState<Editing>(null);
  const [action, run] = useAction();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [test, setTest] = useState<{ id: string; result: TestResult } | null>(null);

  const mutate = async (fn: () => Promise<{ registry: HubView }>, ok: string) => {
    const result = await run(fn, ok);
    if (result) onView(result.registry);
    return result;
  };
  const actions: ModelRowActions = {
    busyId,
    onDefault: async (m) => {
      setBusyId(m.id);
      const saved = await run(() => apiClient.saveAiSettings({ [stage]: m.id }), `${m.label} is now used for new ${STAGE_LABEL[stage].toLowerCase()}. It applies to the next call.`);
      setBusyId(null);
      if (saved) {
        onView(await apiClient.getModelHub());
        void refresh();
      }
    },
    onTest: async (m) => {
      // A language model is tried with a real, tiny request that the provider bills; say so first.
      if (stage === 'llm' && !window.confirm(`${LLM_TEST_NOTICE}

Test ${m.label}?`)) return;
      setBusyId(m.id);
      const result = await run(() => apiClient.testRegistryModel(stage, m.id, { confirmBilling: stage === 'llm' }), 'Test finished.');
      setBusyId(null);
      if (result) setTest({ id: m.id, result });
    },
    onEdit: (m) => setEditing({ kind: 'model', mode: 'edit', initial: editableEntry(m as unknown as Record<string, unknown>) }),
    onToggle: (m) => void mutate(() => apiClient.updateModel(stage, m.id, { enabled: !m.enabled }), `${m.label} is ${m.enabled ? 'off' : 'on'}.`),
    onRemove: (m) => {
      const r = removeAction(m);
      if (!r || !window.confirm(r.confirm)) return;
      void mutate(() => (r.reset ? apiClient.restoreRegistryDefaults([{ kind: 'model', stage, id: m.id }]) : apiClient.deleteModel(stage, m.id)), `${m.label}: done.`);
    },
  };

  return (
    <div className="space-y-4">
      <Card
        title={STAGE_LABEL[stage]}
        subtitle="Every model here comes from the gateway's registry. “Use for new calls” sets the default for this stage on its own; it does not affect a call in progress."
        actions={
          <Button variant="primary" onClick={() => setEditing({ kind: 'model', mode: 'create', initial: entryTemplate('model', stage, view) })}>
            Add model
          </Button>
        }
      >
        <ActionNote state={action} />
        {test && (
          <p role="status" className={`text-xs ${test.result.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
            {test.id}: {test.result.detail}
          </p>
        )}
        <ModelsTable stage={stage} view={view} actions={actions} />
      </Card>
      {editing && (
        <EntryEditor
          key={`${editing.mode}-${String(editing.initial.id)}-${String(editing.initial.stage)}`}
          kind={editing.kind}
          initial={editing.initial}
          mode={editing.mode}
          view={view}
          onSaved={(v) => {
            onView(v);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {stage === 'tts' && <VoicesCard view={view} onView={onView} />}
    </div>
  );
}

/** The voices of one text-to-speech model: they are part of the model's options, so adding one is a small edit of that model. */
function VoicesCard({ view, onView }: { view: HubView; onView: (v: HubView) => void }) {
  const models = view.models.tts;
  const [id, setId] = useState(() => view.defaults?.tts ?? models[0]?.id ?? '');
  const model = models.find((m) => m.id === id) ?? models[0];
  const [name, setName] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [label, setLabel] = useState('');
  const [action, run] = useAction();
  if (!model) return null;
  const voices = voicesOf(model);
  const save = async (options: Record<string, unknown>, ok: string) => {
    const r = await run(() => apiClient.updateModel('tts', model.id, { options }), ok);
    if (r) onView(r.registry);
    return r;
  };
  return (
    <Card title="Voices" subtitle="A voice belongs to a text-to-speech model. The name is what you select; the voice id is only needed when the provider's voices are ids (Cartesia). A voice not listed here can still be typed as the voice on the Text-to-Speech tab.">
      <Field label="Model">
        <Select value={model.id} onChange={(e) => setId(e.target.value)} aria-label="Text-to-speech model">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <ActionNote state={action} />
      <div className="max-h-60 overflow-y-auto">
        {voices.length === 0 ? (
          <p className="text-xs text-slate-500">No named voices for this model; the default voice is {String(model.options.voice ?? '—')}.</p>
        ) : (
          <ul className="divide-y divide-slate-800/70 text-xs" aria-label="Voices">
            {voices.map((v) => (
              <li key={v.name} className="py-1.5 flex items-center justify-between gap-3">
                <span>
                  <span className="text-slate-100">{v.label ?? v.name}</span> <span className="font-mono text-slate-500">{v.name}</span>
                  {v.id && <span className="font-mono text-slate-600"> · {v.id}</span>}
                </span>
                <Button variant="danger" onClick={() => void save(withoutVoice(model, v.name), `${v.name} removed.`)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} aria-label="Voice name" />
        </Field>
        <Field label="Voice id (if different)">
          <TextInput value={voiceId} onChange={(e) => setVoiceId(e.target.value)} aria-label="Voice id" />
        </Field>
        <Field label="Label">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Voice label" />
        </Field>
      </div>
      <Button
        disabled={name.trim() === ''}
        onClick={async () => {
          const r = await save(withVoice(model, { name: name.trim(), ...(voiceId.trim() ? { id: voiceId.trim() } : {}), ...(label.trim() ? { label: label.trim() } : {}) }), `${name.trim()} added.`);
          if (r) {
            setName('');
            setVoiceId('');
            setLabel('');
          }
        }}
      >
        Add voice
      </Button>
    </Card>
  );
}

export function ProvidersTable({ view, onTest, onEdit, onToggle, onRemove, busyId }: { view: HubView; onTest?: (p: HubProvider) => void; onEdit?: (p: HubProvider) => void; onToggle?: (p: HubProvider) => void; onRemove?: (p: HubProvider) => void; busyId?: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" aria-label="Providers">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide font-medium text-slate-500 text-left">
            <th className="py-1 pr-3 font-normal">Provider</th>
            <th className="py-1 pr-3 font-normal">Base URL</th>
            <th className="py-1 pr-3 font-normal">Credential</th>
            <th className="py-1 pr-3 font-normal">Models</th>
            <th className="py-1 font-normal">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {view.providers.map((p) => {
            const cred = credentialNote(p.credentialState);
            const remove = removeAction(p);
            return (
              <tr key={p.id} className="align-top" data-provider-id={p.id}>
                <td className="py-2 pr-3">
                  <div className="text-slate-100 font-medium">{p.name}</div>
                  <div className="font-mono text-[11px] text-slate-500">{p.id}</div>
                  <div className="mt-1 flex gap-1">
                    {defaultBadge(p.builtin, p.modified)}
                    {!p.enabled && <Badge>off</Badge>}
                  </div>
                </td>
                <td className="py-2 pr-3 font-mono text-[11px] text-slate-400 break-all max-w-[16rem]">{p.baseUrl ?? '—'}</td>
                <td className="py-2 pr-3">
                  <span className={`text-[11px] ${cred.tone === 'warn' ? 'text-amber-300' : 'text-slate-400'}`}>{cred.text}</span>
                </td>
                <td className="py-2 pr-3 text-slate-300">{p.models}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {onTest && (
                      <Button onClick={() => onTest(p)} busy={busyId === p.id}>
                        Test connection
                      </Button>
                    )}
                    {onEdit && <Button onClick={() => onEdit(p)}>Edit</Button>}
                    {onToggle && <Button onClick={() => onToggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>}
                    {onRemove && remove && (
                      <Button variant="danger" onClick={() => onRemove(p)}>
                        {remove.label}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProvidersPanel({ view, onView }: { view: HubView; onView: (v: HubView) => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [action, run] = useAction();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [test, setTest] = useState<{ id: string; result: TestResult } | null>(null);
  const mutate = async (fn: () => Promise<{ registry: HubView }>, ok: string) => {
    const r = await run(fn, ok);
    if (r) onView(r.registry);
  };
  return (
    <div className="space-y-4">
      <Card
        title="Providers"
        subtitle="A provider is a credential (the name of the variable that holds its key) and, for OpenAI-compatible services, a base URL. Add one, then add its models. Any service that speaks the OpenAI chat protocol needs nothing else."
        actions={
          <Button variant="primary" onClick={() => setEditing({ kind: 'provider', mode: 'create', initial: entryTemplate('provider', null, view) })}>
            Add provider
          </Button>
        }
      >
        <ActionNote state={action} />
        {test && (
          <p role="status" className={`text-xs ${test.result.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
            {test.id}: {test.result.detail}
          </p>
        )}
        <ProvidersTable
          view={view}
          busyId={busyId}
          onTest={async (p) => {
            setBusyId(p.id);
            const r = await run(() => apiClient.testRegistryProvider(p.id), 'Test finished.');
            setBusyId(null);
            if (r) setTest({ id: p.id, result: r });
          }}
          onEdit={(p) => setEditing({ kind: 'provider', mode: 'edit', initial: editableEntry(p as unknown as Record<string, unknown>) })}
          onToggle={(p) => void mutate(() => apiClient.updateProvider(p.id, { enabled: !p.enabled }), `${p.name} is ${p.enabled ? 'off' : 'on'}.`)}
          onRemove={(p) => {
            const r = removeAction(p);
            if (!r || !window.confirm(r.confirm)) return;
            void mutate(() => (r.reset ? apiClient.restoreRegistryDefaults([{ kind: 'provider', id: p.id }]) : apiClient.deleteProvider(p.id)), `${p.name}: done.`);
          }}
        />
      </Card>
      {editing && (
        <EntryEditor
          key={`${editing.mode}-${String(editing.initial.id)}`}
          kind="provider"
          initial={editing.initial}
          mode={editing.mode}
          view={view}
          onSaved={(v) => {
            onView(v);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card title="Protocols" subtitle="The wire formats the gateway's code can speak, and what each can do. A model names one. A service whose protocol is not listed here needs a protocol added to the code; JSON cannot create one.">
        <ul className="space-y-2 text-xs">
          {view.protocols.map((p) => (
            <li key={p.id}>
              <span className="text-slate-100 font-medium">{p.title}</span> <span className="font-mono text-slate-500">{p.id} · {p.stage}</span>
              <div className="text-slate-500 font-mono text-[11px]">{p.summary}</div>
              <div className="text-slate-600 font-mono text-[11px] break-all">
                {p.endpoint.kind === 'base' ? 'base URL' : 'full URL'} ({p.endpoint.scheme}){p.endpoint.default ? `, default ${p.endpoint.default}` : ', set on the provider or the model'}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

const SAMPLE_PRICES = JSON.stringify(
  [
    {
      id: 'price.llm.example',
      providerId: 'openai',
      modelKind: 'llm',
      modelId: 'openai_gpt_5_4_mini',
      plan: 'standard',
      currency: 'USD',
      rates: [
        { component: 'input_tokens', unit: 'per_million_tokens', price: null },
        { component: 'output_tokens', unit: 'per_million_tokens', price: null },
      ],
      sourceUrl: 'https://…',
      verifiedAt: '2026-01-01',
      effectiveFrom: '2026-01-01',
      status: 'verified',
    },
  ],
  null,
  2
);

export function ProposalReview({ proposal, onApprove, onReject, busy }: { proposal: ProposalDetail; onApprove: (selected: string[], overrides: string[]) => void; onReject: () => void; busy?: boolean }) {
  const rows = diffRows(proposal.diffs).filter((r) => r.kind !== 'unchanged');
  const [selected, setSelected] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.priceId, r.applicable])));
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const chosen = rows.filter((r) => selected[r.priceId]).map((r) => r.priceId);
  const overrides = chosen.filter((id) => override[id]);
  return (
    <div className="space-y-3 border border-cyan-900/60 bg-slate-950/60 rounded-lg p-4" aria-label="Price change review">
      <p className="text-xs text-slate-300">
        Proposed {proposal.createdAt.slice(0, 16).replace('T', ' ')} · {proposal.origin}
        {proposal.note ? ` · ${proposal.note}` : ''}. Nothing below is active until you approve it.
      </p>
      {rows.length === 0 && <p className="text-xs text-slate-500">Nothing in this proposal would change a price.</p>}
      {rows.map((r) => (
        <div key={r.priceId} className="rounded-md border border-slate-800 p-3 space-y-1 text-xs" data-price-id={r.priceId}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-slate-100">{r.priceId}</span>
            <Badge tone={r.kind === 'new' ? 'good' : 'warn'}>{r.kind}</Badge>
          </div>
          <p className="text-slate-500">
            Now: <span className="font-mono text-slate-300">{r.before}</span>
          </p>
          <p className="text-slate-500">
            Proposed: <span className="font-mono text-slate-100">{r.after}</span>
          </p>
          <p className="text-slate-500">Changes: {r.changed}</p>
          {r.reason && <p className="text-amber-300">Held back: {r.reason}.</p>}
          <div className="flex flex-wrap gap-4 pt-1">
            <Toggle checked={selected[r.priceId] === true} onChange={(v) => setSelected({ ...selected, [r.priceId]: v })} label="Apply this price" />
            {r.needsOverride && selected[r.priceId] && (
              <Toggle checked={override[r.priceId] === true} onChange={(v) => setOverride({ ...override, [r.priceId]: v })} label="I understand: replace it anyway" hint="The current price is kept in history." />
            )}
          </div>
        </div>
      ))}
      {proposal.rejectedEntries.length > 0 && (
        <div role="alert" className="text-xs text-rose-300 font-mono space-y-0.5">
          <p className="font-sans">Entries that were not valid and will not be applied:</p>
          <ul className="list-disc pl-4">
            {proposal.rejectedEntries.map((e, i) => (
              <li key={i}>
                {e.id ?? '(no id)'}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="primary" disabled={chosen.length === 0 || rows.some((r) => selected[r.priceId] && r.needsOverride && !override[r.priceId])} busy={busy} onClick={() => onApprove(chosen, overrides)}>
          Approve selected
        </Button>
        <Button variant="danger" onClick={onReject}>
          Reject proposal
        </Button>
      </div>
    </div>
  );
}

function PricingPanel({ view, onView }: { view: HubView; onView: (v: HubView) => void }) {
  const [action, run] = useAction();
  const [text, setText] = useState(SAMPLE_PRICES);
  const [open, setOpen] = useState<ProposalDetail | null>(null);
  const parsedPrices = (() => {
    try {
      const v = JSON.parse(text) as unknown;
      return Array.isArray(v) ? { entries: v, error: null } : { entries: null, error: 'Enter a JSON array of price entries' };
    } catch (e) {
      return { entries: null, error: `Not valid JSON: ${(e as Error).message}` };
    }
  })();
  const pending = view.pricing.proposals.filter((p) => p.status === 'pending');
  const providerName = (id: string) => view.providers.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="space-y-4">
      <Card title="Prices" subtitle="Optional and kept apart from the models: a model with no price here simply has an unknown price, never a free one. Every price carries its currency, billing unit, plan, source, verification date and status. Prices marked imported came with the original catalog and were not re-verified.">
        <ActionNote state={action} />
        <div className="overflow-x-auto">
          <table className="w-full text-xs" aria-label="Prices">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide font-medium text-slate-500 text-left">
                <th className="py-1 pr-3 font-normal">Model</th>
                <th className="py-1 pr-3 font-normal">Rates</th>
                <th className="py-1 pr-3 font-normal">Plan</th>
                <th className="py-1 font-normal">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {view.pricing.prices.map((p) => {
                const s = priceStatus({ id: p.id, summary: p.summary, plan: p.plan, currency: p.currency, status: p.status, protected: p.protected, planSpecific: p.planSpecific, verifiedAt: p.verifiedAt, effectiveFrom: p.effectiveFrom, sourceUrl: p.sourceUrl });
                return (
                  <tr key={p.id} className="align-top">
                    <td className="py-2 pr-3">
                      <div className="font-mono text-slate-200">{p.modelId}</div>
                      <div className="text-[11px] text-slate-500">
                        {providerName(p.providerId)} · {p.modelKind}
                        {p.appliesTo && p.appliesTo.length > 0 ? ` · also ${p.appliesTo.join(', ')}` : ''}
                      </div>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-slate-300 max-w-[22rem]">{p.summary}</td>
                    <td className="py-2 pr-3 text-slate-400">
                      {p.plan}
                      {p.protected && <div className="text-[11px] text-amber-300">protected: never auto-replaced</div>}
                    </td>
                    <td className="py-2">
                      <Badge tone={s.tone}>{s.label}</Badge>
                      <div className="text-[11px] text-slate-500 mt-1">
                        {p.sourceUrl ? <span className="break-all">{p.sourceUrl}</span> : 'no source recorded'}
                        {p.effectiveFrom ? ` · effective ${p.effectiveFrom.slice(0, 10)}` : ''}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Official pricing sources"
        subtitle="Checked only when you press the button, never during a call. These pages are written for people, so a check records when it was made and whether the page changed; the prices themselves come from a reviewed JSON you paste below."
        actions={
          <Button
            variant="primary"
            busy={action.status === 'running'}
            onClick={async () => {
              const r = await run(() => apiClient.checkPricingSources(), 'Sources checked. No price was changed.');
              if (r) onView(r.registry);
            }}
          >
            Check sources now
          </Button>
        }
      >
        <ul className="space-y-2 text-xs">
          {view.pricing.sources.map((s) => {
            const note = sourceCheckNote(s.check);
            return (
              <li key={s.url} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <span className="text-slate-100">{providerName(s.providerId)}</span> <span className="font-mono text-[11px] text-slate-500 break-all">{s.url}</span>
                </span>
                <span className={`text-[11px] ${note.tone === 'bad' ? 'text-rose-300' : note.tone === 'warn' ? 'text-amber-300' : 'text-slate-500'}`}>
                  {note.text}
                  {s.check ? ` (${s.check.checkedAt.slice(0, 16).replace('T', ' ')})` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Propose prices" subtitle="Paste prices you have read from the provider's page or your own invoice, as a JSON array of price entries. They become a proposal you review; nothing is applied until you approve it. A negotiated or hand-entered price is never replaced unless you say so for that price.">
        <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={12} spellCheck={false} aria-label="Reviewed prices JSON" />
        {parsedPrices.error && (
          <p role="alert" className="text-xs text-rose-300 font-mono">
            {parsedPrices.error}
          </p>
        )}
        <Button
          variant="primary"
          disabled={parsedPrices.entries === null}
          onClick={async () => {
            if (!parsedPrices.entries) return;
            const r = await run(() => apiClient.proposePrices(parsedPrices.entries!, 'manual import from the dashboard'), 'Proposal created. Review it below before anything changes.');
            if (r) {
              onView(r.registry);
              setOpen(r.proposal);
            }
          }}
        >
          Create proposal
        </Button>
      </Card>

      <Card title="Proposals awaiting review" subtitle={pending.length === 0 ? 'None.' : undefined}>
        <ul className="space-y-2 text-xs">
          {pending.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2">
              <span className="text-slate-300">
                {p.createdAt.slice(0, 16).replace('T', ' ')} · {p.origin} · {p.counts.new} new, {p.counts.changed} changed, {p.counts.blocked} held back{p.counts.rejected ? `, ${p.counts.rejected} invalid` : ''}
              </span>
              <Button onClick={async () => setOpen(await apiClient.getPriceProposal(p.id))}>Review</Button>
            </li>
          ))}
        </ul>
        {open && open.status === 'pending' && (
          <ProposalReview
            key={open.id}
            proposal={open}
            busy={action.status === 'running'}
            onApprove={async (only, overrides) => {
              const r = await run(() => apiClient.approvePriceProposal(open.id, { onlyIds: only, overrideIds: overrides }), 'Approved. The selected prices are now active; the old ones are kept in history.');
              if (r) {
                onView(r.registry);
                setOpen(null);
              }
            }}
            onReject={async () => {
              const r = await run(() => apiClient.rejectPriceProposal(open.id), 'Rejected. No price changed.');
              if (r) {
                onView(r.registry);
                setOpen(null);
              }
            }}
          />
        )}
      </Card>
    </div>
  );
}

function ImportExportPanel({ view, onView }: { view: HubView; onView: (v: HubView) => void }) {
  const [action, run] = useAction();
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  let doc: unknown = null;
  let parseError: string | null = null;
  if (text.trim()) {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      parseError = `Not valid JSON: ${(e as Error).message}`;
    }
  }
  return (
    <div className="space-y-4">
      <Card title="Export" subtitle="The complete registry (providers and models) as JSON. It never contains an API key: providers name the variable that holds theirs.">
        <Button
          onClick={async () => {
            const exported = await run(() => apiClient.exportRegistry(), 'Exported.');
            if (!exported) return;
            const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'ai-model-registry.json';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download registry JSON
        </Button>
      </Card>
      <Card title="Import" subtitle="Paste a registry JSON. Its providers and models are added, or replace the ones with the same id; nothing is removed. It is checked as a whole first: if anything is invalid nothing is imported.">
        <TextArea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setIssues(null);
          }}
          rows={10}
          spellCheck={false}
          aria-label="Registry JSON to import"
        />
        {parseError && (
          <p role="alert" className="text-xs text-rose-300 font-mono">
            {parseError}
          </p>
        )}
        {issues && issues.length > 0 && (
          <ul role="alert" className="list-disc pl-4 text-rose-300 font-mono text-[11px] space-y-0.5">
            {formatIssues(issues).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
        {issues && issues.length === 0 && <p className="text-xs text-emerald-300">Valid: this can be imported.</p>}
        <ActionNote state={action} />
        <div className="flex gap-2">
          <Button
            disabled={!doc}
            onClick={async () => {
              const r = await run(() => apiClient.validateRegistryDocument(doc), 'Checked.');
              if (r) setIssues(r.issues);
            }}
          >
            Check
          </Button>
          <Button
            variant="primary"
            disabled={!doc || issues === null || issues.length > 0}
            onClick={async () => {
              const r = await run(() => apiClient.importRegistry(doc), 'Imported.');
              if (r) {
                onView(r.registry);
                setText('');
                setIssues(null);
              }
            }}
          >
            Import
          </Button>
        </div>
      </Card>
      <Card title="Defaults" subtitle="Adds back any default provider or model that is missing from the registry (for example ones a newer gateway ships). Your own entries and any default you changed are left as they are; to put one changed default back, use its Reset to default button.">
        <Button
          onClick={async () => {
            const r = await run(() => apiClient.restoreRegistryDefaults(), 'Missing defaults added.');
            if (r) onView(r.registry);
          }}
        >
          Add missing defaults
        </Button>
      </Card>
      {!view.persisted && <p className="text-xs text-amber-300">The registry is held in memory only: it is lost when the gateway restarts.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- the tab

const SUBTABS = [
  { id: 'llm', label: 'Language models' },
  { id: 'stt', label: 'Speech-to-text' },
  { id: 'tts', label: 'Text-to-speech' },
  { id: 'providers', label: 'Providers' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'json', label: 'Import / export' },
] as const;

export function ModelHubTab() {
  const { refreshCatalog } = useAi();
  const [view, setViewState] = useState<HubView | null>(null);
  // A saved change goes into the model dropdowns on the other tabs straight away, without a page reload.
  const setView = useCallback(
    (next: HubView) => {
      setViewState(next);
      void refreshCatalog();
    },
    [refreshCatalog]
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sub, setSub] = useState<(typeof SUBTABS)[number]['id']>('llm');

  const load = useCallback(async () => {
    try {
      setViewState(await apiClient.getModelHub());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError && !view) {
    return (
      <p role="alert" className="text-xs text-rose-300">
        Could not load the model registry from the gateway: {loadError}
      </p>
    );
  }
  if (!view) return <p className="text-xs text-slate-500">Loading…</p>;

  return (
    <div className="space-y-5">
      {!view.load.ok && (
        <div role="alert" className="text-xs rounded-md border border-amber-800/70 bg-amber-950/50 text-amber-200 px-3 py-2 space-y-1">
          <p>A registry file on the gateway is not valid, so the last valid registry is still in use. Nothing was lost; fix the file and it loads again.</p>
          <ul className="list-disc pl-4 font-mono text-[11px]">
            {formatIssues(view.load.issues)
              .slice(0, 6)
              .map((m, i) => (
                <li key={i}>{m}</li>
              ))}
          </ul>
        </div>
      )}
      <div role="tablist" aria-label="Model hub sections" className="flex flex-wrap gap-1">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={sub === t.id}
            onClick={() => setSub(t.id)}
            className={`px-3 py-1.5 text-xs rounded-md border transition ${sub === t.id ? 'bg-cyan-900/50 border-cyan-700 text-white' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {(sub === 'llm' || sub === 'stt' || sub === 'tts') && <ModelsPanel stage={sub} view={view} onView={setView} />}
      {sub === 'providers' && <ProvidersPanel view={view} onView={setView} />}
      {sub === 'pricing' && <PricingPanel view={view} onView={setView} />}
      {sub === 'json' && <ImportExportPanel view={view} onView={setView} />}
    </div>
  );
}
