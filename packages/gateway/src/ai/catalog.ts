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
  /** The vendor name (groq, openai, telnyx, gemini, or a vendor added in the model registry). */
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /** Extra top-level body fields, as the source's plugin parameters. */
  body: Record<string, unknown>;
  /**
   * Tokens added to max_tokens for a model that reasons before it answers. Its hidden reasoning counts against max_tokens,
   * so without this a long reasoning pass can use the whole budget and leave no reply text at all.
   */
  reasoningTokenAllowance?: number;
  /**
   * Whether the provider's chat endpoint accepts OpenAI-style function calling for this model. Only families whose
   * documentation says so are true; anything unverified stays false, and the model is then used without tools.
   */
  toolCalling: boolean;
  /** How the key is sent: Bearer (the default, left out) or Basic. */
  authScheme?: 'bearer' | 'basic';
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
        toolCalling: true,
      };
    case 'groq-reasoning': {
      // gpt-oss reasons before it answers, and the reasoning is billed against max_tokens. On call 503ec8b2 two replies came
      // back empty after exactly the 220-token budget: the reasoning used it all. Low effort is the right size for one or two
      // spoken sentences, and the reasoning gets its own allowance on top of the reply budget.
      const effort = (env.AI_LLM_REASONING_EFFORT ?? 'low').trim().toLowerCase() || 'low';
      if (!['low', 'medium', 'high'].includes(effort)) throw new Error("AI_LLM_REASONING_EFFORT must be 'low', 'medium' or 'high'");
      const allowanceRaw = (env.AI_LLM_REASONING_TOKENS ?? '').trim();
      const allowance = allowanceRaw === '' ? 1024 : Number(allowanceRaw);
      if (!Number.isInteger(allowance) || allowance < 0 || allowance > 8192) throw new Error('AI_LLM_REASONING_TOKENS must be a whole number from 0 to 8192');
      return {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKeyEnv: 'GROQ_API_KEY',
        model: entry.model,
        body: { temperature: 0.15, reasoning_effort: effort },
        reasoningTokenAllowance: allowance,
        toolCalling: true,
      };
    }
    case 'gemini':
      // Google's OpenAI-compatible endpoint (https://ai.google.dev/gemini-api/docs/openai): base URL .../v1beta/openai/, the
      // key as a Bearer token, streaming supported. Verified against Google's documentation; model ids are Google's own.
      return {
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKeyEnv: 'GEMINI_API_KEY',
        model: entry.model,
        body: {},
        toolCalling: true,
      };
    case 'openai':
      return {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        model: entry.model,
        body: {},
        toolCalling: true,
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
        // Not verified for Telnyx's hosted models: left off until it is confirmed on a real call, so nothing changes for them.
        toolCalling: false,
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
  flux: { provider: 'deepgram-flux', model: 'flux-general-en', implemented: true },
  groq_whisper: { provider: 'groq', model: 'whisper-large-v3-turbo', implemented: true },
  soniox: { provider: 'soniox', model: 'stt-rt-v5', implemented: true },
  'stt-rt-v5': { provider: 'soniox', model: 'stt-rt-v5', implemented: true },
  'ink-whisper': { provider: 'cartesia', model: 'ink-whisper', implemented: true },
};

export const DEFAULT_STT_KEY = 'nova-3';

/** The credential each speech-to-text provider needs (null: no credential is stored for it, so it cannot be selected). */
export const STT_KEY_ENV: Record<SttEntry['provider'], string | null> = {
  deepgram: 'DEEPGRAM_API_KEY',
  'deepgram-flux': 'DEEPGRAM_API_KEY',
  groq: 'GROQ_API_KEY',
  soniox: 'SONIOX_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  assemblyai: null,
};

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
  inworld: { defaultVoice: 'Sarah', implemented: true },
  soniox: { defaultVoice: 'Adrian', implemented: true },
  murf_falcon_2: { defaultVoice: 'en-US-natalie', implemented: true },
  // The source's "murf" entry is Murf's older Gen 2 synthesis. Murf's current documentation describes the Falcon streaming
  // endpoint only, so there is no verified endpoint for Gen 2 and it stays unimplemented rather than guessed.
  murf: { defaultVoice: 'Natalie', implemented: false },
  murf_falcon_2_hi: { defaultVoice: 'Pooja', implemented: true },
  cartesia: { defaultVoice: 'katie', implemented: true },
  sarvam: { defaultVoice: 'shubh', implemented: false },
  elevenlabs: { defaultVoice: 'cgSgspJ2msm6clMCkdW9', implemented: true },
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

