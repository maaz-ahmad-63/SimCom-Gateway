import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { createProviders } from '../src/ai/providers/index.js';
import { createMockProviders } from '../src/ai/providers/mock.js';
import { resetActiveRegistry } from '../src/ai/registry/active.js';
import { createGatewayServer } from '../src/server.js';
import { aiEnv } from './ai/helpers.js';

/**
 * Inworld's chat model registered in the Model Hub and followed to the Language Model dropdown's data, the saved selection, a restart,
 * the runtime's provider / credential / endpoint / protocol / authentication, and the Hub's Test action. Everything here is mocked
 * (a fake provider fetch): it does not prove Inworld accepts the request. The real-provider result is reported separately.
 */
const KEY = 'inworld-llm-api-key-123456';
const INWORLD_KEY = 'inworld-test-credential-123456';
const MASTER = 'a-long-master-key-for-tests-only';
const MODEL_ID = 'inworld/models/gemma-4-31b-it';
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  resetActiveRegistry();
});

const GEMMA = {
  id: 'inworld_gemma_4_31b',
  stage: 'llm',
  provider: 'inworld',
  protocol: 'openai-chat',
  model: MODEL_ID,
  label: 'Inworld Gemma 4 31B',
  aliases: ['inworld_gemma_4_31b_it'],
  options: { body: {}, tools: false },
};
const env = (extra: Record<string, string | undefined> = {}) => aiEnv({ AI_SECRETS_MASTER_KEY: MASTER, AI_LLM: 'groq_qwen_3_8_27b', INWORLD_API_KEY: INWORLD_KEY, ...extra });
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function boot(dir: string, opts: { env?: Record<string, string | undefined>; fetchImpl?: Fetch } = {}) {
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 60 });
  const calls: Array<{ url: string; auth: string; body: any }> = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''), body: init?.body ? JSON.parse(String(init.body)) : null });
    return opts.fetchImpl ? opts.fetchImpl(url, init) : new Response('{}', { status: 200 });
  };
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: { env: env(opts.env), providers: createMockProviders({ stt: ['hello'], llm: ['hi'] }), fetchImpl, allowSimulatedHardware: true, registryDir: path.join(dir, 'registry') },
  });
  await modem.initialize();
  closers.push(async () => void (await server.close()));
  const api = (m: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const r = request(server.app)[m](url).set('x-api-key', KEY);
    return body ? r.send(body) : r;
  };
  return { server, api, calls, close: server.close.bind(server) };
}
const sse = (text: string) => new Response(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\ndata: [DONE]\n\n`, { status: 200 });
const llmOption = (catalog: any, key: string) => catalog.llm.find((m: any) => m.key === key);
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inworld-llm-'));
  dirs.push(dir);
  return dir;
};

describe('Inworld Gemma 4 31B in the Model Hub', () => {
  it('appears in the catalog, is selected and saved by its registry id, survives a restart, and runs with Basic authentication at Inworld’s base URL', async () => {
    const dir = tmp();
    const first = await boot(dir);

    const before = (await first.api('get', '/api/ai/catalog')).body;
    expect(before.llm.some((m: any) => m.provider === 'inworld')).toBe(false);
    expect(llmOption(before, 'groq_qwen_3_8_27b')).toMatchObject({ implemented: true });
    expect(llmOption(before, 'telnyx_kimi_k3')).toMatchObject({ implemented: true });
    const revisionBefore = (await first.api('get', '/api/ai/state')).body.catalogRevision;

    // provider + protocol + model id: no endpoint on the model, the credential is the provider's
    const created = await first.api('post', '/api/ai/registry/models', GEMMA);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.registry.models.llm.find((m: any) => m.id === 'inworld_gemma_4_31b')).toMatchObject({
      provider: 'inworld',
      protocol: 'openai-chat',
      model: MODEL_ID,
      resolved: { implemented: true, protocol: 'openai-chat', endpoint: 'https://api.inworld.ai/v1', endpointIsDefault: false, credential: { name: 'INWORLD_API_KEY', state: 'env' } },
    });
    expect((await first.api('get', '/api/ai/state')).body.catalogRevision).not.toBe(revisionBefore);

    const catalog = (await first.api('get', '/api/ai/catalog')).body;
    expect(llmOption(catalog, 'inworld_gemma_4_31b')).toMatchObject({ label: 'Inworld Gemma 4 31B', provider: 'inworld', model: MODEL_ID, implemented: true });
    expect(llmOption(catalog, 'groq_qwen_3_8_27b')).toBeDefined();
    expect(llmOption(catalog, 'telnyx_kimi_k3')).toBeDefined();
    expect((await first.api('get', '/api/ai/settings')).body.llm).toBe('groq_qwen_3_8_27b'); // adding a model changes no selection

    expect((await first.api('put', '/api/ai/settings', { llm: 'inworld_gemma_4_31b' })).status).toBe(200);
    expect((await first.api('get', '/api/ai/settings')).body.llm).toBe('inworld_gemma_4_31b');

    const config = first.server.aiRuntime.config;
    expect(config.errors).toEqual([]);
    expect(config.config.llm.key).toBe('inworld_gemma_4_31b');
    expect(config.config.llm.spec).toMatchObject({ provider: 'inworld', baseUrl: 'https://api.inworld.ai/v1', apiKeyEnv: 'INWORLD_API_KEY', model: MODEL_ID, authScheme: 'basic', toolCalling: false });

    // the client a call uses: POST {base}/chat/completions with "Authorization: Basic <credential>" (not Bearer)
    const seen: Array<{ url: string; auth: string; body: any }> = [];
    const fetchImpl: Fetch = async (url, init) => {
      seen.push({ url, auth: String((init!.headers as Record<string, string>).Authorization), body: JSON.parse(String(init!.body)) });
      return sse('hi');
    };
    const providers = createProviders(config.config, { env: env(), fetchImpl, only: 'llm' });
    expect(providers.llm.name).toBe('inworld');
    const out: string[] = [];
    for await (const c of providers.llm.stream({ system: 's', messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal)) if (c.delta) out.push(c.delta);
    expect(out.join('')).toBe('hi');
    expect(seen[0].url).toBe('https://api.inworld.ai/v1/chat/completions');
    expect(seen[0].auth).toBe(`Basic ${INWORLD_KEY}`);
    expect(seen[0].auth).not.toMatch(/^Bearer/);
    expect(seen[0].body).toMatchObject({ model: MODEL_ID, stream: true });

    // restart: the same folders still give the model, the selection and the same runtime
    await first.close();
    const second = await boot(dir);
    expect(llmOption((await second.api('get', '/api/ai/catalog')).body, 'inworld_gemma_4_31b')).toMatchObject({ implemented: true, provider: 'inworld' });
    expect((await second.api('get', '/api/ai/settings')).body.llm).toBe('inworld_gemma_4_31b');
    expect(second.server.aiRuntime.config.config.llm.spec).toMatchObject({ provider: 'inworld', baseUrl: 'https://api.inworld.ai/v1', model: MODEL_ID, authScheme: 'basic' });
    expect(second.server.aiRuntime.config.errors).toEqual([]);
  });

  it('a selection saved under the old id still resolves, and the settings then report the registry id', async () => {
    const dir = tmp();
    const h = await boot(dir);
    await h.api('post', '/api/ai/registry/models', GEMMA);
    expect((await h.api('put', '/api/ai/settings', { llm: 'inworld_gemma_4_31b_it' })).status).toBe(200);
    expect(h.server.aiRuntime.config.errors).toEqual([]);
    expect(h.server.aiRuntime.config.config.llm.key).toBe('inworld_gemma_4_31b');
    expect((await h.api('get', '/api/ai/settings')).body.llm).toBe('inworld_gemma_4_31b'); // the dropdown selects the canonical option
  });

  it('Groq and Telnyx keep Bearer authentication, and their selections still save and resolve', async () => {
    const dir = tmp();
    const h = await boot(dir);
    await h.api('post', '/api/ai/registry/models', GEMMA);
    const expected: Record<string, { provider: string; baseUrl: string; apiKeyEnv: string; toolCalling: boolean; authScheme?: string }> = {
      telnyx_kimi_k3: { provider: 'telnyx', baseUrl: 'https://api.telnyx.com/v2/ai/openai', apiKeyEnv: 'TELNYX_API_KEY', toolCalling: false },
      inworld_gemma_4_31b: { provider: 'inworld', baseUrl: 'https://api.inworld.ai/v1', apiKeyEnv: 'INWORLD_API_KEY', toolCalling: false, authScheme: 'basic' },
      groq_qwen_3_8_27b: { provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', toolCalling: true },
    };
    for (const key of ['telnyx_kimi_k3', 'inworld_gemma_4_31b', 'groq_qwen_3_8_27b']) {
      expect((await h.api('put', '/api/ai/settings', { llm: key })).status, key).toBe(200);
      expect((await h.api('get', '/api/ai/settings')).body.llm).toBe(key);
      expect(h.server.aiRuntime.config.errors, key).toEqual([]);
      const spec = h.server.aiRuntime.config.config.llm.spec!;
      expect(spec, key).toMatchObject(expected[key]);
      if (!expected[key].authScheme) expect('authScheme' in spec, `${key} sends the default Bearer`).toBe(false);
    }
  });

  it('with the Inworld credential missing, selecting the model reports the variable by name and nothing else changes', async () => {
    const dir = tmp();
    const h = await boot(dir, { env: { INWORLD_API_KEY: undefined } });
    await h.api('post', '/api/ai/registry/models', GEMMA);
    expect((await h.api('get', '/api/ai/registry')).body.models.llm.find((m: any) => m.id === 'inworld_gemma_4_31b').resolved.credential).toEqual({ name: 'INWORLD_API_KEY', state: 'missing' });
    await h.api('put', '/api/ai/settings', { llm: 'inworld_gemma_4_31b' });
    expect(h.server.aiRuntime.config.errors).toContain('INWORLD_API_KEY is required by the selected providers but is not set');
  });

  it('the catalog revision changes when the registry changes and only then', async () => {
    const dir = tmp();
    const h = await boot(dir);
    const revision = async () => (await h.api('get', '/api/ai/state')).body.catalogRevision as number;
    const r0 = await revision();
    expect(await revision()).toBe(r0);
    await h.api('put', '/api/ai/settings', { llm: 'telnyx_kimi_k3' });
    expect(await revision()).toBe(r0);
    await h.api('post', '/api/ai/registry/models', GEMMA);
    const r1 = await revision();
    expect(r1).not.toBe(r0);
    await h.api('patch', '/api/ai/registry/models/llm/inworld_gemma_4_31b', { enabled: false });
    expect(await revision()).not.toBe(r1);
    expect(llmOption((await h.api('get', '/api/ai/catalog')).body, 'inworld_gemma_4_31b')).toMatchObject({ implemented: false, unavailableReason: 'Switched off in the model registry' });
  });

  it('the Inworld provider’s chat settings (base URL, Basic) do not change where, or how, Inworld text-to-speech connects', async () => {
    const dir = tmp();
    const h = await boot(dir);
    const view = (await h.api('get', '/api/ai/registry')).body;
    expect(view.providers.find((p: any) => p.id === 'inworld')).toMatchObject({ baseUrl: 'https://api.inworld.ai/v1', authScheme: 'basic' });
    expect(view.models.tts.find((m: any) => m.id === 'inworld').resolved).toMatchObject({ protocol: 'inworld-tts', endpoint: 'https://api.inworld.ai/tts/v1/voice:stream', endpointIsDefault: true });
  });
});

describe('the Model Hub’s Test action runs the selected model', () => {
  it('asks for confirmation first: without it nothing is sent to the provider', async () => {
    const h = await boot(tmp());
    await h.api('post', '/api/ai/registry/models', GEMMA);
    const res = await h.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/billed.*confirmBilling/);
    expect(h.calls).toHaveLength(0);
  });

  it('sends one short real chat request to the selected model (Basic, the model id, a small limit, streaming) and reports status and timings', async () => {
    const h = await boot(tmp(), { fetchImpl: async () => sse('OK') });
    await h.api('post', '/api/ai/registry/models', GEMMA);
    const res = await h.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', { confirmBilling: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'ok', request: { httpStatus: 200, replyChars: 2 } });
    expect(res.body.request.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(res.body.request.totalMs).toBeGreaterThanOrEqual(res.body.request.firstTokenMs);
    expect(res.body.detail).toMatch(/answered HTTP 200 for 'inworld\/models\/gemma-4-31b-it': first token \d+ ms, complete in \d+ ms/);
    expect(h.calls).toHaveLength(1); // not a model listing, and exactly one request (no retry)
    expect(h.calls[0].url).toBe('https://api.inworld.ai/v1/chat/completions');
    expect(h.calls[0].auth).toBe(`Basic ${INWORLD_KEY}`);
    expect(h.calls[0].body).toMatchObject({ model: MODEL_ID, stream: true, max_tokens: 16 });
    expect(JSON.stringify(res.body)).not.toContain(INWORLD_KEY);
  });

  it('reports a rejected key, a refused model and an unreachable provider differently, and never leaks the key', async () => {
    const rejected = await boot(tmp(), { fetchImpl: async () => new Response(`bad credential ${INWORLD_KEY}`, { status: 401 }) });
    await rejected.api('post', '/api/ai/registry/models', GEMMA);
    const r1 = await rejected.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', { confirmBilling: true });
    expect(r1.body).toMatchObject({ ok: false, status: 'invalid-credential', request: { httpStatus: 401 } });
    expect(JSON.stringify(r1.body)).not.toContain(INWORLD_KEY);

    const refused = await boot(tmp(), { fetchImpl: async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }) });
    await refused.api('post', '/api/ai/registry/models', GEMMA);
    expect((await refused.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', { confirmBilling: true })).body).toMatchObject({ ok: false, status: 'model-rejected', request: { httpStatus: 404 } });
    expect(refused.calls).toHaveLength(1); // a refusal is not retried

    const down = await boot(tmp(), {
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await down.api('post', '/api/ai/registry/models', GEMMA);
    expect((await down.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', { confirmBilling: true })).body).toMatchObject({ ok: false, status: 'unreachable' });
  });

  it('a reply with no text is a failure, not a pass; a missing credential makes no request', async () => {
    const empty = await boot(tmp(), { fetchImpl: async () => new Response('data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\n', { status: 200 }) });
    await empty.api('post', '/api/ai/registry/models', GEMMA);
    expect((await empty.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', { confirmBilling: true })).body).toMatchObject({ ok: false, status: 'model-rejected' });
    const none = await boot(tmp(), { env: { INWORLD_API_KEY: undefined } });
    await none.api('post', '/api/ai/registry/models', GEMMA);
    expect((await none.api('post', '/api/ai/registry/test/model/llm/inworld_gemma_4_31b', { confirmBilling: true })).body).toMatchObject({ ok: false, status: 'no-credential' });
    expect(none.calls).toHaveLength(0);
  });

  it('the connection test of the provider (read-only) uses Basic too, and speech models are still tested without generating anything', async () => {
    const h = await boot(tmp(), { fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: MODEL_ID }] }), { status: 200 }) });
    expect((await h.api('post', '/api/ai/registry/test/provider/inworld')).body).toMatchObject({ ok: true });
    expect(h.calls.at(-1)!.url).toMatch(/^https:\/\/api\.inworld\.ai\//);
    const stt = await h.api('post', '/api/ai/registry/test/model/stt/nova-3');
    expect(stt.status).toBe(200); // no billing confirmation needed: nothing is generated
  });
});
