/**
 * What each LLM provider in the registry is known to offer for repeated prompt context, stated from the providers' own documentation
 * as read when this was written (see `sources`), and nothing more. The gateway talks to all of them through the same stateless
 * chat-completions protocol, so what it can do is limited to two things:
 *
 *  - keep the beginning of every request IDENTICAL from call to call (the campaign's runtime rules and prompt come first, byte for
 *    byte, and everything that changes per call or per turn comes after), which is the condition every automatic prefix cache has; and
 *  - read back and record the cached-token figure when the provider reports one.
 *
 * It does not use a persistent server-side conversation or session: none of these providers exposes one through this protocol, and a
 * stateless request is what keeps every call's history separate. Whether a given request was actually served from a cache is only
 * ever known from the provider's usage reply, never assumed.
 */
export interface LlmCachingInfo {
  vendor: string;
  promptCaching: 'automatic' | 'automatic-on-supported-models' | 'provider-dependent' | 'not-documented';
  /** Whether the provider is documented to put the cached-token count in its usage reply (the field read is prompt_tokens_details.cached_tokens). */
  reportsCachedTokens: 'documented' | 'unconfirmed';
  /** The shortest prompt that can be cached, when the documentation states one. */
  minimumPrefixTokens: number | null;
  /** A reusable server-side conversation the gateway could continue. None is available through the chat-completions protocol. */
  persistentSession: 'not-available-through-this-api';
  note: string;
  sources: string[];
}

const SESSION = 'not-available-through-this-api' as const;

const INFO: Record<string, Omit<LlmCachingInfo, 'vendor'>> = {
  openai: {
    promptCaching: 'automatic',
    reportsCachedTokens: 'documented',
    minimumPrefixTokens: 1024,
    persistentSession: SESSION,
    note: 'Automatic for prompts of 1,024 tokens or more, on an exact repeated prefix; no request change is needed. The gateway also sends a prompt_cache_key per campaign version so requests that share the prefix are routed together, and asks for usage in the stream so the cached count is reported.',
    sources: ['https://docs.litellm.ai/docs/completion/prompt_caching'],
  },
  groq: {
    promptCaching: 'automatic-on-supported-models',
    reportsCachedTokens: 'documented',
    minimumPrefixTokens: null,
    persistentSession: SESSION,
    note: 'Automatic on a limited list of Groq models, on an exact repeated prefix; best effort, so a hit is never guaranteed; entries expire after about two hours unused. Whether the selected model is on the list is on Groq\'s page.',
    sources: ['https://console.groq.com/docs/prompt-caching'],
  },
  gemini: {
    promptCaching: 'provider-dependent',
    reportsCachedTokens: 'unconfirmed',
    minimumPrefixTokens: null,
    persistentSession: SESSION,
    note: 'Gemini has implicit caching on its native API, but through the OpenAI-compatible endpoint the gateway uses it is not confirmed that the cached count is returned, so cache use may not be visible here.',
    sources: ['https://discuss.ai.google.dev/t/question-with-usage-in-openai-compatibility/98760'],
  },
  telnyx: {
    promptCaching: 'provider-dependent',
    reportsCachedTokens: 'unconfirmed',
    minimumPrefixTokens: null,
    persistentSession: SESSION,
    note: 'Telnyx lists a cached-input price for some models, but how a request earns it and where the count appears in the usage reply are not documented in what was found; cache use is recorded only if the reply carries a recognised field.',
    sources: ['https://developers.telnyx.com/docs/inference/models/pricing.md'],
  },
  inworld: {
    promptCaching: 'provider-dependent',
    reportsCachedTokens: 'documented',
    minimumPrefixTokens: null,
    persistentSession: SESSION,
    note: 'Inworld Router passes implicit provider caching through (and keeps a conversation on one provider) and reports savings in prompt_tokens_details. Whether a hit happens depends on the underlying model.',
    sources: ['https://docs.inworld.ai/router/capabilities/caching'],
  },
};

export function describeLlmCaching(vendor: string): LlmCachingInfo {
  const known = INFO[vendor.toLowerCase()];
  if (known) return { vendor, ...known };
  return {
    vendor,
    promptCaching: 'not-documented',
    reportsCachedTokens: 'unconfirmed',
    minimumPrefixTokens: null,
    persistentSession: SESSION,
    note: 'No caching behaviour is documented for this provider here. Requests are still sent with a stable prefix, and any cached-token figure in the reply is recorded.',
    sources: [],
  };
}
