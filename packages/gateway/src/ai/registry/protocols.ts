import { z } from 'zod';
import type { AiConfig } from '../config.js';
import {
  CARTESIA_TTS_URL,
  DEEPGRAM_AU_LISTEN_URL,
  DEEPGRAM_AU_SPEAK_URL,
  ELEVENLABS_API_BASE,
  GROQ_TRANSCRIPTIONS_URL,
  INWORLD_TTS_URL,
  MURF_API_URL,
  SONIOX_TTS_URL,
} from '../catalog.js';
import { deepgramSpeakUrl, deepgramUrl } from '../providers/endpoints.js';
import { FetchLike } from '../providers/http.js';
import { OpenAiCompatibleLlm } from '../providers/llm.js';
import { DeepgramStt, GroqWhisperStt } from '../providers/stt.js';
import { CartesiaInkWhisperStt, DeepgramFluxStt, SonioxStt } from '../providers/stt-more.js';
import { WebSocketFactory } from '../providers/stt-stream.js';
import { CartesiaTts, DeepgramTts, ElevenLabsTts, InworldTts, MurfTts, SonioxTts } from '../providers/tts.js';
import { LlmProvider, SttProvider, TtsProvider } from '../providers/types.js';
import type { ResolvedLlm, ResolvedStt, ResolvedTts } from './registry.js';
import { bodyValueSchema, envValueSchema, Stage, voiceOptionSchema } from './schema.js';

/**
 * The wire protocols the gateway can speak. Each is described once, here: its stage, the settings a model may give it, where it
 * talks to by default, what it can really do, a read-only request that shows whether a key is accepted, and how to build the client.
 * A new API protocol is one class in providers/ plus one entry in PROTOCOLS below; nothing else lists protocols. A different model
 * on a protocol already here is configuration only, and so is any provider that speaks openai-chat at its own base URL.
 */

/** What a protocol does, stated plainly. Shown in the Model Hub; not something a JSON entry can claim. */
export interface Facts {
  streaming: boolean;
  batch: boolean;
  functionCalling: boolean;
  structuredOutput: boolean;
  voiceSelection: boolean;
  languages: 'any' | string[];
  cancellation: boolean;
}

export interface Probe {
  url: string;
  headers: Record<string, string>;
  /** The reply lists models, so a model id can be looked for in it. */
  lists: 'openai-models' | 'soniox-models' | null;
}

export interface CreateContext {
  config: AiConfig;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
  /** The key, read from the credential the provider names. Lives only inside the client that is built. */
  apiKey: string;
  /** Where the registry says to connect (the model's endpoint, or the provider's base URL for a base-URL protocol); undefined: the adapter's own default. */
  endpoint: string | undefined;
  webSocketFactory?: WebSocketFactory;
}

interface ProtocolBase {
  id: string;
  stage: Stage;
  title: string;
  /** The wire format in one line. */
  summary: string;
  endpoint: {
    /** base: the URL is a base that paths are added to; full: it is the whole request URL (a WebSocket URL for wss). */
    kind: 'base' | 'full';
    scheme: 'https' | 'wss';
    /** The adapter's own default, for information (null: the model or provider must give one). */
    default: string | null;
  };
  facts: Facts;
  /** The settings a model of this protocol may carry (strict: anything else is an error). */
  options: z.ZodType<Record<string, unknown>>;
  probe(ctx: { endpoint: string | undefined; key: string; cartesiaVersion?: string; authScheme?: 'bearer' | 'basic' }): Probe | null;
}

export interface LlmProtocol extends ProtocolBase {
  stage: 'llm';
  create(ctx: CreateContext, model: ResolvedLlm): LlmProvider;
}
export interface SttProtocol extends ProtocolBase {
  stage: 'stt';
  create(ctx: CreateContext, model: ResolvedStt): SttProvider;
}
export interface TtsProtocol extends ProtocolBase {
  stage: 'tts';
  create(ctx: CreateContext, model: ResolvedTts): TtsProvider;
}
export type Protocol = LlmProtocol | SttProtocol | TtsProtocol;

const facts = (stage: Stage, over: Partial<Facts> = {}): Facts => ({
  streaming: stage !== 'stt',
  batch: stage !== 'llm',
  functionCalling: false,
  structuredOutput: false,
  voiceSelection: stage === 'tts',
  languages: 'any',
  cancellation: true,
  ...over,
});

// ---------------------------------------------------------------------------------------------- option schemas

