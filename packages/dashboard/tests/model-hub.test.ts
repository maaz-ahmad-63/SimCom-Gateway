import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsTable, ProposalReview, ProvidersTable } from '../src/components/ai/ModelHubTab';
import { GatewayApiClient, GatewayApiError } from '../src/lib/api-client';
import {
  capabilityLabels,
  credentialNote,
  defaultBlocker,
  diffRows,
  editableEntry,
  endpointNote,
  entryTemplate,
  Facts,
  formatIssues,
  HubModel,
  HubProvider,
  HubView,
  LLM_TEST_NOTICE,
  modelStatus,
  parseJsonObject,
  priceStatus,
  ProposalDetail,
  removeAction,
  setJsonField,
  sourceCheckNote,
  voicesOf,
  withoutVoice,
  withVoice,
} from '../src/lib/model-hub';

const facts = (over: Partial<Facts> = {}): Facts => ({ streaming: true, batch: false, functionCalling: true, structuredOutput: false, voiceSelection: false, languages: 'any', cancellation: true, ...over });
const model = (over: Partial<HubModel> = {}): HubModel => ({
  id: 'zz_custom_model',
  stage: 'llm',
  provider: 'zz_provider',
  protocol: 'openai-chat',
  model: 'zz/custom-1',
  label: 'ZZ Custom Model',
  enabled: true,
  aliases: [],
  options: { body: {}, tools: true },
  builtin: false,
  modified: false,
  resolved: { implemented: true, disabled: false, unavailableReason: null, protocol: 'openai-chat', facts: facts(), endpoint: 'https://api.zz.example/v1', endpointIsDefault: false, credential: { name: 'ZZ_API_KEY', state: 'stored' } },
  price: null,
  ...over,
});
const provider = (over: Partial<HubProvider> = {}): HubProvider => ({
  id: 'zz_provider',
  name: 'ZZ Provider',
  credential: 'ZZ_API_KEY',
  baseUrl: 'https://api.zz.example/v1',
  enabled: true,
  builtin: false,
  modified: false,
  credentialState: { name: 'ZZ_API_KEY', state: 'stored' },
  models: 1,
  ...over,
});
const view = (over: Partial<HubView> = {}): HubView => ({
  schemaVersion: 2,
  persisted: true,
  load: { ok: true, usingLastValid: false, at: '2026-10-30T00:00:00Z', issues: [] },
  protocols: [
    { id: 'openai-chat', stage: 'llm', title: 'OpenAI-compatible chat', summary: 'POST {base}/chat/completions', endpoint: { kind: 'base', scheme: 'https', default: null }, facts: facts() },
    { id: 'inworld-tts', stage: 'tts', title: 'Inworld TTS', summary: 'POST /tts/v1/voice:stream', endpoint: { kind: 'full', scheme: 'https', default: 'https://api.inworld.ai/tts/v1/voice:stream' }, facts: facts({ voiceSelection: true, batch: true }) },
  ],
  providers: [provider()],
  models: { llm: [model()], stt: [], tts: [] },
  defaults: { llm: 'zz_custom_model', stt: 'nova-3', tts: 'cartesia', voice: 'katie' },
  pricing: { prices: [], sources: [], proposals: [] },
  ...over,
});