/**
 * ElevenLabs text-to-speech (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): POST /v1/text-to-speech/{voice_id}
 * with the key in the xi-api-key header, { text, model_id } as the body and ?output_format=pcm_<rate> for raw signed 16-bit
 * little-endian mono PCM (/stream returns the same audio as it is generated). Voice ids belong to the account, so the voice is
 * entered as an id (the source project's default is kept). The model is the provider's own id, not invented here.
 */
export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
/** The raw PCM rates the output_format parameter documents (pcm_8000 ... pcm_48000). */
export const ELEVENLABS_PCM_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

/**
 * Raw PCM rates each text-to-speech provider documents. The gateway format must be one of them (a rate not listed is an
 * error, never silently resampled); a request is only ever made at exactly the gateway rate.
 */
export const TTS_PCM_RATES: Record<string, number[]> = {
  cartesia: CARTESIA_RAW_SAMPLE_RATES,
  elevenlabs: ELEVENLABS_PCM_RATES,
  murf_falcon_2: [8000, 16000, 24000, 44100, 48000],
  murf_falcon_2_hi: [8000, 16000, 24000, 44100, 48000],
  soniox: [8000, 16000, 24000, 44100, 48000],
  // Inworld documents 8000-48000 Hz; these are the values its page names.
  inworld: [8000, 16000, 22050, 24000, 32000, 44100, 48000],
  deepgram: [8000, 16000, 24000, 32000, 48000],
};

/**
 * Model ids the operator may select per text-to-speech provider, from each provider's documentation (the first is the default).
 * Providers that choose the model by voice (Deepgram Aura) have none.
 */
export const TTS_MODELS: Record<string, string[]> = {
  cartesia: ['sonic-3'],
  elevenlabs: ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_turbo_v2_5'],
  murf_falcon_2: ['falcon-2.1'],
  murf_falcon_2_hi: ['falcon-2.1'],
  soniox: ['tts-rt-v2'],
  inworld: ['inworld-tts-2'],
};

/** The credential each text-to-speech provider needs. */
export const TTS_KEY_ENV: Record<string, string> = {
  deepgram: 'DEEPGRAM_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  murf_falcon_2: 'MURF_API_KEY',
  murf_falcon_2_hi: 'MURF_API_KEY',
  murf: 'MURF_API_KEY',
  inworld: 'INWORLD_API_KEY',
  soniox: 'SONIOX_API_KEY',
};

/** Names for messages. */
export const TTS_PROVIDER_NAMES: Record<string, string> = { cartesia: 'Cartesia', elevenlabs: 'ElevenLabs', murf_falcon_2: 'Murf', murf_falcon_2_hi: 'Murf', soniox: 'Soniox', inworld: 'Inworld', deepgram: 'Deepgram' };

export const MURF_API_URL = 'https://global.api.murf.ai/v1/speech/stream';
export const INWORLD_TTS_URL = 'https://api.inworld.ai/tts/v1/voice:stream';
export const SONIOX_TTS_URL = 'https://tts-rt.soniox.com/tts';

/** deepgram_tts.py: Aura voices use the v1 client on the AU endpoint. */
export const DEEPGRAM_AU_SPEAK_URL = 'https://api.au.deepgram.com/v1/speak';

// ---------------------------------------------------------------------------
// Idle follow-ups (llm_config.py), kept for a later phase
// ---------------------------------------------------------------------------

export const END_CALL_PATTERN = /\s*\*{0,2}\s*(?<!\w)END_CALL(?!\w)\s*\*{0,2}\s*/i;
