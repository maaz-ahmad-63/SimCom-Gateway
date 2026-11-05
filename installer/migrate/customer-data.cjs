'use strict';
// Customer-data safety copy and restore for the move from the all-users install (Program Files) to the per-user install.
//
//   node customer-data.cjs backup  --data <ProgramData\SimGateway> --secrets <ProgramData\SimGatewaySecrets> --out <backup root> --old-app <old program folder>
//   node customer-data.cjs restore --data ...                      --secrets ...                          --out <backup root>
//
// backup   Makes a VERIFIED copy of everything that is the customer's, BEFORE the old uninstaller (which can offer to delete it) is run:
//            - the database, through SQLite's online backup API (consistent even while the old product is writing, WAL included),
//              then integrity-checked; a plain file copy would miss everything still in the -wal file
//            - config\gateway.env, recordings, IVR audio, model registry, earlier database backups and any other data file
//            - the encryption master key, with the same restricted permissions the product gives it, plus a saved copy of the original ACL
//          The copy goes to a folder outside both program folders. It is built as "<name>.partial", every file is hashed twice
//          (source while copying, copy afterwards), the database is checked again, and only then is it renamed to its final name with a
//          COMPLETE marker. Nothing in the data or secrets folders is changed, and nothing is ever deleted except this run's own .partial.
// restore  After the new install and BEFORE the product starts: puts back only what is missing, taking each item from the NEWEST complete,
//          verified copy that still has it (older copies fill what newer ones lack). It never overwrites an existing file or database,
//          never makes a key, verifies every file's hash first, ignores unfinished or altered copies, and refuses to restore the key for a
//          different Windows account.
//
// SUPPORTED SCOPE: customer data in %ProgramData%\SimGateway and the key in %ProgramData%\SimGatewaySecrets, plus a key kept inside
// config\gateway.env (it is copied with that file). Anything else is REFUSED (exit 70), never silently left out:
//   - SIMGW_DATA_DIR / SIMGW_SECRETS_DIR pointing anywhere else (process, user or machine environment)
//   - SQLITE_DB_PATH, CALL_RECORDING_DIR, AI_REGISTRY_DIR, AI_KNOWLEDGE_DIR, AI_SYSTEM_PROMPT_FILE set (environment or gateway.env) to a
//     place outside the data folder, to a relative path, or to something the copy skips (logs, audio-dumps, updates)
//   - AI_SECRETS_MASTER_KEY set as a Windows environment variable (the key is then in no file this tool can copy)
//
// Exit codes: 0 ok, 10 nothing to protect (no data folder), 20 the encryption key cannot be read by this account,
//             30 not enough free disk space, 40 the copy failed, 50 verification failed, 60 restore problem (see message),
//             70 unsupported configuration: customer data (or the key) lives where this tool does not copy it, 2 usage.

const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_FILE = 'master.key';
const DB_NAME = 'gateway.sqlite';
// Not customer data: regenerated or recreated by the product.
const SKIP_TOP = new Set(['logs', 'audio-dumps', 'updates', 'supervisor.lock', 'supervisor.token', 'supervisor-status.json']);
const isDbFile = (n) => n === DB_NAME || n === `${DB_NAME}-wal` || n === `${DB_NAME}-shm`;

// Settings that name where customer data lives. AUDIO_DUMP_DIRECTORY and LOG_DIR are diagnostics, not customer data, and are ignored.
const PATH_VARS = { SQLITE_DB_PATH: 'database file', CALL_RECORDING_DIR: 'recordings folder', AI_REGISTRY_DIR: 'model registry folder', AI_KNOWLEDGE_DIR: 'knowledge folder', AI_SYSTEM_PROMPT_FILE: 'prompt file' };

function readRegistryEnv() {
  if (process.platform !== 'win32') return {};
  const reg = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'reg.exe');
  const out = {};
  // machine first, then user: the same order Windows uses (the user's value wins)
  for (const key of ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment']) {
    let text = '';
    try {
      text = cp.execFileSync(reg, ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
      if (m) out[m[1].toUpperCase()] = m[2].trim();
    }
  }
  return out;
}

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) out[key] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
const expandPercent = (v, env) => v.replace(/%([^%]+)%/g, (m, n) => env[n.toUpperCase()] ?? m);

