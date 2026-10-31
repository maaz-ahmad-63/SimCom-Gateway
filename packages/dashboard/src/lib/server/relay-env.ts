/**
 * SERVER-ONLY. Never import this from a component or any file that runs in the browser.
 *
 * Where the dashboard server gets the gateway address and API key for its relays (/api/sms, /api/gateway-status).
 *
 * The gateway reads the repository's root `.env`. Next.js does not: it reads `.env*` files from packages/dashboard only, so a
 * dashboard started next to a correctly configured gateway still had no key and reported "no GATEWAY_API_KEY". Precedence:
 *
 *   1. the dashboard server's own environment (process.env, which includes packages/dashboard/.env.local);
 *   2. the repository root `.env`, when this checkout is the gateway's (the same machine, one place to keep the key);
 *      DASHBOARD_USE_REPOSITORY_ENV=false turns this off.
 *
 * Only GATEWAY_API_KEY, GATEWAY_INTERNAL_URL and PORT are ever taken from the root file. Nothing else in it (provider keys,
 * modem settings) is copied into the dashboard process. The key is never returned from here except inside `env`, which only the
 * relays read; `describe()` is the part that may be shown, and it never contains it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProxyEnv } from './sms-proxy';

/** Values that are examples, not keys. The gateway refuses them in hardware mode; the dashboard does not use them either. */
const PLACEHOLDER_KEYS = new Set(['change-this-to-a-secure-random-token', 'dev-secret-api-key-sim7600ei']);

const WANTED = ['GATEWAY_API_KEY', 'GATEWAY_INTERNAL_URL', 'PORT'] as const;
type WantedName = (typeof WANTED)[number];

/** The few assignments of an .env file this relay may use. Quotes and trailing ` # comments` are handled like dotenv does. */
export function parseEnvFile(text: string, wanted: readonly string[] = WANTED): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !wanted.includes(match[1])) continue;
    let value = match[2].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]] = value;
  }
  return out;
}

export type KeySource = 'dashboard-env' | 'repository-env' | 'missing';
export type UrlSource = 'dashboard-env' | 'repository-env' | 'default';

export interface RelaySetup {
  env: ProxyEnv;
  keySource: KeySource;
  urlSource: UrlSource;
  gatewayUrl: string;
}

export interface RelaySetupOptions {
  /** Where the dashboard server was started (default process.cwd(): packages/dashboard). */
  cwd?: string;
  /** Test seam. Returns the file's text, or null when it cannot be read. */
  readFile?: (file: string) => string | null;
  exists?: (file: string) => boolean;
}

const defaultRead = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** The repository root `.env`, if this dashboard is part of a checkout that also holds the gateway. */
export function findRepositoryEnv(options: RelaySetupOptions = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  for (const root of [path.resolve(cwd, '..', '..'), cwd]) {
    if (exists(path.join(root, 'packages', 'gateway')) && exists(path.join(root, '.env'))) return path.join(root, '.env');
  }
  return null;
}

const usableKey = (value: string | undefined): string | undefined => {
  const key = value?.trim();
  return key && !PLACEHOLDER_KEYS.has(key) ? key : undefined;
};

const validPort = (value: string | undefined): number | null => {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
};

export function resolveRelaySetup(processEnv: Record<string, string | undefined>, options: RelaySetupOptions = {}): RelaySetup {
  // DASHBOARD_USE_REPOSITORY_ENV=false turns the fallback off (the dashboard then uses only its own environment).
  const useRepository = processEnv.DASHBOARD_USE_REPOSITORY_ENV?.trim().toLowerCase() !== 'false';
  const file = useRepository ? findRepositoryEnv(options) : null;
  const repo: Partial<Record<WantedName, string>> = file ? parseEnvFile((options.readFile ?? defaultRead)(file) ?? '') : {};

  let key = usableKey(processEnv.GATEWAY_API_KEY);
  let keySource: KeySource = key ? 'dashboard-env' : 'missing';
  if (!key) {
    key = usableKey(repo.GATEWAY_API_KEY);
    if (key) keySource = 'repository-env';
  }

  let url = processEnv.GATEWAY_INTERNAL_URL?.trim() || undefined;
  let urlSource: UrlSource = url ? 'dashboard-env' : 'default';
  if (!url) {
    const fromRepo = repo.GATEWAY_INTERNAL_URL?.trim();
    const port = validPort(repo.PORT);
    if (fromRepo) url = fromRepo;
    else if (port !== null && file) url = `http://127.0.0.1:${port}`;
    if (url) urlSource = 'repository-env';
  }
  const gatewayUrl = (url ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

  return {
    env: { GATEWAY_API_KEY: key, GATEWAY_INTERNAL_URL: gatewayUrl, DASHBOARD_SMS_ALLOW_REMOTE: processEnv.DASHBOARD_SMS_ALLOW_REMOTE },
    keySource,
    urlSource,
    gatewayUrl,
  };
}

/** What may be shown about the setup: where things came from and which gateway is contacted. Never the key. */
export function describeRelaySetup(setup: RelaySetup): { gatewayUrl: string; keyConfigured: boolean; keySource: KeySource; urlSource: UrlSource } {
  return { gatewayUrl: setup.gatewayUrl, keyConfigured: setup.keySource !== 'missing', keySource: setup.keySource, urlSource: setup.urlSource };
}
