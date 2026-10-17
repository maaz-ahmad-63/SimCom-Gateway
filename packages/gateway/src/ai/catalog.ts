/**
 * Provider and model tables ported verbatim from the labs-sizh-voicely source project
 * (services/llm/llm_config.py, services/llm/service_factory.py, services/stt/stt_config.py,
 * services/tts/*.py). Slugs, model ids, voices, default parameters and base URLs are the source's own;
 * nothing here was invented. The source drives these through LiveKit plugins (Python); this gateway
 * calls the providers' HTTP APIs directly, so only providers with an implementation in
 * `providers/` are marked `implemented`. The rest stay listed so choosing one fails with a clear
 * message instead of silently falling back.
 */

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export type LlmFamily = 'groq-qwen' | 'groq-reasoning' | 'openai' | 'gemini' | 'telnyx';

export interface LlmEntry {
  family: LlmFamily;
  model: string;
}

export const LLM_CATALOG: Record<string, LlmEntry> = {
  // Groq. The source keeps the legacy "groq_llama_3_3" slug pointed at the Qwen model.
  groq_llama_3_3: { family: 'groq-qwen', model: 'qwen/qwen3.8-27b' },
  groq_gpt_oss_120b: { family: 'groq-reasoning', model: 'openai/gpt-oss-120b' },
  groq_gpt_oss_20b: { family: 'groq-reasoning', model: 'openai/gpt-oss-20b' },
  groq_qwen_3_6_27b: { family: 'groq-qwen', model: 'qwen/qwen3.8-27b' },
  groq_qwen_3_8_27b: { family: 'groq-qwen', model: 'qwen/qwen3.8-27b' },
  // Google Gemini (not ported: the source uses Google's own SDK)
  gemini_3_flash: { family: 'gemini', model: 'gemini-3.8-flash' },
  // OpenAI
  openai_gpt_4_1_mini: { family: 'openai', model: 'gpt-4.1-mini' },
  openai_gpt_5_2: { family: 'openai', model: 'gpt-5.2' },
  openai_gpt_5_4: { family: 'openai', model: 'gpt-5.4' },
  openai_gpt_5_4_mini: { family: 'openai', model: 'gpt-5.4-mini' },
  // Telnyx (OpenAI-compatible, Australian region preference)
  telnyx_kimi_k2_6: { family: 'telnyx', model: 'moonshotai/Kimi-K2.6' },
  telnyx_deepseek_v4_flash_0731: { family: 'telnyx', model: 'deepseek-ai/DeepSeek-V4-Flash-0731' },
  telnyx_llama_3_3_70b_instruct: { family: 'telnyx', model: 'meta-llama/Llama-3.3-70B-Instruct' },
  telnyx_kimi_k3: { family: 'telnyx', model: 'moonshotai/Kimi-K3' },
};

export const DEFAULT_LLM_KEY = 'groq_qwen_3_8_27b';

/** service_factory.VARTA_LLM_ALIASES */
export const LLM_ALIASES: Record<string, string> = {
  'qwen3.8-27b': 'groq_qwen_3_8_27b',
  'qwen/qwen3.8-27b': 'groq_qwen_3_8_27b',
  'gpt-oss-120b': 'groq_gpt_oss_120b',
  'openai/gpt-oss-120b': 'groq_gpt_oss_120b',
  'moonshotai/Kimi-K3': 'telnyx_kimi_k3',
  'moonshotai/Kimi K3': 'telnyx_kimi_k3',
  'moonshotai/kimi-k3': 'telnyx_kimi_k3',
  'telnyx/moonshotai/Kimi-K3': 'telnyx_kimi_k3',
  'telnyx/moonshotai/kimi-k3': 'telnyx_kimi_k3',
  'telnyx-kimi-k3': 'telnyx_kimi_k3',
  'kimi-k3': 'telnyx_kimi_k3',
  kimi_k3: 'telnyx_kimi_k3',
  'Llama-3.3-70B-Instruct': 'telnyx_llama_3_3_70b_instruct',
  'llama-3.3-70b-instruct': 'telnyx_llama_3_3_70b_instruct',
  'meta-llama/Llama-3.3-70B-Instruct': 'telnyx_llama_3_3_70b_instruct',
  'meta-llama/llama-3.3-70b-instruct': 'telnyx_llama_3_3_70b_instruct',
  'telnyx/meta-llama/Llama-3.3-70B-Instruct': 'telnyx_llama_3_3_70b_instruct',
  'telnyx-llama-3-3-70b-instruct': 'telnyx_llama_3_3_70b_instruct',
  telnyx_llama_3_3: 'telnyx_llama_3_3_70b_instruct',
  'llama-3.3-70b': 'telnyx_llama_3_3_70b_instruct',
  'moonshotai/Kimi-K2.6': 'telnyx_kimi_k2_6',
  'deepseek-ai/DeepSeek-V4-Flash-0731': 'telnyx_deepseek_v4_flash_0731',
};

