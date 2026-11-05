import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSecretsDir, MasterKeyResult } from './master-key.js';
import type { ServiceSpec } from './supervisor.js';

/**
 * Where the installed product keeps things, and what it hands to each service.
 *
 * Program files and customer data are kept apart: the program folder can be replaced by an update or removed by the uninstaller
 * without touching the data folder, which holds the database, recordings, IVR audio, backups, logs and the customer's configuration.
 * Nothing in the program folder is ever written to while the product runs.
 */

export interface Layout {
  /** The folder the installer put the program in. */
  appDir: string;
  /** Everything that belongs to the customer. */
  dataDir: string;
  configFile: string;
  /** Where the encryption key for saved API keys lives. Outside the data folder: the installer repairs permissions on the data folder recursively, and this file must stay restricted. */
  secretsDir: string;
  nodeExe: string;
  gatewayEntry: string;
  dashboardEntry: string;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.SIMGW_DATA_DIR?.trim()) return path.resolve(env.SIMGW_DATA_DIR.trim());
  if (platform === 'win32') return path.join(env.ProgramData || 'C:\\ProgramData', 'SimGateway');
  return path.join(os.homedir(), '.sim-gateway');
}

export function resolveLayout(appDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Layout {
  const dataDir = defaultDataDir(env, platform);
  return {
    appDir,
    dataDir,
    configFile: path.join(dataDir, 'config', 'gateway.env'),
    secretsDir: defaultSecretsDir(env, platform),
    nodeExe: env.SIMGW_NODE?.trim() || process.execPath,
    // The gateway is started through a tiny wrapper that also understands the supervisor's "shut down" message (see gateway-entry.ts).
    gatewayEntry: path.join(appDir, 'gateway', 'dist', 'supervisor', 'gateway-entry.js'),
    // Next.js keeps the monorepo layout inside its standalone folder.
    dashboardEntry: path.join(appDir, 'dashboard', 'packages', 'dashboard', 'server.js'),
  };
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export const generateApiKey = (): string => crypto.randomBytes(32).toString('hex');

/**
 * First run: create the customer configuration with a fresh random API key. An existing file is never overwritten, so an upgrade or a
 * reinstall keeps the customer's key and settings. The development `.env` is never read or copied.
 */
export function ensureConfigFile(file: string): { created: boolean } {
  if (fs.existsSync(file)) return { created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    '# Created on first start. Edit only if you know what you are changing; the product keeps working without edits.',
    `GATEWAY_API_KEY=${generateApiKey()}`,
    'HOST=127.0.0.1',
    'PORT=4000',
    'MODEM_DRIVER=hardware',
    // Empty = find the modem's AT and audio ports automatically from its USB identity (Windows renumbers COM ports). Set a port only to pin it.
    'MODEM_AT_PORT=',
    'MODEM_AUDIO_PORT=',
    'MODEM_AUTO_RECONNECT=true',
    'CORS_ORIGIN=http://127.0.0.1:3000',
    '# Updates come from the project\'s public GitHub Releases by default. Set UPDATE_URL (the https address of latest.json) only to use another source.',
    '# UPDATE_URL=',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return { created: true };
}

/**
 * What the installed product does out of the box, as the gateway's own settings. They are the values a working setup already uses; the
 * gateway reads them at start, and anything the customer saves in the dashboard's Settings overrides them, so each can be switched off.
 *
 * Layering, lowest to highest: these defaults, then an explicit environment variable, then config\gateway.env, then (inside the gateway)
 * the customer's saved Settings. Nothing here changes how audio or the modem is handled; it only says which existing features start on.
 */
export const PACKAGED_AI_DEFAULTS: Readonly<Record<string, string>> = {
  AI_ENABLED: 'true',
  // Attach the agent to every eligible call, in both directions.
  AI_AUTO_HANDLE: 'all',
  // Answer an incoming call after two rings, then register the module's USB audio for it.
  AI_AUTO_ANSWER: 'true',
  AI_AUTO_ANSWER_RINGS: '2',
  AI_AUTO_ACTIVATE_USB_AUDIO: 'true',
  // The agent speaks to the caller (it still waits for the audio checks below).
  AI_AUTO_REPLIES: 'true',
  // Audio is verified automatically from the live stream's health instead of by a person's confirmation. The gateway version that
  // understands this variable is applied separately; until then it is ignored and the existing confirmations still gate the agent.
  AI_AUDIO_AUTO_VERIFY: 'true',
  // The rate the gateway is configured for. The module's own rate is still compared against it on every call (readiness: audio-rate).
  AI_AUDIO_SAMPLE_RATE: '8000',
};

/** Everything a gateway process gets. The customer's file wins over the defaults, the data folder decides where data goes. */
export function buildGatewayEnv(layout: Layout, base: NodeJS.ProcessEnv, fileValues: Record<string, string>, secrets?: MasterKeyResult): NodeJS.ProcessEnv {
  const d = layout.dataDir;
  const env: NodeJS.ProcessEnv = {
    ...PACKAGED_AI_DEFAULTS,
    ...base,
    NODE_ENV: 'production',
    SQLITE_DB_PATH: path.join(d, 'gateway.sqlite'),
    CALL_RECORDING_DIR: path.join(d, 'recordings'),
    AUDIO_DUMP_DIRECTORY: path.join(d, 'audio-dumps'),
    LOG_DIR: path.join(d, 'logs'),
    ...fileValues,
  };
  // COM numbers are never inherited from whatever environment started the product: they come from config\gateway.env, and empty means
  // "discover automatically". (A development shell that exports MODEM_AT_PORT must not pin a customer's modem to a stale port.)
  env.MODEM_AT_PORT = fileValues.MODEM_AT_PORT ?? '';
  env.MODEM_AUDIO_PORT = fileValues.MODEM_AUDIO_PORT ?? '';
  // The encryption key for saved API keys is given to the gateway through the variable it already reads, before it starts, so it exists
  // before the encrypted store is built. A key that cannot be used is blanked (the gateway then runs without key storage) rather than left
  // as a too-short value, which would make the gateway refuse to start.
  if (secrets) {
    if (secrets.key) env.AI_SECRETS_MASTER_KEY = secrets.key;
    else if (!secrets.usable) env.AI_SECRETS_MASTER_KEY = '';
  }
  return env;
}

export function buildDashboardEnv(layout: Layout, base: NodeJS.ProcessEnv, fileValues: Record<string, string>, dashboardPort = 3000): NodeJS.ProcessEnv {
  const gatewayPort = fileValues.PORT || '4000';
  return {
    ...base,
    NODE_ENV: 'production',
    PORT: String(dashboardPort),
    HOSTNAME: '127.0.0.1',
    // Lets the dashboard, opened on this computer, pick the generated key up once (see /api/local-config). Loopback only.
    SIMGW_LOCAL_CONFIG: '1',
    SIMGW_CONFIG_FILE: layout.configFile,
    SIMGW_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    GATEWAY_INTERNAL_URL: `http://127.0.0.1:${gatewayPort}`,
    GATEWAY_API_KEY: fileValues.GATEWAY_API_KEY ?? '',
    // How the dashboard asks the supervisor about updates: loopback only, authenticated with a token file only this Windows user can read.
    SIMGW_SUPERVISOR_URL: `http://127.0.0.1:${base.SIMGW_STATUS_PORT || 4010}`,
    SIMGW_SUPERVISOR_TOKEN_FILE: path.join(layout.dataDir, 'supervisor.token'),
  };
}

export function buildSpecs(layout: Layout, base: NodeJS.ProcessEnv = process.env, secrets?: MasterKeyResult): { gateway: ServiceSpec; dashboard: ServiceSpec } {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(fs.readFileSync(layout.configFile, 'utf8'));
  } catch {
    fileValues = {};
  }
  return {
    gateway: { name: 'gateway', command: layout.nodeExe, args: [layout.gatewayEntry], cwd: path.join(layout.appDir, 'gateway'), env: buildGatewayEnv(layout, base, fileValues, secrets) },
    dashboard: { name: 'dashboard', command: layout.nodeExe, args: [layout.dashboardEntry], cwd: path.dirname(layout.dashboardEntry), env: buildDashboardEnv(layout, base, fileValues, Number(base.SIMGW_DASHBOARD_PORT) || 3000) },
  };
}

/** What must be true before anything is started. Returned as sentences, so the launcher can show them instead of a stack trace. */
export function preflight(layout: Layout, exists: (p: string) => boolean = fs.existsSync): string[] {
  const problems: string[] = [];
  if (!exists(layout.nodeExe)) problems.push(`The bundled Node runtime was not found at ${layout.nodeExe}. Reinstall the product.`);
  if (!exists(layout.gatewayEntry)) problems.push('The gateway program files are missing. Reinstall the product.');
  if (!exists(layout.dashboardEntry)) problems.push('The dashboard program files are missing. Reinstall the product.');
  return problems;
}
