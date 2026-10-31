import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { resetActiveRegistry } from '../src/ai/registry/active.js';
import { createMockProviders } from '../src/ai/providers/mock.js';
import { createGatewayServer } from '../src/server.js';
import { aiEnv } from './ai/helpers.js';

/**
 * The AI Model Hub's HTTP API through the real gateway wiring, with mock providers and a fake fetch. Nothing here reaches a
 * network, a modem or a real provider: it proves the routes, the validation, the persistence and that no secret leaves the gateway.
 */
const KEY = 'registry-api-key-123456';
const SECRET = 'gsk_THIS_IS_A_TEST_SECRET_0123456789abcdef';
const MASTER = 'a-long-master-key-for-tests-only';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  resetActiveRegistry();
});

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function gateway(opts: { fetchImpl?: Fetch; env?: Record<string, string | undefined> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-api-'));
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 60 });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, init });
    return opts.fetchImpl ? opts.fetchImpl(url, init) : new Response('{}', { status: 200 });
  };
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: {
      env: aiEnv({ AI_SECRETS_MASTER_KEY: MASTER, GROQ_API_KEY: SECRET, AI_LLM: 'groq_qwen_3_8_27b', ...opts.env }),
      providers: createMockProviders({ stt: ['hello'], llm: ['hi there'] }),
      fetchImpl,
      allowSimulatedHardware: true,
      registryDir: path.join(dir, 'registry'),
    },
  });
  await modem.initialize();
  cleanups.push(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const api = (m: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const r = request(server.app)[m](url).set('x-api-key', KEY);
    return body ? r.send(body) : r;
  };
  return { server, api, dir, calls };
}

const llm = (over: Record<string, unknown> = {}) => ({
  id: 'groq_llama_4_scout',
  stage: 'llm',
  provider: 'groq',
  protocol: 'openai-chat',
  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
  label: 'Groq Llama 4 Scout',
  options: { body: { temperature: 0.5 } },
  ...over,
});
const findModel = (view: any, stage: string, id: string) => view.models[stage].find((m: any) => m.id === id);

