import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * The encryption master key for saved API keys, provisioned for the customer so nobody has to edit a file.
 *
 * The gateway encrypts every key saved from the dashboard under AI_SECRETS_MASTER_KEY (AES-256-GCM, see ai/secrets.ts) and reads it from its
 * environment when it starts. The supervisor therefore creates the key once, keeps it in a protected file, and puts it in the gateway's
 * environment at every start. The gateway is not changed.
 *
 * The one rule that matters: a key that exists is NEVER replaced. Replacing it would make every saved key unrecoverable without warning.
 * So when the key file is missing while saved keys exist, or is unreadable or damaged, nothing is generated and nothing is passed on;
 * the problem is reported with what to do. Replacing the key is a separate, confirmed, explicit act (resetMasterKey) that keeps the old file.
 */

export const KEY_FILE_NAME = 'master.key';
const KEY_PREFIX = 'SIMGATEWAY-SECRETS-KEY-V1:';
const KEY_PATTERN = /^SIMGATEWAY-SECRETS-KEY-V1:([0-9a-f]{64})\s*$/;
export const MIN_KEY_CHARS = 16; // what the gateway's cipher requires

export type MasterKeyState =
  | 'ok' // an existing key file was read
  | 'created' // first start: a new key was made and protected
  | 'from_environment' // AI_SECRETS_MASTER_KEY was already set (development, or an administrator's choice)
  | 'from_config' // set in config\gateway.env
  | 'missing_with_saved_keys' // no key file, but saved keys exist: a new key would orphan them
  | 'unreadable' // the file exists but cannot be read
  | 'invalid' // the file (or a configured value) is not a usable key
  | 'cannot_protect' // a new key could not be given restricted permissions, so none was made
  | 'cannot_create'; // the folder or file could not be created

export interface MasterKeyResult {
  state: MasterKeyState;
  /** The key to give the gateway (null when the gateway should start without key storage, or when it already has one). */
  key: string | null;
  /** True when the gateway can store keys with this result. */
  usable: boolean;
  path: string;
  /** Plain words for the customer. Never contains the key. */
  message: string;
  /** What to do, or null when nothing is needed. */
  action: string | null;
}

export interface MasterKeyDeps {
  /** Restrict a file to the current user and SYSTEM. Called on the new, still-empty file before the key is written. */
  protect?: (file: string) => { ok: boolean; error?: string };
  /** Whether the database already holds keys saved from the dashboard. */
  hasSavedSecrets?: () => boolean;
  generate?: () => string;
}

export interface MasterKeyOptions {
  /** The folder for the key file (not inside the data folder the installer repairs recursively). */
  secretsDir: string;
  env: NodeJS.ProcessEnv;
  fileValues: Record<string, string>;
  dbPath: string;
  /** Only the confirmed reset sets this: make a new key even though saved keys exist (they will have to be entered again). */
  allowNewKeyWithSavedKeys?: boolean;
}

export function defaultSecretsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.SIMGW_SECRETS_DIR?.trim()) return path.resolve(env.SIMGW_SECRETS_DIR.trim());
  if (platform === 'win32') return path.join(env.ProgramData || 'C:\\ProgramData', 'SimGatewaySecrets');
  return path.join(os.homedir(), '.sim-gateway-secrets');
}

export const generateKey = (): string => crypto.randomBytes(32).toString('hex');

/** Windows: only the current user and SYSTEM may use the file (no inheritance, so the folder's wider rights do not apply). */
export function protectWithIcacls(file: string): { ok: boolean; error?: string } {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  try {
    const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`.replace(/^\\/, '');
    if (!process.env.USERNAME) return { ok: false, error: 'the current Windows user could not be determined' };
    execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${user}:(R,W,D)`, '*S-1-5-18:(F)'], { windowsHide: true, timeout: 15_000, stdio: 'pipe' });
    // Check the result: no group other than SYSTEM and the user may appear.
    const acl = execFileSync('icacls.exe', [file], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (/\b(Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\Authenticated Users)\b/i.test(acl)) return { ok: false, error: 'the file is still readable by other users' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0] };
  }
}

/** The settings that hold keys encrypted under the master key: provider keys and the Google Sheets credential. */
export const SAVED_SECRET_KEY_PATTERNS = ['ai.secret.%', 'integrations.google_sheets.credential'];

export function databaseHasSavedSecrets(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gateway_settings'").get();
    if (!exists) return false;
    const row = db.prepare('SELECT 1 FROM gateway_settings WHERE key LIKE ? OR key = ? LIMIT 1').get(SAVED_SECRET_KEY_PATTERNS[0], SAVED_SECRET_KEY_PATTERNS[1]);
    return row !== undefined;
  } catch {
    // The database exists but could not be read: assume it holds keys. Making a new master key on a guess could orphan them.
    return true;
  } finally {
    db?.close();
  }
}

const bad = (state: MasterKeyState, file: string, message: string, action: string | null): MasterKeyResult => ({ state, key: null, usable: false, path: file, message, action });