describe('the hub shows exactly what the gateway returned', () => {
  it('lists the models in the response, and none that were not in it (the dashboard keeps no model list of its own)', () => {
    const html = renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view() }));
    expect(html).toContain('ZZ Custom Model');
    expect(html).toContain('zz/custom-1');
    for (const builtin of ['telnyx_kimi_k3', 'groq_qwen_3_8_27b', 'openai_gpt_5_4', 'Kimi', 'Qwen']) expect(html).not.toContain(builtin);
    expect(renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view({ models: { llm: [model(), model({ id: 'another_one', label: 'Another One' })], stt: [], tts: [] } }) }))).toContain('Another One');
  });

  it('marks what is in use, the status, the protocol, the endpoint and what the protocol can do, and never calls an unknown price free', () => {
    const html = renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view() }));
    expect(html).toContain('in use');
    expect(html).toContain('ready');
    expect(html).toContain('openai-chat');
    expect(html).toContain('https://api.zz.example/v1');
    expect(html).toContain('function calling');
    expect(html).toContain('ZZ_API_KEY: stored (encrypted)');
    expect(html).toContain('price unknown');
    expect(html).toContain('unknown (never assumed free)');
    expect(html).not.toMatch(/\$0(?![.\d])|USD 0 /);
  });

  it('shows an unusable model with its reason, a pristine default without delete or reset, an edited default with Reset to default, and a custom one with Delete', () => {
    const noProtocol = model({ id: 'b1', label: 'Built-in One', builtin: true, protocol: null, resolved: { ...model().resolved!, implemented: false, unavailableReason: 'Not ported to the gateway yet', protocol: null, facts: null } });
    const acts = { onDefault() {}, onTest() {}, onEdit() {}, onToggle() {}, onRemove() {} };
    const pristine = renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view({ models: { llm: [noProtocol], stt: [], tts: [] }, defaults: { llm: 'x', stt: 'y', tts: 'z', voice: 'v' } }), actions: acts }));
    expect(pristine).toContain('no protocol');
    expect(pristine).toContain('Not ported to the gateway yet');
    expect(pristine).not.toContain('Delete');
    expect(pristine).not.toContain('Reset to default');
    const edited = renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view({ models: { llm: [model({ builtin: true, modified: true })], stt: [], tts: [] } }), actions: acts }));
    expect(edited).toContain('Reset to default');
    expect(edited).toContain('default, edited');
    const custom = renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view(), actions: acts }));
    expect(custom).toContain('Delete');
    expect(custom).toContain('Disable');
    expect(custom).toContain('Use for new calls');
  });

  it('lists providers with their credential state and base URL, and the response never needs to carry a key', () => {
    const html = renderToStaticMarkup(React.createElement(ProvidersTable, { view: view({ providers: [provider(), provider({ id: 'p2', name: 'Needs Key', credentialState: { name: 'NK_API_KEY', state: 'missing' }, baseUrl: null })] }) }));
    expect(html).toContain('ZZ Provider');
    expect(html).toContain('https://api.zz.example/v1');
    expect(html).toContain('NK_API_KEY: not set (add it under API Keys)');
  });
});

