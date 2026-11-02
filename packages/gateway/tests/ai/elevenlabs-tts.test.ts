import { describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../src/ai/config.js';
import { buildCatalog } from '../../src/ai/catalog-view.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { ElevenLabsTts } from '../../src/ai/providers/tts.js';
import { AiProviderError } from '../../src/ai/providers/types.js';
import { credentialProbe } from '../../src/ai/runtime.js';
import { CREDENTIAL_PROVIDERS } from '../../src/ai/settings.js';
import { aiEnv, fakeFetch, FORMAT_8K, hangingFetch, SECRET } from './helpers.js';

const VOICE = 'cgSgspJ2msm6clMCkdW9';
const signal = () => new AbortController().signal;
const noSleep = async () => undefined;
const base = { apiKey: SECRET, timeoutMs: 1000, maxRetries: 1, sleep: noSleep };
const rate = (sampleRate: number) => ({ ...FORMAT_8K, sampleRate });
const pcmResponse = (bytes: number, status = 200) => new Response(Buffer.alloc(bytes, 7), { status });
const make = (impl: never, over: Record<string, unknown> = {}) => new ElevenLabsTts({ ...base, fetchImpl: impl, voice: VOICE, ...over });

describe('ElevenLabs text-to-speech adapter (mocked: no real ElevenLabs request is made)', () => {
  it('asks for raw 16-bit PCM at exactly the gateway rate, with the key in xi-api-key and the account voice in the path', async () => {
    for (const r of [8000, 16000, 22050, 24000, 44100, 48000]) {
      const audio = Buffer.alloc(Math.floor(r / 10) * 2, 3);
      const { impl, requests } = fakeFetch([new Response(audio, { status: 200 })]);
      const pcm = await make(impl as never).synthesize('Hello there.', rate(r), signal());
      expect(pcm.equals(audio), String(r)).toBe(true); // returned untouched: no resampling
      const url = new URL(requests[0].url);
      expect(`${url.origin}${url.pathname}`).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`);
      expect(url.searchParams.get('output_format')).toBe(`pcm_${r}`);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].headers['xi-api-key']).toBe(SECRET);
      expect(requests[0].headers.authorization).toBeUndefined();
      expect(JSON.parse(requests[0].body as string)).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5' });
    }
  });

  it('uses the model that is configured, and the /stream endpoint for streaming', async () => {
    const { impl, requests } = fakeFetch([pcmResponse(1600)]);
    const chunks: Buffer[] = [];
    for await (const chunk of make(impl as never, { model: 'eleven_multilingual_v2' }).synthesizeStream('Hi.', FORMAT_8K, signal())) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toHaveLength(1600);
    expect(new URL(requests[0].url).pathname).toBe(`/v1/text-to-speech/${VOICE}/stream`);
    expect(JSON.parse(requests[0].body as string).model_id).toBe('eleven_multilingual_v2');
  });

  it('refuses an unsupported rate or a voice that is not an id before any request', async () => {
    const { impl, requests } = fakeFetch([pcmResponse(100)]);
    await expect(make(impl as never).synthesize('x', rate(11025), signal())).rejects.toThrow(/cannot produce raw 11025 Hz audio/);
    await expect(make(impl as never, { voice: 'Rachel' }).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/voice id/);
    await expect(make(impl as never, { voice: '../v1/user' }).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/voice id/);
    expect(requests).toHaveLength(0);
  });

  it('reports an authentication failure as advice about the key, without echoing it, and does not retry', async () => {
    const { impl, requests } = fakeFetch([new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: `bad key ${SECRET}` } }), { status: 401 })]);
    const error = (await make(impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)) as AiProviderError;
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).toMatch(/HTTP 401: authentication failed: check the API key/);
    expect(error.message).not.toContain(SECRET);
    expect(requests).toHaveLength(1);
  });

  it('retries a rate limit a bounded number of times (the failed request produced no audio), then succeeds or reports it', async () => {
    const ok = fakeFetch([new Response('{}', { status: 429, headers: { 'retry-after': '1' } }), pcmResponse(320)]);
    expect((await make(ok.impl as never).synthesize('x', FORMAT_8K, signal())).length).toBe(320);
    expect(ok.requests).toHaveLength(2);
    const limited = fakeFetch([new Response('{}', { status: 429 })]);
    const error = (await make(limited.impl as never).synthesize('x', FORMAT_8K, signal()).catch((e) => e)) as AiProviderError;
    expect(error.message).toMatch(/HTTP 429/);
    expect(limited.requests).toHaveLength(2); // 1 retry, then the last error
  });

  it('does not retry a rejected request (a bad model or voice, 4xx)', async () => {
    const { impl, requests } = fakeFetch([new Response(JSON.stringify({ detail: { status: 'voice_not_found' } }), { status: 404 })]);
    await expect(make(impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/HTTP 404/);
    expect(requests).toHaveLength(1);
  });

  it('rejects empty and half-sample audio, and a stream that breaks', async () => {
    await expect(make(fakeFetch([pcmResponse(0)]).impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/returned no audio/);
    await expect(make(fakeFetch([pcmResponse(3)]).impl as never).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(/odd number of bytes/);
    const odd = make(fakeFetch([pcmResponse(5)]).impl as never).synthesizeStream('x', FORMAT_8K, signal());
    await expect((async () => { for await (const _ of odd) { /* drain */ } })()).rejects.toThrow(/odd number of bytes/);
  });

  it('times out on a provider that never answers, and stops on cancel', async () => {
    await expect(make(hangingFetch as never, { timeoutMs: 30, maxRetries: 0 }).synthesize('x', FORMAT_8K, signal())).rejects.toThrow(AiProviderError);
    const controller = new AbortController();
    const pending = make(hangingFetch as never, { timeoutMs: 5000, maxRetries: 0 }).synthesize('x', FORMAT_8K, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('ElevenLabs through the existing settings, catalog and key store', () => {
  it('is an implemented, selectable TTS option with its own key, accurate sample rates, and no second provider system', () => {
    const option = buildCatalog(aiEnv()).tts.find((o) => o.key === 'elevenlabs')!;
    expect(option).toMatchObject({ implemented: true, unavailableReason: null, model: 'eleven_flash_v2_5', sampleRates: [8000, 16000, 22050, 24000, 44100, 48000] });
    expect(CREDENTIAL_PROVIDERS.ELEVENLABS_API_KEY).toBe('ElevenLabs');
  });

  it('needs ELEVENLABS_API_KEY (and only that for TTS), and refuses a rate it cannot produce', () => {
    const noKey = loadAiConfig(aiEnv({ AI_TTS: 'elevenlabs', AI_TTS_VOICE: VOICE }));
    expect(noKey.config.requiredKeyEnv).toContain('ELEVENLABS_API_KEY');
    expect(noKey.errors.join(' ')).toMatch(/ELEVENLABS_API_KEY is required by the selected providers but is not set/);
    expect(noKey.config.requiredKeyEnv).not.toContain('CARTESIA_API_KEY');
    const ready = loadAiConfig(aiEnv({ AI_TTS: 'elevenlabs', AI_TTS_VOICE: VOICE, ELEVENLABS_API_KEY: SECRET }));
    expect(ready.errors).toEqual([]);
    expect(ready.config.tts).toEqual({ key: 'elevenlabs', voice: VOICE, model: null });
  });

  it('is built by the factory, and never silently replaces the selected provider', () => {
    const config = loadAiConfig(aiEnv({ AI_TTS: 'elevenlabs', AI_TTS_VOICE: VOICE, ELEVENLABS_API_KEY: SECRET })).config;
    expect(createProviders(config, { env: aiEnv({ AI_TTS: 'elevenlabs', ELEVENLABS_API_KEY: SECRET }), only: 'tts' }).tts.name).toBe('elevenlabs');
    expect(() => createProviders(config, { env: aiEnv({ AI_TTS: 'elevenlabs', ELEVENLABS_API_KEY: undefined }), only: 'tts' })).toThrow(/ELEVENLABS_API_KEY is required/);
  });

  it('tests the key against the read-only models list with the xi-api-key header', () => {
    expect(credentialProbe('ELEVENLABS_API_KEY', SECRET)).toEqual({ url: 'https://api.elevenlabs.io/v1/models', headers: { 'xi-api-key': SECRET } });
  });
});
