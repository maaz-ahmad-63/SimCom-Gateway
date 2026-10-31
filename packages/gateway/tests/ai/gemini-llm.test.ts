import { describe, expect, it } from 'vitest';
import { LLM_CATALOG, openAiCompatibleSpec } from '../../src/ai/catalog.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { OpenAiCompatibleLlm } from '../../src/ai/providers/llm.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { AiProviderError } from '../../src/ai/providers/types.js';
import { credentialProbe } from '../../src/ai/runtime.js';
import { CREDENTIAL_PROVIDERS } from '../../src/ai/settings.js';
import { aiEnv, delta, fakeFetch, json, SECRET, sse } from './helpers.js';

/** Google Gemini through its documented OpenAI-compatible endpoint (https://ai.google.dev/gemini-api/docs/openai). Mocked: no request leaves the process. */
const noSleep = async () => undefined;
const llmFor = (impl: never) =>
  new OpenAiCompatibleLlm({ spec: openAiCompatibleSpec(LLM_CATALOG.gemini_3_flash, {})!, apiKey: SECRET, fetchImpl: impl, firstTokenTimeoutMs: 1000, totalTimeoutMs: 5000, maxRetries: 1, maxTokens: null, sleep: noSleep });
const collect = async (llm: OpenAiCompatibleLlm, signal = new AbortController().signal) => {
  let text = '';
  for await (const chunk of llm.stream({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] }, signal)) if (chunk.delta) text += chunk.delta;
  return text;
};

describe('Gemini LLM', () => {
  it('is an implemented catalog entry with Google\'s own model id, endpoint and key name', () => {
    expect(openAiCompatibleSpec(LLM_CATALOG.gemini_3_flash, {})).toMatchObject({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: 'GEMINI_API_KEY',
      model: 'gemini-3.8-flash',
    });
    expect(CREDENTIAL_PROVIDERS.GEMINI_API_KEY).toBe('Google Gemini');
  });

  it('streams a reply with the system prompt and conversation, key as a Bearer token', async () => {
    const { impl, requests } = fakeFetch([sse([delta('Hello'), delta(' there'), '[DONE]'])]);
    expect(await collect(llmFor(impl as never))).toBe('Hello there');
    expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(requests[0].body as string);
    expect(body).toMatchObject({ model: 'gemini-3.8-flash', stream: true });
    expect(body.messages).toEqual([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }]);
  });

  it('reports a bad key, a missing model and a rate limit distinctly, never echoing the key', async () => {
    const auth = (await collect(llmFor(fakeFetch([json({ error: { message: `API key ${SECRET} not valid` } }, 401)]).impl as never)).catch((e) => e)) as AiProviderError;
    expect(auth.message).toMatch(/HTTP 401: authentication failed/);
    expect(auth.message).not.toContain(SECRET);
    const missing = (await collect(llmFor(fakeFetch([json({ error: { message: 'models/x is not found' } }, 404)]).impl as never)).catch((e) => e)) as AiProviderError;
    expect(missing.message).toMatch(/HTTP 404/);
    const limited = fakeFetch([json({ error: 'quota' }, 429), json({ error: 'quota' }, 429)]);
    expect(((await collect(llmFor(limited.impl as never)).catch((e) => e)) as AiProviderError).message).toMatch(/HTTP 429/);
    expect(limited.requests).toHaveLength(2); // one bounded retry before the first token, then the last error
  });

  it('is selectable with only its own key, built by the factory, and tested against the read-only models list', () => {
    const missing = loadAiConfig(aiEnv({ AI_LLM: 'gemini_3_flash' }));
    expect(missing.errors.join(' ')).toMatch(/GEMINI_API_KEY is required by the selected providers but is not set/);
    expect(missing.config.requiredKeyEnv).toContain('GEMINI_API_KEY');
    const env = aiEnv({ AI_LLM: 'gemini_3_flash', GEMINI_API_KEY: SECRET });
    const ready = loadAiConfig(env);
    expect(ready.errors).toEqual([]);
    expect(createProviders(ready.config, { env, only: 'llm' }).llm.name).toBeTruthy();
    expect(credentialProbe('GEMINI_API_KEY', SECRET)).toEqual({ url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', headers: { Authorization: `Bearer ${SECRET}` } });
  });
});
