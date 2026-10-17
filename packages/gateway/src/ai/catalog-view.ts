import { AiCatalogOption, AiCatalogResponse } from '@sim-gateway/shared';
import {
  CARTESIA_RAW_SAMPLE_RATES,
  CARTESIA_VOICES,
  LLM_CATALOG,
  openAiCompatibleSpec,
  STT_CATALOG,
  TTS_CATALOG,
} from './catalog.js';
import { priceNote } from './pricing.js';

/** Aura-1 voices documented by Deepgram; any other id starting with "aura-" is also accepted. */
const DEEPGRAM_AURA_VOICES = [
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
  'aura-athena-en',
  'aura-hera-en',
  'aura-orion-en',
  'aura-arcas-en',
  'aura-perseus-en',
  'aura-angus-en',
  'aura-orpheus-en',
  'aura-helios-en',
  'aura-zeus-en',
];

/** Deepgram's linear16 output rates for Aura (documented sample_rate values). */
const DEEPGRAM_TTS_RATES = [8000, 16000, 24000, 32000, 48000];

const LANGUAGES = ['en', 'en-US', 'en-AU', 'en-IN', 'hi', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'ru', 'ta', 'te', 'bn', 'mr'];

const STT_LABELS: Record<string, string> = {
  'nova-3': 'Deepgram Nova-3',
  'nova-3-multi': 'Deepgram Nova-3 (multilingual)',
  groq_whisper: 'Groq Whisper large-v3-turbo',
  assemblyai: 'AssemblyAI',
  flux: 'Deepgram Flux',
  soniox: 'Soniox',
  'stt-rt-v5': 'Soniox stt-rt-v5',
  'ink-whisper': 'Cartesia Ink-Whisper',
};

const humanize = (slug: string) => slug.replace(/_/g, ' ');

/**
 * What the dashboard may offer. It is the gateway's own catalog, annotated with what is actually
 * implemented here, so the UI can never list a provider the gateway cannot run as if it worked.
 */
export function buildCatalog(env: Record<string, string | undefined> = {}): AiCatalogResponse {
  const stt: AiCatalogOption[] = Object.entries(STT_CATALOG).map(([key, entry]) => ({
    key,
    label: STT_LABELS[key] ?? key,
    provider: entry.provider,
    model: entry.model,
    implemented: entry.implemented,
    unavailableReason: entry.implemented ? null : 'Not ported to the gateway yet',
    // Every implemented STT here transcribes one finished utterance per request: no partial text while the caller talks.
    streaming: false,
    priceNote: entry.implemented ? priceNote('stt', key) : null,
  }));

  const llm: AiCatalogOption[] = Object.entries(LLM_CATALOG).map(([key, entry]) => {
    let spec = null;
    let error: string | null = null;
    try {
      spec = openAiCompatibleSpec(entry, env);
    } catch (e) {
      error = (e as Error).message;
    }
    const fixed: Record<string, string | number | boolean> = {};
    if (spec) for (const [name, value] of Object.entries(spec.body)) fixed[name] = value as string | number | boolean;
    return {
      key,
      label: humanize(key),
      provider: entry.family === 'groq-qwen' || entry.family === 'groq-reasoning' ? 'groq' : entry.family,
      model: entry.model,
      implemented: spec !== null,
      unavailableReason: spec !== null ? null : (error ?? 'Not ported to the gateway yet'),
      // The only request parameter the operator controls; the rest are set per model family by the gateway.
      supportedParams: spec ? ['maxTokens'] : [],
      fixedParams: spec ? fixed : undefined,
      priceNote: spec ? priceNote('llm', key) : null,
    };
  });

  const tts: AiCatalogOption[] = Object.entries(TTS_CATALOG).map(([key, entry]) => {
    const voices =
      key === 'cartesia'
        ? Object.keys(CARTESIA_VOICES).map((id) => ({ id, label: humanize(id) }))
        : key === 'deepgram'
          ? DEEPGRAM_AURA_VOICES.map((id) => ({ id, label: id }))
          : [];
    return {
      key,
      label: key === 'cartesia' ? 'Cartesia Sonic-3' : key === 'deepgram' ? 'Deepgram Aura' : humanize(key),
      provider: key,
      model: key === 'cartesia' ? 'sonic-3' : null,
      implemented: entry.implemented,
      unavailableReason: entry.implemented ? null : 'Not ported to the gateway yet',
      voices,
      sampleRates: entry.implemented ? (key === 'cartesia' ? CARTESIA_RAW_SAMPLE_RATES : DEEPGRAM_TTS_RATES) : [],
      priceNote: entry.implemented ? priceNote('tts', key) : null,
    };
  });

  return { stt, llm, tts, languages: LANGUAGES };
}