const openaiChatOptions = z
  .object({
    /** Fixed top-level request fields (temperature, reasoning controls ...), each a literal or an environment override. */
    body: z.record(z.string().max(64), bodyValueSchema).default({}),
    /** Tokens added to max_tokens for a model that reasons before it answers. */
    reasoningTokenAllowance: z.union([z.number().int().min(0).max(8192), envValueSchema]).optional(),
    /** Whether the provider accepts OpenAI-style function calling for this model. Off until it is confirmed. */
    tools: z.boolean().default(true),
    /** Informational name recorded on call logs. */
    family: z.string().max(40).nullable().optional(),
  })
  .strict();
const sttDeepgramOptions = z.object({ language: z.literal('multi').optional() }).strict();
const sttPlainOptions = z.object({}).strict();
const ttsShared = {
  /** The voice used when AI_TTS_VOICE is not set. */
  voice: z.string().min(1).max(120),
  /** Raw PCM rates the provider documents; the gateway rate must be one of them (never resampled). */
  sampleRates: z.array(z.number().int().min(8000).max(48000)).max(12).default([]),
  /** Named voices, for a dropdown and for providers whose voices are ids (name → id). */
  voices: z.array(voiceOptionSchema).max(200).default([]),
};
/** `model` is the default; more model ids the operator may pick go here. */
const ttsOptions = z.object({ ...ttsShared, models: z.array(z.string().min(1).max(120)).max(30).default([]) }).strict();
const ttsVoiceChoosesModel = z.object(ttsShared).strict();

// ---------------------------------------------------------------------------------------------- the protocols

const sttLanguage = (c: CreateContext) => (c.env.AI_STT_LANGUAGE ?? process.env.AI_STT_LANGUAGE)?.trim() || c.config.language;
const common = (c: CreateContext) => ({ fetchImpl: c.fetchImpl, maxRetries: c.maxRetries, sleep: c.sleep });
const voiceIds = (m: ResolvedTts): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const v of m.voices) if (v.id) map[v.name.toLowerCase()] = v.id;
  return map;
};

