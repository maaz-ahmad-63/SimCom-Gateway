import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { describeLlmCaching } from '../src/ai/llm-caching.js';
import { OpenAiCompatibleLlm, usageFrom } from '../src/ai/providers/llm.js';
import { LlmChunk } from '../src/ai/providers/types.js';
import { builtinRegistry } from '../src/ai/registry/registry.js';
import { AiUsageStore, TurnRecord } from '../src/ai/usage-store.js';
import { createCampaignsRouter } from '../src/api/routes/campaigns.js';
import { makeHarness } from './campaign-harness.js';

/**
 * Token use and prompt caching. The gateway does not invent a cache or a session: it keeps the beginning of every campaign request
 * identical, asks OpenAI for what only OpenAI's API takes, and records what each provider REPORTS. These tests pin what is read from
 * each reply, what is and is not sent to whom, and that the report separates cached from ordinary tokens and says "not reported"
 * rather than showing zero.
 */

describe('what is read from a provider\'s usage reply', () => {
  const base = { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 };

  it('OpenAI and Groq: prompt_tokens_details.cached_tokens', () => {
    expect(usageFrom({ usage: { ...base, prompt_tokens_details: { cached_tokens: 1024 } } })).toEqual({ promptTokens: 1200, completionTokens: 8, totalTokens: 1208, cachedPromptTokens: 1024 });
    expect(usageFrom({ x_groq: { usage: { ...base, prompt_tokens_details: { cached_tokens: 512 } } } })).toMatchObject({ cachedPromptTokens: 512 });
  });

  it('other shapes: DeepSeek-style prompt_cache_hit_tokens, and cache read / write counts', () => {
    expect(usageFrom({ usage: { ...base, prompt_cache_hit_tokens: 300 } })).toMatchObject({ cachedPromptTokens: 300 });
    expect(usageFrom({ usage: { ...base, cache_read_input_tokens: 700, cache_creation_input_tokens: 200 } })).toMatchObject({ cachedPromptTokens: 700, cacheWriteTokens: 200 });
  });

  it('a provider that reports nothing about its cache gives NO cached figure (which is not zero)', () => {
    const usage = usageFrom({ usage: base })!;
    expect(usage).toEqual({ promptTokens: 1200, completionTokens: 8, totalTokens: 1208 });
    expect('cachedPromptTokens' in usage).toBe(false);
    expect('cacheWriteTokens' in usage).toBe(false);
  });

  it('an explicit zero IS recorded as zero (the provider said nothing was cached), and nonsense is ignored', () => {
    expect(usageFrom({ usage: { ...base, prompt_tokens_details: { cached_tokens: 0 } } })).toMatchObject({ cachedPromptTokens: 0 });
    for (const bad of [-5, Number.NaN, '1024', null, {}]) {
      expect('cachedPromptTokens' in usageFrom({ usage: { ...base, prompt_tokens_details: { cached_tokens: bad } } })!).toBe(false);
    }
    expect(usageFrom({ choices: [] })).toBeUndefined();
  });
});

