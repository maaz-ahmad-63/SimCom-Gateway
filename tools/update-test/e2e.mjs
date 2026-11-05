#!/usr/bin/env node
// Real Windows update test, fully isolated. It installs a packaged program into a scratch folder, runs the REAL supervisor, gateway (mock
// modem: no serial port is ever opened) and dashboard on spare ports, and drives the REAL updater end to end over a local https server with
// a throwaway signing key. Nothing here touches the development gateway, the modem, the repository's .env, ProgramData or the production
// key. Everything lives under one scratch folder that is removed at the end (kept with --keep).
//
//   node tools/update-test/e2e.mjs --package installer/stage/app [--work <scratch folder>] [--keep]
//
// Scenarios, in order: (1) A -> broken release: the update is undone and A runs again; (2) A -> B succeeds, data and encrypted keys intact;
// (3) the update runner is killed in the dangerous window between the two renames, and the start guard repairs it; (4) the same for a new version
// that was put in place but never confirmed healthy.

import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const keep = argv.includes('--keep');
const pkg = path.resolve(opt('package', path.join(repo, 'installer', 'stage', 'app')));
const work = path.resolve(opt('work', path.join(os.tmpdir(), 'simgw-update-e2e')));
const P = { gateway: 14000, dashboard: 13000, status: 14010, https: 14443 };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const log = (m) => console.log(`      ${m}`);

async function waitFor(fn, ms, label, step = 500) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* keep waiting */
    }
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---- safety ---------------------------------------------------------------------------------------------------------------------------
if (!fs.existsSync(path.join(pkg, 'gateway', 'dist', 'supervisor', 'update', 'runner.js'))) {
  console.error(`The package at ${pkg} has no updater (gateway\\dist\\supervisor\\update\\runner.js). Build it first: installer\\build-package.ps1 -SkipInstaller`);
  process.exit(2);
}
if (!path.basename(work).includes('simgw-update-e2e') || work.startsWith(repo)) {
  console.error('The scratch folder must be named simgw-update-e2e and be outside the repository.');
  process.exit(2);
}
const elevated = spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;
check('the test runs without administrator rights', !elevated, elevated ? 'this shell is elevated' : 'normal user');

const dirs = {
  install: path.join(work, 'install'),
  app: path.join(work, 'install', 'app'),
  data: path.join(work, 'data'),
  secrets: path.join(work, 'secrets'),
  pub: path.join(work, 'pub'),
  keys: path.join(work, 'keys'),
  trees: path.join(work, 'trees'),
};
if (fs.existsSync(work)) {
  if (!fs.existsSync(path.join(work, '.simgw-update-e2e'))) {
    console.error(`${work} exists and is not a previous run of this test; it is not touched.`);
    process.exit(2);
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, '.simgw-update-e2e'), 'scratch folder of tools/update-test/e2e.mjs');

const API_KEY = crypto.randomBytes(24).toString('hex');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MODEM_|GATEWAY_|AI_|SIMGW_|SQLITE_|NODE_ENV)/.test(k))),
  SIMGW_APP_DIR: dirs.app,
  SIMGW_NODE: path.join(dirs.app, 'runtime', 'node.exe'),
  SIMGW_DATA_DIR: dirs.data,
  SIMGW_SECRETS_DIR: dirs.secrets,
  SIMGW_STATUS_PORT: String(P.status),
  SIMGW_DASHBOARD_PORT: String(P.dashboard),
  SIMGW_UPDATE_HEALTH_TIMEOUT_MS: '40000',
  NODE_EXTRA_CA_CERTS: path.join(dirs.keys, 'cert.pem'),
};

// ---- the program trees: A (installed), B (newer), C (newer but broken), D/E (for the interruption scenarios) -------------------
function robocopy(src, dst) {
  const r = spawnSync('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1'], { stdio: 'ignore' });
  if (r.status >= 8) throw new Error(`robocopy failed (${r.status})`);
}
function makeTree(dest, version, mutate) {
  robocopy(pkg, dest);
  fs.writeFileSync(path.join(dest, 'VERSION.json'), JSON.stringify({ name: 'SIZH IT Solution', version, builtAt: new Date().toISOString() }));
  fs.mkdirSync(path.join(dest, 'update'), { recursive: true });
  fs.copyFileSync(path.join(dirs.keys, 'public-key.pem'), path.join(dest, 'update', 'public-key.pem'));
  mutate?.(dest);
}

