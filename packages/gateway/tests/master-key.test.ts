import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { AiSettingsService } from '../src/ai/settings.js';
import { buildGatewayEnv, resolveLayout } from '../src/supervisor/launcher.js';
import { databaseHasSavedSecrets, KEY_FILE_NAME, protectWithIcacls, provisionMasterKey, resetMasterKey, secretsStatus } from '../src/supervisor/master-key.js';

/**
 * The encryption key for saved API keys. The customer never sets or sees it. The rule under test: a key that exists is never replaced,
 * because replacing it would silently make every saved API key unrecoverable.
 */
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const noProtect = () => ({ ok: true });
function options(over: Partial<Parameters<typeof provisionMasterKey>[0]> = {}) {
  const dir = tmp();
  return { secretsDir: path.join(dir, 'secrets'), env: {} as NodeJS.ProcessEnv, fileValues: {}, dbPath: path.join(dir, 'gateway.sqlite'), ...over };
}
function savedKeysDb(dbPath: string, key = 'ai.secret.DEEPGRAM_API_KEY') {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE gateway_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO gateway_settings VALUES (?, ?)').run(key, 'v1:blob');
  db.close();
}

describe('first run', () => {
  it('creates a 256-bit key once, restricts the file BEFORE writing the key, and reports it', () => {
    const o = options();
    let sizeWhenProtected = -1;
    const r = provisionMasterKey(o, { protect: (file) => ((sizeWhenProtected = fs.statSync(file).size), { ok: true }) });
    expect(r).toMatchObject({ state: 'created', usable: true });
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(sizeWhenProtected).toBe(0); // the key was not on disk while the permissions were still wide
    const text = fs.readFileSync(path.join(o.secretsDir, KEY_FILE_NAME), 'utf8');
    expect(text.trim()).toBe(`SIMGATEWAY-SECRETS-KEY-V1:${r.key}`);
  });

  it('never makes a key it could not protect, and leaves no half-made file behind', () => {
    const o = options();
    const r = provisionMasterKey(o, { protect: () => ({ ok: false, error: 'access denied' }) });
    expect(r).toMatchObject({ state: 'cannot_protect', usable: false, key: null });
    expect(r.message).toContain('access denied');
    expect(r.action).toMatch(/installer again/);
    expect(fs.existsSync(path.join(o.secretsDir, KEY_FILE_NAME))).toBe(false);
  });

  it('says so when the folder cannot be created', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const r = provisionMasterKey(options({ secretsDir: path.join(blocker, 'secrets') }), { protect: noProtect });
    expect(r).toMatchObject({ state: 'cannot_create', usable: false });
  });
});

