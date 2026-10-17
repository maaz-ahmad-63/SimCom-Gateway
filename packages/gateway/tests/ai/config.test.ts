import { describe, expect, it } from 'vitest';
import { LLM_CATALOG, openAiCompatibleSpec, resolveLlmKey } from '../../src/ai/catalog.js';
import { describeConfig, loadAiConfig } from '../../src/ai/config.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { aiEnv, SECRET } from './helpers.js';

describe('AI configuration', () => {
  it('is off by default and says nothing is wrong', () => {
    const result = loadAiConfig({});
    expect(result.config.enabled).toBe(false);
    expect(result.usable).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.config.autoHandle).toBe('off');
    expect(result.config.allowAgentHangup).toBe(false);
    expect(result.config.logTranscripts).toBe(false);
    expect(result.config.audio.inboundVerified).toBe(false);
    expect(result.config.audio.outboundVerified).toBe(false);
  });

  it('accepts a complete setup using the source project slugs', () => {
    const result = loadAiConfig(aiEnv());
    expect(result.errors).toEqual([]);
    expect(result.usable).toBe(true);
    expect(result.config.llm.key).toBe('groq_qwen_3_8_27b');
    expect(result.config.llm.spec).toMatchObject({ provider: 'groq', model: 'qwen/qwen3.8-27b' });
    expect(result.config.stt.entry.model).toBe('nova-3');
    expect(result.config.requiredKeyEnv.sort()).toEqual(['CARTESIA_API_KEY', 'DEEPGRAM_API_KEY', 'GROQ_API_KEY']);
  });

  it('never defaults the audio sample rate', () => {
    const { AI_AUDIO_SAMPLE_RATE: _omitted, ...withoutRate } = aiEnv();
    const result = loadAiConfig(withoutRate);
    expect(result.config.audio.format).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/AI_AUDIO_SAMPLE_RATE is not set/);
    expect(result.usable).toBe(true); // the offline loop still works; live attach is blocked elsewhere
  });

  it('names the missing credential, never a value, when enabled', () => {
    const result = loadAiConfig(aiEnv({ GROQ_API_KEY: undefined, CARTESIA_API_KEY: '  ' }));
    expect(result.usable).toBe(false);
    expect(result.errors).toContain('GROQ_API_KEY is required by the selected providers but is not set');
    expect(result.errors).toContain('CARTESIA_API_KEY is required by the selected providers but is not set');
    expect(JSON.stringify(result.errors)).not.toContain(SECRET);
  });

  it('does not demand credentials while disabled', () => {
    expect(loadAiConfig({ AI_ENABLED: 'false', AI_LLM: 'openai_gpt_5_4_mini' }).errors).toEqual([]);
  });

  it.each([
    [{ AI_STT: 'whisper-9000' }, /not a known STT slug/],
    [{ AI_STT: 'soniox' }, /not ported to the gateway yet/],
    [{ AI_LLM: 'gpt-9' }, /not a known LLM slug/],
    [{ AI_LLM: 'gemini_3_flash' }, /not ported to the gateway yet/],
    [{ AI_TTS: 'elevenlabs' }, /not ported to the gateway yet/],
    [{ AI_TTS: 'nope' }, /not a known TTS slug/],
    [{ AI_TTS: 'deepgram' }, /needs an Aura voice/],
    [{ AI_AUDIO_SAMPLE_RATE: '12345' }, /not a raw rate Cartesia supports/],
    [{ AI_AUDIO_SAMPLE_RATE: 'fast' }, /integer between 8000 and 48000/],
    [{ AI_AUDIO_BIT_DEPTH: '8' }, /16-bit, mono, little-endian/],
    [{ AI_ENABLED: 'maybe' }, /AI_ENABLED must be true or false/],
    [{ AI_AUTO_HANDLE: 'everything' }, /AI_AUTO_HANDLE must be one of/],
    [{ AI_LLM_TOTAL_TIMEOUT_MS: '99999999' }, /AI_LLM_TOTAL_TIMEOUT_MS must be a number/],
    [{ AI_SYSTEM_PROMPT_FILE: 'Z:\\does\\not\\exist.txt' }, /could not be read/],
  ])('reports a clear error for %j', (override, pattern) => {
    const result = loadAiConfig(aiEnv(override as Record<string, string>));
    expect(result.usable).toBe(false);
    expect(result.errors.join(' | ')).toMatch(pattern);
  });

  it('requires a Telnyx region mode the source accepts', () => {
    const result = loadAiConfig(aiEnv({ AI_LLM: 'telnyx_kimi_k3', TELNYX_LLM_REGION_MODE: 'sometimes' }));
    expect(result.errors.join(' ')).toMatch(/TELNYX_LLM_REGION_MODE must be preferred or strict/);
  });

  it('describes the config without any credential values', () => {
    const { config } = loadAiConfig(aiEnv());
    expect(JSON.stringify(describeConfig(config))).not.toContain(SECRET);
  });
});

