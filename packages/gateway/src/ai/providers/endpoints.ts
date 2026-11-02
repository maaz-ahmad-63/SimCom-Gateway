/**
 * Optional operator overrides of the Deepgram endpoints through the environment (the defaults are the AU region for English, as in
 * the source project). The API key is sent to these URLs, so they must be https URLs on deepgram.com. A model's own `endpoint` in the
 * registry, when set, takes precedence over these.
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
