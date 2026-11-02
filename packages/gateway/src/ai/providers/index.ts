import { AiConfig, readProviderKey } from '../config.js';
import { activeRegistry } from '../registry/active.js';
import { CreateContext, LlmProtocol, protocolById, SttProtocol, TtsProtocol } from '../registry/protocols.js';
import { ResolvedLlm, ResolvedStt, ResolvedTts } from '../registry/registry.js';
import { sharedLimiter, LimitedTts } from '../tts-limiter.js';
import { deepgramUrl } from './endpoints.js';
import { FetchLike } from './http.js';
import { DeepgramStreamingStt, WebSocketFactory } from './stt-stream.js';
import { AiProviderError, AiStage, LlmProvider, ProviderSet, StreamingSttProvider, SttProvider, TtsProvider } from './types.js';

export * from './types.js';
export { requestWithRetry, redactSecrets } from './http.js';
export type { FetchLike } from './http.js';
export { deepgramUrl, deepgramSpeakUrl } from './endpoints.js';

export interface ProviderFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Build only one provider; the other two become stubs that refuse to run, so only that provider's
   * key is needed. Passive transcription uses 'stt'; the dashboard's LLM and TTS tests use 'llm' / 'tts'.
   */
  only?: AiStage;
  /** Test seam for the streaming recognizer's WebSocket. Production uses Node's built-in one. */
  webSocketFactory?: WebSocketFactory;
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
 * Build the configured STT, LLM and TTS providers. Each model names its provider and protocol in the registry; the protocol builds the
 * client (protocols.ts), so nothing here lists providers. Keys are read from the credential the provider names (the encrypted store
 * first, then the environment) at construction time, and live only inside the client built (never in config, status or logs). Throws a
 * plain Error naming the missing variable (never its value) if a key is absent.
 */
export function createProviders(config: AiConfig, options: ProviderFactoryOptions = {}): ProviderSet {
  const env = options.env ?? process.env;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const registry = activeRegistry();
  const key = (name: string): string => {
    const value = readProviderKey(env, name);
    if (!value) throw new Error(`${name} is required by the selected providers but is not set`);
    return value;
  };
  const want = (stage: AiStage): boolean => !options.only || options.only === stage;
  const context = (model: ResolvedLlm | ResolvedStt | ResolvedTts): CreateContext => {
    if (!model.keyEnv) throw new Error(`${model.stage.toUpperCase()} '${model.key}' has no credential`);
    return {
      config,
      env,
      fetchImpl,
      maxRetries: config.maxRetries,
      sleep: options.sleep,
      apiKey: key(model.keyEnv),
      endpoint: model.endpoint ?? undefined,
      webSocketFactory: options.webSocketFactory,
    };
  };

  // STT
  let stt = stub('stt') as SttProvider;
  if (want('stt')) {
    const model = registry.stt(config.stt.key);
    if (!model || !model.implemented || !model.model) throw new Error(`STT '${config.stt.key}' is not implemented`);
    stt = (protocolById(model.protocol) as SttProtocol).create(context(model), model);
  }

  // Streaming STT (optional, off unless AI_STT_STREAMING). Needs a Deepgram key; without one the batch provider above
  // simply keeps doing the work, so a missing key never blocks a call.
  let sttStream: StreamingSttProvider | undefined;
  if (want('stt') && config.sttStreaming.enabled) {
    const deepgramKey = readProviderKey(env, 'DEEPGRAM_API_KEY');
    if (deepgramKey) {
      const selected = registry.stt(config.stt.key);
      const deepgramSelected = selected?.protocol === 'deepgram-listen';
      sttStream = new DeepgramStreamingStt({
        apiKey: deepgramKey,
        model: deepgramSelected && selected?.model ? selected.model : 'nova-3',
        // As in the batch provider: the multilingual model is selected by language=multi.
        language: config.stt.entry.params.language === 'multi' ? 'multi' : (env.AI_STT_LANGUAGE ?? process.env.AI_STT_LANGUAGE)?.trim() || config.language,
        keyterms: config.stt.keyterms,
        baseUrl: (deepgramSelected ? selected?.endpoint : null) ?? deepgramUrl('AI_DEEPGRAM_LISTEN_URL', env.AI_DEEPGRAM_LISTEN_URL ?? process.env.AI_DEEPGRAM_LISTEN_URL),
        finalizeTimeoutMs: config.sttStreaming.finalizeTimeoutMs,
        warmStandby: options.webSocketFactory === undefined, // a spare idle connection; tests that inject a socket factory count connections
        webSocketFactory: options.webSocketFactory,
      });
    }
  }

  // LLM
  let llm = stub('llm') as LlmProvider;
  if (want('llm')) {
    const model = registry.llm(config.llm.key);
    if (!model || !config.llm.spec) throw new Error(`LLM '${config.llm.key}' is not implemented`);
    llm = (protocolById(model.protocol) as LlmProtocol).create(context(model), model);
  }

  // TTS
  let tts = stub('tts') as TtsProvider;
  if (want('tts')) {
    const model = registry.tts(config.tts.key);
    if (!model || !model.implemented) throw new Error(`TTS '${config.tts.key}' is not implemented`);
    tts = (protocolById(model.protocol) as TtsProtocol).create(context(model), model);
    // Never more than the configured number of simultaneous requests to this provider, process-wide.
    tts = new LimitedTts(tts, sharedLimiter(config.tts.key, config.limits.ttsConcurrency));
  }

  return { stt, llm, tts, ...(sttStream ? { sttStream } : {}) };
}