describe('source catalog port', () => {
  it('resolves the source aliases case-insensitively and rejects unknown slugs', () => {
    expect(resolveLlmKey('kimi-k3')).toBe('telnyx_kimi_k3');
    expect(resolveLlmKey('KIMI-K3')).toBe('telnyx_kimi_k3');
    expect(resolveLlmKey('meta-llama/Llama-3.3-70B-Instruct')).toBe('telnyx_llama_3_3_70b_instruct');
    expect(resolveLlmKey('qwen/qwen3.8-27b')).toBe('groq_qwen_3_8_27b');
    expect(resolveLlmKey('GROQ_GPT_OSS_20B')).toBe('groq_gpt_oss_20b');
    expect(resolveLlmKey('made-up')).toBeNull();
  });

  it('keeps the source request parameters per family', () => {
    const spec = (key: string, env: Record<string, string | undefined> = {}) =>
      openAiCompatibleSpec(LLM_CATALOG[key], env)!;
    expect(spec('groq_qwen_3_8_27b').body).toEqual({ temperature: 0.4, reasoning_effort: 'none' });
    expect(spec('groq_gpt_oss_120b').body).toEqual({ temperature: 0.15, reasoning_effort: 'medium' });
    expect(spec('openai_gpt_5_4_mini').body).toEqual({}); // the source sets no temperature for OpenAI
    expect(spec('openai_gpt_5_4_mini')).toMatchObject({ baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' });
    expect(spec('telnyx_kimi_k3').body).toEqual({ temperature: 0.3, region: 'AUS', mode: 'preferred', reasoning_effort: 'none' });
    expect(spec('telnyx_llama_3_3_70b_instruct').body).toEqual({ temperature: 0.3, region: 'AUS', mode: 'preferred' });
    expect(spec('telnyx_deepseek_v4_flash_0731', { TELNYX_LLM_REGION_MODE: 'strict' }).body).toEqual({
      temperature: 0.3,
      region: 'AUS',
      mode: 'strict',
      enable_thinking: false,
      reasoning_effort: 'none',
    });
    expect(spec('telnyx_kimi_k3').baseUrl).toBe('https://api.telnyx.com/v2/ai/openai');
    expect(openAiCompatibleSpec(LLM_CATALOG.gemini_3_flash, {})).toBeNull();
  });
});

describe('provider construction', () => {
  it('fails with the variable name, never a value, when a key is missing at build time', () => {
    const { config } = loadAiConfig(aiEnv());
    expect(() => createProviders(config, { env: aiEnv({ CARTESIA_API_KEY: undefined }) })).toThrow(
      'CARTESIA_API_KEY is required by the selected providers but is not set'
    );
  });

  it('builds the selected providers when the keys are present', () => {
    const { config } = loadAiConfig(aiEnv());
    const providers = createProviders(config, { env: aiEnv() });
    expect([providers.stt.name, providers.llm.name, providers.tts.name]).toEqual(['deepgram', 'groq', 'cartesia']);
  });
});