export const PROTOCOLS: Protocol[] = [
  {
    id: 'openai-chat',
    stage: 'llm',
    title: 'OpenAI-compatible chat',
    summary: 'POST {base}/chat/completions, Bearer key, server-sent events, optional tools',
    endpoint: { kind: 'base', scheme: 'https', default: null },
    facts: facts('llm', { functionCalling: true, batch: false }),
    options: openaiChatOptions,
    probe: ({ endpoint, key, authScheme }) => (endpoint ? { url: `${endpoint.replace(/\/+$/, '')}/models`, headers: { Authorization: `${authScheme === 'basic' ? 'Basic' : 'Bearer'} ${key}` }, lists: 'openai-models' } : null),
    create: (c, m) => {
      const spec = c.config.llm.spec;
      if (!spec) throw new Error(`LLM '${m.key}' is not implemented`);
      return new OpenAiCompatibleLlm({
        ...common(c),
        spec,
        apiKey: c.apiKey,
        firstTokenTimeoutMs: c.config.timeoutsMs.llmFirstToken,
        totalTimeoutMs: c.config.timeoutsMs.llmTotal,
        maxTokens: c.config.limits.maxLlmTokens,
      });
    },
  },
  {
    id: 'deepgram-listen',
    stage: 'stt',
    title: 'Deepgram speech-to-text (nova)',
    summary: 'POST /v1/listen per utterance; the same model also serves the optional streaming recognizer',
    endpoint: { kind: 'full', scheme: 'https', default: DEEPGRAM_AU_LISTEN_URL },
    facts: facts('stt', { streaming: true }),
    options: sttDeepgramOptions,
    probe: ({ key }) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${key}` }, lists: null }),
    create: (c, m) =>
      new DeepgramStt({
        ...common(c),
        apiKey: c.apiKey,
        model: m.model!,
        // The multilingual model is selected by language=multi; without it nova-3-multi would behave like nova-3.
        language: m.params.language === 'multi' ? 'multi' : c.config.language,
        keyterms: c.config.stt.keyterms,
        baseUrl: c.endpoint ?? deepgramUrl('AI_DEEPGRAM_LISTEN_URL', c.env.AI_DEEPGRAM_LISTEN_URL ?? process.env.AI_DEEPGRAM_LISTEN_URL),
        timeoutMs: c.config.timeoutsMs.stt,
      }),
  },
  {
    id: 'deepgram-flux',
    stage: 'stt',
    title: 'Deepgram Flux',
    summary: 'WebSocket /v2/listen, one utterance per request (the model follows the language)',
    endpoint: { kind: 'full', scheme: 'wss', default: 'wss://api.deepgram.com/v2/listen' },
    facts: facts('stt', { languages: ['en'] }),
    options: sttPlainOptions,
    probe: ({ key }) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${key}` }, lists: null }),
    create: (c) => new DeepgramFluxStt({ ...common(c), apiKey: c.apiKey, language: sttLanguage(c), baseUrl: c.endpoint, timeoutMs: c.config.timeoutsMs.stt, webSocketFactory: c.webSocketFactory }),
  },
  {
    id: 'groq-whisper',
    stage: 'stt',
    title: 'Groq Whisper',
    summary: 'POST /openai/v1/audio/transcriptions (multipart WAV)',
    endpoint: { kind: 'full', scheme: 'https', default: GROQ_TRANSCRIPTIONS_URL },
    facts: facts('stt'),
    options: sttPlainOptions,
    probe: ({ key }) => ({ url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${key}` }, lists: 'openai-models' }),
    create: (c, m) =>
      new GroqWhisperStt({
        ...common(c),
        apiKey: c.apiKey,
        model: m.model!,
        // AI_STT_LANGUAGE can pin what the caller speaks without changing the language the agent writes in.
        language: sttLanguage(c),
        prompt: (c.env.AI_STT_PROMPT ?? process.env.AI_STT_PROMPT)?.trim() || undefined,
        url: c.endpoint,
        timeoutMs: c.config.timeoutsMs.stt,
      } as ConstructorParameters<typeof GroqWhisperStt>[0]),
  },
  {
    id: 'soniox-stt',
    stage: 'stt',
    title: 'Soniox speech-to-text',
    summary: 'WebSocket wss://stt-rt.soniox.com/transcribe-websocket, one utterance per request',
    endpoint: { kind: 'full', scheme: 'wss', default: 'wss://stt-rt.soniox.com/transcribe-websocket' },
    facts: facts('stt'),
    options: sttPlainOptions,
    probe: ({ key }) => ({ url: 'https://api.soniox.com/v1/models', headers: { Authorization: `Bearer ${key}` }, lists: 'soniox-models' }),
    create: (c, m) => new SonioxStt({ ...common(c), apiKey: c.apiKey, model: m.model!, language: sttLanguage(c), url: c.endpoint, timeoutMs: c.config.timeoutsMs.stt, webSocketFactory: c.webSocketFactory }),
  },
  {
    id: 'cartesia-stt',
    stage: 'stt',
    title: 'Cartesia Ink-Whisper',
    summary: 'POST /stt (multipart WAV)',
    endpoint: { kind: 'full', scheme: 'https', default: 'https://api.cartesia.ai/stt' },
    facts: facts('stt'),
    options: sttPlainOptions,
    probe: ({ key, cartesiaVersion }) => ({ url: 'https://api.cartesia.ai/voices?limit=1', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': cartesiaVersion ?? '2026-08-14' }, lists: null }),
    create: (c, m) =>
      new CartesiaInkWhisperStt({
        ...common(c),
        apiKey: c.apiKey,
        model: m.model ?? undefined,
        language: sttLanguage(c),
        version: c.env.CARTESIA_VERSION ?? process.env.CARTESIA_VERSION,
        url: c.endpoint,
        timeoutMs: c.config.timeoutsMs.stt,
      }),
  },
  {
    id: 'inworld-tts',
    stage: 'tts',
    title: 'Inworld TTS',
    summary: 'POST /tts/v1/voice:stream, Basic key, newline-delimited JSON with base64 PCM',
    endpoint: { kind: 'full', scheme: 'https', default: INWORLD_TTS_URL },
    facts: facts('tts'),
    options: ttsOptions,
    probe: ({ key }) => ({ url: 'https://api.inworld.ai/voices/v1/voices?pageSize=1', headers: { Authorization: `Basic ${key}` }, lists: null }),
    create: (c, m) => new InworldTts({ ...common(c), apiKey: c.apiKey, voice: c.config.tts.voice, sampleRates: m.sampleRates, model: c.config.tts.model ?? m.model ?? undefined, url: c.endpoint, timeoutMs: c.config.timeoutsMs.tts }),
  },
  {
    id: 'cartesia-tts',
    stage: 'tts',
    title: 'Cartesia TTS',
    summary: 'POST /tts/bytes, raw PCM stream',
    endpoint: { kind: 'full', scheme: 'https', default: CARTESIA_TTS_URL },
    facts: facts('tts'),
    options: ttsOptions,
    probe: ({ key, cartesiaVersion }) => ({ url: 'https://api.cartesia.ai/voices?limit=1', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': cartesiaVersion ?? '2026-08-14' }, lists: null }),
    create: (c, m) =>
      new CartesiaTts({
        ...common(c),
        apiKey: c.apiKey,
        voices: voiceIds(m),
        voice: c.config.tts.voice,
        model: c.config.tts.model ?? m.model ?? undefined,
        language: c.config.language,
        version: c.env.CARTESIA_VERSION ?? process.env.CARTESIA_VERSION,
        url: c.endpoint,
        timeoutMs: c.config.timeoutsMs.tts,
      }),
  },
  {
    id: 'deepgram-tts',
    stage: 'tts',
    title: 'Deepgram Aura',
    summary: 'POST /v1/speak, linear16 stream (the voice selects the model)',
    endpoint: { kind: 'full', scheme: 'https', default: DEEPGRAM_AU_SPEAK_URL },
    facts: facts('tts'),
    options: ttsVoiceChoosesModel,
    probe: ({ key }) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${key}` }, lists: null }),
    create: (c) => new DeepgramTts({ ...common(c), apiKey: c.apiKey, voice: c.config.tts.voice, baseUrl: c.endpoint ?? deepgramSpeakUrl(c.env.AI_DEEPGRAM_SPEAK_URL ?? process.env.AI_DEEPGRAM_SPEAK_URL), timeoutMs: c.config.timeoutsMs.tts }),
  },
  {
    id: 'elevenlabs-tts',
    stage: 'tts',
    title: 'ElevenLabs',
    summary: 'POST /v1/text-to-speech/{voice}/stream?output_format=pcm_<rate>',
    endpoint: { kind: 'base', scheme: 'https', default: ELEVENLABS_API_BASE },
    facts: facts('tts'),
    options: ttsOptions,
    probe: ({ key }) => ({ url: 'https://api.elevenlabs.io/v1/models', headers: { 'xi-api-key': key }, lists: null }),
    create: (c, m) =>
      new ElevenLabsTts({
        ...common(c),
        apiKey: c.apiKey,
        voice: c.config.tts.voice,
        // AI_TTS_MODEL, then the legacy ELEVENLABS_MODEL variable, then the model this entry names.
        model: c.config.tts.model ?? (c.env.ELEVENLABS_MODEL?.trim() || m.model || undefined),
        baseUrl: c.endpoint,
        timeoutMs: c.config.timeoutsMs.tts,
      }),
  },
  {
    id: 'murf-tts',
    stage: 'tts',
    title: 'Murf Falcon',
    summary: 'POST /v1/speech/stream (Falcon), raw PCM',
    endpoint: { kind: 'full', scheme: 'https', default: MURF_API_URL },
    facts: facts('tts'),
    options: ttsOptions,
    probe: ({ key }) => ({ url: 'https://api.murf.ai/v1/speech/voices', headers: { 'api-key': key }, lists: null }),
    create: (c, m) => new MurfTts({ ...common(c), apiKey: c.apiKey, voice: c.config.tts.voice, rateKey: m.key, sampleRates: m.sampleRates, model: c.config.tts.model ?? m.model ?? undefined, url: c.endpoint, timeoutMs: c.config.timeoutsMs.tts }),
  },
  {
    id: 'soniox-tts',
    stage: 'tts',
    title: 'Soniox TTS',
    summary: 'POST https://tts-rt.soniox.com/tts, raw PCM body',
    endpoint: { kind: 'full', scheme: 'https', default: SONIOX_TTS_URL },
    facts: facts('tts'),
    options: ttsOptions,
    probe: ({ key }) => ({ url: 'https://api.soniox.com/v1/models', headers: { Authorization: `Bearer ${key}` }, lists: 'soniox-models' }),
    create: (c, m) => new SonioxTts({ ...common(c), apiKey: c.apiKey, voice: c.config.tts.voice, language: c.config.language, sampleRates: m.sampleRates, model: c.config.tts.model ?? m.model ?? undefined, url: c.endpoint, timeoutMs: c.config.timeoutsMs.tts }),
  },
];

const BY_ID = new Map(PROTOCOLS.map((p) => [p.id, p]));
export const protocolById = (id: string | null): Protocol | undefined => (id ? BY_ID.get(id) : undefined);
export const protocolsFor = (stage: Stage): Protocol[] => PROTOCOLS.filter((p) => p.stage === stage);

/** "Did you mean ...": the protocols of the stage whose names contain, or are contained in, what was typed. */
export function suggestProtocols(stage: Stage, typed: string): string[] {
  const t = typed.toLowerCase();
  const ofStage = protocolsFor(stage).map((p) => p.id);
  const close = ofStage.filter((id) => id.includes(t) || t.includes(id.split('-')[0]));
  return close.length > 0 ? close : ofStage;
}
