import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * D1: customer data that lives where the safety copy does not reach must be REFUSED (exit 70), never skipped while reporting success.
 * D2: restore takes each item from the newest complete, verified copy that still has it.
 * Real files, a real SQLite database and real Windows ACLs in a scratch folder.
 */
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'installer', 'migrate', 'customer-data.cjs');
type Deps = Record<string, unknown>;
const tool = require(script) as {
  backup: (o: Opts, d?: Deps) => Promise<R>;
  restore: (o: Opts, d?: Deps) => R;
  completeBackups: (root: string) => { valid: { name: string; dir: string }[]; rejected: string[] };
  sha256File: (f: string) => string;
};
const Database = require('better-sqlite3');

interface Opts {
  dataDir: string;
  secretsDir: string;
  outRoot: string;
  oldAppDir?: string;
}
interface R {
  code: number;
  message: string;
  dir?: string;
  problems?: string[];
  restored?: string[];
  kept?: string[];
  skipped?: string[];
  rejected?: string[];
}

const me = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`.replace(/^\\/, '');
let tmp: string;
let o: Opts;
const clean: Deps = { registryEnv: () => ({}) }; // never read this machine's real user/machine environment
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const copies = () => (fs.existsSync(o.outRoot) ? fs.readdirSync(o.outRoot).filter((n) => n.startsWith('migration-')) : []);
const T = (iso: string): Deps => ({ ...clean, now: () => new Date(iso) });
const GATEWAY_KEY = 'GATEWAY_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaa';
const setEnvFile = (extra: string) => fs.writeFileSync(path.join(o.dataDir, 'config', 'gateway.env'), `${GATEWAY_KEY}\n${extra}\n`);
const wipe = () => {
  fs.rmSync(o.dataDir, { recursive: true, force: true });
  fs.rmSync(o.secretsDir, { recursive: true, force: true });
};
async function withEnv(vars: Record<string, string>, fn: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeCustomer() {
  for (const d of ['config', 'recordings', 'ivr', 'registry']) fs.mkdirSync(path.join(o.dataDir, d), { recursive: true });
  setEnvFile('MODEM_AT_PORT=');
  fs.writeFileSync(path.join(o.dataDir, 'recordings', 'call-1.wav'), crypto.randomBytes(8000));
  fs.writeFileSync(path.join(o.dataDir, 'ivr', 'menu.wav'), crypto.randomBytes(3000));
  fs.writeFileSync(path.join(o.dataDir, 'registry', 'pricing.json'), '{"p":1}');
  const db = new Database(path.join(o.dataDir, 'gateway.sqlite'));
  db.exec("CREATE TABLE gateway_settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO gateway_settings VALUES ('agent.inboundInstructions','Custom prompt'),('ai.secret.DEEPGRAM_API_KEY','ciphertext')");
  db.close();
  fs.mkdirSync(o.secretsDir, { recursive: true });
  const key = path.join(o.secretsDir, 'master.key');
  fs.writeFileSync(key, `SIMGATEWAY-SECRETS-KEY-V1:${crypto.randomBytes(32).toString('hex')}`);
  execFileSync('icacls.exe', [key, '/inheritance:r', '/grant:r', `${me}:(R,W,D)`, '*S-1-5-18:(F)'], { stdio: 'pipe' });
}
const dbRows = (f: string) => {
  const db = new Database(f, { readonly: true });
  try {
    return db.prepare('SELECT key FROM gateway_settings ORDER BY key').all().map((r: { key: string }) => r.key);
  } finally {
    db.close();
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simgw-scope-'));
  o = { dataDir: path.join(tmp, 'ProgramData', 'SimGateway'), secretsDir: path.join(tmp, 'ProgramData', 'SimGatewaySecrets'), outRoot: path.join(tmp, 'Local', 'Data Backups'), oldAppDir: repoRoot };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('D1: unsupported data locations are refused (exit 70), never silently left out', () => {
  const refused = (r: R, name: RegExp) => {
    expect(r.code).toBe(70);
    expect(r.message).toMatch(name);
    expect(r.message).toMatch(/Do NOT uninstall the older version/);
    expect(r.message).toMatch(/Nothing was changed/);
    expect(r.problems!.length).toBeGreaterThan(0);
    expect(copies()).toEqual([]); // no copy was made, and none is reported
    expect(fs.existsSync(o.outRoot)).toBe(false);
  };

  it('a custom data directory (SIMGW_DATA_DIR) is refused', async () => {
    makeCustomer();
    await withEnv({ SIMGW_DATA_DIR: 'D:\\CustomerData' }, async () => refused(await tool.backup(o, clean), /SIMGW_DATA_DIR/));
  });

  it('a custom secrets directory (SIMGW_SECRETS_DIR) is refused', async () => {
    makeCustomer();
    await withEnv({ SIMGW_SECRETS_DIR: 'D:\\Keys' }, async () => refused(await tool.backup(o, clean), /SIMGW_SECRETS_DIR/));
  });

  it('the same variables are seen when set only for the user or the machine (registry), not in this process', async () => {
    makeCustomer();
    refused(await tool.backup(o, { registryEnv: () => ({ SIMGW_DATA_DIR: 'E:\\Data' }) }), /SIMGW_DATA_DIR/);
    refused(await tool.backup(o, { registryEnv: () => ({ AI_REGISTRY_DIR: 'E:\\Reg' }) }), /AI_REGISTRY_DIR/);
  });

  it('the variables set to exactly the standard folders are fine', async () => {
    makeCustomer();
    await withEnv({ SIMGW_DATA_DIR: o.dataDir, SIMGW_SECRETS_DIR: o.secretsDir }, async () => expect((await tool.backup(o, clean)).code).toBe(0));
  });

  it('an unknown folder for the data is refused even when the standard folder does not exist (never "nothing to protect")', async () => {
    await withEnv({ SIMGW_DATA_DIR: 'D:\\Elsewhere' }, async () => {
      const r = await tool.backup(o, clean);
      expect(r.code).toBe(70);
    });
  });

  it.each([
    ['external database', () => 'SQLITE_DB_PATH=D:\\Db\\gateway.sqlite', /SQLITE_DB_PATH/],
    ['a different database file name inside the data folder', () => `SQLITE_DB_PATH=${o.dataDir}\\other.sqlite`, /SQLITE_DB_PATH/],
    ['external recordings', () => 'CALL_RECORDING_DIR=D:\\Recs', /CALL_RECORDING_DIR/],
    ['recordings on a network share', () => 'CALL_RECORDING_DIR=\\\\server\\share\\recs', /CALL_RECORDING_DIR/],
    ['recordings in a folder the copy skips (logs)', () => `CALL_RECORDING_DIR=${o.dataDir}\\logs\\recs`, /CALL_RECORDING_DIR/],
    ['a relative recordings path (inside the old program folder at run time)', () => 'CALL_RECORDING_DIR=./call-recordings', /CALL_RECORDING_DIR/],
    ['an external model registry', () => 'AI_REGISTRY_DIR=D:\\Reg', /AI_REGISTRY_DIR/],
    ['an external knowledge folder', () => 'AI_KNOWLEDGE_DIR=D:\\Kb', /AI_KNOWLEDGE_DIR/],
    ['an external prompt file', () => 'AI_SYSTEM_PROMPT_FILE=D:\\prompt.txt', /AI_SYSTEM_PROMPT_FILE/],
    ['a path that cannot be resolved (unknown %VARIABLE%)', () => 'CALL_RECORDING_DIR=%NO_SUCH_VARIABLE_XYZ%\\recs', /CALL_RECORDING_DIR/],
  ])('gateway.env: %s is refused', async (_name, line, rx) => {
    makeCustomer();
    setEnvFile((line as () => string)());
    refused(await tool.backup(o, clean), rx as RegExp);
  });

  it('the same settings in the Windows environment (not gateway.env) are refused too', async () => {
    makeCustomer();
    await withEnv({ CALL_RECORDING_DIR: 'D:\\Recs' }, async () => refused(await tool.backup(o, clean), /CALL_RECORDING_DIR/));
    await withEnv({ AI_KNOWLEDGE_DIR: 'D:\\Kb' }, async () => refused(await tool.backup(o, clean), /AI_KNOWLEDGE_DIR/));
  });

  it('paths INSIDE the standard data folder are supported, including a %VARIABLE% that expands into it', async () => {
    makeCustomer();
    fs.mkdirSync(path.join(o.dataDir, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(o.dataDir, 'knowledge', 'faq.txt'), 'opening hours');
    setEnvFile([`CALL_RECORDING_DIR=%SIMGW_TEST_ROOT%\\recordings\\2026`, `SQLITE_DB_PATH=${o.dataDir}\\gateway.sqlite`, `AI_REGISTRY_DIR=${o.dataDir}\\registry`, `AI_KNOWLEDGE_DIR=${o.dataDir}\\knowledge`].join('\n'));
    await withEnv({ SIMGW_TEST_ROOT: o.dataDir }, async () => {
      const r = await tool.backup(o, clean);
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(r.dir!, 'data', 'knowledge', 'faq.txt'), 'utf8')).toBe('opening hours'); // and it really is in the copy
    });
  });

  it('diagnostic locations (LOG_DIR, AUDIO_DUMP_DIRECTORY) are not customer data and do not block', async () => {
    makeCustomer();
    setEnvFile('LOG_DIR=D:\\Logs\nAUDIO_DUMP_DIRECTORY=D:\\Dumps');
    expect((await tool.backup(o, clean)).code).toBe(0);
  });

  it('a master key supplied by a Windows environment variable is refused, and its value is never shown', async () => {
    makeCustomer();
    const secret = `SIMGATEWAY-SECRETS-KEY-V1:${'ab'.repeat(32)}`;
    await withEnv({ AI_SECRETS_MASTER_KEY: secret }, async () => {
      const r = await tool.backup(o, clean);
      refused(r, /AI_SECRETS_MASTER_KEY/);
      expect(JSON.stringify(r)).not.toContain('abab');
    });
    refused(await tool.backup(o, { registryEnv: () => ({ AI_SECRETS_MASTER_KEY: secret }) }), /AI_SECRETS_MASTER_KEY/); // user/machine scope
  });

  it('an EMPTY master-key variable is ignored, and a key stored in gateway.env is supported because that file is copied', async () => {
    makeCustomer();
    await withEnv({ AI_SECRETS_MASTER_KEY: '' }, async () => expect((await tool.backup(o, clean)).code).toBe(0));
    setEnvFile(`AI_SECRETS_MASTER_KEY=SIMGATEWAY-SECRETS-KEY-V1:${'cd'.repeat(32)}`);
    const r = await tool.backup(o, T('2026-11-05T11:00:00Z'));
    expect(r.code).toBe(0);
    expect(sha(path.join(r.dir!, 'data', 'config', 'gateway.env'))).toBe(sha(path.join(o.dataDir, 'config', 'gateway.env')));
  });

  it('restore refuses too: it will not put data into the standard folders when the product looks elsewhere', async () => {
    makeCustomer();
    expect((await tool.backup(o, clean)).code).toBe(0);
    wipe();
    await withEnv({ SIMGW_DATA_DIR: 'D:\\CustomerData' }, () => {
      const r = tool.restore(o, clean);
      expect(r.code).toBe(70);
      expect(fs.existsSync(o.dataDir)).toBe(false);
    });
    expect(copies()).toHaveLength(1); // the safety copy is untouched
  });

  it('the command line exits 70 and leaves a plain-text message and a JSON result for setup', async () => {
    makeCustomer();
    const result = path.join(tmp, 'result.json');
    const r = spawnSync(process.execPath, [script, 'backup', '--data', o.dataDir, '--secrets', o.secretsDir, '--out', o.outRoot, '--old-app', repoRoot, '--result', result], { encoding: 'utf8', env: { ...process.env, SIMGW_DATA_DIR: 'D:\\Custom' } });
    expect(r.status).toBe(70);
    expect(JSON.parse(fs.readFileSync(result, 'utf8')).code).toBe(70);
    expect(fs.readFileSync(`${result}.txt`, 'utf8')).toMatch(/SIMGW_DATA_DIR[\s\S]*Do NOT uninstall/);
  });

  it('setup stops on 70 before any uninstall instruction, with a message of its own', () => {
    const iss = fs.readFileSync(path.join(repoRoot, 'installer', 'SimGateway.iss'), 'utf8');
    const code = iss.split('[Code]')[1];
    const protect = code.slice(code.indexOf('function ProtectDataOfOlderInstall'), code.indexOf('function InitializeSetup'));
    const branch = protect.slice(protect.indexOf('    70:'), protect.indexOf('    20:'));
    expect(branch).toMatch(/outside the standard folders/);
    expect(branch).toMatch(/do NOT uninstall/i);
    expect(branch).not.toMatch(/Result := True/);
    expect(protect).toMatch(/0, 10: Result := True/); // the only success codes
    expect(protect).toContain("ResultText(ResFile + '.txt')"); // the tool's own explanation is shown
    const init = code.slice(code.indexOf('function InitializeSetup'), code.indexOf('procedure RestoreCustomerData'));
    expect(init).toMatch(/Result := False;\s+if ProtectDataOfOlderInstall then/); // uninstall instructions exist only on success
  });
});

describe('D2: restore from several verified copies', () => {
  let original: { rec: string; ivr: string; env: string; rows: string[] };
  const snap = async (iso: string) => {
    const r = await tool.backup(o, T(iso));
    expect(r.code).toBe(0);
    return r.dir!;
  };
  const setup = async () => {
    makeCustomer();
    original = { rec: sha(path.join(o.dataDir, 'recordings', 'call-1.wav')), ivr: sha(path.join(o.dataDir, 'ivr', 'menu.wav')), env: sha(path.join(o.dataDir, 'config', 'gateway.env')), rows: dbRows(path.join(o.dataDir, 'gateway.sqlite')) };
  };
  const thin = () => {
    for (const d of ['recordings', 'ivr']) fs.rmSync(path.join(o.dataDir, d), { recursive: true, force: true });
    fs.rmSync(path.join(o.dataDir, 'gateway.sqlite'), { force: true });
  };

  it('a newer copy that lacks files does not hide an older complete one: missing items come from the older copy', async () => {
    await setup();
    await snap('2026-11-05T10:00:00Z');
    thin();
    await snap('2026-11-05T12:00:00Z');
    wipe();
    const r = tool.restore(o, clean);
    expect(r.code).toBe(0);
    expect(sha(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(original.rec);
    expect(sha(path.join(o.dataDir, 'ivr', 'menu.wav'))).toBe(original.ivr);
    expect(dbRows(path.join(o.dataDir, 'gateway.sqlite'))).toEqual(original.rows); // the database came from the older copy that has it
    expect(r.restored).toEqual(expect.arrayContaining(['database', 'recordings/call-1.wav', 'ivr/menu.wav', 'master.key', 'config/gateway.env']));
  });

  it('conflicting files: the newest verified copy wins, an older copy never replaces it, and a restored file is never overwritten again', async () => {
    await setup();
    await snap('2026-11-05T10:00:00Z');
    fs.writeFileSync(path.join(o.dataDir, 'config', 'gateway.env'), `${GATEWAY_KEY}\nNEWER=1\n`);
    const newerEnv = sha(path.join(o.dataDir, 'config', 'gateway.env'));
    await snap('2026-11-05T12:00:00Z');
    wipe();
    const r = tool.restore(o, clean);
    expect(r.code).toBe(0);
    expect(sha(path.join(o.dataDir, 'config', 'gateway.env'))).toBe(newerEnv);
    // run it again after the customer edited the restored file: nothing is touched
    fs.writeFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'EDITED AFTER RESTORE\n');
    const again = tool.restore(o, clean);
    expect(again.restored).toEqual([]);
    expect(fs.readFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'utf8')).toBe('EDITED AFTER RESTORE\n');
  });

  it('a tampered OLDER copy: the file only it has is skipped (code 60), everything else is still restored, and nothing corrupted is written', async () => {
    await setup();
    const older = await snap('2026-11-05T10:00:00Z');
    thin();
    await snap('2026-11-05T12:00:00Z');
    fs.appendFileSync(path.join(older, 'data', 'recordings', 'call-1.wav'), 'tamper');
    wipe();
    const r = tool.restore(o, clean);
    expect(r.code).toBe(60);
    expect(r.skipped!.join(' ')).toMatch(/recordings\/call-1\.wav[^;]*no longer matches its checksum/);
    expect(fs.existsSync(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(false);
    expect(sha(path.join(o.dataDir, 'ivr', 'menu.wav'))).toBe(original.ivr);
  });

  it('a tampered NEWER copy: the same file is taken from the older, intact copy instead', async () => {
    await setup();
    await snap('2026-11-05T10:00:00Z');
    const newer = await snap('2026-11-05T12:00:00Z');
    fs.appendFileSync(path.join(newer, 'data', 'recordings', 'call-1.wav'), 'tamper');
    wipe();
    const r = tool.restore(o, clean);
    expect(r.code).toBe(0);
    expect(sha(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(original.rec);
  });

  it('an orphan ".partial" folder that even contains a COMPLETE marker is never used, listed or rejected', async () => {
    await setup();
    const good = await snap('2026-11-05T10:00:00Z');
    const orphan = path.join(o.outRoot, 'migration-20261105-235959.partial'); // the newest name of all
    fs.cpSync(good, orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'data', 'recordings', 'call-1.wav'), 'NOT THE REAL RECORDING');
    fs.writeFileSync(path.join(orphan, 'COMPLETE'), tool.sha256File(path.join(orphan, 'MANIFEST.json')));
    const listed = tool.completeBackups(o.outRoot);
    expect(listed.valid.map((v) => v.name)).toEqual([path.basename(good)]);
    expect(listed.rejected).toEqual([]);
    wipe();
    expect(tool.restore(o, clean).code).toBe(0);
    expect(sha(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(original.rec);
  });

  it('rejects unfinished copies and copies whose manifest no longer matches its COMPLETE marker, and says so', async () => {
    await setup();
    const a = await snap('2026-11-05T10:00:00Z');
    thin();
    const b = await snap('2026-11-05T11:00:00Z');
    const c = await snap('2026-11-05T12:00:00Z');
    fs.rmSync(path.join(b, 'COMPLETE'));
    const manifest = JSON.parse(fs.readFileSync(path.join(c, 'MANIFEST.json'), 'utf8'));
    manifest.files.push({ rel: 'recordings/forged.wav', size: 1, sha256: '0'.repeat(64) });
    fs.writeFileSync(path.join(c, 'MANIFEST.json'), JSON.stringify(manifest));
    const listed = tool.completeBackups(o.outRoot);
    expect(listed.valid.map((v) => v.name)).toEqual([path.basename(a)]);
    expect(listed.rejected.join(' ')).toMatch(/unfinished \(no COMPLETE marker\)/);
    expect(listed.rejected.join(' ')).toMatch(/does not match the COMPLETE marker/);
    wipe();
    const r = tool.restore(o, clean);
    expect(r.code).toBe(0);
    expect(r.message).toMatch(/Unusable copies were ignored/);
    expect(fs.existsSync(path.join(o.dataDir, 'recordings', 'forged.wav'))).toBe(false);
  });

  it('if no copy is usable, nothing is restored and the reason is given', async () => {
    await setup();
    const a = await snap('2026-11-05T10:00:00Z');
    fs.rmSync(path.join(a, 'COMPLETE'));
    wipe();
    const r = tool.restore(o, clean);
    expect(r.code).toBe(60);
    expect(r.message).toMatch(/None of the safety copies/);
    expect(fs.existsSync(o.dataDir)).toBe(false);
  });

  it('a hostile manifest cannot make restore write outside the data folder', async () => {
    await setup();
    const a = await snap('2026-11-05T10:00:00Z');
    const manifest = JSON.parse(fs.readFileSync(path.join(a, 'MANIFEST.json'), 'utf8'));
    manifest.files.push({ rel: '../escaped.txt', size: 1, sha256: '1'.repeat(64) }, { rel: 'recordings/../../escaped2.txt', size: 1, sha256: '1'.repeat(64) });
    fs.writeFileSync(path.join(a, 'MANIFEST.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(a, 'COMPLETE'), tool.sha256File(path.join(a, 'MANIFEST.json'))); // an attacker can recompute the marker
    wipe();
    const r = tool.restore(o, clean);
    expect(r.skipped!.join(' ')).toMatch(/unsafe name/);
    expect(fs.existsSync(path.join(path.dirname(o.dataDir), 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(o.dataDir), 'escaped2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(true); // the honest entries still restore
  });

  it('keeps an existing master key and its permissions untouched, and restores a missing one with the restricted ACL, from the newest copy of the same account', async () => {
    await setup();
    await snap('2026-11-05T10:00:00Z');
    const key = path.join(o.secretsDir, 'master.key');
    const before = { hash: sha(key), acl: execFileSync('icacls.exe', [key], { encoding: 'utf8' }) };
    // 1. key present: kept
    fs.rmSync(path.join(o.dataDir, 'recordings'), { recursive: true, force: true });
    const r1 = tool.restore(o, clean);
    expect(r1.kept).toContain('master.key');
    expect(sha(key)).toBe(before.hash);
    expect(execFileSync('icacls.exe', [key], { encoding: 'utf8' })).toBe(before.acl);
    // 2. key missing: restored byte-identical with the restricted ACL
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    const r2 = tool.restore(o, clean);
    expect(r2.restored).toContain('master.key');
    expect(sha(key)).toBe(before.hash);
    expect(execFileSync('icacls.exe', [key], { encoding: 'utf8' })).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|BUILTIN\\Administrators/i);
    // 3. a copy that belongs to another account is not used for the key
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    const r3 = tool.restore(o, { ...clean, user: () => ({ name: 'OTHER\\someone', sid: 'S-1-5-21-9-9-9-9' }) });
    expect(r3.code).toBe(60);
    expect(r3.skipped!.join(' ')).toMatch(/master\.key[^;]*belongs to .*sign in with that account/);
    expect(fs.existsSync(key)).toBe(false);
  });
});
