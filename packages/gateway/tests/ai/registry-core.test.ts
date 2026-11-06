import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/ai/catalog-view.js';
import { INWORLD_TTS_URL, LLM_CATALOG, STT_CATALOG, TTS_CATALOG } from '../../src/ai/catalog.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { activeRegistry, resetActiveRegistry } from '../../src/ai/registry/active.js';
import { PROTOCOLS } from '../../src/ai/registry/protocols.js';
import { RegistryStore } from '../../src/ai/registry/store.js';
import { AiSettingsService, credentialProviders } from '../../src/ai/settings.js';
import { aiEnv, FORMAT_8K } from './helpers.js';
import { MemoryBackend } from './sheets-helpers.js';

/**
 * The simplified registry: one provider list, one flat model list, protocols described in one place. Everything here is mocked
 * (fake fetch, fake WebSocket): it proves the configuration, routing and request shape, not that any real account works.
 */
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'registry2-'));
  dirs.push(d);
  return d;
};
beforeEach(() => resetActiveRegistry());
afterEach(() => {
  resetActiveRegistry();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const memory = (selection?: () => { llm: string; stt: string; tts: string; voice: string } | null) => {
  const store = new RegistryStore({ dir: null, selection });
  store.load();
  return store;
};
const text = (r: { issues: Array<{ path: string; message: string }> }) => r.issues.map((i) => `${i.path}: ${i.message}`).join(' | ');
const signal = () => new AbortController().signal;

const llm = (over: Record<string, unknown> = {}) => ({ id: 'groq_llama_4_scout', stage: 'llm', provider: 'groq', protocol: 'openai-chat', model: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Groq Llama 4 Scout', options: { body: { temperature: 0.5 } }, ...over });
const together = { id: 'together', name: 'Together AI', credential: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1' };
const togetherModel = (over: Record<string, unknown> = {}) => ({ id: 'together_llama', stage: 'llm', provider: 'together', protocol: 'openai-chat', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Together Llama', ...over });

describe('the default registry is the original catalog, as one provider list and one flat model list', () => {
  it('has a provider list and a flat model list; nothing is written until something is changed', () => {
    const dir = tmp();
    const store = new RegistryStore({ dir });
    expect(store.load().ok).toBe(true);
    expect(store.registry.file.models.filter((m) => m.stage === 'llm')).toHaveLength(Object.keys(LLM_CATALOG).length + 1 /* + the seeded Inworld Router model */);
    expect(store.registry.file.models.filter((m) => m.stage === 'stt')).toHaveLength(Object.keys(STT_CATALOG).length);
    expect(store.registry.file.models.filter((m) => m.stage === 'tts')).toHaveLength(Object.keys(TTS_CATALOG).length);
    expect(fs.readdirSync(dir)).toEqual([]); // no file at startup
    expect(store.upsertModel(llm()).ok).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['.last-valid', 'registry.json']);
  });

  it('the existing default selections still resolve: the shipped defaults, and the models in use on this machine', () => {
    const shipped = loadAiConfig(aiEnv({}));
    expect(shipped.errors).toEqual([]);
    expect([shipped.config.llm.key, shipped.config.stt.key, shipped.config.tts.key]).toEqual(['groq_qwen_3_8_27b', 'nova-3', 'cartesia']);
    const env = aiEnv({ AI_LLM: 'telnyx_kimi_k3', AI_STT: 'stt-rt-v5', AI_TTS: 'inworld', INWORLD_API_KEY: 'inworld-key-123456', SONIOX_API_KEY: 'soniox-key-123456', AI_AUDIO_SAMPLE_RATE: '8000' });
    const result = loadAiConfig(env);
    expect(result.errors).toEqual([]);
    expect(result.config.llm.spec).toMatchObject({ provider: 'telnyx', baseUrl: 'https://api.telnyx.com/v2/ai/openai', model: 'moonshotai/Kimi-K3', toolCalling: false });
    const providers = createProviders(result.config, { env });
    expect([providers.stt.name, providers.llm.name, providers.tts.name]).toEqual(['soniox', 'telnyx', 'inworld']);
    // an alias still works
    expect(loadAiConfig(aiEnv({ AI_LLM: 'kimi-k3' })).config.llm.key).toBe('telnyx_kimi_k3');
  });
});

describe('validation: strict, with messages that say what to do', () => {
  it('rejects unknown fields, bad ids, secret-looking values and credential values pasted where a variable name belongs', () => {
    const store = memory();
    expect(text(store.upsertModel(llm({ apiKey: 'x' })))).toMatch(/Unrecognized key/);
    expect(text(store.upsertModel(llm({ id: 'Bad Id' })))).toMatch(/lowercase/);
    expect(text(store.upsertModel(llm({ label: 'sk-abcdefghijklmnopqrstuvwxyz123456' })))).toMatch(/secret/);
    expect(text(store.upsertProvider({ ...together, credential: 'together_key' }))).toMatch(/variable name/);
    expect(text(store.upsertProvider({ ...together, credential: 'sk-abcdefghijklmnopqrstuvwxyz123456' }))).toMatch(/secret|variable name/);
    expect(text(store.upsertProvider({ ...together, credential: 'TOGETHER_PASSWORD' }))).toMatch(/_API_KEY or _API_TOKEN/);
    expect(store.registry.provider('together')).toBeUndefined();
  });

  it('an unknown or misnamed protocol lists the protocols that exist, and says new wire formats need code', () => {
    const store = memory();
    const wrongName = text(store.upsertModel({ id: 'inw', stage: 'tts', provider: 'inworld', protocol: 'inworld', model: 'inworld-tts-2', label: 'Inworld', options: { voice: 'Sarah', sampleRates: [8000] } }));
    expect(wrongName).toMatch(/no protocol 'inworld'.*tts protocols:.*inworld-tts/);
    expect(wrongName).toMatch(/needs a protocol added to the gateway's code/);
    expect(text(store.upsertModel({ id: 'inw', stage: 'llm', provider: 'inworld', protocol: 'inworld-tts', model: 'x', label: 'x' }))).toMatch(/'inworld-tts' is a tts protocol, not llm/);
  });

  it('rejects dangling providers, an OpenAI-compatible model with nowhere to connect, a wrong scheme and private addresses', () => {
    const store = memory();
    expect(text(store.upsertModel(llm({ provider: 'nobody' })))).toMatch(/unknown provider/);
    store.upsertProvider({ id: 'nobase', name: 'No base', credential: 'NOBASE_API_KEY' });
    expect(text(store.upsertModel(llm({ id: 'nb', provider: 'nobase' })))).toMatch(/needs a base URL: set baseUrl on provider 'nobase' or endpoint on this model/);
    expect(text(store.upsertProvider({ ...together, baseUrl: 'http://api.example.com/v1' }))).toMatch(/https URL/);
    expect(text(store.upsertProvider({ ...together, baseUrl: 'https://192.168.1.20/v1' }))).toMatch(/local or private/);
    expect(text(store.upsertModel(llm({ endpoint: 'https://localhost:8080/v1' })))).toMatch(/local or private/);
    expect(text(store.upsertModel({ id: 'sx', stage: 'stt', provider: 'soniox', protocol: 'soniox-stt', model: 'stt-rt-v5', label: 'x', endpoint: 'https://stt.example.com/ws' }))).toMatch(/connects over wss/);
  });

  it('checks each protocol’s own settings, names the duplicate or conflicting id, and needs a reason for an unavailable model', () => {
    const store = memory();
    expect(text(store.upsertModel({ id: 'd1', stage: 'tts', provider: 'deepgram', protocol: 'deepgram-tts', model: null, label: 'x', options: { voice: 'aura-asteria-en', sampleRates: [8000], models: ['m'] } }))).toMatch(/Unrecognized key.*models/);
    expect(text(store.upsertModel({ id: 'i1', stage: 'tts', provider: 'inworld', protocol: 'inworld-tts', model: 'm', label: 'x', options: { voice: 'Sarah', sampleRates: [] } }))).toMatch(/sample rates/);
    expect(text(store.upsertModel(llm({ aliases: ['kimi-k3'] })))).toMatch(/already used by 'telnyx_kimi_k3'/);
    expect(text(store.upsertModel({ id: 'u1', stage: 'llm', provider: 'groq', protocol: null, model: null, label: 'x' }))).toMatch(/must say why/);
    expect(text(store.upsertModel(llm({ options: { body: {}, temperatur: 1 } })))).toMatch(/Unrecognized key/);
  });
});

describe('adding a model to an existing provider is configuration only', () => {
  it('an LLM on Groq: selectable by id and alias, in the catalog, built by createProviders with Groq’s endpoint and key', () => {
    const store = memory();
    expect(store.upsertModel(llm({ aliases: ['llama4-scout'] })).ok).toBe(true);
    const env = aiEnv({ AI_LLM: 'llama4-scout' });
    const result = loadAiConfig(env);
    expect(result.errors).toEqual([]);
    expect(result.config.llm.spec).toMatchObject({ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', model: 'meta-llama/llama-4-scout-17b-16e-instruct', body: { temperature: 0.5 }, toolCalling: true });
    expect(buildCatalog({}).llm.find((m) => m.key === 'groq_llama_4_scout')).toMatchObject({ implemented: true, provider: 'groq' });
    expect(createProviders(result.config, { env }).llm.name).toBe('groq');
  });

  it('an STT model on Deepgram and a second TTS model on Inworld, with the TTS model list and sample rates of its own', () => {
    const store = memory();
    expect(store.upsertModel({ id: 'nova-3-medical', stage: 'stt', provider: 'deepgram', protocol: 'deepgram-listen', model: 'nova-3-medical', label: 'Nova-3 Medical' }).ok).toBe(true);
    expect(store.upsertModel({ id: 'inworld_max', stage: 'tts', provider: 'inworld', protocol: 'inworld-tts', model: 'inworld-tts-1.5-max', label: 'Inworld Max', options: { voice: 'Sarah', models: ['inworld-tts-1.5-mini'], sampleRates: [8000, 16000] } }).ok).toBe(true);
    const env = aiEnv({ AI_STT: 'nova-3-medical', AI_TTS: 'inworld_max', AI_TTS_MODEL: 'inworld-tts-1.5-mini', INWORLD_API_KEY: 'inworld-key-123456', AI_AUDIO_SAMPLE_RATE: '8000' });
    const result = loadAiConfig(env);
    expect(result.errors).toEqual([]);
    expect(result.config.stt.entry).toMatchObject({ model: 'nova-3-medical', protocol: 'deepgram-listen', provider: 'deepgram' });
    expect(result.config.tts.model).toBe('inworld-tts-1.5-mini');
    const providers = createProviders(result.config, { env });
    expect([providers.stt.name, providers.tts.name]).toEqual(['deepgram', 'inworld']);
    expect(loadAiConfig(aiEnv({ AI_TTS: 'inworld_max', AI_AUDIO_SAMPLE_RATE: '24000' })).errors.join('|')).toMatch(/not a raw rate Inworld supports \(8000, 16000\)/);
    expect(loadAiConfig(aiEnv({ AI_TTS: 'inworld_max', AI_TTS_MODEL: 'other' })).errors.join('|')).toMatch(/is not a model of 'inworld_max' \(supported: inworld-tts-1.5-max, inworld-tts-1.5-mini\)/);
  });

  it('a provider with a custom OpenAI-compatible endpoint needs only a base URL and a credential name', async () => {
    const store = memory();
    expect(store.upsertProvider(together).ok).toBe(true);
    expect(store.upsertModel(togetherModel()).ok).toBe(true);
    const env = aiEnv({ AI_LLM: 'together_llama', TOGETHER_API_KEY: 'together-key-123456' });
    const result = loadAiConfig(env);
    expect(result.errors).toEqual([]);
    expect(result.config.requiredKeyEnv).toContain('TOGETHER_API_KEY');
    const requests: Array<{ url: string; auth: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, auth: (init!.headers as Record<string, string>).Authorization });
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    };
    const providers = createProviders(result.config, { env, fetchImpl });
    expect(providers.llm.name).toBe('together');
    const chunks: string[] = [];
    for await (const c of providers.llm.stream({ system: 's', messages: [{ role: 'user', content: 'hello' }] }, signal())) if (c.delta) chunks.push(c.delta);
    expect(chunks.join('')).toBe('hi');
    expect(requests[0].url).toBe('https://api.together.xyz/v1/chat/completions');
    expect(requests[0].auth).toBe('Bearer together-key-123456');
  });

  it('a model of its own can point at a different endpoint than its provider', () => {
    const store = memory();
    store.upsertProvider(together);
    store.upsertModel(togetherModel({ endpoint: 'https://eu.api.together.xyz/v1' }));
    expect(loadAiConfig(aiEnv({ AI_LLM: 'together_llama', TOGETHER_API_KEY: 'together-key-123456' })).config.llm.spec?.baseUrl).toBe('https://eu.api.together.xyz/v1');
  });
});

describe('endpoint overrides reach every adapter', () => {
  const OVERRIDE = 'override.example.com';
  const keys = { INWORLD_API_KEY: 'inworld-key-123456', SONIOX_API_KEY: 'soniox-key-123456', ELEVENLABS_API_KEY: 'eleven-key-123456', MURF_API_KEY: 'murf-key-123456' };

  async function urlOf(stage: 'stt' | 'tts', entry: Record<string, unknown>): Promise<string> {
    const store = memory();
    const added = store.upsertModel(entry);
    expect(added.ok, text(added)).toBe(true);
    const env = aiEnv({ ...keys, [stage === 'stt' ? 'AI_STT' : 'AI_TTS']: entry.id as string, AI_AUDIO_SAMPLE_RATE: '8000' });
    const config = loadAiConfig(env);
    expect(config.errors, entry.id as string).toEqual([]);
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response('no', { status: 400 }); // a refusal that is not retried: only the URL matters here
    };
    const webSocketFactory = (url: string) => {
      seen.push(url);
      throw new Error('stop');
    };
    const providers = createProviders(config.config, { env, fetchImpl, webSocketFactory, only: stage });
    await (stage === 'stt' ? providers.stt.transcribe(Buffer.alloc(16000), FORMAT_8K, signal()) : providers.tts.synthesize('hello', FORMAT_8K, signal())).catch(() => undefined);
    return seen[0];
  }

  const stt = (id: string, provider: string, protocol: string, endpoint: string | null, model: string | null = 'm') => ({ id, stage: 'stt', provider, protocol, model, label: id, options: {}, ...(endpoint ? { endpoint } : {}) });
  // Deepgram and ElevenLabs check the shape of the voice, so each gets one of its own kind.
  const VOICE: Record<string, string> = { 'deepgram-tts': 'aura-asteria-en', 'elevenlabs-tts': 'cgSgspJ2msm6clMCkdW9' };
  const tts = (id: string, provider: string, protocol: string, endpoint: string | null) => ({ id, stage: 'tts', provider, protocol, model: protocol === 'deepgram-tts' ? null : 'm', label: id, options: { voice: VOICE[protocol] ?? 'v', sampleRates: [8000, 16000] }, ...(endpoint ? { endpoint } : {}) });

  it.each([
    ['deepgram-listen', 'deepgram', `https://${OVERRIDE}/v1/listen`],
    ['groq-whisper', 'groq', `https://${OVERRIDE}/transcribe`],
    ['cartesia-stt', 'cartesia', `https://${OVERRIDE}/stt`],
    ['soniox-stt', 'soniox', `wss://${OVERRIDE}/ws`],
    ['deepgram-flux', 'deepgram-flux', `wss://${OVERRIDE}/v2/listen`],
  ])('speech-to-text %s connects to the model’s endpoint', async (protocol, provider, endpoint) => {
    const url = await urlOf('stt', stt(`s_${protocol}`, provider, protocol, endpoint));
    expect(url.startsWith(endpoint)).toBe(true);
  });

  it.each([
    ['inworld-tts', 'inworld', `https://${OVERRIDE}/tts`],
    ['cartesia-tts', 'cartesia', `https://${OVERRIDE}/tts/bytes`],
    ['deepgram-tts', 'deepgram', `https://${OVERRIDE}/v1/speak`],
    ['elevenlabs-tts', 'elevenlabs', `https://${OVERRIDE}`],
    ['murf-tts', 'murf', `https://${OVERRIDE}/speech`],
    ['soniox-tts', 'soniox', `https://${OVERRIDE}/tts`],
  ])('text-to-speech %s connects to the model’s endpoint', async (protocol, provider, endpoint) => {
    const url = await urlOf('tts', tts(`t_${protocol}`, provider, protocol, endpoint));
    expect(url.startsWith(endpoint)).toBe(true);
  });

  it('with no endpoint set, each adapter keeps its own default', async () => {
    expect(await urlOf('tts', tts('t_inworld_default', 'inworld', 'inworld-tts', null))).toBe(INWORLD_TTS_URL);
    expect(await urlOf('tts', tts('t_cartesia_default', 'cartesia', 'cartesia-tts', null))).toBe('https://api.cartesia.ai/tts/bytes');
    expect(await urlOf('stt', stt('s_groq_default', 'groq', 'groq-whisper', null))).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('every protocol is described once, with a stage, an endpoint rule and a read-only check', () => {
    expect(new Set(PROTOCOLS.map((p) => p.id)).size).toBe(PROTOCOLS.length);
    for (const p of PROTOCOLS) {
      expect(['llm', 'stt', 'tts']).toContain(p.stage);
      expect(['base', 'full']).toContain(p.endpoint.kind);
      expect(p.probe({ endpoint: 'https://x.example.com/v1', key: 'k' })).not.toBeUndefined();
    }
    for (const entry of activeRegistry().file.models) if (entry.protocol) expect(PROTOCOLS.some((p) => p.id === entry.protocol && p.stage === entry.stage), entry.id).toBe(true);
  });
});

describe('Inworld text-to-speech', () => {
  const inworldCall = async (extra: Record<string, string> = {}, entry?: Record<string, unknown>) => {
    const store = memory();
    if (entry) expect(store.upsertModel(entry).ok).toBe(true);
    const env = aiEnv({ AI_TTS: (entry?.id as string) ?? 'inworld', INWORLD_API_KEY: 'inworld-key-123456', AI_AUDIO_SAMPLE_RATE: '8000', ...extra });
    const cfg = loadAiConfig(env);
    expect(cfg.errors).toEqual([]);
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const line = JSON.stringify({ result: { audioContent: Buffer.alloc(1600, 3).toString('base64') } });
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      return new Response(`${line}\n`, { status: 200 });
    };
    const providers = createProviders(cfg.config, { env, fetchImpl, only: 'tts' });
    const audio = await providers.tts.synthesize('Hello.', FORMAT_8K, signal());
    return { seen, audio, cfg };
  };

  it('is registered in the defaults as provider "inworld" and protocol "inworld-tts", with its own model, voice and sample rates', () => {
    const reg = activeRegistry();
    expect(reg.provider('inworld')).toMatchObject({ credential: 'INWORLD_API_KEY' });
    expect(reg.tts('inworld')).toMatchObject({ protocol: 'inworld-tts', vendor: 'inworld', model: 'inworld-tts-2', defaultVoice: 'Sarah', implemented: true, keyEnv: 'INWORLD_API_KEY' });
    expect(reg.tts('inworld')!.sampleRates).toContain(8000);
  });

  it('speaks the Inworld protocol with the voice, model, rate and key from the registry and the environment variable it names', async () => {
    const { seen, audio } = await inworldCall({ AI_TTS_VOICE: 'Ashley' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(INWORLD_TTS_URL);
    expect(seen[0].headers.Authorization).toBe('Basic inworld-key-123456');
    expect(seen[0].body).toEqual({ text: 'Hello.', voiceId: 'Ashley', modelId: 'inworld-tts-2', audioConfig: { audioEncoding: 'PCM', sampleRateHertz: 8000 } });
    expect(audio.length).toBe(1600);
  });

  it('a second Inworld model (a different model id, voice and endpoint) is one entry, no code', async () => {
    const { seen } = await inworldCall({}, { id: 'inworld_eu', stage: 'tts', provider: 'inworld', protocol: 'inworld-tts', model: 'inworld-tts-1.5-max', label: 'Inworld EU', endpoint: 'https://eu.inworld.example.com/tts/v1/voice:stream', options: { voice: 'Dennis', sampleRates: [8000, 16000] } });
    expect(seen[0].url).toBe('https://eu.inworld.example.com/tts/v1/voice:stream');
    expect(seen[0].body).toMatchObject({ voiceId: 'Dennis', modelId: 'inworld-tts-1.5-max' });
  });

  it('the registry JSON names the credential variable and never holds its value', () => {
    const store = memory();
    const exported = JSON.stringify(store.exportDocument());
    expect(exported).toContain('INWORLD_API_KEY');
    expect(exported).not.toMatch(/inworld-key|Basic |sk-/);
  });
});

describe('credential resolution', () => {
  const MASTER = 'a-long-master-key-for-tests-only';

  it('a provider names an environment variable; the key is read from it at construction and a missing one is reported by name only', () => {
    const store = memory();
    store.upsertProvider(together);
    store.upsertModel(togetherModel());
    const env = aiEnv({ AI_LLM: 'together_llama' });
    const result = loadAiConfig(env);
    expect(result.errors).toContain('TOGETHER_API_KEY is required by the selected providers but is not set');
    expect(result.missingKeys).toEqual(['TOGETHER_API_KEY']);
    expect(() => createProviders(loadAiConfig({ ...env, TOGETHER_API_KEY: 'x'.repeat(12) }).config, { env })).toThrow(/TOGETHER_API_KEY is required by the selected providers but is not set/);
  });

  it('the encrypted store accepts the credential a provider names (and still nothing else), and a stored key beats the environment', () => {
    const backend = new MemoryBackend();
    const settings = new AiSettingsService(backend, aiEnv({ AI_SECRETS_MASTER_KEY: MASTER, AI_LLM: 'together_llama', TOGETHER_API_KEY: 'from-env-key-123456' }));
    expect(() => settings.setSecret('TOGETHER_API_KEY', 'stored-key-1234567890')).toThrow(/Unknown credential/); // no provider names it yet
    const store = memory();
    store.upsertProvider(together);
    store.upsertModel(togetherModel());
    expect(Object.keys(credentialProviders())).toContain('TOGETHER_API_KEY');
    settings.setSecret('TOGETHER_API_KEY', 'stored-key-1234567890');
    expect(() => settings.setSecret('RANDOM_THING_API_KEY', 'stored-key-1234567890')).toThrow(/Unknown credential/);
    expect(settings.effectiveEnv().TOGETHER_API_KEY).toBe('stored-key-1234567890');
    expect(settings.loadConfig().errors).toEqual([]);
    // what the database holds is ciphertext
    const blob = [...backend.values.values()].join('|');
    expect(blob).not.toContain('stored-key-1234567890');
    expect(settings.credentialStatuses([]).find((c) => c.name === 'TOGETHER_API_KEY')).toMatchObject({ source: 'stored', provider: 'Together AI' });
  });
});

describe('function calling', () => {
  it('is a per-model setting: on for Groq, OpenAI and Gemini, off for Telnyx until verified, and each can be changed for one model', () => {
    const store = memory();
    const tools = (key: string) => loadAiConfig(aiEnv({ AI_LLM: key })).config.llm.spec?.toolCalling;
    expect([tools('groq_qwen_3_8_27b'), tools('openai_gpt_5_4'), tools('gemini_3_flash'), tools('telnyx_kimi_k3')]).toEqual([true, true, true, false]);
    const kimi26 = store.registry.model('llm', 'telnyx_kimi_k2_6')!;
    expect(store.upsertModel({ ...kimi26, options: { ...kimi26.options, tools: true } }).ok).toBe(true);
    expect(tools('telnyx_kimi_k2_6')).toBe(true);
    expect(tools('telnyx_kimi_k3')).toBe(false);
    store.upsertModel(llm({ options: { body: {}, tools: false } }));
    const env = aiEnv({ AI_LLM: 'groq_llama_4_scout' });
    expect(createProviders(loadAiConfig(env).config, { env }).llm.supportsTools).toBe(false);
  });
});

describe('switching off, deleting, resetting and the model in use', () => {
  it('a switched-off model is an explicit configuration error and unselectable in the catalog', () => {
    const store = memory();
    expect(store.upsertModel({ ...store.registry.model('llm', 'groq_gpt_oss_20b')!, enabled: false }).ok).toBe(true);
    expect(loadAiConfig(aiEnv({ AI_LLM: 'groq_gpt_oss_20b' })).errors.join('|')).toMatch(/switched off in the model registry/);
    expect(buildCatalog({}).llm.find((m) => m.key === 'groq_gpt_oss_20b')).toMatchObject({ implemented: false, unavailableReason: 'Switched off in the model registry' });
    store.upsertProvider({ ...store.registry.provider('telnyx')!, enabled: false });
    expect(loadAiConfig(aiEnv({ AI_LLM: 'telnyx_kimi_k3' })).errors.join('|')).toMatch(/switched off/);
  });

  it('refuses to disable or remove what is in use right now, naming it', () => {
    const store = memory(() => ({ llm: 'groq_qwen_3_8_27b', stt: 'nova-3', tts: 'cartesia', voice: 'katie' }));
    const reg = store.registry;
    expect(text(store.upsertModel({ ...reg.model('llm', 'groq_qwen_3_8_27b')!, enabled: false }))).toMatch(/selected language model/);
    expect(text(store.upsertModel({ ...reg.model('stt', 'nova-3')!, enabled: false }))).toMatch(/selected speech-to-text/);
    expect(text(store.upsertModel({ ...reg.model('tts', 'cartesia')!, enabled: false }))).toMatch(/selected text-to-speech/);
    expect(text(store.upsertProvider({ ...reg.provider('groq')!, enabled: false }))).toMatch(/selected language model/);
    const cartesia = reg.model('tts', 'cartesia')!;
    const without = { ...cartesia, options: { ...cartesia.options, voices: (cartesia.options.voices as Array<{ name: string }>).filter((v) => v.name !== 'katie') } };
    expect(text(store.upsertModel(without))).toMatch(/voice 'katie' is in use/);
    expect(store.upsertModel({ ...reg.model('llm', 'groq_gpt_oss_20b')!, enabled: false }).ok).toBe(true);
  });

  it('default entries are never deleted, your own can be, and a changed default is reset or restored', () => {
    const store = memory();
    expect(text(store.removeModel('llm', 'telnyx_kimi_k3'))).toMatch(/defaults and cannot be deleted/);
    expect(text(store.removeProvider('groq'))).toMatch(/defaults and cannot be deleted/);
    store.upsertModel(llm());
    expect(store.removeModel('llm', 'groq_llama_4_scout').ok).toBe(true);
    expect(text(store.removeModel('llm', 'no_such'))).toMatch(/no llm model/);
    store.upsertModel({ ...store.registry.model('llm', 'telnyx_kimi_k3')!, label: 'My label' });
    expect(store.registry.modifiedModel('llm', 'telnyx_kimi_k3')).toBe(true);
    expect(store.restoreDefaults([{ kind: 'model', stage: 'llm', id: 'telnyx_kimi_k3' }]).ok).toBe(true);
    expect(store.registry.llm('telnyx_kimi_k3')!.label).toBe('telnyx kimi k3');
    expect(store.registry.modifiedModel('llm', 'telnyx_kimi_k3')).toBe(false);
  });

  it('defaults missing from a registry.json (for example models a newer gateway ships) can be added back without touching your own', () => {
    const dir = tmp();
    const first = new RegistryStore({ dir });
    first.load();
    first.upsertModel(llm());
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
    file.models = file.models.filter((m: { id: string }) => m.id !== 'groq_gpt_oss_20b');
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(file), 'utf8');
    const second = new RegistryStore({ dir });
    expect(second.load().ok).toBe(true);
    expect(second.registry.model('llm', 'groq_gpt_oss_20b')).toBeUndefined();
    expect(second.restoreDefaults().ok).toBe(true);
    expect(second.registry.model('llm', 'groq_gpt_oss_20b')).toBeDefined();
    expect(second.registry.model('llm', 'groq_llama_4_scout')).toBeDefined();
  });

  it('a registry that lacks the default model of a stage is rejected, since the gateway falls back to it', () => {
    const dir = tmp();
    const store = new RegistryStore({ dir });
    store.load();
    store.upsertModel(llm());
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
    file.models = file.models.filter((m: { id: string }) => m.id !== 'groq_qwen_3_8_27b');
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(file), 'utf8');
    const report = new RegistryStore({ dir }).load();
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.message).join(' ')).toMatch(/default llm model 'groq_qwen_3_8_27b' must stay/);
  });
});

describe('invalid JSON never replaces the last valid registry', () => {
  it('a corrupted file keeps the registry in use; at the next start the last good copy is restored', () => {
    const dir = tmp();
    const store = new RegistryStore({ dir });
    store.load();
    expect(store.upsertModel(llm()).ok).toBe(true);
    fs.writeFileSync(path.join(dir, 'registry.json'), '{ this is not json', 'utf8');
    const report = store.load();
    expect(report).toMatchObject({ ok: false, usingLastValid: true });
    expect(report.issues[0].message).toMatch(/not valid JSON/);
    expect(store.registry.model('llm', 'groq_llama_4_scout')).toBeDefined();
    const restarted = new RegistryStore({ dir });
    expect(restarted.load().ok).toBe(false);
    expect(restarted.registry.model('llm', 'groq_llama_4_scout')).toBeDefined(); // from .last-valid
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ schemaVersion: 2, providers: store.registry.file.providers, models: store.registry.file.models.map((m) => (m.id === 'groq_llama_4_scout' ? { ...m, label: 'Fixed' } : m)) }), 'utf8');
    expect(restarted.load().ok).toBe(true);
    expect(restarted.registry.llm('groq_llama_4_scout')!.label).toBe('Fixed');
  });

  it('a schema-invalid file is rejected as a whole, and a rejected change writes nothing', () => {
    const dir = tmp();
    const store = new RegistryStore({ dir });
    store.load();
    store.upsertModel(llm());
    const before = fs.readFileSync(path.join(dir, 'registry.json'), 'utf8');
    expect(store.upsertModel(llm({ provider: 'nobody' })).ok).toBe(false);
    expect(store.upsertProvider({ ...together, baseUrl: 'http://x' }).ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')).toBe(before);
    const doc = JSON.parse(before);
    doc.models[0].apiKey = 'nope';
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(doc), 'utf8');
    const report = new RegistryStore({ dir }).load();
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.message).join(' ')).toMatch(/Unrecognized key/);
  });

  it('a bad file at the very first start with no last good copy falls back to the defaults, which are the original catalog', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'registry.json'), 'nonsense', 'utf8');
    const store = new RegistryStore({ dir });
    expect(store.load().ok).toBe(false);
    expect(store.registry.llmKeys()).toHaveLength(Object.keys(LLM_CATALOG).length + 1 /* + the seeded Inworld Router model */);
    expect(loadAiConfig(aiEnv({})).errors).toEqual([]);
  });
});