// ---- keys, certificate, https server -------------------------------------------------------------------------------------------
const gitOpenssl = ['C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files (x86)/Git/usr/bin/openssl.exe'].find((p) => fs.existsSync(p));
const releaseTool = path.join(repo, 'tools', 'release', 'release.mjs');
const keyFile = path.join(dirs.keys, 'test-signing.key');

function publish(treeDir) {
  const r = spawnSync(process.execPath, [releaseTool, 'publish', '--key', keyFile, '--app', treeDir, '--base-url', `https://localhost:${P.https}/`, '--out', dirs.pub, '--notes', 'e2e test release'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`release tool failed: ${r.stderr || r.stdout}`);
}

// ---- helpers over the running product ------------------------------------------------------------------------------------------
const getJson = async (url, init) => {
  // A pooled keep-alive socket that the server already closed fails with ECONNRESET on a POST (which is not retried by default). Retry once.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
};
const supStatus = () => getJson(`http://127.0.0.1:${P.status}/status`).then((r) => (r.status === 200 ? r.body : null));
const gw = (p, init = {}) => getJson(`http://127.0.0.1:${P.gateway}${p}`, { ...init, headers: { 'x-api-key': API_KEY, 'content-type': 'application/json', ...(init.headers ?? {}) } });
const dash = (p, method = 'GET') =>
  getJson(`http://127.0.0.1:${P.dashboard}${p}`, {
    method,
    headers: { 'x-dashboard-sms': '1', origin: `http://127.0.0.1:${P.dashboard}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
  });

async function healthy(version) {
  const s = await supStatus();
  if (!s || (version && s.version !== version)) return null;
  if (s.gateway.state !== 'running' || s.dashboard.state !== 'running') return null;
  const g = await fetch(`http://127.0.0.1:${P.gateway}/health`, { signal: AbortSignal.timeout(4000) });
  const d = await fetch(`http://127.0.0.1:${P.dashboard}/`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
  return g.status === 200 && d.status < 500 ? s : null;
}
const readResult = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirs.data, 'updates', 'result.json'), 'utf8'));
  } catch {
    return null;
  }
};
const versionOf = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8').replace(/^\uFEFF/, '')).version;
  } catch {
    return null;
  }
};