describe('an existing key is never replaced', () => {
  it('returns the same key on every later start, an upgrade included, without touching the file or generating another', () => {
    const o = options();
    const first = provisionMasterKey(o, { protect: noProtect });
    const file = path.join(o.secretsDir, KEY_FILE_NAME);
    const stamp = fs.statSync(file).mtimeMs;
    let generated = 0;
    for (let i = 0; i < 3; i++) {
      const again = provisionMasterKey(o, { protect: noProtect, generate: () => (generated++, 'f'.repeat(64)) });
      expect(again).toMatchObject({ state: 'ok', key: first.key });
    }
    expect(generated).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
  });

  it('does not touch a damaged file: reports it, passes no key, and keeps the file as it is', () => {
    const o = options();
    fs.mkdirSync(o.secretsDir, { recursive: true });
    const file = path.join(o.secretsDir, KEY_FILE_NAME);
    fs.writeFileSync(file, 'SIMGATEWAY-SECRETS-KEY-V1:tooshort');
    const r = provisionMasterKey(o, { protect: noProtect });
    expect(r).toMatchObject({ state: 'invalid', usable: false, key: null });
    expect(r.message).toMatch(/damaged/);
    expect(r.action).toMatch(/Restore .* from a backup/);
    expect(fs.readFileSync(file, 'utf8')).toBe('SIMGATEWAY-SECRETS-KEY-V1:tooshort');
    fs.writeFileSync(file, ''); // an empty file is not replaced either
    expect(provisionMasterKey(o, { protect: noProtect }).state).toBe('invalid');
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('does not touch a file it cannot read (it may belong to another Windows user)', () => {
    const o = options();
    fs.mkdirSync(path.join(o.secretsDir, KEY_FILE_NAME), { recursive: true }); // reading a folder fails like a permission error would
    const r = provisionMasterKey(o, { protect: noProtect });
    expect(r).toMatchObject({ state: 'unreadable', usable: false, key: null });
    expect(r.action).toMatch(/Do not delete it/);
    expect(fs.statSync(path.join(o.secretsDir, KEY_FILE_NAME)).isDirectory()).toBe(true);
  });

  it('makes no new key when the key file is missing but saved keys exist, because that would orphan them', () => {
    const o = options();
    savedKeysDb(o.dbPath);
    let generated = 0;
    const r = provisionMasterKey(o, { protect: noProtect, generate: () => (generated++, 'a'.repeat(64)) });
    expect(r).toMatchObject({ state: 'missing_with_saved_keys', usable: false, key: null });
    expect(r.message).toMatch(/will not make a new key by itself/);
    expect(r.action).toMatch(/Reset saved API keys/);
    expect(generated).toBe(0);
    expect(fs.existsSync(path.join(o.secretsDir, KEY_FILE_NAME))).toBe(false);
  });

  it('counts the Google Sheets credential as a saved key too, ignores unrelated settings, and treats an unreadable database as holding keys', () => {
    expect(databaseHasSavedSecrets(path.join(tmp(), 'none.sqlite'))).toBe(false);
    const sheets = path.join(tmp(), 'a.sqlite');
    savedKeysDb(sheets, 'integrations.google_sheets.credential');
    expect(databaseHasSavedSecrets(sheets)).toBe(true);
    const unrelated = path.join(tmp(), 'b.sqlite');
    savedKeysDb(unrelated, 'ai.settings');
    expect(databaseHasSavedSecrets(unrelated)).toBe(false);
    const garbage = path.join(tmp(), 'c.sqlite');
    fs.writeFileSync(garbage, 'this is not a database');
    expect(databaseHasSavedSecrets(garbage)).toBe(true); // cannot tell: assume yes, so no new key is made on a guess
  });

  it('makes a key on first run when the database exists but holds no saved keys yet', () => {
    const o = options();
    savedKeysDb(o.dbPath, 'ai.settings');
    expect(provisionMasterKey(o, { protect: noProtect }).state).toBe('created');
  });
});

describe('backward compatibility: a key given explicitly is respected', () => {
  it('uses the environment variable (development .env) or the config file and generates nothing', () => {
    const fromEnv = options({ env: { AI_SECRETS_MASTER_KEY: 'x'.repeat(24) } });
    expect(provisionMasterKey(fromEnv, { protect: noProtect })).toMatchObject({ state: 'from_environment', usable: true, key: null });
    expect(fs.existsSync(fromEnv.secretsDir)).toBe(false);
    const fromConfig = options({ fileValues: { AI_SECRETS_MASTER_KEY: 'y'.repeat(24) } });
    expect(provisionMasterKey(fromConfig, { protect: noProtect })).toMatchObject({ state: 'from_config', usable: true, key: null });
  });

  it('refuses a configured key that is too short (the gateway would refuse to start) instead of crashing', () => {
    const r = provisionMasterKey(options({ env: { AI_SECRETS_MASTER_KEY: 'short' } }), { protect: noProtect });
    expect(r).toMatchObject({ state: 'invalid', usable: false });
    expect(r.message).toMatch(/shorter than 16/);
    const layout = resolveLayout('/app', { SIMGW_DATA_DIR: '/d' }, 'linux');
    expect(buildGatewayEnv(layout, { AI_SECRETS_MASTER_KEY: 'short' }, {}, r).AI_SECRETS_MASTER_KEY).toBe(''); // blanked: the gateway runs without key storage
  });
});

describe('what the gateway is given', () => {
  it('receives the key through the variable it already reads, and a key from the file is not overridden by a stale base value', () => {
    const layout = resolveLayout('/app', { SIMGW_DATA_DIR: '/d' }, 'linux');
    const r = provisionMasterKey(options(), { protect: noProtect });
    expect(buildGatewayEnv(layout, { AI_SECRETS_MASTER_KEY: 'stale-value-from-elsewhere' }, {}, r).AI_SECRETS_MASTER_KEY).toBe(r.key);
    expect(buildGatewayEnv(layout, {}, {}).AI_SECRETS_MASTER_KEY).toBeUndefined(); // no result: unchanged behaviour
    const explicit = provisionMasterKey(options({ env: { AI_SECRETS_MASTER_KEY: 'z'.repeat(20) } }), { protect: noProtect });
    expect(buildGatewayEnv(layout, { AI_SECRETS_MASTER_KEY: 'z'.repeat(20) }, {}, explicit).AI_SECRETS_MASTER_KEY).toBe('z'.repeat(20));
    expect(layout.secretsDir).not.toContain(layout.dataDir); // outside the folder the installer repairs recursively
  });

  it('puts nothing secret on the status page', () => {
    const r = provisionMasterKey(options(), { protect: noProtect });
    const shown = JSON.stringify(secretsStatus(r));
    expect(shown).not.toContain(r.key!);
    expect(shown).not.toMatch(/[0-9a-f]{40}/);
  });
});

describe('saved API keys survive restarts and upgrades, and never leak', () => {
  const backend = () => {
    const m = new Map<string, string>();
    return { m, b: { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v), deleteSetting: (k: string) => void m.delete(k) } };
  };

  it('decrypts after a restart with the same key, is unreadable (and says so) under a different key, and never exposes the plaintext', () => {
    const o = options();
    const { m, b } = backend();
    const key1 = provisionMasterKey(o, { protect: noProtect }).key!;
    const first = new AiSettingsService(b as never, { AI_SECRETS_MASTER_KEY: key1 } as never);
    first.setSecret('DEEPGRAM_API_KEY', 'dg-the-real-secret-1234');
    expect([...m.values()].join('|')).not.toContain('the-real-secret'); // encrypted at rest
    // a restart, and then an upgrade: the supervisor finds the same file and gives the gateway the same key
    const key2 = provisionMasterKey(o, { protect: noProtect }).key!;
    expect(key2).toBe(key1);
    const restarted = new AiSettingsService(b as never, { AI_SECRETS_MASTER_KEY: key2 } as never);
    expect(restarted.resolveSecret('DEEPGRAM_API_KEY')).toBe('dg-the-real-secret-1234');
    const status = restarted.credentialStatuses([]).find((c) => c.name === 'DEEPGRAM_API_KEY')!;
    expect(status.source).toBe('stored');
    expect(JSON.stringify(restarted.credentialStatuses([]))).not.toContain('the-real-secret');
    // a different key (what a silent replacement would have caused)
    const wrong = new AiSettingsService(b as never, { AI_SECRETS_MASTER_KEY: 'f'.repeat(64) } as never);
    expect(wrong.resolveSecret('DEEPGRAM_API_KEY')).toBeUndefined();
    expect(wrong.credentialStatuses([]).find((c) => c.name === 'DEEPGRAM_API_KEY')).toMatchObject({ source: 'missing' });
    expect(wrong.credentialStatuses([]).find((c) => c.name === 'DEEPGRAM_API_KEY')!.lastCheckDetail).toMatch(/cannot be decrypted/);
  });

  it('adds, updates and removes a key, and falls back to .env only when nothing is saved', () => {
    const { b } = backend();
    const key = provisionMasterKey(options(), { protect: noProtect }).key!;
    const svc = new AiSettingsService(b as never, { AI_SECRETS_MASTER_KEY: key, OPENAI_API_KEY: 'sk-from-dot-env-0000' } as never);
    expect(svc.credentialSource('OPENAI_API_KEY').source).toBe('env');
    svc.setSecret('OPENAI_API_KEY', 'sk-saved-from-dashboard-1');
    expect(svc.resolveSecret('OPENAI_API_KEY')).toBe('sk-saved-from-dashboard-1');
    svc.setSecret('OPENAI_API_KEY', 'sk-replaced-in-dashboard-2');
    expect(svc.resolveSecret('OPENAI_API_KEY')).toBe('sk-replaced-in-dashboard-2');
    svc.deleteSecret('OPENAI_API_KEY');
    expect(svc.credentialSource('OPENAI_API_KEY').source).toBe('env'); // the development .env key still works
    expect(svc.resolveSecret('OPENAI_API_KEY')).toBe('sk-from-dot-env-0000');
  });
});

describe('the explicit reset', () => {
  it('keeps the old key file aside, makes a different key, and is the only way a key is replaced', () => {
    const o = options();
    const first = provisionMasterKey(o, { protect: noProtect });
    savedKeysDb(o.dbPath); // saved keys exist: a normal start would refuse to make a key
    const r = resetMasterKey(o, { protect: noProtect }, () => new Date('2026-11-04T10:20:30Z'));
    expect(r).toMatchObject({ state: 'created', usable: true });
    expect(r.key).not.toBe(first.key);
    expect(r.replacedFile).toMatch(/master\.key\.replaced-20261104102030$/);
    expect(fs.readFileSync(r.replacedFile!, 'utf8')).toContain(first.key!); // the old key is still on disk
    expect(provisionMasterKey(o, { protect: noProtect })).toMatchObject({ state: 'ok', key: r.key });
  });

  it('works when there was no key file at all', () => {
    const o = options();
    savedKeysDb(o.dbPath);
    const r = resetMasterKey(o, { protect: noProtect });
    expect(r).toMatchObject({ state: 'created', replacedFile: null });
  });

  it('after a reset, keys saved under the old key are reported as unreadable, not silently wrong', () => {
    const o = options();
    const m = new Map<string, string>();
    const b = { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v), deleteSetting: (k: string) => void m.delete(k) };
    const old = provisionMasterKey(o, { protect: noProtect }).key!;
    new AiSettingsService(b as never, { AI_SECRETS_MASTER_KEY: old } as never).setSecret('GROQ_API_KEY', 'gsk-saved-before-reset-123');
    const fresh = resetMasterKey(o, { protect: noProtect }).key!;
    const after = new AiSettingsService(b as never, { AI_SECRETS_MASTER_KEY: fresh } as never);
    expect(after.resolveSecret('GROQ_API_KEY')).toBeUndefined();
    after.setSecret('GROQ_API_KEY', 'gsk-entered-again-456'); // entering it again works
    expect(after.resolveSecret('GROQ_API_KEY')).toBe('gsk-entered-again-456');
  });
});

describe.skipIf(process.platform !== 'win32')('Windows permissions on the key file (real icacls)', () => {
  it('leaves only the current user and SYSTEM able to use the file', () => {
    const dir = tmp();
    const file = path.join(dir, 'master.key');
    fs.writeFileSync(file, 'x');
    expect(protectWithIcacls(file)).toEqual({ ok: true });
    const acl = execFileSync('icacls.exe', [file], { encoding: 'utf8' });
    expect(acl).toMatch(/NT AUTHORITY\\SYSTEM/i);
    expect(acl).toContain(process.env.USERNAME!);
    expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|Authenticated Users|BUILTIN\\Administrators/i);
    fs.writeFileSync(file, 'y'); // the owner can still use it
  });

  it('reports a failure instead of pretending, for a file that does not exist', () => {
    const r = protectWithIcacls(path.join(tmp(), 'missing.key'));
    expect(r.ok).toBe(false);
  });
});