describe('import and export', () => {
  it('an export imports into a fresh registry and reproduces it; an import adds or replaces by id and removes nothing', () => {
    const a = memory();
    a.upsertProvider(together);
    a.upsertModel(llm());
    const exported = JSON.parse(JSON.stringify(a.exportDocument()));
    const b = memory();
    expect(b.importDocument(exported).ok).toBe(true);
    expect(b.registry.file).toEqual(a.registry.file);
    expect(JSON.stringify(exported)).not.toMatch(/sk-|Bearer|private key/i);
    const c = memory();
    c.upsertModel(llm({ id: 'mine' }));
    expect(c.importDocument({ models: [llm()] }).ok).toBe(true);
    expect(c.registry.model('llm', 'mine')).toBeDefined();
    expect(c.registry.model('llm', 'groq_llama_4_scout')).toBeDefined();
  });

  it('an import with one invalid entry changes nothing', () => {
    const store = memory();
    const before = JSON.stringify(store.registry.file);
    const result = store.importDocument({ models: [llm(), llm({ id: 'second', provider: 'nobody' })] });
    expect(result.ok).toBe(false);
    expect(text(result)).toMatch(/unknown provider/);
    expect(JSON.stringify(store.registry.file)).toBe(before);
  });
});

describe('how an OpenAI-compatible API wants the key: Bearer (default) or Basic', () => {
  const sse = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
  async function headerFor(config: ReturnType<typeof loadAiConfig>['config'], env: Record<string, string | undefined>): Promise<string> {
    let auth = '';
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      auth = String((init!.headers as Record<string, string>).Authorization);
      return sse();
    };
    const providers = createProviders(config, { env, fetchImpl, only: 'llm' });
    for await (const c of providers.llm.stream({ system: 's', messages: [{ role: 'user', content: 'x' }] }, signal())) void c;
    return auth;
  }

  it('the setting is Bearer or Basic and nothing else', () => {
    const store = memory();
    expect(store.upsertProvider({ ...together, authScheme: 'basic' }).ok).toBe(true);
    expect(store.upsertProvider({ ...together, authScheme: 'bearer' }).ok).toBe(true);
    expect(text(store.upsertProvider({ ...together, authScheme: 'digest' }))).toMatch(/Invalid enum value/);
  });

  it('Inworld ships as Basic at its documented base URL; Groq, OpenAI, Gemini and Telnyx are unchanged and send Bearer', () => {
    const reg = activeRegistry();
    expect(reg.provider('inworld')).toMatchObject({ baseUrl: 'https://api.inworld.ai/v1', authScheme: 'basic', credential: 'INWORLD_API_KEY' });
    for (const id of ['groq', 'openai', 'gemini', 'telnyx']) expect(reg.provider(id)!.authScheme, id).toBeUndefined();
    for (const key of ['groq_qwen_3_8_27b', 'openai_gpt_5_4', 'gemini_3_flash', 'telnyx_kimi_k3']) expect('authScheme' in loadAiConfig(aiEnv({ AI_LLM: key })).config.llm.spec!, key).toBe(false);
  });

  it('a request carries "Authorization: Basic <key>" for a Basic provider and "Bearer <key>" otherwise, with the key given as stored (never re-encoded)', async () => {
    const store = memory();
    store.upsertProvider({ ...together, authScheme: 'basic' });
    store.upsertModel(togetherModel());
    const basicEnv = aiEnv({ AI_LLM: 'together_llama', TOGETHER_API_KEY: 'dG9nZXRoZXI6a2V5MTIzNDU2' });
    expect(await headerFor(loadAiConfig(basicEnv).config, basicEnv)).toBe('Basic dG9nZXRoZXI6a2V5MTIzNDU2');
    store.upsertProvider({ ...together, authScheme: 'bearer' });
    expect(await headerFor(loadAiConfig(basicEnv).config, basicEnv)).toBe('Bearer dG9nZXRoZXI6a2V5MTIzNDU2');
    const groqEnv = aiEnv({ AI_LLM: 'groq_qwen_3_8_27b', GROQ_API_KEY: 'groq-key-123456' });
    expect(await headerFor(loadAiConfig(groqEnv).config, groqEnv)).toBe('Bearer groq-key-123456');
  });

  it('the read-only connection check of a Basic provider presents the key the same way', () => {
    const store = memory();
    store.upsertProvider({ ...together, authScheme: 'basic' });
    const probe = PROTOCOLS.find((p) => p.id === 'openai-chat')!.probe({ endpoint: 'https://api.together.xyz/v1', key: 'abc', authScheme: 'basic' });
    expect(probe!.headers.Authorization).toBe('Basic abc');
    expect(PROTOCOLS.find((p) => p.id === 'openai-chat')!.probe({ endpoint: 'https://api.together.xyz/v1', key: 'abc' })!.headers.Authorization).toBe('Bearer abc');
  });
});
