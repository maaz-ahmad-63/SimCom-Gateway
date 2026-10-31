import { AiCatalogOption, AiCatalogResponse } from '@sim-gateway/shared';
import { priceNote } from './pricing.js';
import { activeRegistry } from './registry/active.js';
import { buildLlmSpec } from './registry/registry.js';

const LANGUAGES = ['en', 'en-US', 'en-AU', 'en-IN', 'hi', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'ru', 'ta', 'te', 'bn', 'mr'];

const SWITCHED_OFF = 'Switched off in the model registry';

/**
 * What the dashboard may offer. It is read from the model registry (the built-in entries are the original catalog, plus whatever
 * was added or switched off on the AI Model Hub), annotated with what an adapter actually implements, so the UI can never list a
 * provider the gateway cannot run as if it worked.
 */
export function buildCatalog(env: Record<string, string | undefined> = {}): AiCatalogResponse {
  const registry = activeRegistry();

  const stt: AiCatalogOption[] = registry.sttKeys().map((key) => {
    const r = registry.stt(key)!;
    const usable = r.implemented && !r.disabled;
    return {
      key,
      label: r.label,
      provider: r.vendor,
      model: r.model,
      keyEnv: r.keyEnv,
      implemented: usable,
      unavailableReason: usable ? null : r.disabled ? SWITCHED_OFF : (r.unavailableReason ?? 'Not ported to the gateway yet'),
      // Every implemented STT here transcribes one finished utterance per request: no partial text while the caller talks.
      streaming: false,
      priceNote: r.implemented ? priceNote('stt', key) : null,
    };
  });

  const llm: AiCatalogOption[] = registry.llmKeys().map((key) => {
    const r = registry.llm(key)!;
    let spec = null;
    let error: string | null = null;
    try {
      spec = buildLlmSpec(r, env);
    } catch (e) {
      error = (e as Error).message;
    }
    const fixed: Record<string, string | number | boolean> = {};
    if (spec) for (const [name, value] of Object.entries(spec.body)) fixed[name] = value as string | number | boolean;
    const usable = spec !== null && !r.disabled;
    return {
      key,
      label: r.label,
      provider: r.vendor,
      model: r.model,
      implemented: usable,
      unavailableReason: usable ? null : r.disabled && spec !== null ? SWITCHED_OFF : (error ?? r.unavailableReason ?? 'Not ported to the gateway yet'),
      // The only request parameter the operator controls; the rest are set per model by the gateway.
      supportedParams: usable ? ['maxTokens'] : [],
      fixedParams: spec ? fixed : undefined,
      priceNote: spec ? priceNote('llm', key) : null,
    };
  });

  const tts: AiCatalogOption[] = registry.ttsKeys().map((key) => {
    const r = registry.tts(key)!;
    const usable = r.implemented && !r.disabled;
    return {
      key,
      label: r.label,
      provider: key,
      model: r.models[0] ?? null,
      // The models the operator may choose from (ids from the provider's documentation); the first is the default.
      models: r.models.map((id) => ({ id, label: id })),
      keyEnv: r.keyEnv,
      implemented: usable,
      unavailableReason: usable ? null : r.disabled ? SWITCHED_OFF : (r.unavailableReason ?? 'Not ported to the gateway yet'),
      voices: r.voices.map((v) => ({ id: v.name, label: v.label ?? v.name })),
      sampleRates: usable ? r.sampleRates : [],
      priceNote: r.implemented ? priceNote('tts', key) : null,
    };
  });

  return { stt, llm, tts, languages: LANGUAGES };
}
