import type { AiCredentialStatus } from '@sim-gateway/shared';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** The same rule the gateway enforces; checking it here only saves a round trip. */
export function validateKeyInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Paste the API key';
  if (trimmed.length < 8) return 'That is too short to be an API key';
  if (trimmed.length > 512) return 'That is too long to be an API key';
  if (/\s/.test(trimmed)) return 'An API key has no spaces or line breaks';
  return null;
}

export interface CredentialBadge {
  /** Whether a key exists at all. */
  presence: { label: string; tone: Tone };
  /** What the last operator-triggered check found. Absence of a check is not "valid". */
  check: { label: string; tone: Tone };
}

/** Missing, invalid and unreachable are three different problems and are never merged into one badge. */
export function credentialBadges(c: AiCredentialStatus): CredentialBadge {
  const presence =
    c.source === 'stored'
      ? { label: `Stored ${c.masked ?? ''}`.trim(), tone: 'good' as const }
      : c.source === 'env'
        ? { label: 'Set in .env', tone: 'good' as const }
        : { label: 'Missing', tone: c.requiredBySelection ? ('bad' as const) : ('neutral' as const) };
  let check: CredentialBadge['check'];
  if (c.source === 'missing') check = { label: 'Nothing to check', tone: 'neutral' };
  else if (c.lastCheck === 'ok') check = { label: 'Provider accepted it', tone: 'good' };
  else if (c.lastCheck === 'invalid') check = { label: 'Provider rejected it', tone: 'bad' };
  else if (c.lastCheck === 'unreachable') check = { label: 'Could not reach provider', tone: 'warn' };
  else check = { label: 'Not checked yet', tone: 'neutral' };
  return { presence, check };
}

/** Credentials the current selection needs that have no key. Names only. */
export function missingRequired(credentials: AiCredentialStatus[]): string[] {
  return credentials.filter((c) => c.requiredBySelection && c.source === 'missing').map((c) => c.name);
}
