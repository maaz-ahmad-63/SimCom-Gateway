import { describe, expect, it } from 'vitest';
import type { AiCatalogResponse } from '@sim-gateway/shared';
import { selectTtsProvider } from '../src/lib/ai-settings-form';
import { filterVoices, voiceDetails, voiceListNotice, TtsVoice, TtsVoicesResponse } from '../src/lib/tts-voices';

const V: TtsVoice[] = [
  { id: 'Ashley', name: 'Ashley', language: 'en-US', gender: 'female', description: 'warm, friendly' },
  { id: 'Dennis', name: 'Dennis', language: 'en-GB', gender: 'male', description: null },
  { id: 'hi-IN-kabir', name: 'Kabir', language: 'hi-IN', gender: 'male', description: 'calm' },
];

describe('voice search', () => {
  it('matches every word across name, id, language, gender and description, case-insensitively', () => {
    expect(filterVoices(V, '').map((v) => v.id)).toEqual(['Ashley', 'Dennis', 'hi-IN-kabir']);
    expect(filterVoices(V, 'MALE').map((v) => v.id)).toEqual(['Ashley', 'Dennis', 'hi-IN-kabir']); // "female" contains "male"
    expect(filterVoices(V, 'male hi').map((v) => v.id)).toEqual(['hi-IN-kabir']);
    expect(filterVoices(V, 'en-gb').map((v) => v.id)).toEqual(['Dennis']);
    expect(filterVoices(V, 'friendly').map((v) => v.id)).toEqual(['Ashley']);
    expect(filterVoices(V, 'nobody')).toEqual([]);
  });

  it('shows only the details the provider reported', () => {
    expect(voiceDetails(V[0])).toBe('en-US · female · warm, friendly');
    expect(voiceDetails({ id: 'x', name: 'x', language: null, gender: null, description: null })).toBe('');
  });

  it('says where the list came from, and why it is not the live one', () => {
    const live: TtsVoicesResponse = { tts: 'inworld', keyEnv: 'INWORLD_API_KEY', model: null, source: 'provider', voices: V, error: null };
    expect(voiceListNotice(live)).toEqual({ tone: 'good', text: '3 voices from the provider' });
    const noKey: TtsVoicesResponse = { ...live, source: 'built-in', voices: [], error: { kind: 'no-credential', message: 'Add the Inworld API key (INWORLD_API_KEY) to load its voices' } };
    expect(voiceListNotice(noKey)).toEqual({ tone: 'warn', text: 'Add the Inworld API key (INWORLD_API_KEY) to load its voices Type the voice id instead.' });
    expect(voiceListNotice({ ...noKey, voices: V, error: { kind: 'unsupported', message: 'No list API' } })!.tone).toBe('neutral');
    expect(voiceListNotice(null)).toBeNull();
  });
});

describe('switching text-to-speech provider', () => {
  const catalog = {
    stt: [],
    llm: [],
    languages: [],
    tts: [
      { key: 'cartesia', label: 'Cartesia', voices: [{ id: 'katie', label: 'katie' }, { id: 'shared', label: 'shared' }] },
      { key: 'deepgram', label: 'Deepgram', voices: [{ id: 'aura-asteria-en', label: 'aura-asteria-en' }, { id: 'shared', label: 'shared' }] },
      { key: 'inworld', label: 'Inworld', voices: [] },
    ],
  } as unknown as AiCatalogResponse;
  const draft = { tts: 'cartesia', ttsVoice: 'katie', ttsModel: 'sonic-3' } as never;

  it('keeps the voice when it belongs to the new provider, otherwise takes the new provider’s first voice', () => {
    expect(selectTtsProvider({ ...(draft as object), ttsVoice: 'shared' } as never, catalog, 'deepgram')).toMatchObject({ tts: 'deepgram', ttsVoice: 'shared', ttsModel: null });
    expect(selectTtsProvider(draft, catalog, 'deepgram')).toMatchObject({ tts: 'deepgram', ttsVoice: 'aura-asteria-en', ttsModel: null });
    expect(selectTtsProvider(draft, catalog, 'inworld')).toMatchObject({ tts: 'inworld', ttsVoice: '' }); // chosen from its live list
    expect(selectTtsProvider(draft, catalog, 'cartesia')).toMatchObject({ ttsVoice: 'katie', ttsModel: 'sonic-3' }); // same provider: unchanged
  });
});
