/** GET /api/ai/voices/:tts: a provider's voices, read by the gateway with the stored key (the key never reaches the browser). */
export interface TtsVoice {
  id: string;
  name: string;
  language: string | null;
  gender: string | null;
  description: string | null;
}

export interface TtsVoicesResponse {
  tts: string;
  keyEnv: string | null;
  model: string | null;
  /** 'provider': the live list from the provider. 'built-in': the gateway's own list, with `error` saying why. */
  source: 'provider' | 'built-in';
  voices: TtsVoice[];
  error: { kind: 'unsupported' | 'no-credential' | 'invalid-credential' | 'unreachable' | 'provider-error' | string; message: string } | null;
}

/** Case-insensitive match on id, name, language, gender and description; every word of the query must match. */
export function filterVoices(voices: TtsVoice[], query: string): TtsVoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return voices;
  return voices.filter((v) => {
    const text = [v.id, v.name, v.language, v.gender, v.description].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** One line of details under a voice name: language · gender · description (whatever the provider reported). */
export function voiceDetails(v: TtsVoice): string {
  return [v.language, v.gender, v.description].filter(Boolean).join(' · ');
}

/** What the picker should say about where its list came from. */
export function voiceListNotice(res: TtsVoicesResponse | null): { tone: 'good' | 'warn' | 'neutral'; text: string } | null {
  if (!res) return null;
  if (res.source === 'provider') return { tone: 'good', text: `${res.voices.length} voice${res.voices.length === 1 ? '' : 's'} from the provider` };
  const fallback = res.voices.length > 0 ? ' Showing the built-in list.' : ' Type the voice id instead.';
  return { tone: res.error?.kind === 'unsupported' ? 'neutral' : 'warn', text: `${res.error?.message ?? 'The live list is unavailable.'}${fallback}` };
}