describe('model hub helpers', () => {
  it('statuses: ready, off, needs a credential, no protocol, broken reference', () => {
    expect(modelStatus(model())).toEqual({ tone: 'good', label: 'ready' });
    expect(modelStatus(model({ enabled: false }))).toEqual({ tone: 'neutral', label: 'off' });
    expect(modelStatus(model({ resolved: { ...model().resolved!, credential: { name: 'ZZ_API_KEY', state: 'missing' } } }))).toEqual({ tone: 'warn', label: 'needs ZZ_API_KEY' });
    expect(modelStatus(model({ resolved: { ...model().resolved!, implemented: false } })).label).toBe('no protocol');
    expect(modelStatus(model({ resolved: null })).tone).toBe('bad');
  });

  it('only a ready model that is not already in use can be made the default, and the reason is given', () => {
    expect(defaultBlocker(model(), 'other')).toBeNull();
    expect(defaultBlocker(model(), 'zz_custom_model')).toBe('already the default');
    expect(defaultBlocker(model({ enabled: false }), 'other')).toBe('switched off');
    expect(defaultBlocker(model({ resolved: { ...model().resolved!, implemented: false, unavailableReason: 'Not ported to the gateway yet' } }), 'other')).toBe('Not ported to the gateway yet');
  });

  it('what a protocol can do is stated plainly', () => {
    expect(capabilityLabels(facts({ streaming: false, batch: true, functionCalling: false, languages: ['en'], cancellation: false }))).toEqual(['no streaming', 'batch', '1 language', 'not cancellable']);
    expect(capabilityLabels(facts({ structuredOutput: true, voiceSelection: true }))).toEqual(expect.arrayContaining(['structured output', 'voice selection']));
  });

  it('credential notes name the variable and where it comes from, never a value', () => {
    expect(credentialNote({ name: 'A_API_KEY', state: 'stored' }).text).toBe('A_API_KEY: stored (encrypted)');
    expect(credentialNote({ name: 'A_API_KEY', state: 'env' }).text).toBe('A_API_KEY: from the environment');
    expect(credentialNote({ name: 'A_API_KEY', state: 'missing' }).tone).toBe('warn');
    expect(credentialNote(null).text).toBe('no credential');
  });

  it('price statuses never present an imported or unverified price as verified', () => {
    const p = (status: string, verifiedAt: string | null = null) => ({ id: 'p', summary: 's', plan: 'standard', currency: 'USD', status, protected: false, planSpecific: false, verifiedAt, effectiveFrom: null, sourceUrl: null });
    expect(priceStatus(null)).toEqual({ tone: 'neutral', label: 'price unknown' });
    expect(priceStatus(p('imported-unverified'))).toEqual({ tone: 'warn', label: 'imported, not re-verified' });
    expect(priceStatus(p('unverified')).tone).toBe('warn');
    expect(priceStatus(p('verified', '2026-10-30T00:00:00Z')).label).toBe('verified 2026-10-30');
    expect(priceStatus(p('negotiated')).label).toBe('negotiated');
  });

  it('default entries are never deleted: only reset when changed; your own can be deleted', () => {
    expect(removeAction({ builtin: true, modified: false })).toBeNull();
    expect(removeAction({ builtin: true, modified: true })).toMatchObject({ label: 'Reset to default', reset: true });
    expect(removeAction({ builtin: false, modified: false })).toMatchObject({ label: 'Delete', reset: false });
  });

  it('templates are empty starting points built from the response, and editing strips what the gateway derived', () => {
    const v = view();
    expect(entryTemplate('provider', null, v)).toMatchObject({ id: '', credential: '', enabled: true });
    expect(entryTemplate('model', 'llm', v)).toMatchObject({ id: '', stage: 'llm', provider: 'zz_provider', protocol: 'openai-chat', options: { tools: false } });
    expect(entryTemplate('model', 'tts', v)).toMatchObject({ stage: 'tts', protocol: 'inworld-tts', options: { sampleRates: [8000, 16000], voices: [] } });
    expect(Object.keys(editableEntry(model() as unknown as Record<string, unknown>))).not.toEqual(expect.arrayContaining(['builtin', 'modified', 'resolved', 'price']));
    expect(Object.keys(editableEntry(provider() as unknown as Record<string, unknown>))).not.toEqual(expect.arrayContaining(['credentialState', 'models', 'builtin']));
    expect(editableEntry(model() as unknown as Record<string, unknown>).id).toBe('zz_custom_model');
  });

  it('the JSON editor reports bad JSON, keeps the text when a field is set on text that does not parse, and can remove a field', () => {
    expect(parseJsonObject('').error).toMatch(/Enter the entry/);
    expect(parseJsonObject('[1]').error).toMatch(/must be a JSON object/);
    expect(parseJsonObject('{ nope').error).toMatch(/Not valid JSON/);
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 });
    expect(JSON.parse(setJsonField('{"a":1}', 'b', 2))).toEqual({ a: 1, b: 2 });
    expect(JSON.parse(setJsonField('{"a":1,"b":2}', 'b', undefined))).toEqual({ a: 1 });
    expect(setJsonField('{ broken', 'b', 2)).toBe('{ broken');
  });

  it('formats the gateway’s validation issues for display before saving', () => {
    expect(formatIssues([{ collection: 'models', id: 'x', path: 'provider', message: "unknown provider 'nobody'" }, { collection: 'document', id: null, path: '$', message: 'broken' }])).toEqual(["x: provider: unknown provider 'nobody'", 'broken']);
  });

  it('endpoints read as the model’s own, the provider’s, or the protocol’s default', () => {
    expect(endpointNote(model())).toBe('https://api.zz.example/v1');
    expect(endpointNote(model({ resolved: { ...model().resolved!, endpoint: 'https://api.inworld.ai/tts/v1/voice:stream', endpointIsDefault: true } }))).toBe("https://api.inworld.ai/tts/v1/voice:stream (the protocol's default)");
    expect(endpointNote(model({ resolved: null }))).toBe('no endpoint needed');
  });

  it('voices are part of a text-to-speech model’s options: adding replaces a voice of the same name, removing drops it, nothing else changes', () => {
    const tts = model({ stage: 'tts', options: { voice: 'Sarah', sampleRates: [8000], voices: [{ name: 'Sarah', label: 'Sarah' }, { name: 'Dennis' }] } });
    expect(voicesOf(tts)).toHaveLength(2);
    expect(voicesOf(model())).toEqual([]);
    const added = withVoice(tts, { name: 'dennis', id: 'abc', label: 'Dennis' });
    expect(added.voices).toEqual([{ name: 'Sarah', label: 'Sarah' }, { name: 'dennis', id: 'abc', label: 'Dennis' }]);
    expect(added.sampleRates).toEqual([8000]);
    expect(withoutVoice(tts, 'Dennis').voices).toEqual([{ name: 'Sarah', label: 'Sarah' }]);
  });
});