describe('what is sent to which provider', () => {
  const sse = (events: object[]) => new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const spec = (baseUrl: string, body: Record<string, unknown> = {}) => ({ provider: 'x', baseUrl, apiKeyEnv: 'K', model: 'm', body, toolCalling: false });

  async function ask(baseUrl: string, cacheKey?: string, body: Record<string, unknown> = {}, events: object[] = [{ choices: [{ delta: { content: 'Hi' } }] }]) {
    const sent: Array<Record<string, any>> = [];
    const llm = new OpenAiCompatibleLlm({
      spec: spec(baseUrl, body),
      apiKey: 'key',
      fetchImpl: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return sse(events);
      },
      firstTokenTimeoutMs: 5000,
      totalTimeoutMs: 5000,
      maxRetries: 0,
      maxTokens: null,
    });
    const chunks: LlmChunk[] = [];
    for await (const c of llm.stream({ system: 'S', messages: [{ role: 'user', content: 'hello' }], ...(cacheKey ? { cacheKey } : {}) }, new AbortController().signal)) chunks.push(c);
    return { body: sent[0], chunks };
  }

  it('OpenAI: usage is requested in the stream, and the campaign\'s cache key names the shared prefix', async () => {
    const { body } = await ask('https://api.openai.com/v1', 'campaign:abc:v3');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.prompt_cache_key).toBe('campaign:abc:v3');
  });

  it('OpenAI without a cache key (an ordinary call) sends no cache key, and an operator-set stream option is not overridden', async () => {
    const plain = await ask('https://api.openai.com/v1');
    expect(plain.body.prompt_cache_key).toBeUndefined();
    const custom = await ask('https://api.openai.com/v1', 'k', { stream_options: { include_usage: false } });
    expect(custom.body.stream_options).toEqual({ include_usage: false });
  });

  it('Groq, Telnyx, Gemini and Inworld hosts get neither parameter: nothing is added to a request their API is not documented to take', async () => {
    for (const url of ['https://api.groq.com/openai/v1', 'https://api.telnyx.com/v2/ai/openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://api.inworld.ai/v1']) {
      const { body } = await ask(url, 'campaign:abc:v3');
      expect(body.stream_options, url).toBeUndefined();
      expect(body.prompt_cache_key, url).toBeUndefined();
      expect(body.messages[0]).toEqual({ role: 'system', content: 'S' }); // one system message, once
    }
  });

  it('reads the cached count from the final usage chunk of a real stream', async () => {
    const { chunks } = await ask('https://api.openai.com/v1', 'k', {}, [
      { choices: [{ delta: { content: 'Okay' } }] },
      { choices: [], usage: { prompt_tokens: 1500, completion_tokens: 3, total_tokens: 1503, prompt_tokens_details: { cached_tokens: 1408 } } },
    ]);
    expect(chunks.find((c) => c.usage)?.usage).toEqual({ promptTokens: 1500, completionTokens: 3, totalTokens: 1503, cachedPromptTokens: 1408 });
  });

  it('a provider with no caching support still works: the same request, usage without a cache figure', async () => {
    const { chunks } = await ask('https://api.telnyx.com/v2/ai/openai', undefined, {}, [{ choices: [{ delta: { content: 'Hi' } }] }, { usage: { prompt_tokens: 900, completion_tokens: 2 } }]);
    expect(chunks.map((c) => c.delta).join('')).toBe('Hi');
    expect(chunks.find((c) => c.usage)?.usage).toEqual({ promptTokens: 900, completionTokens: 2, totalTokens: 902 });
  });
});

describe('what is known about each provider\'s caching, and no more', () => {
  it('states the documented facts for OpenAI and Groq, and says what is unconfirmed for the rest', () => {
    expect(describeLlmCaching('openai')).toMatchObject({ promptCaching: 'automatic', reportsCachedTokens: 'documented', minimumPrefixTokens: 1024 });
    expect(describeLlmCaching('groq')).toMatchObject({ promptCaching: 'automatic-on-supported-models', reportsCachedTokens: 'documented' });
    expect(describeLlmCaching('gemini')).toMatchObject({ reportsCachedTokens: 'unconfirmed' });
    expect(describeLlmCaching('telnyx')).toMatchObject({ reportsCachedTokens: 'unconfirmed' });
    expect(describeLlmCaching('somebody-new')).toMatchObject({ promptCaching: 'not-documented', reportsCachedTokens: 'unconfirmed', sources: [] });
  });

  it('no provider in the registry is described as having a persistent session: every call is a separate, stateless conversation', () => {
    const registry = builtinRegistry();
    const vendors = new Set(registry.llmKeys().map((k) => registry.llm(k)!.vendor));
    expect(vendors.size).toBeGreaterThanOrEqual(4);
    for (const vendor of vendors) {
      const info = describeLlmCaching(vendor);
      expect(info.persistentSession, vendor).toBe('not-available-through-this-api');
      expect(info.note.length, vendor).toBeGreaterThan(20);
    }
    for (const vendor of ['openai', 'groq', 'gemini', 'telnyx', 'inworld']) expect(describeLlmCaching(vendor).sources.length, vendor).toBeGreaterThan(0);
  });
});