function startSupervisor() {
  const child = spawn(path.join(dirs.app, 'runtime', 'node.exe'), [path.join(dirs.app, 'gateway', 'dist', 'supervisor', 'main.js')], { cwd: dirs.app, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}
async function stopSupervisor() {
  let token;
  try {
    token = fs.readFileSync(path.join(dirs.data, 'supervisor.token'), 'utf8').trim();
  } catch {
    return;
  }
  await fetch(`http://127.0.0.1:${P.status}/stop`, { method: 'POST', headers: { 'x-supervisor-token': token }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  await waitFor(async () => !(await supStatus()), 60_000, 'the supervisor to stop').catch(() => {});
}
function killScratchProcesses() {
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*simgw-update-e2e*' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
  return ps.status;
}

function snapshot() {
  const secretFiles = fs.existsSync(dirs.secrets) ? fs.readdirSync(dirs.secrets).sort().map((f) => `${f}:${sha(path.join(dirs.secrets, f))}`) : [];
  return {
    env: sha(path.join(dirs.data, 'config', 'gateway.env')),
    secretFiles,
    recording: sha(path.join(dirs.data, 'recordings', 'e2e-call.wav')),
    dbBytes: fs.existsSync(path.join(dirs.data, 'gateway.sqlite')) ? fs.statSync(path.join(dirs.data, 'gateway.sqlite')).size : 0,
  };
}
let seeded;
async function dataIntact(label) {
  const now = snapshot();
  check(`${label}: gateway.env unchanged`, now.env === seeded.snap.env);
  check(`${label}: encryption key file unchanged`, JSON.stringify(now.secretFiles) === JSON.stringify(seeded.snap.secretFiles) && now.secretFiles.length > 0, `${now.secretFiles.length} file(s)`);
  check(`${label}: recording unchanged`, now.recording === seeded.snap.recording);
  check(`${label}: database present`, now.dbBytes > 0);
  const st = await gw('/api/ai/settings');
  const agent = st.body?.settings?.agent ?? st.body?.agent ?? {};
  check(`${label}: custom inbound prompt still saved`, agent.inboundInstructions === seeded.inbound);
  check(`${label}: custom outbound prompt still saved`, agent.outboundInstructions === seeded.outbound);
  const cr = await gw('/api/ai/credentials');
  const list = cr.body?.credentials;
  const entry = Array.isArray(list) ? list.find((c) => c.name === seeded.credential) : list?.[seeded.credential];
  check(`${label}: saved API key is still readable (decrypts)`, JSON.stringify(entry ?? {}).includes('true') && cr.body?.secretStorageAvailable !== false, JSON.stringify(entry));
}

let server;
try {
  // keys + certificate
  spawnSync(process.execPath, [releaseTool, 'keygen', '--key', keyFile, '--public', path.join(dirs.keys, 'public-key.pem')], { stdio: 'ignore' });
  if (!gitOpenssl) throw new Error('openssl (from Git for Windows) is needed to make the throwaway https certificate');
  spawnSync(gitOpenssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dirs.keys, 'key.pem'), '-out', path.join(dirs.keys, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  server = https
    .createServer({ key: fs.readFileSync(path.join(dirs.keys, 'key.pem')), cert: fs.readFileSync(path.join(dirs.keys, 'cert.pem')) }, (req, res) => {
      const f = path.join(dirs.pub, path.basename(decodeURIComponent((req.url ?? '').split('?')[0])));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    })
    .listen(P.https, '127.0.0.1');

  console.log('\n== preparing program versions (copying the package several times; this takes a minute)');
  makeTree(dirs.app, '0.90.1');
  makeTree(path.join(dirs.trees, 'B'), '0.90.2');
  makeTree(path.join(dirs.trees, 'C'), '0.90.3', (d) => fs.writeFileSync(path.join(d, 'gateway', 'dist', 'supervisor', 'gateway-entry.js'), 'process.exit(1);\n')); // never becomes healthy
  makeTree(path.join(dirs.trees, 'D'), '0.90.4');
  makeTree(path.join(dirs.trees, 'E'), '0.90.5');

  // customer configuration, as the installed product would create it (mock modem: no serial port is ever opened)
  fs.mkdirSync(path.join(dirs.data, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.data, 'config', 'gateway.env'),
    ['GATEWAY_API_KEY=' + API_KEY, 'HOST=127.0.0.1', `PORT=${P.gateway}`, 'MODEM_DRIVER=mock', 'MODEM_AT_PORT=', 'MODEM_AUDIO_PORT=', `CORS_ORIGIN=http://127.0.0.1:${P.dashboard}`, `UPDATE_URL=https://localhost:${P.https}/latest.json`, ''].join('\n')
  );

  console.log('\n== starting version 0.90.1');
  startSupervisor();
  await waitFor(() => healthy('0.90.1'), 180_000, 'version 0.90.1 to start', 1500);
  check('version 0.90.1 started: supervisor, gateway and dashboard are healthy', true);

  // seed customer data through the real API
  const inbound = `E2E inbound prompt ${crypto.randomUUID()}`;
  const outbound = `E2E outbound prompt ${crypto.randomUUID()}`;
  const put = await gw('/api/ai/settings', { method: 'PUT', body: JSON.stringify({ agent: { inboundInstructions: inbound, outboundInstructions: outbound } }) });
  check('seeded custom inbound and outbound prompts', put.status === 200, `HTTP ${put.status}`);
  const cr0 = await gw('/api/ai/credentials');
  const names = Array.isArray(cr0.body?.credentials) ? cr0.body.credentials.map((c) => c.name) : Object.keys(cr0.body?.credentials ?? {});
  const credential = names.find((n) => /DEEPGRAM|GROQ|OPENAI/i.test(n)) ?? names[0];
  const putKey = await gw(`/api/ai/credentials/${credential}`, { method: 'PUT', body: JSON.stringify({ value: 'sk-e2e-not-a-real-key-0000000000000000' }) });
  check(`seeded an encrypted API key (${credential})`, putKey.status === 200, `HTTP ${putKey.status}`);
  fs.mkdirSync(path.join(dirs.data, 'recordings'), { recursive: true });
  fs.writeFileSync(path.join(dirs.data, 'recordings', 'e2e-call.wav'), crypto.randomBytes(4096));
  await sleep(1500);
  seeded = { inbound, outbound, credential, snap: snapshot() };
  await dataIntact('before any update');

  // ======================================================================================================================================
  console.log('\n== scenario 1: update to a release whose new version never becomes healthy -> must be undone, 0.90.1 runs again');
  publish(path.join(dirs.trees, 'C'));
  let r = await dash('/api/update/check', 'POST');
  check('check now finds 0.90.3 through the dashboard', r.status === 200 && r.body?.update?.available?.version === '0.90.3', `HTTP ${r.status}`);
  r = await dash('/api/update/apply', 'POST');
  check('update now is accepted (no call in progress)', r.status === 200, `HTTP ${r.status} ${r.body?.error ?? ''}`);
  await waitFor(() => {
    try {
      const res = JSON.parse(fs.readFileSync(path.join(dirs.data, 'updates', 'result.json'), 'utf8'));
      return res.outcome === 'rolled_back' ? res : null;
    } catch {
      return null;
    }
  }, 240_000, 'the failed update to be rolled back', 1500);
  const s1 = await waitFor(() => healthy('0.90.1'), 180_000, '0.90.1 to run again', 1500);
  check('the failed update was rolled back and 0.90.1 runs again, healthy', Boolean(s1));
  check('the program folder is 0.90.1 again and no leftover folders remain', versionOf(dirs.app) === '0.90.1' && !fs.existsSync(`${dirs.app}.failed`) && !fs.existsSync(`${dirs.app}.new`) && !fs.existsSync(`${dirs.app}.backup`));
  check('the dashboard reports the undone update', s1?.update?.lastResult?.outcome === 'rolled_back', s1?.update?.lastResult?.reason);
  await dataIntact('after the undone update');

  // ======================================================================================================================================
  console.log('\n== scenario 2: update 0.90.1 -> 0.90.2 succeeds');
  publish(path.join(dirs.trees, 'B'));
  r = await dash('/api/update/check', 'POST');
  check('check now finds 0.90.2', r.body?.update?.available?.version === '0.90.2');
  r = await dash('/api/update/apply', 'POST');
  check('update now is accepted', r.status === 200, `HTTP ${r.status}`);
  const s2 = await waitFor(() => healthy('0.90.2'), 300_000, '0.90.2 to start', 2000);
  check('0.90.2 is running: supervisor, gateway and dashboard healthy', Boolean(s2));
  check('the program folder is 0.90.2 and the previous version is kept as the backup', versionOf(dirs.app) === '0.90.2' && versionOf(`${dirs.app}.backup`) === '0.90.1');
  const res2 = await waitFor(() => readResult(), 60_000, 'the update result to be recorded');
  await waitFor(() => !fs.existsSync(path.join(dirs.data, 'updates', 'journal.json')), 30_000, 'the journal to be removed').catch(() => {});
  check('the result says updated, and the journal is gone', res2.outcome === 'updated' && !fs.existsSync(path.join(dirs.data, 'updates', 'journal.json')));
  check('the dashboard shows the new version', (await dash('/api/update')).body?.update?.currentVersion === '0.90.2');
  await dataIntact('after the update to 0.90.2');

  // ======================================================================================================================================
  async function interrupted(label, tree, version, lockWhat) {
    console.log(`\n== ${label}`);
    publish(tree);
    await dash('/api/update/check', 'POST');
    const staging = `${dirs.app}.new`;
    const a = await dash('/api/update/apply', 'POST');
    check(`${label}: update is accepted`, a.status === 200, `HTTP ${a.status} ${a.body?.error ?? ''}`);
    // The package is extracted and the runner started; the old program is still shutting down. Hold a process inside the staged folder, so
    // Windows refuses to rename it into place: the runner then sits in its retry loop with the journal saying where it is.
    const lock = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { cwd: staging, stdio: 'ignore', windowsHide: true });
    const journalPath = path.join(dirs.data, 'updates', 'journal.json');
    const j = await waitFor(() => {
      const jj = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      return jj.state === lockWhat && !fs.existsSync(dirs.app) ? jj : null;
    }, 120_000, `the runner to reach "${lockWhat}" with the program folder moved aside`, 50);
    check(`${label}: caught the runner between the renames (journal "${j.state}", program folder absent)`, true);
    spawnSync('taskkill', ['/PID', String(j.runnerPid), '/T', '/F'], { stdio: 'ignore' });
    lock.kill();
    await sleep(1500);
    check(`${label}: the runner is dead and the program folder is missing`, !fs.existsSync(dirs.app) && fs.existsSync(`${dirs.app}.backup`));
    await dash('/api/update').catch(() => null); // the dashboard is down too; nothing answers
    // the shortcut path: the start guard repairs, then starts the product (exactly what the Start-menu icon runs)
    const guard = path.join(repo, 'installer', 'guard', 'SimGatewayStart.js');
    const g = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe'), ['//Nologo', guard, '--no-browser'], { env, encoding: 'utf8', timeout: 300_000 });
    check(`${label}: the start guard finished`, g.status === 0, `exit ${g.status} ${g.stdout?.trim() ?? ''}`);
    return version;
  }

  // 3: caught between the renames: program folder missing, backup = 0.90.2, staged = 0.90.4
  await interrupted('scenario 3: runner killed after the program folder was moved aside', path.join(dirs.trees, 'D'), '0.90.4', 'installing');
  const s3 = await waitFor(() => healthy('0.90.2'), 240_000, '0.90.2 to be running again after recovery', 2000);
  check('recovery restored 0.90.2 and the product is healthy', Boolean(s3));
  const res3 = await waitFor(() => readResult(), 60_000, 'the recovery result to be recorded');
  check('the recovery was recorded', res3.outcome === 'recovered', res3.reason);
  check('no journal remains and a valid program folder exists', !fs.existsSync(path.join(dirs.data, 'updates', 'journal.json')) && versionOf(dirs.app) === '0.90.2');
  check('the dashboard reports the recovery', (await supStatus())?.update?.lastResult?.outcome === 'recovered');
  await dataIntact('after recovery (program folder missing)');

  // 4: the new version is in place but never confirmed: stop the product, build that state from a real update's folders, recover
  console.log('\n== scenario 4: new version in place but never confirmed healthy (power loss while checking it)');
  await stopSupervisor();
  killScratchProcesses();
  await sleep(1500);
  fs.rmSync(`${dirs.app}.backup`, { recursive: true, force: true });
  fs.renameSync(dirs.app, `${dirs.app}.backup`);
  robocopy(path.join(dirs.trees, 'E'), dirs.app);
  fs.mkdirSync(path.join(dirs.data, 'updates'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.data, 'updates', 'journal.json'),
    JSON.stringify({ version: 1, state: 'installing', appDir: dirs.app, stagingDir: `${dirs.app}.new`, backupDir: `${dirs.app}.backup`, fromVersion: '0.90.2', toVersion: '0.90.5', runnerPid: 2147480000, at: new Date().toISOString() })
  );
  const guard = path.join(repo, 'installer', 'guard', 'SimGatewayStart.js');
  const g4 = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe'), ['//Nologo', guard, '--no-browser'], { env, encoding: 'utf8', timeout: 300_000 });
  check('scenario 4: the start guard finished', g4.status === 0, `exit ${g4.status}`);
  const s4 = await waitFor(() => healthy('0.90.2'), 240_000, '0.90.2 after rolling back the unconfirmed version', 2000);
  check('scenario 4: the unconfirmed new version was undone and 0.90.2 is healthy', Boolean(s4));
  await dataIntact('after recovery (unconfirmed new version)');
} catch (e) {
  check('the test ran to completion', false, [e.message, e.cause?.message ?? e.cause ?? '', String(e.stack ?? '').split(String.fromCharCode(10)).slice(1, 3).join(' | ')].join(' '));
} finally {
  await stopSupervisor().catch(() => {});
  killScratchProcesses();
  server?.close();
  await sleep(1500);
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length === 0 && !keep) {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    console.log('scratch folder removed');
  } else console.log(`scratch folder kept for inspection: ${work}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