describe('pricing review', () => {
  const rates = (price: number | null) => [{ component: 'input_tokens', unit: 'per_million_tokens', price }];
  const entry = (id: string, price: number | null, status = 'verified') => ({ id, providerId: 'p', modelKind: 'llm', modelId: 'm', plan: 'standard', currency: 'USD', rates: rates(price), sourceUrl: null, verifiedAt: null, effectiveFrom: null, status, protected: false, planSpecific: false, builtin: false, modified: false, summary: '' });
  const proposal = (): ProposalDetail => ({
    id: 'pr1',
    createdAt: '2026-10-30T10:00:00.000Z',
    origin: 'manual-import',
    sourceUrl: null,
    note: null,
    status: 'pending',
    appliedIds: [],
    rejectedEntries: [{ id: 'bad', message: 'rates: Array must contain at least 1 element(s)' }],
    diffs: [
      { priceId: 'a', kind: 'changed', fields: ['rates'], protected: false, blocked: null, before: entry('a', 1), after: entry('a', 2) },
      { priceId: 'b', kind: 'changed', fields: ['rates'], protected: true, blocked: 'the current price is negotiated or hand-entered (protected)', before: entry('b', 1, 'negotiated'), after: entry('b', 2) },
      { priceId: 'c', kind: 'unchanged', fields: [], protected: false, blocked: null, before: entry('c', 1), after: entry('c', 1) },
      { priceId: 'd', kind: 'new', fields: ['rates'], protected: false, blocked: null, before: null, after: entry('d', null, 'unverified') },
    ],
  });

  it('lists only what would change, says what is held back, and shows unknown as unknown', () => {
    const rows = diffRows(proposal().diffs);
    expect(rows.map((r) => [r.priceId, r.applicable, r.needsOverride])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', false, false],
      ['d', true, false],
    ]);
    expect(rows[0].before).toContain('USD 1 per million tokens');
    expect(rows[0].after).toContain('USD 2 per million tokens');
    expect(rows[3].before).toBe('—');
    expect(rows[3].after).toContain('unknown');
  });

  it('the review screen shows the held-back reason and the invalid entries, and offers approval only as an explicit action', () => {
    const html = renderToStaticMarkup(React.createElement(ProposalReview, { proposal: proposal(), onApprove() {}, onReject() {} }));
    expect(html).toContain('Nothing below is active until you approve it');
    expect(html).toContain('Held back: the current price is negotiated or hand-entered (protected)');
    expect(html).toContain('Entries that were not valid and will not be applied');
    expect(html).toContain('bad: rates: Array must contain at least 1 element(s)');
    expect(html).toContain('Approve selected');
    expect(html).toContain('Reject proposal');
    expect(html).not.toContain('data-price-id="c"');
  });

  it('describes a source check plainly', () => {
    const check = (over: object) => ({ providerId: 'p', url: 'https://x', format: 'html', checkedAt: '2026-10-30T00:00:00Z', ok: true, httpStatus: 200, contentHash: 'h', changed: null, error: null, proposalId: null, ...over });
    expect(sourceCheckNote(null).text).toBe('never checked');
    expect(sourceCheckNote(check({ ok: false, error: 'the site refused an automated request (HTTP 403): use a reviewed manual import for this provider' })).tone).toBe('bad');
    expect(sourceCheckNote(check({ changed: true })).text).toMatch(/changed since the last check/);
    expect(sourceCheckNote(check({ changed: false })).text).toBe('unchanged since the last check');
    expect(sourceCheckNote(check({})).text).toMatch(/nothing to compare/);
  });
});

