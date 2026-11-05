import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The safety copy taken before the old all-users install is removed, and the restore after the per-user install. Everything runs on real
 * files, a real SQLite database in WAL mode and real Windows ACLs in a scratch folder: no customer data, no program folder, no modem.
 */
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'installer', 'migrate', 'customer-data.cjs');
const tool = require(script) as {
  backup: (o: Opts, d?: Record<string, unknown>) => Promise<R>;
  restore: (o: Opts, d?: Record<string, unknown>) => R;
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
  restored?: string[];
  kept?: string[];
  skipped?: string[];
}

const me = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`.replace(/^\\/, '');
let tmp: string;
let o: Opts;
let writer: { exec: (s: string) => unknown; close: () => void };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const listing = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/'))
        .sort()
    : [];
const backups = () => (fs.existsSync(o.outRoot) ? fs.readdirSync(o.outRoot) : []);

/** A customer: database with rows that exist ONLY in the -wal file, recordings, IVR audio, config, registry, key. */
function makeCustomer() {
  fs.mkdirSync(path.join(o.dataDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(o.dataDir, 'recordings'), { recursive: true });
  fs.mkdirSync(path.join(o.dataDir, 'ivr'), { recursive: true });
  fs.mkdirSync(path.join(o.dataDir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(o.dataDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(o.dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'GATEWAY_API_KEY=customer-key-aaaaaaaaaaaaaaaa\nMODEM_AT_PORT=\n');
  fs.writeFileSync(path.join(o.dataDir, 'recordings', 'call-1.wav'), crypto.randomBytes(20_000));
  fs.writeFileSync(path.join(o.dataDir, 'ivr', 'menu.wav'), crypto.randomBytes(5_000));
  fs.writeFileSync(path.join(o.dataDir, 'registry', 'pricing.json'), '{"p":1}');
  fs.writeFileSync(path.join(o.dataDir, 'backups', 'pre-update.sqlite'), 'older backup');
  fs.writeFileSync(path.join(o.dataDir, 'logs', 'gateway.log'), 'log noise');
  fs.writeFileSync(path.join(o.dataDir, 'supervisor.token'), 'not customer data');
  const db = new Database(path.join(o.dataDir, 'gateway.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0'); // nothing is ever merged into the main file: rows live in -wal only
  db.exec("CREATE TABLE gateway_settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO gateway_settings VALUES ('agent.inboundInstructions','Custom inbound prompt'),('ai.secret.DEEPGRAM_API_KEY','ciphertext-xyz');");
  db.exec("INSERT INTO gateway_settings VALUES ('agent.outboundInstructions','Custom outbound prompt');");
  writer = db; // kept OPEN, like a running old product
  fs.mkdirSync(o.secretsDir, { recursive: true });
  const key = path.join(o.secretsDir, 'master.key');
  fs.writeFileSync(key, crypto.randomBytes(32).toString('hex'));
  execFileSync('icacls.exe', [key, '/inheritance:r', '/grant:r', `${me}:(R,W,D)`, '*S-1-5-18:(F)'], { stdio: 'pipe' });
}
const rows = (file: string) => {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT key, value FROM gateway_settings ORDER BY key').all();
  } finally {
    db.close();
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simgw-mig-'));
  o = { dataDir: path.join(tmp, 'ProgramData', 'SimGateway'), secretsDir: path.join(tmp, 'ProgramData', 'SimGatewaySecrets'), outRoot: path.join(tmp, 'LocalAppData', 'SIZH IT Solution Data Backups'), oldAppDir: repoRoot };
});
afterEach(() => {
  try {
    writer?.close();
  } catch {
    /* already closed */
  }
  spawnSync('icacls.exe', [path.join(o.secretsDir, 'master.key'), '/remove:d', me], { stdio: 'ignore' });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the safety copy', () => {
  it('captures rows that exist only in the WAL file, which a plain file copy of the database would lose', async () => {
    makeCustomer();
    // the proof that the method matters: copying just gateway.sqlite loses the settings
    const plain = path.join(tmp, 'plain-copy.sqlite');
    fs.copyFileSync(path.join(o.dataDir, 'gateway.sqlite'), plain);
    let plainRows = -1;
    try {
      plainRows = rows(plain).length;
    } catch {
      plainRows = 0;
    }
    expect(plainRows).toBeLessThan(3);

    const r = await tool.backup(o);
    expect(r.code).toBe(0);
    const copy = path.join(r.dir!, 'gateway.sqlite');
    expect(rows(copy)).toEqual(rows(path.join(o.dataDir, 'gateway.sqlite'))); // all three rows, including the one written last
    expect(rows(copy)).toHaveLength(3);
    // and it is a real, checkable database
    const db = new Database(copy, { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });

  it('copies the customer files, the key and a manifest, builds it as .partial and ends with a COMPLETE marker; the originals are untouched', async () => {
    makeCustomer();
    const before = { env: sha(path.join(o.dataDir, 'config', 'gateway.env')), key: sha(path.join(o.secretsDir, 'master.key')), rec: sha(path.join(o.dataDir, 'recordings', 'call-1.wav')) };
    const r = await tool.backup(o);
    expect(r.code).toBe(0);
    const files = listing(r.dir!);
    for (const f of ['MANIFEST.json', 'COMPLETE', 'gateway.sqlite', 'data/config/gateway.env', 'data/recordings/call-1.wav', 'data/ivr/menu.wav', 'data/registry/pricing.json', 'data/backups/pre-update.sqlite', 'secrets/master.key', 'secrets-acl.txt']) expect(files, f).toContain(f);
    expect(files.some((f) => f.includes('gateway.log') || f.includes('supervisor.token'))).toBe(false); // not customer data
    expect(backups().filter((n) => n.endsWith('.partial'))).toEqual([]);
    expect(backups()[0]).toMatch(/^migration-\d{8}-\d{6}$/);
    expect(sha(path.join(r.dir!, 'data', 'config', 'gateway.env'))).toBe(before.env);
    expect(sha(path.join(r.dir!, 'secrets', 'master.key'))).toBe(before.key);
    expect(sha(path.join(r.dir!, 'data', 'recordings', 'call-1.wav'))).toBe(before.rec);
    // nothing in the live folders changed
    expect(sha(path.join(o.dataDir, 'config', 'gateway.env'))).toBe(before.env);
    expect(sha(path.join(o.secretsDir, 'master.key'))).toBe(before.key);
    expect(sha(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(before.rec);
  });

  it('keeps the key protected: only this account and SYSTEM, no inheritance, and the original ACL is saved', async () => {
    makeCustomer();
    const r = await tool.backup(o);
    for (const target of [path.join(r.dir!, 'secrets', 'master.key'), path.join(r.dir!, 'secrets')]) {
      const acl = execFileSync('icacls.exe', [target], { encoding: 'utf8' });
      expect(acl, target).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|BUILTIN\\Administrators/i);
      expect(acl.toLowerCase()).toContain(me.toLowerCase());
    }
    expect(fs.readFileSync(path.join(r.dir!, 'secrets-acl.txt')).length).toBeGreaterThan(10);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir!, 'MANIFEST.json'), 'utf8')).user.name.toLowerCase()).toBe(me.toLowerCase());
  });

  it('stops (code 20) and creates no copy when this account cannot read the encryption key, and never makes a key', async () => {
    makeCustomer();
    const key = path.join(o.secretsDir, 'master.key');
    execFileSync('icacls.exe', [key, '/deny', `${me}:(R)`], { stdio: 'pipe' });
    const r = await tool.backup(o);
    expect(r.code).toBe(20);
    expect(r.message).toMatch(/cannot be read by this Windows account/);
    expect(backups().filter((n) => n.startsWith('migration-'))).toEqual([]);
    expect(fs.readdirSync(o.secretsDir)).toEqual(['master.key']); // no replacement key appeared
  });

  it('stops (code 30) and writes nothing when there is not enough free disk space', async () => {
    makeCustomer();
    const r = await tool.backup(o, { freeBytes: () => 1000 });
    expect(r.code).toBe(30);
    expect(r.message).toMatch(/not enough free disk space/);
    expect(backups().filter((n) => n.startsWith('migration-'))).toEqual([]);
  });

  it('stops (code 50) when a copied file does not match, leaves no finished copy and no .partial, and the originals are intact', async () => {
    makeCustomer();
    const rec = sha(path.join(o.dataDir, 'recordings', 'call-1.wav'));
    const r = await tool.backup(o, {
      afterCopy: (to: string) => {
        if (to.endsWith('call-1.wav')) fs.appendFileSync(to, 'tamper');
      },
    });
    expect(r.code).toBe(50);
    expect(r.message).toMatch(/does not match the original/);
    expect(r.message).toMatch(/do NOT uninstall the old version/);
    expect(backups()).toEqual([]);
    expect(sha(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(rec);
  });

  it('stops (code 50) when the key copy does not match', async () => {
    makeCustomer();
    const r = await tool.backup(o, {
      afterCopy: (to: string) => {
        if (to.endsWith('master.key')) fs.writeFileSync(to, 'different');
      },
    });
    expect(r.code).toBe(50);
    expect(backups()).toEqual([]);
  });

  it('stops (code 40) when the database library cannot be loaded, because a consistent copy is then impossible', async () => {
    makeCustomer();
    const r = await tool.backup(o, {
      loadSqlite: () => {
        throw Object.assign(new Error('cannot load'), { code: 40 });
      },
    });
    expect(r.code).toBe(40);
    expect(backups()).toEqual([]);
  });

  it('reports "nothing to protect" (code 10) when there is no customer data folder', async () => {
    expect((await tool.backup(o)).code).toBe(10);
  });

  it('refuses to start over an existing copy with the same name, and never deletes an earlier finished copy', async () => {
    makeCustomer();
    const first = await tool.backup(o, { now: () => new Date('2026-11-05T10:00:00Z') });
    expect(first.code).toBe(0);
    const again = await tool.backup(o, { now: () => new Date('2026-11-05T10:00:00Z') });
    expect(again.code).toBe(40);
    expect(fs.existsSync(path.join(first.dir!, 'COMPLETE'))).toBe(true);
    const later = await tool.backup(o, { now: () => new Date('2026-11-05T10:05:00Z') });
    expect(later.code).toBe(0);
    expect(backups().filter((n) => n.startsWith('migration-'))).toHaveLength(2);
  });
});

describe('restoring after the old uninstaller deleted the data (the customer answered Yes)', () => {
  it('puts everything back: database with its WAL-only rows, files, and the key with its protection and original account', async () => {
    makeCustomer();
    const before = { rows: rows(path.join(o.dataDir, 'gateway.sqlite')), key: sha(path.join(o.secretsDir, 'master.key')), env: sha(path.join(o.dataDir, 'config', 'gateway.env')), rec: sha(path.join(o.dataDir, 'recordings', 'call-1.wav')), ivr: sha(path.join(o.dataDir, 'ivr', 'menu.wav')) };
    expect((await tool.backup(o)).code).toBe(0);
    writer.close();
    // what "delete my data" does
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    expect(fs.existsSync(o.dataDir)).toBe(false);

    const r = tool.restore(o);
    expect(r.code).toBe(0);
    expect(r.restored).toEqual(expect.arrayContaining(['database', 'config/gateway.env', 'recordings/call-1.wav', 'ivr/menu.wav', 'master.key']));
    expect(rows(path.join(o.dataDir, 'gateway.sqlite'))).toEqual(before.rows);
    expect(sha(path.join(o.secretsDir, 'master.key'))).toBe(before.key);
    expect(sha(path.join(o.dataDir, 'config', 'gateway.env'))).toBe(before.env);
    expect(sha(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(before.rec);
    expect(sha(path.join(o.dataDir, 'ivr', 'menu.wav'))).toBe(before.ivr);
    const acl = execFileSync('icacls.exe', [path.join(o.secretsDir, 'master.key')], { encoding: 'utf8' });
    expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|BUILTIN\\Administrators/i);
    // the copy itself is still there afterwards
    expect(backups().filter((n) => n.startsWith('migration-'))).toHaveLength(1);
  });

  it('a second restore changes nothing, and newer data written after the first restore is never overwritten', async () => {
    makeCustomer();
    expect((await tool.backup(o)).code).toBe(0);
    writer.close();
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    tool.restore(o);
    fs.writeFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'NEWER=1\n');
    const db = new Database(path.join(o.dataDir, 'gateway.sqlite'));
    db.exec("INSERT INTO gateway_settings VALUES ('newer','row')");
    db.close();
    const again = tool.restore(o);
    expect(again.restored).toEqual([]);
    expect(again.kept).toEqual(expect.arrayContaining(['database', 'config/gateway.env', 'master.key']));
    expect(fs.readFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'utf8')).toBe('NEWER=1\n');
    expect(rows(path.join(o.dataDir, 'gateway.sqlite')).some((x: { key: string }) => x.key === 'newer')).toBe(true);
  });

  it('never overwrites existing data: a live database, key and config are kept as they are', async () => {
    makeCustomer();
    expect((await tool.backup(o)).code).toBe(0);
    writer.close();
    // the customer already has newer data in place (for example the product was started once)
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(o.dataDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'LIVE=1\n');
    const live = new Database(path.join(o.dataDir, 'gateway.sqlite'));
    live.exec("CREATE TABLE gateway_settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO gateway_settings VALUES ('live','1');");
    live.close();
    const liveKey = fs.readFileSync(path.join(o.secretsDir, 'master.key'), 'utf8');
    const r = tool.restore(o);
    expect(r.kept).toEqual(expect.arrayContaining(['database', 'config/gateway.env', 'master.key']));
    expect(rows(path.join(o.dataDir, 'gateway.sqlite'))).toEqual([{ key: 'live', value: '1' }]);
    expect(fs.readFileSync(path.join(o.dataDir, 'config', 'gateway.env'), 'utf8')).toBe('LIVE=1\n');
    expect(fs.readFileSync(path.join(o.secretsDir, 'master.key'), 'utf8')).toBe(liveKey);
    // but the missing files are still put back
    expect(fs.existsSync(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(true);
  });

  it('refuses an unfinished or altered copy, and restores nothing from it', async () => {
    makeCustomer();
    const b = await tool.backup(o);
    writer.close();
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    fs.rmSync(path.join(b.dir!, 'COMPLETE'));
    const noMarker = tool.restore(o);
    expect(noMarker.restored ?? []).toEqual([]);
    expect(fs.existsSync(o.dataDir)).toBe(false);
    fs.writeFileSync(path.join(b.dir!, 'COMPLETE'), 'wrong');
    const altered = tool.restore(o);
    expect(altered.code).toBe(60);
    expect(fs.existsSync(o.dataDir)).toBe(false);
  });

  it('skips a file whose copy no longer matches its checksum instead of restoring a corrupted one', async () => {
    makeCustomer();
    const b = await tool.backup(o);
    writer.close();
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.appendFileSync(path.join(b.dir!, 'data', 'recordings', 'call-1.wav'), 'x');
    const r = tool.restore(o);
    expect(r.code).toBe(60);
    expect(r.skipped?.join(' ')).toMatch(/call-1\.wav/);
    expect(fs.existsSync(path.join(o.dataDir, 'recordings', 'call-1.wav'))).toBe(false);
    expect(fs.existsSync(path.join(o.dataDir, 'ivr', 'menu.wav'))).toBe(true); // the intact files are still restored
  });

  it('does not restore the key for a different Windows account, and never creates a key', async () => {
    makeCustomer();
    expect((await tool.backup(o)).code).toBe(0);
    writer.close();
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    const r = tool.restore(o, { user: () => ({ name: 'OTHER\\someone', sid: 'S-1-5-21-1-2-3-9999' }) });
    expect(r.code).toBe(60);
    expect(r.skipped?.join(' ')).toMatch(/master\.key.*sign in with that account/);
    expect(fs.existsSync(path.join(o.secretsDir, 'master.key'))).toBe(false); // the product's "key is missing but keys were saved" refusal then protects the data
    expect(fs.existsSync(path.join(o.dataDir, 'gateway.sqlite'))).toBe(true);
  });

  it('does nothing when there is no safety copy (a normal first install)', () => {
    const r = tool.restore(o);
    expect(r.code).toBe(0);
    expect(fs.existsSync(o.dataDir)).toBe(false);
  });
});

describe('the command line used by setup', () => {
  it('backup then restore through node exactly as setup runs them, with the exit codes setup relies on', async () => {
    makeCustomer();
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const b = run(['backup', '--data', o.dataDir, '--secrets', o.secretsDir, '--out', o.outRoot, '--old-app', repoRoot]);
    expect(b.status).toBe(0);
    expect(JSON.parse(b.stdout.trim().split('\n').pop()!).code).toBe(0);
    writer.close();
    fs.rmSync(o.dataDir, { recursive: true, force: true });
    fs.rmSync(o.secretsDir, { recursive: true, force: true });
    const r = run(['restore', '--data', o.dataDir, '--secrets', o.secretsDir, '--out', o.outRoot]);
    expect(r.status).toBe(0);
    expect(rows(path.join(o.dataDir, 'gateway.sqlite'))).toHaveLength(3);
    expect(run(['backup']).status).toBe(2); // usage error, not a silent success
    expect(run(['backup', '--data', path.join(tmp, 'missing'), '--secrets', path.join(tmp, 'missing2'), '--out', path.join(tmp, 'o2')]).status).toBe(10);
  });
});

describe('the installer script wires it in safely', () => {
  const iss = fs.readFileSync(path.join(repoRoot, 'installer', 'SimGateway.iss'), 'utf8');
  const code = iss.split('[Code]')[1];

  it('takes and verifies the copy BEFORE telling the customer to uninstall, and stops setup if it fails', () => {
    const protect = code.slice(code.indexOf('function ProtectDataOfOlderInstall'), code.indexOf('function InitializeSetup'));
    const init = code.slice(code.indexOf('function InitializeSetup'), code.indexOf('procedure RestoreCustomerData'));
    expect(protect).toMatch(/ExtractTemporaryFile\('customer-data\.cjs'\)/);
    expect(protect).toMatch(/backup --data/);
    expect(protect).toMatch(/runtime\\node\.exe/); // run with the OLD install's own Node and database library
    expect(protect).toMatch(/0, 10: Result := True/); // only a verified copy (or no data at all) lets setup go on
    expect(protect.match(/do NOT uninstall/gi)!.length).toBeGreaterThanOrEqual(4); // every failure says so
    // setup always ends (Result := False); the uninstall instructions are shown only when the copy succeeded
    expect(init).toMatch(/Result := False;\s+if ProtectDataOfOlderInstall then/);
    expect(init.indexOf('ProtectDataOfOlderInstall')).toBeLessThan(init.indexOf('click Uninstall'));
    expect(init).toMatch(/Choose NO/);
    expect(init).toMatch(/restores your data from the safety copy/);
    // setup itself never launches the older uninstaller
    expect(code).not.toMatch(/unins\d+\.exe|UninstallString/i);
  });

  it('restores missing data after installing and before the product is started, and only reports problems', () => {
    expect(code).toMatch(/procedure RestoreCustomerData/);
    expect(code).toMatch(/restore --data/);
    expect(iss).toMatch(/Source: "migrate\\customer-data\.cjs"; DestDir: "\{app\}\\migrate"/);
    expect(code).toMatch(/ssPostInstall[\s\S]*RestoreCustomerData/);
    expect(iss.indexOf('Description: "Start SIZH IT Solution now')).toBeGreaterThan(0); // the product only starts at the very end
  });

  it('keeps the safety copy outside both program folders and out of every cleanup rule', () => {
    expect(iss).toContain('SIZH IT Solution Data Backups');
    const deletes = iss.split('[UninstallDelete]')[1].split('\n[')[0];
    expect(deletes).not.toContain('Data Backups');
    expect(iss.split('[InstallDelete]')[1].split('\n[')[0]).not.toContain('Data Backups');
    expect(code).not.toMatch(/DelTree[^\n]*Data Backups/);
    expect(iss).not.toMatch(/\{app\}[^\n]*Data Backups/);
  });
});
