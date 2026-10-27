import { AiConfig, readProviderKey } from '../config.js';
import { FetchLike } from './http.js';
import { OpenAiCompatibleLlm } from './llm.js';
import { DeepgramStt, GroqWhisperStt } from './stt.js';
import { CartesiaTts, DeepgramTts } from './tts.js';
import { sharedLimiter, LimitedTts } from '../tts-limiter.js';
import { AiProviderError, AiStage, LlmProvider, ProviderSet, SttProvider, TtsProvider } from './types.js';

export * from './types.js';
export { requestWithRetry, redactSecrets } from './http.js';
export type { FetchLike } from './http.js';

export interface ProviderFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Build only one provider; the other two become stubs that refuse to run, so only that provider's
   * key is needed. Passive transcription uses 'stt'; the dashboard's LLM and TTS tests use 'llm' / 'tts'.
   */
  only?: AiStage;
}

function stub(stage: AiStage): ProviderSet[AiStage] {
  const refuse = () => new AiProviderError('not-selected', stage, 'this provider was not built for this operation');
  if (stage === 'stt') {
    const stt: SttProvider = {
      name: 'disabled',
      async transcribe() {
        throw refuse();
      },
    };
    return stt;
  }
  if (stage === 'llm') {
    const llm: LlmProvider = {
      name: 'disabled',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw refuse();
      },
    };
    return llm;
  }
  const tts: TtsProvider = {
    name: 'disabled',
    async synthesize() {
      throw refuse();
    },
  };
  return tts;
}

/**
 * Optional override of the Deepgram text-to-speech endpoint (the default is the AU region, as in the source project),
 * for comparing regions. The API key is sent to this URL, so it must be an https deepgram.com host.
 */
export function deepgramUrl(name: string, value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:' || !(url.hostname === 'deepgram.com' || url.hostname.endsWith('.deepgram.com'))) {
    throw new Error(`${name} must be an https URL on deepgram.com (the API key is sent there)`);
  }
  return url.toString();
}

export function deepgramSpeakUrl(value: string | undefined): string | undefined {
  return deepgramUrl('AI_DEEPGRAM_SPEAK_URL', value);
}

/**
 * Build the configured STT, LLM and TTS providers. Keys are read from the environment here, at
 * construction time, and live only inside the provider objects (never in config, status or logs).
 * Throws a plain Error naming the missing variable (never its value) if a key is absent.
 */
export function createProviders(config: AiConfig, options: ProviderFactoryOptions = {}): ProviderSet {
  const env = options.env ?? process.env;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const key = (name: string): string => {
    const value = readProviderKey(env, name);
    if (!value) throw new Error(`${name} is required by the selected providers but is not set`);
    return value;
  };
  const common = { fetchImpl, maxRetries: config.maxRetries, sleep: options.sleep };
  const want = (stage: AiStage): boolean => !options.only || options.only === stage;

  // STT
  let stt = stub('stt') as SttProvider;
  if (want('stt')) {
    const sttEntry = config.stt.entry;
    if (!sttEntry.implemented || !sttEntry.model) {
      throw new Error(`STT '${config.stt.key}' is not implemented`);
    }
    stt =
      sttEntry.provider === 'deepgram'
        ? new DeepgramStt({
            ...common,
            apiKey: key('DEEPGRAM_API_KEY'),
            model: sttEntry.model,
            // The multilingual model is selected by language=multi; without it nova-3-multi would behave like nova-3.
            language: config.stt.key === 'nova-3-multi' ? 'multi' : config.language,
            keyterms: config.stt.keyterms,
            baseUrl: deepgramUrl('AI_DEEPGRAM_LISTEN_URL', env.AI_DEEPGRAM_LISTEN_URL ?? process.env.AI_DEEPGRAM_LISTEN_URL),
            timeoutMs: config.timeoutsMs.stt,
          })
        : new GroqWhisperStt({
            ...common,
            apiKey: key('GROQ_API_KEY'),
            model: sttEntry.model,
            // AI_STT_LANGUAGE can pin what the caller speaks without changing the language the agent writes in.
            language: (env.AI_STT_LANGUAGE ?? process.env.AI_STT_LANGUAGE)?.trim() || config.language,
            prompt: (env.AI_STT_PROMPT ?? process.env.AI_STT_PROMPT)?.trim() || undefined,
            timeoutMs: config.timeoutsMs.stt,
          });
  }

  // LLM
  let llm = stub('llm') as LlmProvider;
  if (want('llm')) {
    const spec = config.llm.spec;
    if (!spec) throw new Error(`LLM '${config.llm.key}' is not implemented`);
    llm = new OpenAiCompatibleLlm({
      ...common,
      spec,
      apiKey: key(spec.apiKeyEnv),
      firstTokenTimeoutMs: config.timeoutsMs.llmFirstToken,
      totalTimeoutMs: config.timeoutsMs.llmTotal,
      maxTokens: config.limits.maxLlmTokens,
    });
  }

  // TTS
  let tts = stub('tts') as TtsProvider;
  if (want('tts')) {
    tts =
      config.tts.key === 'cartesia'
        ? new CartesiaTts({
            ...common,
            apiKey: key('CARTESIA_API_KEY'),
            voice: config.tts.voice,
            language: config.language,
            version: env.CARTESIA_VERSION ?? process.env.CARTESIA_VERSION,
            timeoutMs: config.timeoutsMs.tts,
          })
        : new DeepgramTts({
            ...common,
            apiKey: key('DEEPGRAM_API_KEY'),
            voice: config.tts.voice,
            baseUrl: deepgramSpeakUrl(env.AI_DEEPGRAM_SPEAK_URL ?? process.env.AI_DEEPGRAM_SPEAK_URL),
            timeoutMs: config.timeoutsMs.tts,
          });
    // Never more than the configured number of simultaneous requests to this provider, process-wide.
    tts = new LimitedTts(tts, sharedLimiter(config.tts.key, config.limits.ttsConcurrency));
  }

  return { stt, llm, tts };
}