/**
 * Every way this installation can keep customer data (or its key) where the safety copy does not reach. Returns plain-English reasons;
 * an empty list means everything is inside the two standard folders. Values of secrets are never included.
 */
function findUnsupportedLocations(opts, deps) {
  const { dataDir, secretsDir } = opts;
  const env = { ...deps.registryEnv() };
  for (const [k, v] of Object.entries(process.env)) env[k.toUpperCase()] = v;
  let file = {};
  try {
    file = parseEnvFile(fs.readFileSync(path.join(dataDir, 'config', 'gateway.env'), 'utf8'));
  } catch {
    /* no configuration file: nothing to inspect there */
  }
  const problems = [];
  const dataRoot = norm(dataDir);

  for (const [name, expected] of [['SIMGW_DATA_DIR', dataDir], ['SIMGW_SECRETS_DIR', secretsDir]]) {
    const v = (env[name] || '').trim();
    if (!v) continue;
    const x = expandPercent(v, env);
    if (/%/.test(x) || !path.isAbsolute(x) || norm(x) !== norm(expected)) problems.push(`${name} is set (to ${v}), so this installation keeps ${name === 'SIMGW_DATA_DIR' ? 'its data' : 'its encryption key'} somewhere other than the standard folder.`);
  }
  for (const [source, values] of [['the Windows environment', env], ['config\\gateway.env', file]]) {
    for (const [name, what] of Object.entries(PATH_VARS)) {
      const raw = (values[name] || '').trim();
      if (!raw) continue;
      const x = expandPercent(raw, env);
      let ok = false;
      if (!/%/.test(x) && path.isAbsolute(x)) {
        if (name === 'SQLITE_DB_PATH') ok = norm(x) === norm(path.join(dataDir, DB_NAME));
        else {
          const rel = path.relative(dataRoot, path.resolve(x));
          const first = rel.split(path.sep)[0];
          ok = !rel.startsWith('..') && !path.isAbsolute(rel) && !SKIP_TOP.has(first) && !isDbFile(first);
        }
      }
      if (!ok) problems.push(`${name} is set in ${source} (to ${raw}): the ${what} is outside the standard data folder, or its place cannot be determined.`);
    }
  }
  if ((env.AI_SECRETS_MASTER_KEY || '').trim()) problems.push('AI_SECRETS_MASTER_KEY is set as a Windows environment variable, so the key that protects the saved API keys is not in any file that can be copied (it is not lost by uninstalling, but it is not protected by this copy either).');
  return problems;
}

function unsupportedMessage(problems, action) {
  return `This installation cannot be ${action === 'restore' ? 'restored' : 'migrated'} automatically, because customer data or the encryption key is kept where the safety copy does not reach:\n- ${problems.join('\n- ')}\nThe safety copy covers only the standard folders (%ProgramData%\\SimGateway and %ProgramData%\\SimGatewaySecrets). Nothing was changed. Do NOT uninstall the older version; contact support.`;
}

