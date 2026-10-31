/** Which stored credential a catalog option needs. The gateway names it (`keyEnv`); the fallback is for an older gateway. */
type Option = { provider?: string; key?: string; keyEnv?: string | null } | undefined;

const FALLBACK: Record<string, string> = {
  deepgram: 'DEEPGRAM_API_KEY',
  'deepgram-flux': 'DEEPGRAM_API_KEY',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  telnyx: 'TELNYX_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  soniox: 'SONIOX_API_KEY',
  inworld: 'INWORLD_API_KEY',
  murf_falcon_2: 'MURF_API_KEY',
  murf_falcon_2_hi: 'MURF_API_KEY',
  murf: 'MURF_API_KEY',
};

export function keyEnvFor(option: Option): string | null {
  if (!option) return null;
  if (option.keyEnv !== undefined) return option.keyEnv;
  return FALLBACK[option.provider ?? ''] ?? FALLBACK[option.key ?? ''] ?? null;
}
