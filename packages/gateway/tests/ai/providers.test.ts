import { describe, expect, it } from 'vitest';
import { toWav } from '../../src/ai/audio.js';
import { LLM_CATALOG, openAiCompatibleSpec } from '../../src/ai/catalog.js';
import { redactSecrets, requestWithRetry } from '../../src/ai/providers/http.js';
import { OpenAiCompatibleLlm } from '../../src/ai/providers/llm.js';
import { DeepgramStt, GroqWhisperStt } from '../../src/ai/providers/stt.js';
import { CartesiaTts, DeepgramTts } from '../../src/ai/providers/tts.js';
import { AiProviderError } from '../../src/ai/providers/types.js';
import { delta, fakeFetch, FORMAT_8K, hangingFetch, json, speechPcm, SECRET, sse } from './helpers.js';

const signal = () => new AbortController().signal;
const noSleep = async () => {};
const base = { apiKey: SECRET, timeoutMs: 1000, maxRetries: 1, sleep: noSleep };

describe('Deepgram STT', () => {
  const reply = json({ results: { channels: [{ alternatives: [{ transcript: ' Hello there ', confidence: 0.93 }] }] } });

  it('uploads a self-describing WAV with the source parameters and returns the transcript', async () => {
    const { impl, requests } = fakeFetch([reply]);
    const stt = new DeepgramStt({ ...base, fetchImpl: impl, model: 'nova-3', language: 'en', keyterms: ['Acme', 'Beta Corp'] });
    const pcm = speechPcm(600);

    const result = await stt.transcribe(pcm, FORMAT_8K, signal());

    expect(result).toEqual({ text: 'Hello there', confidence: 0.93 });
    const url = new URL(requests[0].url);
    expect(url.origin).toBe('https://api.au.deepgram.com'); // English uses the AU endpoint, as in deepgram_stt.py
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.getAll('keyterm')).toEqual(['Acme', 'Beta Corp']);
    expect(url.searchParams.has('language')).toBe(false);
    expect(requests[0].headers.authorization).toBe(`Token ${SECRET}`);
    expect(requests[0].headers['content-type']).toBe('audio/wav');
    const body = requests[0].body as Buffer;
    expect(body.equals(toWav(pcm, FORMAT_8K))).toBe(true);
    expect(body.readUInt32LE(24)).toBe(8000); // the WAV states the real rate
  });

  it('uses the global endpoint and a language parameter for non-English', async () => {
    const { impl, requests } = fakeFetch([reply]);
    await new DeepgramStt({ ...base, fetchImpl: impl, model: 'nova-3', language: 'hi', keyterms: [] }).transcribe(speechPcm(400), FORMAT_8K, signal());
    const url = new URL(requests[0].url);
    expect(url.origin).toBe('https://api.deepgram.com');
    expect(url.searchParams.get('language')).toBe('hi');
  });

  it('refuses to upload an empty or malformed buffer', async () => {
    const { impl, requests } = fakeFetch([reply]);
    const stt = new DeepgramStt({ ...base, fetchImpl: impl, model: 'nova-3', language: 'en', keyterms: [] });
    await expect(stt.transcribe(Buffer.alloc(0), FORMAT_8K, signal())).rejects.toThrow(/empty audio buffer/);
    await expect(stt.transcribe(Buffer.alloc(3), FORMAT_8K, signal())).rejects.toThrow(/whole number/);
    expect(requests).toHaveLength(0);
  });

  it('reports a response it cannot read', async () => {
    const { impl } = fakeFetch([json({ results: {} })]);
    const stt = new DeepgramStt({ ...base, fetchImpl: impl, model: 'nova-3', language: 'en', keyterms: [] });
    await expect(stt.transcribe(speechPcm(400), FORMAT_8K, signal())).rejects.toThrow(/no transcript field/);
  });
});

