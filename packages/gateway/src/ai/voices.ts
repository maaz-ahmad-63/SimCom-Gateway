/**
 * The voices a text-to-speech provider offers, read from the provider's own voice-list API with the stored key (gateway side only: the
 * key never reaches the browser). Read-only listing requests, never synthesis, so nothing is billed as characters. One fetcher per wire
 * protocol; a protocol without a documented list API says so instead of guessing.
 *
 * Documented list APIs used here:
 *   cartesia-tts   GET https://api.cartesia.ai/voices                          (Bearer, Cartesia-Version)
 *   elevenlabs-tts GET https://api.elevenlabs.io/v2/voices                     (xi-api-key)
 *   murf-tts       GET https://global.api.murf.ai/v1/speech/voices?model=...   (api-key)
 *   inworld-tts    GET https://api.inworld.ai/voices/v1/voices                 (Basic)
 *   deepgram-tts   GET https://api.deepgram.com/v1/models  (the "tts" list)    (Token)
 *   soniox-tts     GET https://api.soniox.com/v1/shared-voices?model=...       (Bearer)
 * Field names differ between some providers' documentation versions, so each parser accepts the documented alternatives.
 */

export interface ProviderVoice {
  /** What is saved as the voice and sent to the provider. */
  id: string;
  name: string;
  language: string | null;
  gender: string | null;
  description: string | null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class VoiceListError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid-credential' | 'unreachable' | 'provider-error'
  ) {
    super(message);
    this.name = 'VoiceListError';
  }
}

export interface VoiceListOptions {
  key: string;
  fetchImpl: FetchLike;
  /** The TTS model in use (Murf and Soniox list voices per model). */
  model?: string | null;
  cartesiaVersion?: string;
  timeoutMs?: number;
}

const MAX_PAGES = 20;
const MAX_VOICES = 5000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const firstStr = (...values: unknown[]): string | null => {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
    if (Array.isArray(v)) {
      const joined = v.map(str).filter(Boolean).join(', ');
      if (joined) return joined;
    }
  }
  return null;
};
const genderFromTags = (tags: unknown): string | null => {
  if (!Array.isArray(tags)) return null;
  const t = tags.map((x) => String(x).toLowerCase());
  if (t.some((x) => x === 'female' || x === 'feminine')) return 'female';
  if (t.some((x) => x === 'male' || x === 'masculine')) return 'male';
  return null;
};

/** The protocols with a voice-list API implemented here. */
export const VOICE_LIST_PROTOCOLS = ['cartesia-tts', 'elevenlabs-tts', 'murf-tts', 'inworld-tts', 'deepgram-tts', 'soniox-tts'] as const;
export const supportsVoiceList = (protocol: string | null): boolean => !!protocol && (VOICE_LIST_PROTOCOLS as readonly string[]).includes(protocol);

async function getJson(o: VoiceListOptions, provider: string, url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await o.fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  } catch (error) {
    throw new VoiceListError(`${provider} ${(error as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached'} while listing voices`, 'unreachable');
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => {});
    throw new VoiceListError(`${provider} rejected the API key (HTTP ${response.status})`, 'invalid-credential');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new VoiceListError(`${provider} answered HTTP ${response.status} to the voice list request`, 'provider-error');
  }
  try {
    return await response.json();
  } catch {
    throw new VoiceListError(`${provider} sent a voice list that is not valid JSON`, 'provider-error');
  }
}

const arrayAt = (body: unknown, ...keys: string[]): unknown[] => {
  if (Array.isArray(body)) return body;
  for (const k of keys) {
    const v = (body as Record<string, unknown> | null)?.[k];
    if (Array.isArray(v)) return v;
  }
  return [];
};

type Rec = Record<string, unknown>;

async function cartesia(o: VoiceListOptions): Promise<ProviderVoice[]> {
  const out: ProviderVoice[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_VOICES; page++) {
    const url = `https://api.cartesia.ai/voices?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`;
    const body = await getJson(o, 'Cartesia', url, { Authorization: `Bearer ${o.key}`, 'Cartesia-Version': o.cartesiaVersion ?? '2026-08-14' });
    const items = arrayAt(body, 'data', 'voices') as Rec[];
    for (const v of items) {
      const id = str(v.id);
      if (id) out.push({ id, name: str(v.name) ?? id, language: firstStr(v.language), gender: firstStr(v.gender), description: firstStr(v.description) });
    }
    const more = !Array.isArray(body) && (body as Rec).has_more === true;
    after = more && items.length > 0 ? str(items[items.length - 1].id) : null;
    if (!after) break;
  }
  return out;
}