class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sha256File = (file) => {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
};

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && SKIP_TOP.has(e.name)) continue;
    if (!rel && isDbFile(e.name)) continue;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const defaultDeps = {
  now: () => new Date(),
  freeBytes: (dir) => {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  },
  user: () => {
    const name = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || os.userInfo().username}`.replace(/^\\/, '');
    let sid = null;
    try {
      // by full path: a `whoami` earlier on PATH (Git's GNU one) does not understand these options
      sid = cp.execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().split(',')[1]?.replace(/"/g, '') ?? null;
    } catch {
      /* not fatal: the name is still recorded */
    }
    return { name, sid };
  },
  // Same rule as the product (master-key.ts): only this user and SYSTEM, no inheritance.
  protect: (target, directory) => {
    if (process.platform !== 'win32') return;
    const user = defaultDeps.user().name;
    cp.execFileSync('icacls.exe', [target, '/inheritance:r', '/grant:r', directory ? `${user}:(OI)(CI)F` : `${user}:(R,W,D)`, directory ? '*S-1-5-18:(OI)(CI)F' : '*S-1-5-18:(F)'], { windowsHide: true, stdio: 'pipe' });
    const acl = cp.execFileSync('icacls.exe', [target], { encoding: 'utf8', windowsHide: true });
    if (/\b(Everyone|BUILTIN\\Users|Authenticated Users)\b/i.test(acl)) throw new Error(`${target} is still readable by other accounts`);
  },
  saveAcl: (dir, file) => {
    if (process.platform === 'win32') cp.execFileSync('icacls.exe', [dir, '/save', file, '/T', '/C'], { windowsHide: true, stdio: 'pipe' });
  },
  loadSqlite: (oldAppDir) => {
    const { createRequire } = require('node:module');
    const bases = [oldAppDir && path.join(oldAppDir, 'gateway', 'package.json'), oldAppDir && path.join(oldAppDir, 'package.json'), __filename].filter(Boolean);
    let last;
    for (const b of bases) {
      try {
        return createRequire(b)('better-sqlite3');
      } catch (e) {
        last = e;
      }
    }
    throw new MigrationError(40, `The database library of the installed product could not be loaded (${last && last.message}).`);
  },
  registryEnv: readRegistryEnv,
  afterCopy: () => undefined, // test seam: runs after a file was copied, before verification
  log: () => undefined,
};

function checkDb(Database, file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    return { ok: result === 'ok', result, tables };
  } finally {
    db.close();
  }
}

async function backup(opts, over = {}) {
  const deps = { ...defaultDeps, ...over };
  const { dataDir, secretsDir, outRoot, oldAppDir } = opts;
  const dbFile = path.join(dataDir, DB_NAME);
  const keyFile = path.join(secretsDir, KEY_FILE);
  // Before anything else (even before "there is nothing to protect"): data that lives elsewhere must never be reported as protected.
  const unsupported = findUnsupportedLocations(opts, deps);
  if (unsupported.length > 0) return { code: 70, message: unsupportedMessage(unsupported, 'backup'), problems: unsupported };
  if (!fs.existsSync(dataDir) && !fs.existsSync(secretsDir)) return { code: 10, message: 'There is no customer data folder, so there is nothing to protect.' };

  // 1. The key must be readable by THIS account. If it is not, the data cannot be used by the new install either: stop, and never invent a new key.
  if (fs.existsSync(secretsDir) && fs.readdirSync(secretsDir).length > 0) {
    if (fs.existsSync(keyFile)) {
      try {
        if (fs.readFileSync(keyFile).length === 0) throw new Error('the key file is empty');
      } catch (e) {
        return { code: 20, message: `The encryption key that protects the saved API keys cannot be read by this Windows account (${e.code || e.message}). Sign in with the account that used the product and run setup again. Nothing was changed.` };
      }
    }
  }

  // 2. Work out what must be copied and whether there is room (a second copy of the recordings may be large).
  const files = fs.existsSync(dataDir) ? walk(dataDir) : [];
  const secretFiles = fs.existsSync(secretsDir) ? fs.readdirSync(secretsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  let total = 0;
  for (const f of files) total += fs.statSync(path.join(dataDir, f)).size;
  for (const n of ['', '-wal']) if (fs.existsSync(dbFile + n)) total += fs.statSync(dbFile + n).size;
  fs.mkdirSync(outRoot, { recursive: true });
  const free = deps.freeBytes(outRoot);
  const need = Math.ceil(total * 1.1) + 64 * 1024 * 1024;
  if (free < need) return { code: 30, message: `There is not enough free disk space for a safety copy of your data (${Math.ceil(need / 1048576)} MB needed, ${Math.floor(free / 1048576)} MB free). Free some space and run setup again. Nothing was changed.` };

  const stamp = deps.now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const finalDir = path.join(outRoot, `migration-${stamp}`);
  const partial = `${finalDir}.partial`;
  if (fs.existsSync(finalDir) || fs.existsSync(partial)) return { code: 40, message: 'A safety copy with this timestamp already exists; run setup again in a moment.' };
  const manifest = { version: 1, createdAt: deps.now().toISOString(), user: deps.user(), sources: { dataDir, secretsDir }, files: [], secrets: [], db: null };

  try {
    fs.mkdirSync(partial, { recursive: true });
    // 3. Database: SQLite's online backup, then check it. A running old product keeps working; the copy is a consistent snapshot.
    if (fs.existsSync(dbFile)) {
      const Database = deps.loadSqlite(oldAppDir);
      const src = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        await src.backup(path.join(partial, DB_NAME));
      } finally {
        src.close();
      }
      const check = checkDb(Database, path.join(partial, DB_NAME));
      if (!check.ok) throw new MigrationError(50, `The copy of the database failed its integrity check (${check.result}).`);
      manifest.db = { integrity: 'ok', tables: check.tables, sha256: sha256File(path.join(partial, DB_NAME)), size: fs.statSync(path.join(partial, DB_NAME)).size };
    }
    // 4. Everything else the customer owns. The source is hashed WHILE copying; the copy is hashed again below.
    for (const rel of files) {
      const from = path.join(dataDir, ...rel.split('/'));
      const to = path.join(partial, 'data', ...rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const srcHash = sha256File(from);
      fs.copyFileSync(from, to);
      fs.utimesSync(to, fs.statSync(from).atime, fs.statSync(from).mtime);
      deps.afterCopy(to);
      manifest.files.push({ rel, size: fs.statSync(from).size, sha256: srcHash });
    }
    // 5. The master key with its restricted permissions, and the original ACL saved for a faithful restore.
    if (secretFiles.length > 0) {
      const sdir = path.join(partial, 'secrets');
      fs.mkdirSync(sdir, { recursive: true });
      deps.saveAcl(secretsDir, path.join(partial, 'secrets-acl.txt'));
      for (const n of secretFiles) {
        const to = path.join(sdir, n);
        const srcHash = sha256File(path.join(secretsDir, n));
        fs.copyFileSync(path.join(secretsDir, n), to);
        deps.protect(to, false);
        deps.afterCopy(to);
        manifest.secrets.push({ name: n, size: fs.statSync(to).size, sha256: srcHash });
      }
      deps.protect(sdir, true);
    }
    fs.writeFileSync(path.join(partial, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

    // 6. Verify the finished copy against the manifest before anything may rely on it.
    const bad = verifyBackup(partial, manifest, deps, oldAppDir);
    if (bad) throw new MigrationError(50, bad);
    fs.writeFileSync(path.join(partial, 'COMPLETE'), sha256File(path.join(partial, 'MANIFEST.json')));
    fs.renameSync(partial, finalDir);
  } catch (e) {
    try {
      fs.rmSync(partial, { recursive: true, force: true }); // only this run's own unfinished copy
    } catch {
      /* leave it */
    }
    if (e instanceof MigrationError) return { code: e.code, message: `${e.message} Nothing was changed; do NOT uninstall the old version yet.` };
    return { code: 40, message: `The safety copy could not be made (${e.code || e.message}). Nothing was changed; do NOT uninstall the old version yet.` };
  }
  return { code: 0, message: `A verified safety copy of your data is in ${finalDir}`, dir: finalDir, files: manifest.files.length, secrets: manifest.secrets.length, db: Boolean(manifest.db) };
}

/** Returns a sentence describing the first problem, or null when every file and the database match the manifest. */
function verifyBackup(dir, manifest, deps, oldAppDir) {
  for (const f of manifest.files) {
    const p = path.join(dir, 'data', ...f.rel.split('/'));
    if (!fs.existsSync(p) || fs.statSync(p).size !== f.size || sha256File(p) !== f.sha256) return `The copy of ${f.rel} does not match the original.`;
  }
  for (const s of manifest.secrets) {
    const p = path.join(dir, 'secrets', s.name);
    if (!fs.existsSync(p) || sha256File(p) !== s.sha256) return `The copy of the encryption key file ${s.name} does not match the original.`;
  }
  if (manifest.db) {
    const p = path.join(dir, DB_NAME);
    if (!fs.existsSync(p) || sha256File(p) !== manifest.db.sha256) return 'The copy of the database does not match what was written.';
    const check = checkDb(deps.loadSqlite(oldAppDir), p);
    if (!check.ok) return `The copy of the database failed its integrity check (${check.result}).`;
    if (JSON.stringify(check.tables) !== JSON.stringify(manifest.db.tables)) return 'The copy of the database has different tables than it was written with.';
  }
  return null;
}

/** Same Windows account: by SID when both are known, otherwise by name. If neither comparison is possible the answer is NO (fail closed). */
function sameAccount(was, now) {
  if (!was || !now) return false;
  if (was.sid && now.sid) return was.sid === now.sid;
  return Boolean(was.name && now.name && was.name.toLowerCase() === now.name.toLowerCase());
}

/** Every finished copy that passes its own checks, newest first, and the ones that were turned away (with the reason). */
function completeBackups(outRoot) {
  const valid = [];
  const rejected = [];
  if (!fs.existsSync(outRoot)) return { valid, rejected };
  // only finished names: an unfinished "*.partial" never matches, even if it contains a COMPLETE marker
  const names = fs.readdirSync(outRoot).filter((n) => /^migration-\d{8}-\d{6}$/.test(n)).sort().reverse();
  for (const n of names) {
    const d = path.join(outRoot, n);
    try {
      if (!fs.existsSync(path.join(d, 'COMPLETE')) || !fs.existsSync(path.join(d, 'MANIFEST.json'))) throw new Error('unfinished (no COMPLETE marker)');
      if (fs.readFileSync(path.join(d, 'COMPLETE'), 'utf8') !== sha256File(path.join(d, 'MANIFEST.json'))) throw new Error('its manifest does not match the COMPLETE marker (changed or damaged)');
      const manifest = JSON.parse(fs.readFileSync(path.join(d, 'MANIFEST.json'), 'utf8'));
      if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.secrets)) throw new Error('not a valid manifest');
      valid.push({ name: n, dir: d, manifest });
    } catch (e) {
      rejected.push(`${n}: ${e.message}`);
    }
  }
  return { valid, rejected };
}

function latestBackup(outRoot) {
  const first = completeBackups(outRoot).valid[0];
  return first ? first.dir : null;
}

/** Account-independent, traversal-free relative name (a hostile manifest cannot point outside the data folder). */
const safeRel = (rel) => typeof rel === 'string' && rel !== '' && !path.isAbsolute(rel) && !/[:]/.test(rel) && !rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '');
const safeName = (n) => typeof n === 'string' && n !== '' && !/[\\/:]/.test(n) && n !== '..' && n !== '.';

function restore(opts, over = {}) {
  const deps = { ...defaultDeps, ...over };
  const { dataDir, secretsDir, outRoot } = opts;
  const { valid, rejected } = completeBackups(outRoot);
  const report = { restored: [], kept: [], skipped: [], rejected };
  if (valid.length === 0) {
    return rejected.length
      ? { code: 60, message: `None of the safety copies in ${outRoot} is usable (${rejected.join('; ')}), so nothing was restored.`, ...report }
      : { code: 0, message: 'There is no safety copy to restore from.', ...report };
  }
  const unsupported = findUnsupportedLocations(opts, deps);
  if (unsupported.length > 0) return { code: 70, message: unsupportedMessage(unsupported, 'restore'), problems: unsupported, ...report };

  // For every item, the list of copies that have it, newest first.
  const items = new Map();
  const offer = (id, label, dest, kind, candidate) => {
    if (!items.has(id)) items.set(id, { label, dest, kind, candidates: [] });
    items.get(id).candidates.push(candidate);
  };
  const liveDb = path.join(dataDir, DB_NAME);
  for (const b of valid) {
    if (b.manifest.db && /^[0-9a-f]{64}$/.test(b.manifest.db.sha256 || '')) offer('db', 'database', liveDb, 'db', { backup: b.name, from: path.join(b.dir, DB_NAME), hash: b.manifest.db.sha256 });
    for (const f of b.manifest.files) {
      if (!safeRel(f.rel) || isDbFile(f.rel)) report.skipped.push(`${String(f.rel)} (unsafe name in ${b.name})`);
      else offer(`file:${f.rel}`, f.rel, path.join(dataDir, ...f.rel.split('/')), 'file', { backup: b.name, from: path.join(b.dir, 'data', ...f.rel.split('/')), hash: f.sha256 });
    }
    for (const sec of b.manifest.secrets) {
      if (!safeName(sec.name)) report.skipped.push(`${String(sec.name)} (unsafe name in ${b.name})`);
      else offer(`key:${sec.name}`, sec.name, path.join(secretsDir, sec.name), 'key', { backup: b.name, from: path.join(b.dir, 'secrets', sec.name), hash: sec.sha256, owner: b.manifest.user });
    }
  }

  const place = (from, to, hash, label, protectKey) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.restoring`;
    fs.copyFileSync(from, tmp);
    if (protectKey) deps.protect(tmp, false);
    fs.renameSync(tmp, to);
    if (sha256File(to) !== hash) throw new Error(`${label} does not match after restoring`);
  };
  try {
    for (const it of items.values()) {
      // Already there (live, or restored a moment ago from a newer copy): never overwritten.
      if (it.kind === 'db' ? fs.existsSync(it.dest) || fs.existsSync(`${it.dest}-wal`) : fs.existsSync(it.dest)) {
        report.kept.push(it.label);
        continue;
      }
      const why = [];
      let done = false;
      for (const c of it.candidates) {
        if (it.kind === 'key' && !sameAccount(c.owner, deps.user())) {
          why.push(`it belongs to ${(c.owner && c.owner.name) || 'another account'}; sign in with that account, then run setup again`);
          continue;
        }
        if (!/^[0-9a-f]{64}$/.test(c.hash || '') || !fs.existsSync(c.from) || sha256File(c.from) !== c.hash) {
          why.push(`the copy in ${c.backup} no longer matches its checksum`);
          continue;
        }
        place(c.from, it.dest, c.hash, it.label, it.kind === 'key');
        report.restored.push(it.label);
        done = true;
        break;
      }
      if (!done) report.skipped.push(`${it.label} (${why.join('; ')})`);
    }
  } catch (e) {
    return { code: 60, message: `Restoring stopped: ${e.message}`, ...report };
  }
  const problems = report.skipped.length;
  const note = rejected.length ? ` Unusable copies were ignored: ${rejected.join('; ')}.` : '';
  const from = valid.length === 1 ? valid[0].dir : `${valid.length} safety copies in ${outRoot}`;
  return {
    code: problems ? 60 : 0,
    message: (problems ? `Some data could not be restored: ${report.skipped.join('; ')}. The safety copies are in ${outRoot}.` : report.restored.length ? `Restored from ${from}: ${report.restored.length} item(s). Nothing existing was overwritten.` : 'Your existing data was kept; nothing needed restoring.') + note,
    dir: valid[0].dir,
    ...report,
  };
}

