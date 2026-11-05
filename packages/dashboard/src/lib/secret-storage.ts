/**
 * Whether API keys can be saved from the dashboard, and what to tell the customer when they cannot.
 *
 * In the installed product the supervisor makes the encryption key itself and reports its state on its local status page, so a missing,
 * unreadable or damaged key is explained here in plain words, with what to do, and never as an instruction to edit a file. In development
 * (no supervisor) the original hint about AI_SECRETS_MASTER_KEY in the gateway's .env is still shown. Nothing here ever handles a key.
 */

export interface SupervisorSecrets {
  state: string;
  usable: boolean;
  message: string;
  action: string | null;
  file: string;
}

export interface StorageNotice {
  tone: 'bad' | 'warn';
  title: string;
  message: string;
  action: string | null;
}

/** The supervisor's status page on the computer the dashboard was opened from. null: there is no supervisor (development) or it did not answer. */
export async function fetchSupervisorSecrets(hostname: string, fetchImpl: typeof fetch = fetch, port = 4010): Promise<SupervisorSecrets | null> {
  try {
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname || '127.0.0.1';
    const res = await fetchImpl(`http://${host}:${port}/status`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { secrets?: Partial<SupervisorSecrets> };
    const s = body.secrets;
    if (!s || typeof s.state !== 'string' || typeof s.usable !== 'boolean' || typeof s.message !== 'string') return null;
    return { state: s.state, usable: s.usable, message: s.message, action: typeof s.action === 'string' ? s.action : null, file: typeof s.file === 'string' ? s.file : '' };
  } catch {
    return null;
  }
}

const TITLES: Record<string, string> = {
  missing_with_saved_keys: 'The encryption key for your saved API keys is missing',
  unreadable: 'SIZH IT Solution cannot read its encryption key',
  invalid: 'The encryption key for your saved API keys is damaged',
  cannot_protect: 'SIZH IT Solution could not protect its encryption key',
  cannot_create: 'SIZH IT Solution could not create its encryption key',
};

/** What to show above the key list, or null when keys can be saved. */
export function storageNotice(i: { storageAvailable: boolean; supervisor: SupervisorSecrets | null }): StorageNotice | null {
  const { supervisor } = i;
  if (supervisor && !supervisor.usable) {
    return { tone: 'bad', title: TITLES[supervisor.state] ?? 'API key storage is not available', message: supervisor.message, action: supervisor.action };
  }
  if (supervisor && supervisor.usable && !i.storageAvailable) {
    return {
      tone: 'warn',
      title: 'Saving API keys is not active yet',
      message: 'SIZH IT Solution has its encryption key, but the gateway started without it.',
      action: 'Restart SIZH IT Solution: Start menu, "Stop SIZH IT Solution", then "SIZH IT Solution".',
    };
  }
  if (!supervisor && !i.storageAvailable) {
    return {
      tone: 'warn',
      title: 'Key storage is off',
      message: 'This gateway was started without an encryption key (a development setup). The installed product creates one by itself.',
      action: 'For development: add AI_SECRETS_MASTER_KEY=<16 or more random characters> to the gateway .env and restart the gateway. Keys already in .env keep working.',
    };
  }
  return null;
}