async function elevenlabs(o: VoiceListOptions): Promise<ProviderVoice[]> {
  const out: ProviderVoice[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_VOICES; page++) {
    const url = `https://api.elevenlabs.io/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const body = (await getJson(o, 'ElevenLabs', url, { 'xi-api-key': o.key })) as Rec;
    for (const v of arrayAt(body, 'voices') as Rec[]) {
      const id = str(v.voice_id);
      const labels = (v.labels ?? {}) as Rec;
      if (id) out.push({ id, name: str(v.name) ?? id, language: firstStr(labels.language, labels.accent), gender: firstStr(labels.gender), description: firstStr(v.description, labels.description) });
    }
    token = body.has_more === true ? str(body.next_page_token) : null;
    if (!token) break;
  }
  return out;
}

async function murf(o: VoiceListOptions): Promise<ProviderVoice[]> {
  const model = o.model ? `?model=${encodeURIComponent(o.model)}` : '';
  const body = await getJson(o, 'Murf', `https://global.api.murf.ai/v1/speech/voices${model}`, { 'api-key': o.key });
  const out: ProviderVoice[] = [];
  for (const v of arrayAt(body, 'voices') as Rec[]) {
    const id = firstStr(v.voiceId, v.voice_id, v.id);
    if (id) out.push({ id, name: firstStr(v.displayName, v.name) ?? id, language: firstStr(v.locale, v.displayLanguage), gender: firstStr(v.gender), description: firstStr(v.description, v.accent) });
  }
  return out;
}

async function inworld(o: VoiceListOptions): Promise<ProviderVoice[]> {
  const out: ProviderVoice[] = [];
  const seen = new Set<string>();
  let token = '';
  for (let page = 0; page < MAX_PAGES && out.length < MAX_VOICES; page++) {
    const url = `https://api.inworld.ai/voices/v1/voices?pageSize=500${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const body = (await getJson(o, 'Inworld', url, { Authorization: `Basic ${o.key}` })) as Rec;
    for (const v of arrayAt(body, 'voices') as Rec[]) {
      const id = firstStr(v.voiceId, v.name);
      if (!id || seen.has(id)) continue; // pages are not a stable snapshot: de-duplicate by voiceId
      seen.add(id);
      out.push({ id, name: firstStr(v.displayName) ?? id, language: firstStr(v.langCode, v.languageCode, v.languages), gender: firstStr(v.gender) ?? genderFromTags(v.tags), description: firstStr(v.description) });
    }
    token = str(body.nextPageToken) ?? '';
    if (!token) break;
  }
  return out;
}

async function deepgram(o: VoiceListOptions): Promise<ProviderVoice[]> {
  const body = (await getJson(o, 'Deepgram', 'https://api.deepgram.com/v1/models', { Authorization: `Token ${o.key}` })) as Rec;
  const out: ProviderVoice[] = [];
  for (const v of arrayAt(body, 'tts') as Rec[]) {
    const id = firstStr(v.canonical_name, v.name);
    const meta = (v.metadata ?? {}) as Rec;
    if (id) out.push({ id, name: firstStr(v.name) ?? id, language: firstStr(v.languages, meta.accent), gender: genderFromTags(meta.tags), description: firstStr(meta.accent ? `${String(meta.accent)} accent` : null, v.architecture) });
  }
  return out;
}

async function soniox(o: VoiceListOptions): Promise<ProviderVoice[]> {
  if (!o.model) throw new VoiceListError('Soniox lists voices per TTS model, and no model is selected', 'provider-error');
  const out: ProviderVoice[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_VOICES; page++) {
    const url = `https://api.soniox.com/v1/shared-voices?model=${encodeURIComponent(o.model)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = (await getJson(o, 'Soniox', url, { Authorization: `Bearer ${o.key}` })) as Rec;
    for (const v of arrayAt(body, 'voices') as Rec[]) {
      const id = firstStr(v.id, v.name);
      if (id) out.push({ id, name: firstStr(v.name) ?? id, language: firstStr(v.language, v.accent), gender: firstStr(v.gender), description: firstStr(v.description) });
    }
    cursor = str(body.next_page_cursor);
    if (!cursor) break;
  }
  return out;
}

const FETCHERS: Record<(typeof VOICE_LIST_PROTOCOLS)[number], (o: VoiceListOptions) => Promise<ProviderVoice[]>> = {
  'cartesia-tts': cartesia,
  'elevenlabs-tts': elevenlabs,
  'murf-tts': murf,
  'inworld-tts': inworld,
  'deepgram-tts': deepgram,
  'soniox-tts': soniox,
};

/** Lists the provider's voices, sorted by name. Throws VoiceListError (never containing the key). */
export async function listProviderVoices(protocol: string, o: VoiceListOptions): Promise<ProviderVoice[]> {
  const fetcher = FETCHERS[protocol as (typeof VOICE_LIST_PROTOCOLS)[number]];
  if (!fetcher) throw new VoiceListError(`No voice list API is implemented for ${protocol}`, 'provider-error');
  try {
    const voices = (await fetcher(o)).slice(0, MAX_VOICES);
    return voices.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error instanceof VoiceListError) throw new VoiceListError(error.message.split(o.key).join('[redacted]'), error.kind);
    throw new VoiceListError('The voice list could not be read', 'provider-error');
  }
}