/** Resolve a slug or alias (case-insensitive) to a catalog key, or null if it is unknown. */
export function resolveLlmKey(setting: string): string | null {
  const requested = setting.trim();
  if (requested in LLM_CATALOG) return requested;
  if (requested in LLM_ALIASES) return LLM_ALIASES[requested];
  const lower = requested.toLowerCase();
  for (const [alias, target] of Object.entries(LLM_ALIASES)) {
    if (alias.toLowerCase() === lower) return target;
  }
  for (const key of Object.keys(LLM_CATALOG)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

export interface OpenAiCompatibleSpec {
  provider: 'groq' | 'openai' | 'telnyx';
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /** Extra top-level body fields, as the source's plugin parameters. */
  body: Record<string, unknown>;
}

/**
 * Request parameters per family, exactly as the source's *_llm.py builds them. Returns null for
 * families that have no HTTP port here (gemini).
 */
export function openAiCompatibleSpec(
  entry: LlmEntry,
  env: Record<string, string | undefined>
): OpenAiCompatibleSpec | null {
  switch (entry.family) {
    case 'groq-qwen':
      return {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        model: entry.model,
        body: { temperature: 0.4, reasoning_effort: 'none' },
      };
    case 'groq-reasoning':
      return {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        model: entry.model,
        body: { temperature: 0.15, reasoning_effort: 'medium' },
      };
    case 'openai':
      return {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        model: entry.model,
        body: {},
      };
    case 'telnyx': {
      const mode = (env.TELNYX_LLM_REGION_MODE ?? 'preferred').trim().toLowerCase() || 'preferred';
      if (mode !== 'preferred' && mode !== 'strict') {
        throw new Error('TELNYX_LLM_REGION_MODE must be preferred or strict');
      }
      const extra: Record<string, unknown> = { region: 'AUS', mode };
      if (entry.model === 'moonshotai/Kimi-K3') {
        extra.reasoning_effort = 'none';
      } else if (entry.model !== 'meta-llama/Llama-3.3-70B-Instruct') {
        // Llama 3.3 is a non-reasoning model: no thinking controls.
        extra.enable_thinking = false;
        extra.reasoning_effort = 'none';
      }
      return {
        provider: 'telnyx',
        baseUrl: 'https://api.telnyx.com/v2/ai/openai',
        apiKeyEnv: 'TELNYX_API_KEY',
        model: entry.model,
        body: { temperature: 0.3, ...extra },
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export interface SttEntry {
  provider: 'deepgram' | 'deepgram-flux' | 'groq' | 'assemblyai' | 'soniox' | 'cartesia';
  model: string | null;
  /** Has an HTTP implementation in providers/stt.ts. */
  implemented: boolean;
}

/** stt_config.stt_configurations */
export const STT_CATALOG: Record<string, SttEntry> = {
  assemblyai: { provider: 'assemblyai', model: null, implemented: false },
  'nova-3': { provider: 'deepgram', model: 'nova-3', implemented: true },
  'nova-3-multi': { provider: 'deepgram', model: 'nova-3', implemented: true },
  flux: { provider: 'deepgram-flux', model: 'flux-general-en', implemented: false },
  groq_whisper: { provider: 'groq', model: 'whisper-large-v3-turbo', implemented: true },
  soniox: { provider: 'soniox', model: 'stt-rt-v5', implemented: false },
  'stt-rt-v5': { provider: 'soniox', model: 'stt-rt-v5', implemented: false },
  'ink-whisper': { provider: 'cartesia', model: 'ink-whisper', implemented: false },
};

export const DEFAULT_STT_KEY = 'nova-3';

/** deepgram_stt.py: AU endpoint for English, global endpoint for other languages. */
export const DEEPGRAM_AU_LISTEN_URL = 'https://api.au.deepgram.com/v1/listen';
export const DEEPGRAM_GLOBAL_LISTEN_URL = 'https://api.deepgram.com/v1/listen';
export const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TtsEntry {
  defaultVoice: string;
  implemented: boolean;
}

/** service_factory.TTS_VOICE_DEFAULTS */
export const TTS_CATALOG: Record<string, TtsEntry> = {
  deepgram: { defaultVoice: 'flux-alexis-en', implemented: true },
  inworld: { defaultVoice: 'Sarah', implemented: false },
  soniox: { defaultVoice: 'Adrian', implemented: false },
  murf_falcon_2: { defaultVoice: 'en-US-natalie', implemented: false },
  murf: { defaultVoice: 'Natalie', implemented: false },
  murf_falcon_2_hi: { defaultVoice: 'Pooja', implemented: false },
  cartesia: { defaultVoice: 'katie', implemented: true },
  sarvam: { defaultVoice: 'shubh', implemented: false },
  elevenlabs: { defaultVoice: 'cgSgspJ2msm6clMCkdW9', implemented: false },
};

/**
 * The source defaults to deepgram with the 'flux-alexis-en' voice, which uses Deepgram's v2 streaming
 * protocol and is not ported; Cartesia's raw PCM output is documented, so it is the default here.
 */
export const DEFAULT_TTS_KEY = 'cartesia';

/** cartesia_tts.cartesia_voices */
export const CARTESIA_VOICES: Record<string, string> = {
  katie: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
  brooke: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
  kiefer: '228fca29-3a0a-435c-8728-5cb483251068',
  riya: 'faf0731e-dfb9-4cfc-8119-259a79b27e12',
  cathy: 'e8e5fffb-252c-436d-b842-8879b84445b6',
  tessa: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b',
  cindy: '1242fb95-7ddd-44ac-8a05-9e8a22a6137d',
  kyle: 'c961b81c-a935-4c17-bfb3-ba2239de8c2f',
  carolina: 'f9836c6e-a0bd-460e-9d3c-f7299fa60f94',
  southern_belle: '69267136-1bdc-412f-ad78-0caad210fb40',
  british_lady: '7360f116-6306-4e9a-b487-1235f35a0f21',
  arushi: '95d51f79-c397-46f9-b49a-23763d3eaa2d',
  celine: 'ca566b43-944e-4474-b494-7d9f0695f307',
};

/** cartesia_tts.py model default. */
export const CARTESIA_MODEL = 'sonic-3';
export const CARTESIA_TTS_URL = 'https://api.cartesia.ai/tts/bytes';
/** Header value required by Cartesia's current API reference; override with CARTESIA_VERSION if it changes. */
export const CARTESIA_DEFAULT_VERSION = '2026-08-14';
/** Raw sample rates the Cartesia bytes endpoint documents. */
export const CARTESIA_RAW_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

/** deepgram_tts.py: Aura voices use the v1 client on the AU endpoint. */
export const DEEPGRAM_AU_SPEAK_URL = 'https://api.au.deepgram.com/v1/speak';

// ---------------------------------------------------------------------------
// Idle follow-ups (llm_config.py), kept for a later phase
// ---------------------------------------------------------------------------

export const END_CALL_PATTERN = /\s*\*{0,2}\s*(?<!\w)END_CALL(?!\w)\s*\*{0,2}\s*/i;