describe('Groq Whisper STT', () => {
  it('posts multipart audio and reads the text field', async () => {
    const { impl, requests } = fakeFetch([json({ text: ' What time do you open? ' })]);
    const stt = new GroqWhisperStt({ ...base, fetchImpl: impl, model: 'whisper-large-v3-turbo', language: 'en' });
    const result = await stt.transcribe(speechPcm(500), FORMAT_8K, signal());
    expect(result.text).toBe('What time do you open?');
    expect(requests[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    const form = requests[0].body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('response_format')).toBe('json');
    expect((form.get('file') as File).type).toBe('audio/wav');
    // The language is always stated, English included, so Whisper never guesses it from a short clip.
    expect(form.get('language')).toBe('en');
  });

  it('sends the configured non-English language too', async () => {
    const { impl, requests } = fakeFetch([json({ text: 'namaste' })]);
    await new GroqWhisperStt({ ...base, fetchImpl: impl, model: 'whisper-large-v3-turbo', language: 'hi-IN' }).transcribe(speechPcm(500), FORMAT_8K, signal());
    expect((requests[0].body as FormData).get('language')).toBe('hi');
  });
});

describe('OpenAI-compatible LLM', () => {
  const llmFor = (key: string, fetchImpl: ReturnType<typeof fakeFetch>['impl'], extra: Record<string, unknown> = {}) =>
    new OpenAiCompatibleLlm({
      spec: openAiCompatibleSpec(LLM_CATALOG[key], {})!,
      apiKey: SECRET,
      fetchImpl,
      firstTokenTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      maxRetries: 1,
      maxTokens: null,
      sleep: noSleep,
      ...extra,
    });
  const collect = async (stream: AsyncIterable<{ delta?: string; usage?: unknown }>) => {
    let text = '';
    let usage: unknown;
    for await (const chunk of stream) {
      if (chunk.delta) text += chunk.delta;
      if (chunk.usage) usage = chunk.usage;
    }
    return { text, usage };
  };

  it('streams tokens across arbitrary chunk boundaries and reports usage', async () => {
    const { impl, requests } = fakeFetch([
      sse([delta('Hello'), delta(', wor'), delta('ld!'), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }, '[DONE]'], 7),
    ]);
    const llm = llmFor('groq_qwen_3_8_27b', impl);
    const { text, usage } = await collect(llm.stream({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] }, signal()));

    expect(text).toBe('Hello, world!');
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    const body = JSON.parse(requests[0].body as string);
    expect(requests[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', stream: true, temperature: 0.4, reasoning_effort: 'none' });
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('sends the Telnyx region parameters from the source and no temperature for OpenAI', async () => {
    const telnyx = fakeFetch([sse([delta('ok'), '[DONE]'])]);
    await collect(llmFor('telnyx_kimi_k3', telnyx.impl).stream({ system: 's', messages: [] }, signal()));
    expect(telnyx.requests[0].url).toBe('https://api.telnyx.com/v2/ai/openai/chat/completions');
    expect(JSON.parse(telnyx.requests[0].body as string)).toMatchObject({ region: 'AUS', mode: 'preferred', reasoning_effort: 'none' });

    const openai = fakeFetch([sse([delta('ok'), '[DONE]'])]);
    await collect(llmFor('openai_gpt_5_4_mini', openai.impl, { maxTokens: 120 }).stream({ system: 's', messages: [] }, signal()));
    const body = JSON.parse(openai.requests[0].body as string);
    expect(body).not.toHaveProperty('temperature');
    expect(body.max_tokens).toBe(120);
  });

  it('ignores a malformed keep-alive line but fails on a provider error event', async () => {
    const ok = fakeFetch([sse([': keep-alive', 'not json', delta('fine'), '[DONE]'])]);
    expect((await collect(llmFor('groq_qwen_3_8_27b', ok.impl).stream({ system: 's', messages: [] }, signal()))).text).toBe('fine');

    const bad = fakeFetch([sse([delta('partial'), { error: { message: `quota exceeded for key ${SECRET}` } }])]);
    const failure = collect(llmFor('groq_qwen_3_8_27b', bad.impl).stream({ system: 's', messages: [] }, signal()));
    await expect(failure).rejects.toThrow(/stream error/);
    await expect(failure).rejects.not.toThrow(new RegExp(SECRET));
  });

  it('retries a 429 before the first token, then streams', async () => {
    const { impl, requests } = fakeFetch([json({ error: 'slow down' }, 429, { 'retry-after': '1' }), sse([delta('back'), '[DONE]'])]);
    const { text } = await collect(llmFor('groq_qwen_3_8_27b', impl).stream({ system: 's', messages: [] }, signal()));
    expect(text).toBe('back');
    expect(requests).toHaveLength(2);
  });

  it('cancels the stream when the caller aborts', async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch([
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta('start'))}\n\n`));
              // never closes
            },
          }),
          { status: 200 }
        ),
    ]);
    const llm = llmFor('groq_qwen_3_8_27b', impl);
    const seen: string[] = [];
    const run = (async () => {
      for await (const chunk of llm.stream({ system: 's', messages: [] }, controller.signal)) {
        if (chunk.delta) seen.push(chunk.delta);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AiProviderError', details: { aborted: true } });
    expect(seen).toEqual(['start']);
  });
});

describe('Cartesia and Deepgram TTS', () => {
  it('asks Cartesia for raw 16-bit PCM at the sink rate and maps source voice names', async () => {
    const audio = Buffer.alloc(1600, 3);
    const { impl, requests } = fakeFetch([new Response(audio, { status: 200 })]);
    const tts = new CartesiaTts({ ...base, fetchImpl: impl, voice: 'katie', language: 'en' });

    const pcm = await tts.synthesize('Hello there.', FORMAT_8K, signal());

    expect(pcm.equals(audio)).toBe(true);
    expect(requests[0].url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(requests[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(requests[0].headers['cartesia-version']).toBe('2026-08-14');
    expect(JSON.parse(requests[0].body as string)).toMatchObject({
      model_id: 'sonic-3',
      transcript: 'Hello there.',
      voice: { id: 'f786b574-daa5-4673-aa0c-cbe3e8534c02' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 8000 },
    });
  });

  it('rejects an unsupported rate before any request, and empty or odd-length audio after', async () => {
    const empty = fakeFetch([new Response(new Uint8Array(0), { status: 200 })]);
    const tts = new CartesiaTts({ ...base, fetchImpl: empty.impl, voice: 'katie', language: 'en' });
    await expect(tts.synthesize('x', { ...FORMAT_8K, sampleRate: 11025 }, signal())).rejects.toThrow(/cannot produce raw 11025 Hz/);
    expect(empty.requests).toHaveLength(0);
    await expect(tts.synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/returned no audio/);

    const odd = fakeFetch([new Response(Buffer.alloc(3), { status: 200 })]);
    await expect(new CartesiaTts({ ...base, fetchImpl: odd.impl, voice: 'katie', language: 'en' }).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/odd number of bytes/);
  });

  it('asks Deepgram for linear16 and accepts raw PCM or a WAV that matches exactly', async () => {
    const raw = Buffer.alloc(800, 1);
    const rawFetch = fakeFetch([new Response(raw, { status: 200 })]);
    const tts = new DeepgramTts({ ...base, fetchImpl: rawFetch.impl, voice: 'aura-asteria-en' });
    expect((await tts.synthesize('Hi.', FORMAT_8K, signal())).equals(raw)).toBe(true);
    const url = new URL(rawFetch.requests[0].url);
    expect(url.searchParams.get('model')).toBe('aura-asteria-en');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('8000');
    expect(rawFetch.requests[0].headers.authorization).toBe(`Token ${SECRET}`);

    const pcm = speechPcm(100);
    const wavFetch = fakeFetch([new Response(toWav(pcm, FORMAT_8K), { status: 200 })]);
    expect((await new DeepgramTts({ ...base, fetchImpl: wavFetch.impl, voice: 'aura-asteria-en' }).synthesize('Hi.', FORMAT_8K, signal())).equals(pcm)).toBe(true);

    const wrong = fakeFetch([new Response(toWav(pcm, { ...FORMAT_8K, sampleRate: 24000 }), { status: 200 })]);
    await expect(new DeepgramTts({ ...base, fetchImpl: wrong.impl, voice: 'aura-asteria-en' }).synthesize('Hi.', FORMAT_8K, signal())).rejects.toThrow(/expected 8000 Hz/);
  });
});

describe('failure handling shared by every provider', () => {
  const opts = (fetchImpl: ReturnType<typeof fakeFetch>['impl'], over: Record<string, unknown> = {}) => ({
    provider: 'test',
    stage: 'stt' as const,
    fetchImpl,
    timeoutMs: 1000,
    maxRetries: 2,
    signal: signal(),
    sleep: noSleep,
    ...over,
  });

  it('turns a 401 into advice about the key without ever echoing a credential', async () => {
    const { impl, requests } = fakeFetch([json({ err: `Invalid Authorization: Token ${SECRET} sk-${'a'.repeat(20)}` }, 401)]);
    const failure = requestWithRetry('https://x.test/', { method: 'POST' }, opts(impl));
    await expect(failure).rejects.toThrow(/HTTP 401: authentication failed: check the API key/);
    await expect(failure).rejects.not.toThrow(new RegExp(SECRET));
    await expect(failure).rejects.not.toThrow(/sk-a{20}/);
    expect(requests).toHaveLength(1); // an auth failure is never retried
  });

  it('does not retry a rejected request (4xx other than 408/429)', async () => {
    const { impl, requests } = fakeFetch([json({ error: 'bad' }, 400)]);
    await expect(requestWithRetry('https://x.test/', {}, opts(impl))).rejects.toThrow(/HTTP 400/);
    expect(requests).toHaveLength(1);
  });

  it('retries 429, 5xx and network errors a bounded number of times, then reports the last error', async () => {
    const flaky = fakeFetch([json({}, 503), new Error('socket hang up'), json({ ok: true })]);
    const response = await requestWithRetry('https://x.test/', {}, opts(flaky.impl));
    expect(response.ok).toBe(true);
    expect(flaky.requests).toHaveLength(3);

    const dead = fakeFetch([json({}, 500)]);
    await expect(requestWithRetry('https://x.test/', {}, opts(dead.impl, { maxRetries: 1 }))).rejects.toThrow(/HTTP 500: provider server error/);
    expect(dead.requests).toHaveLength(2);
  });

  it('gives up on a provider that never answers', async () => {
    const started = Date.now();
    const failure = requestWithRetry('https://x.test/', {}, opts(hangingFetch, { timeoutMs: 40, maxRetries: 1 }));
    await expect(failure).rejects.toMatchObject({ name: 'AiProviderError', details: { timedOut: true } });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('stops immediately, and without retrying, when the caller cancels', async () => {
    const controller = new AbortController();
    const pending = requestWithRetry('https://x.test/', {}, opts(hangingFetch, { signal: controller.signal, timeoutMs: 5000 }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ details: { aborted: true } });
    expect(new AiProviderError('a', 'stt', 'b').retryable).toBe(false);
  });

  it('redacts bearer tokens and key-shaped strings from arbitrary text', () => {
    const text = redactSecrets(`Authorization: Bearer abcdef123456 and api_key=hunter2hunter2 and ${SECRET}`);
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain('hunter2hunter2');
    expect(text).not.toContain(SECRET);
  });
});