export function provisionMasterKey(o: MasterKeyOptions, deps: MasterKeyDeps = {}): MasterKeyResult {
  const file = path.join(o.secretsDir, KEY_FILE_NAME);
  const protect = deps.protect ?? protectWithIcacls;
  const hasSaved = deps.hasSavedSecrets ?? (() => databaseHasSavedSecrets(o.dbPath));
  const generate = deps.generate ?? generateKey;

  // 1. A key given explicitly (the development .env, or an administrator's config) is respected and never overwritten by a generated one.
  for (const [source, value, state] of [
    ['the environment', o.env.AI_SECRETS_MASTER_KEY, 'from_environment'],
    ['config\\gateway.env', o.fileValues.AI_SECRETS_MASTER_KEY, 'from_config'],
  ] as const) {
    const given = value?.trim();
    if (!given) continue;
    if (given.length < MIN_KEY_CHARS) {
      return bad('invalid', file, `The encryption key set in ${source} is shorter than ${MIN_KEY_CHARS} characters, so it cannot be used and saved API keys are unavailable.`, `Remove that setting (SIZH IT Solution then keeps its own key), or set a key of at least ${MIN_KEY_CHARS} characters, then start SIZH IT Solution again.`);
    }
    return { state, key: null, usable: true, path: file, message: `Saved API keys are encrypted with the key set in ${source}.`, action: null };
  }

  // 2. An existing key file is read, never rewritten.
  if (fs.existsSync(file)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return bad('unreadable', file, `SIZH IT Solution cannot read its encryption key file, so your saved API keys cannot be decrypted. (${(e as NodeJS.ErrnoException).code ?? 'read error'})`, `The file ${file} may belong to another Windows user. Sign in as the Windows user who first started SIZH IT Solution, or restore the file from a backup. Do not delete it: it is the only way to read your saved keys.`);
    }
    const m = KEY_PATTERN.exec(text);
    if (!m) {
      return bad('invalid', file, 'SIZH IT Solution\'s encryption key file is damaged, so your saved API keys cannot be decrypted.', `Restore ${file} from a backup. If there is no backup, you can reset the key storage (Start menu: "Reset saved API keys") and enter your provider keys again; the damaged file is kept aside.`);
    }
    return { state: 'ok', key: m[1], usable: true, path: file, message: 'Saved API keys are encrypted with this PC\'s key.', action: null };
  }

  // 3. No key file. If saved keys exist, a new key would orphan them: stop and say so.
  if (!o.allowNewKeyWithSavedKeys && hasSaved()) {
    return bad('missing_with_saved_keys', file, 'SIZH IT Solution\'s encryption key file is missing, but API keys were saved earlier. Without the original key they cannot be decrypted, and SIZH IT Solution will not make a new key by itself because that would lose them for good.', `Restore ${file} from a backup. If there is no backup, reset the key storage (Start menu: "Reset saved API keys") and enter your provider keys again.`);
  }

  // 4. First run: make the key. Exclusive create (fails if the file appeared meanwhile), restrict permissions BEFORE the key is written.
  let fd: number | null = null;
  try {
    fs.mkdirSync(o.secretsDir, { recursive: true });
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return provisionMasterKey(o, deps); // someone else made it a moment ago: read theirs
    return bad('cannot_create', file, `SIZH IT Solution cannot create its encryption key file in ${o.secretsDir}. (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 'Run the SIZH IT Solution installer again to repair the folders, or ask your administrator to allow your Windows account to create files there.');
  }
  const done = (): void => {
    if (fd !== null) fs.closeSync(fd);
    fd = null;
  };
  const protectedOk = protect(file);
  if (!protectedOk.ok) {
    done();
    fs.rmSync(file, { force: true }); // empty, so nothing was ever encrypted under it
    return bad('cannot_protect', file, `SIZH IT Solution could not restrict the permissions of its encryption key file (${protectedOk.error ?? 'unknown error'}), so it did not make one.`, 'Run the SIZH IT Solution installer again. If this PC\'s disk is not NTFS, saved API keys cannot be protected here.');
  }
  const key = generate();
  try {
    fs.writeSync(fd, `${KEY_PREFIX}${key}\n`);
    fs.fsyncSync(fd);
  } catch (e) {
    done();
    return bad('invalid', file, `SIZH IT Solution started creating its encryption key file but could not finish (${(e as NodeJS.ErrnoException).code ?? 'write error'}).`, `Make sure the disk has free space, then reset the key storage (Start menu: "Reset saved API keys").`);
  }
  done();
  return { state: 'created', key, usable: true, path: file, message: 'A new encryption key was created for this PC. Saved API keys are encrypted with it.', action: null };
}

/**
 * The confirmed, explicit replacement of the key. The old file is renamed (never deleted); saved keys can no longer be read and must be
 * entered again. Returns the result of provisioning the new key.
 */
export function resetMasterKey(o: MasterKeyOptions, deps: MasterKeyDeps = {}, now: () => Date = () => new Date()): MasterKeyResult & { replacedFile: string | null } {
  const file = path.join(o.secretsDir, KEY_FILE_NAME);
  let replaced: string | null = null;
  if (fs.existsSync(file)) {
    replaced = `${file}.replaced-${now().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    fs.renameSync(file, replaced);
  }
  const result = provisionMasterKey({ ...o, env: { ...o.env, AI_SECRETS_MASTER_KEY: undefined }, fileValues: { ...o.fileValues, AI_SECRETS_MASTER_KEY: '' }, allowNewKeyWithSavedKeys: true }, deps);
  return { ...result, replacedFile: replaced };
}

/** What the supervisor puts on its status page: the state and the words, never the key and never the key's path to anyone but this PC's owner. */
export function secretsStatus(r: MasterKeyResult): { state: MasterKeyState; usable: boolean; message: string; action: string | null; file: string } {
  return { state: r.state, usable: r.usable, message: r.message, action: r.action, file: r.path };
}