describe('the gateway client for the model hub', () => {
  const original = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => {
    global.fetch = original;
  });
  const client = () => new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'dashboard-test-key-123' });
  const last = () => {
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    return { url: String(url), init: init as RequestInit };
  };

  it('reads every list from the gateway and sends changes to the registry endpoints with the API key', async () => {
    await client().getModelHub();
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry');
    expect((last().init.headers as Record<string, string>)['x-api-key']).toBe('dashboard-test-key-123');
    await client().createProvider({ id: 'p' });
    expect(last()).toMatchObject({ url: 'http://127.0.0.1:4000/api/ai/registry/providers', init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'p' }) }) });
    await client().updateProvider('a b', { enabled: false });
    expect(last()).toMatchObject({ url: 'http://127.0.0.1:4000/api/ai/registry/providers/a%20b', init: expect.objectContaining({ method: 'PATCH' }) });
    await client().createModel({ id: 'm', stage: 'llm' });
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/models');
    await client().updateModel('tts', 'm 1', { enabled: false });
    expect(last()).toMatchObject({ url: 'http://127.0.0.1:4000/api/ai/registry/models/tts/m%201', init: expect.objectContaining({ method: 'PATCH' }) });
    await client().deleteModel('stt', 'm');
    expect(last()).toMatchObject({ url: 'http://127.0.0.1:4000/api/ai/registry/models/stt/m', init: expect.objectContaining({ method: 'DELETE' }) });
    await client().deleteProvider('p');
    expect(last().init.method).toBe('DELETE');
    await client().validateRegistryEntry('model', { id: 'p' });
    expect(JSON.parse(String(last().init.body))).toEqual({ kind: 'model', entry: { id: 'p' } });
    await client().importRegistry({ models: [] });
    expect(JSON.parse(String(last().init.body))).toEqual({ document: { models: [] } });
    await client().restoreRegistryDefaults([{ kind: 'model', stage: 'llm', id: 'x' }]);
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/restore-defaults');
    await client().testRegistryProvider('groq');
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/test/provider/groq');
    await client().testRegistryModel('llm', 'm', { confirmBilling: true });
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/test/model/llm/m');
    expect(JSON.parse(String(last().init.body))).toEqual({ confirmBilling: true }); // a language-model test is billed, so it is confirmed
    await client().testRegistryModel('stt', 'm');
    expect(JSON.parse(String(last().init.body))).toEqual({});
    await client().checkPricingSources(['groq']);
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/pricing/check');
    await client().proposePrices([{ id: 'p' }], 'note');
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/pricing/proposals');
    await client().approvePriceProposal('pr1', { onlyIds: ['a'], overrideIds: [] });
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/pricing/proposals/pr1/approve');
    await client().rejectPriceProposal('pr1');
    expect(last().url).toBe('http://127.0.0.1:4000/api/ai/registry/pricing/proposals/pr1/reject');
  });

  it('a rejected change carries the gateway’s readable validation messages', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ success: false, error: 'The registry was not changed: the entry is not valid', blockers: ["models 'x' provider: unknown provider 'nobody'"], issues: [{ path: 'provider', message: 'x' }] }),
    });
    const error = await client().createModel({ id: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(GatewayApiError);
    expect(error.statusCode).toBe(422);
    expect(error.reasons).toEqual(["models 'x' provider: unknown provider 'nobody'"]);
  });
});

describe('the Test action', () => {
  it('tells the operator a language-model test is a real, billed request before it is sent', () => {
    expect(LLM_TEST_NOTICE).toMatch(/one very short request/);
    expect(LLM_TEST_NOTICE).toMatch(/bills/);
    expect(LLM_TEST_NOTICE).toMatch(/does not touch a call/);
  });

  it('labels the language-model button as sending a request, and a speech model’s as a read-only check', () => {
    const acts = { onDefault() {}, onTest() {}, onEdit() {}, onToggle() {}, onRemove() {} };
    const llm = renderToStaticMarkup(React.createElement(ModelsTable, { stage: 'llm', view: view(), actions: acts }));
    expect(llm).toContain('Test (sends a request)');
    const stt = renderToStaticMarkup(
      React.createElement(ModelsTable, { stage: 'stt', view: view({ models: { llm: [], stt: [model({ stage: 'stt', id: 's1', label: 'S One' })], tts: [] } }), actions: acts })
    );
    expect(stt).not.toContain('sends a request');
  });

  it('the result can carry the real request’s status and timings', () => {
    const result = { ok: true, status: 'ok', detail: 'x', checkedAt: 't', request: { httpStatus: 200, firstTokenMs: 300, totalMs: 500, replyChars: 2 } };
    expect(result.request.totalMs).toBeGreaterThanOrEqual(result.request.firstTokenMs);
  });
});