describe('the registry API', () => {
  it('requires the gateway API key', async () => {
    const h = await gateway();
    expect((await request(h.server.app).get('/api/ai/registry')).status).toBe(401);
    expect((await request(h.server.app).post('/api/ai/registry/models').send(llm())).status).toBe(401);
  });

  it('serves every provider, model, protocol and price the dashboard shows, with what each can do, and no secret value', async () => {
    const h = await gateway();
    const res = await h.api('get', '/api/ai/registry');
    expect(res.status).toBe(200);
    const view = res.body;
    expect(view.providers.length).toBeGreaterThan(8);
    expect(findModel(view, 'llm', 'telnyx_kimi_k3')).toMatchObject({
      builtin: true,
      modified: false,
      resolved: { implemented: true, disabled: false, protocol: 'openai-chat', facts: { functionCalling: false, streaming: true }, endpoint: 'https://api.telnyx.com/v2/ai/openai' },
      price: { summary: '$2.7/1M input, $13.5/1M output tokens', status: 'imported-unverified', sourceUrl: null },
    });
    expect(findModel(view, 'llm', 'groq_qwen_3_8_27b').resolved.facts.functionCalling).toBe(true);
    expect(findModel(view, 'stt', 'assemblyai').resolved).toMatchObject({ implemented: false, unavailableReason: 'Not ported to the gateway yet' });
    expect(findModel(view, 'tts', 'inworld')).toMatchObject({ protocol: 'inworld-tts', provider: 'inworld', model: 'inworld-tts-2', resolved: { endpoint: 'https://api.inworld.ai/tts/v1/voice:stream', endpointIsDefault: true, credential: { name: 'INWORLD_API_KEY', state: 'missing' } } }); // the shared test helper sets no Inworld key
    expect(findModel(view, 'llm', 'groq_qwen_3_8_27b').resolved.credential).toEqual({ name: 'GROQ_API_KEY', state: 'env' });
    expect(view.providers.find((p: any) => p.id === 'sarvam').credentialState).toBeNull();
    expect(view.defaults).toMatchObject({ llm: 'groq_qwen_3_8_27b', stt: 'nova-3', tts: 'cartesia' });
    expect(view.protocols.map((p: any) => p.id)).toEqual(expect.arrayContaining(['openai-chat', 'inworld-tts', 'deepgram-listen']));
    expect(view.pricing.sources.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify((await h.api('get', '/api/ai/registry/export')).body)).not.toContain(SECRET);
  });

  it('a model added through the API is saved as JSON, appears in the catalog and can be selected, with no code change', async () => {
    const h = await gateway();
    expect(fs.existsSync(path.join(h.dir, 'registry', 'registry.json'))).toBe(false); // nothing written until something changes
    const created = await h.api('post', '/api/ai/registry/models', llm());
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(findModel(created.body.registry, 'llm', 'groq_llama_4_scout')).toMatchObject({ builtin: false });
    const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'registry', 'registry.json'), 'utf8'));
    expect(saved.schemaVersion).toBe(2);
    expect(saved.models.some((m: any) => m.id === 'groq_llama_4_scout')).toBe(true);
    expect(saved.models.length).toBeGreaterThan(30); // the whole list is in the file now
    const catalog = (await h.api('get', '/api/ai/catalog')).body;
    expect(catalog.llm.find((m: any) => m.key === 'groq_llama_4_scout')).toMatchObject({ implemented: true, provider: 'groq' });
    expect((await h.api('put', '/api/ai/settings', { llm: 'groq_llama_4_scout' })).status).toBe(200);
    expect(h.server.aiRuntime.config.config.llm.key).toBe('groq_llama_4_scout');
    expect(h.server.aiRuntime.config.errors).toEqual([]);
  });

  it('a second Inworld model with its own endpoint is one entry; the endpoint shows in the Hub', async () => {
    const h = await gateway();
    const created = await h.api('post', '/api/ai/registry/models', {
      id: 'inworld_max',
      stage: 'tts',
      provider: 'inworld',
      protocol: 'inworld-tts',
      model: 'inworld-tts-1.5-max',
      label: 'Inworld Max',
      endpoint: 'https://eu.inworld.example.com/tts/v1/voice:stream',
      options: { voice: 'Sarah', sampleRates: [8000, 16000] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(findModel(created.body.registry, 'tts', 'inworld_max').resolved).toMatchObject({ endpoint: 'https://eu.inworld.example.com/tts/v1/voice:stream', endpointIsDefault: false });
    expect((await h.api('get', '/api/ai/catalog')).body.tts.find((m: any) => m.key === 'inworld_max')).toMatchObject({ implemented: true, model: 'inworld-tts-1.5-max' });
  });

  it('rejects an invalid entry with every issue, 422, and changes nothing; validation can be asked for first', async () => {
    const h = await gateway();
    const dry = await h.api('post', '/api/ai/registry/validate', { kind: 'model', entry: llm({ provider: 'nobody', apiKey: 'x' }) });
    expect(dry.status).toBe(200);
    expect(dry.body.ok).toBe(false);
    expect(dry.body.issues.length).toBeGreaterThan(0);
    const bad = await h.api('post', '/api/ai/registry/models', llm({ provider: 'nobody' }));
    expect(bad.status).toBe(422);
    expect(bad.body.issues[0].message).toMatch(/unknown provider/);
    expect(bad.body.blockers[0]).toMatch(/unknown provider/);
    expect(findModel((await h.api('get', '/api/ai/registry')).body, 'llm', 'groq_llama_4_scout')).toBeUndefined();
    expect(fs.existsSync(path.join(h.dir, 'registry', 'registry.json'))).toBe(false);
    expect((await h.api('post', '/api/ai/registry/validate', { kind: 'nonsense', entry: {} })).status).toBe(400);
    expect((await h.api('patch', '/api/ai/registry/models/nonsense/x', { enabled: false })).status).toBe(404);
    expect((await h.api('post', '/api/ai/registry/models', llm({ id: 'telnyx_kimi_k3', provider: 'telnyx' }))).status).toBe(422); // exists: edit instead
  });

  it('edits, disables and deletes; the model in use cannot be disabled or deleted, and default entries cannot be deleted', async () => {
    const h = await gateway();
    await h.api('post', '/api/ai/registry/models', llm());
    const edited = await h.api('patch', '/api/ai/registry/models/llm/groq_llama_4_scout', { label: 'Scout (edited)', enabled: false });
    expect(edited.status).toBe(200);
    expect(findModel(edited.body.registry, 'llm', 'groq_llama_4_scout')).toMatchObject({ label: 'Scout (edited)', enabled: false });
    expect((await h.api('patch', '/api/ai/registry/models/llm/groq_llama_4_scout', { id: 'other' })).status).toBe(422);
    const inUse = await h.api('patch', '/api/ai/registry/models/llm/groq_qwen_3_8_27b', { enabled: false });
    expect(inUse.status).toBe(422);
    expect(inUse.body.issues[0].message).toMatch(/selected language model/);
    expect(h.server.aiRuntime.config.errors).toEqual([]); // the agent is still configured
    expect((await h.api('delete', '/api/ai/registry/models/llm/telnyx_kimi_k3')).status).toBe(422);
    expect((await h.api('delete', '/api/ai/registry/providers/groq')).status).toBe(422);
    expect((await h.api('delete', '/api/ai/registry/models/llm/groq_llama_4_scout')).status).toBe(200);
    expect((await h.api('delete', '/api/ai/registry/models/llm/groq_llama_4_scout')).status).toBe(422);
  });

  it('a changed default can be reset; defaults that are missing can be restored', async () => {
    const h = await gateway();
    await h.api('patch', '/api/ai/registry/models/llm/telnyx_kimi_k3', { label: 'My label' });
    expect(findModel((await h.api('get', '/api/ai/registry')).body, 'llm', 'telnyx_kimi_k3')).toMatchObject({ label: 'My label', modified: true });
    const reset = await h.api('post', '/api/ai/registry/restore-defaults', { ids: [{ kind: 'model', stage: 'llm', id: 'telnyx_kimi_k3' }] });
    expect(reset.status).toBe(200);
    expect(findModel(reset.body.registry, 'llm', 'telnyx_kimi_k3')).toMatchObject({ label: 'telnyx kimi k3', modified: false });
  });

  it('a registry change takes effect for the next configuration without touching existing settings, keys or the active selection', async () => {
    const h = await gateway();
    const before = (await h.api('get', '/api/ai/settings')).body.llm;
    await h.api('post', '/api/ai/registry/models', llm());
    expect((await h.api('get', '/api/ai/settings')).body.llm).toBe(before);
    expect(h.server.aiRuntime.config.config.llm.key).toBe('groq_qwen_3_8_27b');
  });

  it('exports the registry and imports it back (dry run first), and refuses an import with an invalid entry', async () => {
    const h = await gateway();
    await h.api('post', '/api/ai/registry/models', llm());
    const exported = (await h.api('get', '/api/ai/registry/export')).body;
    expect(exported.models.some((m: any) => m.id === 'groq_llama_4_scout')).toBe(true);
    await h.api('delete', '/api/ai/registry/models/llm/groq_llama_4_scout');
    const dry = await h.api('post', '/api/ai/registry/import', { document: exported, dryRun: true });
    expect(dry.body.ok).toBe(true);
    expect(findModel((await h.api('get', '/api/ai/registry')).body, 'llm', 'groq_llama_4_scout')).toBeUndefined();
    expect((await h.api('post', '/api/ai/registry/import', { document: exported })).status).toBe(200);
    expect(findModel((await h.api('get', '/api/ai/registry')).body, 'llm', 'groq_llama_4_scout')).toBeDefined();
    expect((await h.api('post', '/api/ai/registry/import', { document: { models: [llm({ id: 'broken', provider: 'nobody' })] } })).status).toBe(422);
    expect((await h.api('post', '/api/ai/registry/import', {})).status).toBe(400);
  });

  it('a provider added in the Hub can store its own encrypted credential; the store still rejects every other name', async () => {
    const h = await gateway();
    const together = { id: 'together', name: 'Together AI', credential: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1' };
    expect((await h.api('put', '/api/ai/credentials/TOGETHER_API_KEY', { value: 'together-secret-key-123456' })).status).toBe(404); // not yet known
    expect((await h.api('post', '/api/ai/registry/providers', together)).status).toBe(200);
    const stored = await h.api('put', '/api/ai/credentials/TOGETHER_API_KEY', { value: 'together-secret-key-123456' });
    expect(stored.status).toBe(200);
    expect(JSON.stringify(stored.body)).not.toContain('together-secret-key-123456');
    expect((await h.api('put', '/api/ai/credentials/RANDOM_THING_API_KEY', { value: 'together-secret-key-123456' })).status).toBe(404);
    const view = (await h.api('get', '/api/ai/registry')).body;
    expect(view.providers.find((p: any) => p.id === 'together').credentialState).toEqual({ name: 'TOGETHER_API_KEY', state: 'stored' });
    expect(JSON.stringify(view)).not.toContain('together-secret-key-123456');
  });
});

describe('connection and model-availability tests (read-only, operator-triggered)', () => {
  it('reports a missing credential without making any request', async () => {
    const h = await gateway({ env: { CARTESIA_API_KEY: undefined } });
    const res = await h.api('post', '/api/ai/registry/test/provider/cartesia');
    expect(res.body).toMatchObject({ ok: false, status: 'no-credential' });
    expect(res.body.detail).toMatch(/CARTESIA_API_KEY is not set/);
    expect(h.calls).toHaveLength(0);
  });

  it('checks a key with the provider’s own listing request, and sends it only there', async () => {
    const h = await gateway({ fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.8-27b' }, { id: 'openai/gpt-oss-20b' }] }), { status: 200 }) });
    const res = await h.api('post', '/api/ai/registry/test/provider/groq');
    expect(res.body).toMatchObject({ ok: true, status: 'ok' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('https://api.groq.com/openai/v1/models');
    expect((h.calls[0].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('a speech model is checked read-only: the key is tried with the provider’s list, and the model id is looked for in it', async () => {
    const h = await gateway({ env: { SONIOX_API_KEY: 'soniox-key-123456' }, fetchImpl: async () => new Response(JSON.stringify({ models: [{ id: 'stt-rt-v5' }] }), { status: 200 }) });
    expect((await h.api('post', '/api/ai/registry/test/model/stt/stt-rt-v5')).body).toMatchObject({ ok: true, status: 'ok', detail: expect.stringMatching(/'stt-rt-v5' is listed/) });
    expect(h.calls[0].url).toBe('https://api.soniox.com/v1/models');
    const other = await gateway({ env: { SONIOX_API_KEY: 'soniox-key-123456' }, fetchImpl: async () => new Response(JSON.stringify({ models: [{ id: 'something-else' }] }), { status: 200 }) });
    expect((await other.api('post', '/api/ai/registry/test/model/stt/stt-rt-v5')).body).toMatchObject({ ok: false, status: 'model-not-listed' });
    expect((await h.api('post', '/api/ai/registry/test/model/nonsense/x')).status).toBe(404);
    expect((await h.api('post', '/api/ai/registry/test/model/llm/no_such_model', { confirmBilling: true })).body).toMatchObject({ ok: false, status: 'not-implemented' });
  });

  it('a language model is tested with one real short request: at its own base URL, with its own key, not by listing models', async () => {
    const sse = () => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    const h = await gateway({ env: { MYGPU_API_KEY: 'mygpu-key-123456' }, fetchImpl: async () => sse() });
    await h.api('post', '/api/ai/registry/providers', { id: 'mygpu', name: 'My GPU box', credential: 'MYGPU_API_KEY', baseUrl: 'https://llm.example.com/v1' });
    await h.api('post', '/api/ai/registry/models', { id: 'mygpu_llama', stage: 'llm', provider: 'mygpu', protocol: 'openai-chat', model: 'llama-3', label: 'Llama 3' });
    const res = await h.api('post', '/api/ai/registry/test/model/llm/mygpu_llama', { confirmBilling: true });
    expect(res.body).toMatchObject({ ok: true, status: 'ok', request: { httpStatus: 200 } });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('https://llm.example.com/v1/chat/completions');
    expect((h.calls[0].init!.headers as Record<string, string>).Authorization).toBe('Bearer mygpu-key-123456'); // the default presentation
    expect(JSON.parse(String(h.calls[0].init!.body))).toMatchObject({ model: 'llama-3', max_tokens: 16 });
    // the provider-level connection test is the read-only listing
    const listing = await gateway({ env: { MYGPU_API_KEY: 'mygpu-key-123456' }, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'llama-3' }] }), { status: 200 }) });
    await listing.api('post', '/api/ai/registry/providers', { id: 'mygpu', name: 'My GPU box', credential: 'MYGPU_API_KEY', baseUrl: 'https://llm.example.com/v1' });
    await listing.api('post', '/api/ai/registry/models', { id: 'mygpu_llama', stage: 'llm', provider: 'mygpu', protocol: 'openai-chat', model: 'llama-3', label: 'Llama 3' });
    expect((await listing.api('post', '/api/ai/registry/test/provider/mygpu')).body).toMatchObject({ ok: true });
    expect(listing.calls[0].url).toBe('https://llm.example.com/v1/models');
  });

  it('distinguishes a rejected key from an unreachable provider, and never calls a provider with no protocol', async () => {
    const rejected = await gateway({ fetchImpl: async () => new Response('no', { status: 401 }) });
    expect((await rejected.api('post', '/api/ai/registry/test/provider/groq')).body).toMatchObject({ ok: false, status: 'invalid-credential' });
    const down = await gateway({
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect((await down.api('post', '/api/ai/registry/test/provider/groq')).body).toMatchObject({ ok: false, status: 'unreachable' });
    const none = await gateway();
    expect((await none.api('post', '/api/ai/registry/test/provider/assemblyai')).body).toMatchObject({ ok: false, status: 'not-implemented' });
    expect(none.calls).toHaveLength(0);
  });

  it('says plainly when a provider does not list its models, instead of claiming the model exists', async () => {
    const h = await gateway({ env: { DEEPGRAM_API_KEY: 'deepgram-key-123456' }, fetchImpl: async () => new Response('{}', { status: 200 }) });
    expect((await h.api('post', '/api/ai/registry/test/model/stt/nova-3')).body).toMatchObject({ ok: true, status: 'unverified', detail: expect.stringMatching(/does not list its models/) });
  });
});

describe('pricing review through the API', () => {
  const reviewed = {
    id: 'price.llm.groq_gpt_oss_20b',
    providerId: 'groq',
    modelKind: 'llm',
    modelId: 'groq_gpt_oss_20b',
    plan: 'standard',
    currency: 'USD',
    rates: [
      { component: 'input_tokens', unit: 'per_million_tokens', price: 0.08 },
      { component: 'output_tokens', unit: 'per_million_tokens', price: 0.32 },
    ],
    sourceUrl: 'https://pricing.example.com/groq',
    verifiedAt: '2026-10-30',
    effectiveFrom: '2026-10-01',
    status: 'verified',
  };
  const priceNow = async (h: Awaited<ReturnType<typeof gateway>>) => findModel((await h.api('get', '/api/ai/registry')).body, 'llm', 'groq_gpt_oss_20b').price.summary;

  it('a reviewed price is a proposal first; approving it changes the active price in pricing.json only, rejecting leaves it', async () => {
    const h = await gateway();
    const proposed = await h.api('post', '/api/ai/registry/pricing/proposals', { entries: [reviewed], note: 'from the pricing page, checked by hand' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const id = proposed.body.proposal.id;
    expect(proposed.body.registry.pricing.proposals[0]).toMatchObject({ id, status: 'pending', counts: { changed: 1, new: 0, blocked: 0, rejected: 0 } });
    expect(await priceNow(h)).toBe('$0.075/1M input, $0.3/1M output tokens');
    const detail = (await h.api('get', `/api/ai/registry/pricing/proposals/${id}`)).body;
    expect([detail.diffs[0].before.rates[0].price, detail.diffs[0].after.rates[0].price]).toEqual([0.075, 0.08]);
    const approved = await h.api('post', `/api/ai/registry/pricing/proposals/${id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toEqual(['price.llm.groq_gpt_oss_20b']);
    expect(await priceNow(h)).toBe('$0.08/1M input, $0.32/1M output tokens');
    expect(fs.existsSync(path.join(h.dir, 'registry', 'pricing.json'))).toBe(true);
    expect(fs.existsSync(path.join(h.dir, 'registry', 'registry.json'))).toBe(false); // the model registry was not touched
    expect((await h.api('post', `/api/ai/registry/pricing/proposals/${id}/approve`, {})).status).toBe(409); // once only
    expect((await h.api('get', '/api/ai/registry/pricing/history')).body.history).toHaveLength(1);
    const second = (await h.api('post', '/api/ai/registry/pricing/proposals', { entries: [{ ...reviewed, plan: 'other' }] })).body.proposal.id;
    expect((await h.api('post', `/api/ai/registry/pricing/proposals/${second}/reject`, { note: 'wrong plan' })).status).toBe(200);
    expect(await priceNow(h)).toBe('$0.08/1M input, $0.32/1M output tokens');
  });

  it('refuses a malformed proposal and unknown ids', async () => {
    const h = await gateway();
    expect((await h.api('post', '/api/ai/registry/pricing/proposals', {})).status).toBe(400);
    expect((await h.api('post', '/api/ai/registry/pricing/proposals', { entries: [] })).status).toBe(400);
    expect((await h.api('get', '/api/ai/registry/pricing/proposals/nope')).status).toBe(404);
    expect((await h.api('post', '/api/ai/registry/pricing/proposals/nope/approve', {})).status).toBe(404);
  });

  it('checking the official sources is an explicit request, records the result and changes no price', async () => {
    const h = await gateway({ fetchImpl: async () => new Response('<html><body>pricing text</body></html>', { status: 200 }) });
    expect(h.calls).toHaveLength(0); // starting the gateway fetched nothing
    const res = await h.api('post', '/api/ai/registry/pricing/check', { providerIds: ['groq'], force: true });
    expect(res.status).toBe(200);
    expect(res.body.checks[0]).toMatchObject({ providerId: 'groq', ok: true, url: 'https://groq.com/pricing' });
    expect(h.calls.map((c) => c.url)).toEqual(['https://groq.com/pricing']);
    expect(res.body.registry.pricing.sources.find((s: any) => s.providerId === 'groq').check.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.registry.pricing.proposals).toEqual([]);
  });
});

describe('startup with a damaged file', () => {
  async function startWith(file: string, content: string) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-bad-'));
    fs.mkdirSync(path.join(dir, 'registry'));
    fs.writeFileSync(path.join(dir, 'registry', file), content, 'utf8');
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem: new MockModemAdapter({ autoAnswerDelayMs: 60 }),
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: MASTER }), providers: createMockProviders({ stt: ['x'], llm: ['y'] }), allowSimulatedHardware: true, registryDir: path.join(dir, 'registry') },
    });
    cleanups.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { server, view: async () => (await request(server.app).get('/api/ai/registry').set('x-api-key', KEY)).body };
  }

  it('a damaged registry.json keeps the gateway and the AI running on the defaults and says what is wrong', async () => {
    const { server, view } = await startWith('registry.json', '{ nope');
    const v = await view();
    expect(v.load).toMatchObject({ ok: false, usingLastValid: true });
    expect(v.load.issues[0].message).toMatch(/not valid JSON/);
    expect(v.models.llm.length).toBeGreaterThan(10);
    expect(server.aiRuntime.config.errors).toEqual([]);
  });

  it('a damaged pricing.json leaves the models alone and the default prices in force', async () => {
    const { server, view } = await startWith('pricing.json', '{ nope');
    const v = await view();
    expect(v.load.ok).toBe(true);
    expect(findModel(v, 'llm', 'telnyx_kimi_k3').price.summary).toBe('$2.7/1M input, $13.5/1M output tokens');
    expect(server.aiRuntime.config.errors).toEqual([]);
  });
});