describe('the campaign token report', () => {
  const turn = (callId: string, over: Partial<TurnRecord> = {}): TurnRecord => ({
    callId, status: 'completed', sttMs: 100, llmFirstTokenMs: 200, ttsFirstMs: 100, totalMs: 900, utteranceMs: 1500, sttSeconds: 1.5,
    llmPromptTokens: 1200, llmCompletionTokens: 8, ttsChars: 20, selection: { stt: 'nova-3', llm: 'openai_gpt_4_1_mini', tts: 'cartesia' }, mock: false, ...over,
  });

  /** A campaign with three finished calls, call-1 .. call-3, each from its own contact. */
  async function threeCalls() {
    const h = makeHarness();
    h.store.start(h.campaign.id);
    for (let i = 0; i < 3; i++) {
      await h.runner.tick();
      h.advance(11_000);
    }
    return { h, turns: new AiUsageStore(h.db) };
  }

  it('sums input, output and cached tokens per call and per campaign, and keeps cached apart from ordinary input', async () => {
    const { h, turns } = await threeCalls();
    turns.record(turn('call-1', { llmPromptTokens: 1200, llmCompletionTokens: 8, llmCachedTokens: 1024 }));
    turns.record(turn('call-1', { llmPromptTokens: 1300, llmCompletionTokens: 10, llmCachedTokens: 1152, llmCacheWriteTokens: 64 }));
    turns.record(turn('call-2', { llmPromptTokens: 1100, llmCompletionTokens: 9 })); // this provider reported no cache figure
    const usage = h.store.usage(h.campaign.id);

    expect(usage.calls.map((c) => [c.callId, c.turns, c.inputTokens, c.outputTokens, c.cachedInputTokens])).toEqual([
      ['call-1', 2, 2500, 18, 2176],
      ['call-2', 1, 1100, 9, null], // not reported: null, never 0
      ['call-3', 0, 0, 0, null], // a call with no model turns at all
    ]);
    expect(usage.totals).toMatchObject({
      calls: 3,
      turns: 3,
      turnsWithUsage: 3,
      inputTokens: 3600,
      outputTokens: 27,
      cachedInputTokens: 2176,
      cacheWriteTokens: 64,
      turnsReportingCache: 2,
      inputTokensOnTurnsReportingCache: 2500, // the cache share is only stated over the turns that reported one
      uncachedInputTokens: 324, // 2500 - 2176
    });
  });

  it('says "not reported", not zero, when no turn carried a cache figure', async () => {
    const { h, turns } = await threeCalls();
    turns.record(turn('call-1'));
    turns.record(turn('call-2', { llmPromptTokens: 800 }));
    const { totals } = h.store.usage(h.campaign.id);
    expect(totals).toMatchObject({ inputTokens: 2000, cachedInputTokens: null, cacheWriteTokens: null, uncachedInputTokens: null, turnsReportingCache: 0 });
  });

  it('never counts offline mock turns, another campaign\'s calls, or a turn the provider gave no usage for', async () => {
    const { h, turns } = await threeCalls();
    turns.record(turn('call-1', { llmPromptTokens: 999_999, mock: true })); // offline mock providers: logged, never counted
    turns.record(turn('someone-elses-call', { llmPromptTokens: 777 })); // not an attempt of this campaign
    turns.record(turn('call-2', { llmPromptTokens: null, llmCompletionTokens: null })); // no usage reported at all
    const { totals, calls } = h.store.usage(h.campaign.id);
    expect(totals.inputTokens).toBe(0);
    expect(totals.turnsWithUsage).toBe(0);
    expect(calls.find((c) => c.callId === 'call-2')).toMatchObject({ turns: 1, turnsWithUsage: 0 });
  });

  it('is empty, not an error, for a campaign that has placed no calls', () => {
    const h = makeHarness();
    expect(h.store.usage(h.campaign.id)).toEqual({
      totals: { calls: 0, turns: 0, turnsWithUsage: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: null, cacheWriteTokens: null, turnsReportingCache: 0, uncachedInputTokens: null, inputTokensOnTurnsReportingCache: null },
      calls: [],
    });
  });

  it('is served over the API, next to the model choices with their caching facts', async () => {
    const { h, turns } = await threeCalls();
    turns.record(turn('call-1', { llmCachedTokens: 1024 }));
    const a = express();
    a.use(express.json());
    a.use('/api/campaigns', createCampaignsRouter({ store: h.store, runner: h.runner, blockers: () => [], llm: { problem: () => null, choices: () => [{ key: 'm', caching: describeLlmCaching('openai') }] }, now: () => new Date(h.clock.now) }));
    const usage = await request(a).get(`/api/campaigns/${h.campaign.id}/usage`);
    expect(usage.body).toMatchObject({ success: true, totals: { inputTokens: 1200, cachedInputTokens: 1024, uncachedInputTokens: 176 } });
    const models = await request(a).get('/api/campaigns/llm-options');
    expect(models.body.models[0].caching).toMatchObject({ promptCaching: 'automatic', persistentSession: 'not-available-through-this-api' });
    expect((await request(a).get('/api/campaigns/nope/usage')).status).toBe(404);
  });
});