module.exports = { backup, restore, verifyBackup, latestBackup, completeBackups, findUnsupportedLocations, KEY_FILE, DB_NAME, MigrationError, sha256File };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const opts = { dataDir: arg('data'), secretsDir: arg('secrets'), outRoot: arg('out'), oldAppDir: arg('old-app') };
  if (!['backup', 'restore'].includes(argv[0]) || !opts.dataDir || !opts.secretsDir || !opts.outRoot) {
    console.error('usage: customer-data.cjs backup|restore --data <dir> --secrets <dir> --out <dir> [--old-app <dir>]');
    process.exit(2);
  }
  // setup reads this file: it cannot capture standard output
  const writeResult = (r) => {
    console.log(JSON.stringify(r));
    if (arg('result')) {
      try {
        fs.writeFileSync(arg('result'), JSON.stringify(r));
        fs.writeFileSync(`${arg('result')}.txt`, String(r.message || ''));
      } catch {
        /* the exit code still carries the outcome */
      }
    }
  };
  Promise.resolve(argv[0] === 'backup' ? backup(opts) : restore(opts)).then(
    (r) => {
      writeResult(r);
      process.exit(r.code);
    },
    (e) => {
      writeResult({ code: 40, message: `Unexpected error: ${e.message}` });
      process.exit(40);
    }
  );
}
