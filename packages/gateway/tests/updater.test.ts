import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareVersions, UpdateError, verifyManifest } from '../src/supervisor/update/manifest.js';
import { tarExe, unsafeEntries, validateStaged, verifyPackageFile } from '../src/supervisor/update/package.js';
import { journalFile, recoverInterruptedUpdate, runUpdate, RunnerDeps, UpdateJob } from '../src/supervisor/update/runner.js';
import { UpdateConfig, UpdateDeps, UpdateService } from '../src/supervisor/update/service.js';

const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NOW = new Date('2026-11-05T12:00:00Z');

const sign = (bytes: Buffer, key = keys.privateKey) => crypto.sign(null, bytes, key).toString('base64');
function manifestFor(over: Record<string, unknown> = {}) {
  const m = {
    schema: 1,
    product: 'sizh-it-solution',
    version: '0.2.0',
    packageUrl: 'https://updates.example.com/pkg-0.2.0.zip',
    packageSha256: 'a'.repeat(64),
    packageSize: 1234,
    publishedAt: '2026-11-01T00:00:00Z',
    expiresAt: '2027-11-01T00:00:00Z',
    ...over,
  };
  const bytes = Buffer.from(JSON.stringify(m));
  return { m, bytes, sig: sign(bytes) };
}
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as UpdateError).code;
  }
  return undefined;
};

describe('signed manifest', () => {
  it('accepts a correctly signed, newer, unexpired manifest', () => {
    const { bytes, sig } = manifestFor();
    expect(verifyManifest(bytes, sig, PUBLIC, '0.1.2', NOW).version).toBe('0.2.0');
  });
  it('rejects a manifest signed by another key, or changed after signing', () => {
    const { bytes } = manifestFor();
    const other = crypto.generateKeyPairSync('ed25519');
    expect(code(() => verifyManifest(bytes, sign(bytes, other.privateKey), PUBLIC, '0.1.2', NOW))).toBe('BAD_SIGNATURE');
    const { bytes: b2, sig: s2 } = manifestFor();
    const tampered = Buffer.from(b2.toString().replace('0.2.0', '9.9.9'));
    expect(code(() => verifyManifest(tampered, s2, PUBLIC, '0.1.2', NOW))).toBe('BAD_SIGNATURE');
    expect(code(() => verifyManifest(b2, 'not-a-signature', PUBLIC, '0.1.2', NOW))).toBe('BAD_SIGNATURE');
  });
  it('rejects the same or an older version (no downgrade or replay), an expired manifest and a too-old install', () => {
    const same = manifestFor({ version: '0.1.2' });
    expect(code(() => verifyManifest(same.bytes, same.sig, PUBLIC, '0.1.2', NOW))).toBe('NOT_NEWER');
    const old = manifestFor({ version: '0.1.0' });
    expect(code(() => verifyManifest(old.bytes, old.sig, PUBLIC, '0.1.2', NOW))).toBe('NOT_NEWER');
    const expired = manifestFor({ expiresAt: '2026-01-01T00:00:00Z' });
    expect(code(() => verifyManifest(expired.bytes, expired.sig, PUBLIC, '0.1.2', NOW))).toBe('EXPIRED');
    const gated = manifestFor({ minimumVersion: '0.1.5' });
    expect(code(() => verifyManifest(gated.bytes, gated.sig, PUBLIC, '0.1.2', NOW))).toBe('TOO_OLD');
  });
  it('rejects a package address that is not https, and malformed fields, even when signed', () => {
    const http = manifestFor({ packageUrl: 'http://updates.example.com/p.zip' });
    expect(code(() => verifyManifest(http.bytes, http.sig, PUBLIC, '0.1.2', NOW))).toBe('INSECURE_URL');
    const bad = manifestFor({ packageSha256: 'xyz' });
    expect(code(() => verifyManifest(bad.bytes, bad.sig, PUBLIC, '0.1.2', NOW))).toBe('BAD_MANIFEST');
    const other = manifestFor({ product: 'something-else' });
    expect(code(() => verifyManifest(other.bytes, other.sig, PUBLIC, '0.1.2', NOW))).toBe('BAD_MANIFEST');
  });
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow();
  });
});

describe('package safety', () => {
  it('refuses entries that leave the program folder or carry customer data or keys', () => {
    expect(unsafeEntries(['./', './gateway/dist/a.js', './dashboard/x', './VERSION.json', './runtime/node.exe'])).toEqual([]);
    expect(unsafeEntries(['../evil.dll']).length).toBe(1);
    expect(unsafeEntries(['gateway/../../evil']).length).toBe(1);
    expect(unsafeEntries(['C:/Windows/x']).length).toBe(1);
    expect(unsafeEntries(['/abs']).length).toBe(1);
    expect(unsafeEntries(['config/gateway.env']).length).toBe(1);
    expect(unsafeEntries(['gateway/.env']).length).toBe(1);
    expect(unsafeEntries(['gateway/data/gateway.sqlite']).length).toBe(1);
    expect(unsafeEntries(['unknown-top/file']).length).toBe(1);
  });
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simgw-upd-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeProgram(dir: string, version: string, marker = version) {
  const files: Record<string, string> = {
    'VERSION.json': JSON.stringify({ version }),
    'runtime/node.exe': 'node',
    'gateway/dist/supervisor/main.js': marker,
    'dashboard/packages/dashboard/server.js': marker,
  };
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function zipOf(dir: string, out: string) {
  execFileSync(tarExe(), ['-a', '-cf', out, '-C', dir, '.']);
}

describe('update service', () => {
  let app: string;
  let data: string;
  let zip: string;
  let launched: string[];
  let stopped: number;
  let call: 'idle' | 'busy' | 'unknown';
  let served: { manifest: Buffer; sig: string };

  const cfg = (): UpdateConfig => ({ updateUrl: 'https://updates.example.com/latest.json', publicKeyPem: PUBLIC, currentVersion: '0.1.2', appDir: app, dataDir: data, gatewayPort: 4000, dashboardPort: 3000, statusPort: 4010, supervisorPid: 1 });
  const deps = (): UpdateDeps => ({
    now: () => NOW,
    fetchBytes: async (url) => (url.endsWith('.sig') ? Buffer.from(served.sig) : served.manifest),
    downloadTo: async (_url, file) => fs.copyFileSync(zip, file),
    callState: async () => call,
    launchRunner: (jobFile) => launched.push(jobFile),
    stopSupervisor: async () => void stopped++,
    log: () => undefined,
  });
  const publish = (over: Record<string, unknown> = {}) => {
    const { bytes, sig } = manifestFor({ packageSha256: sha(zip), packageSize: fs.statSync(zip).size, version: '0.2.0', ...over });
    served = { manifest: bytes, sig };
  };

  beforeEach(() => {
    app = path.join(tmp, 'app');
    data = path.join(tmp, 'data');
    fs.mkdirSync(app);
    fs.mkdirSync(data);
    writeProgram(app, '0.1.2');
    const pkg = path.join(tmp, 'pkg');
    fs.mkdirSync(pkg);
    writeProgram(pkg, '0.2.0');
    zip = path.join(tmp, 'p.zip');
    zipOf(pkg, zip);
    launched = [];
    stopped = 0;
    call = 'idle';
    publish();
  });

  it('reports nothing when the server has nothing newer, and an update when it has', async () => {
    publish({ version: '0.1.2' });
    const svc = new UpdateService(cfg(), deps());
    expect((await svc.check()).available).toBeNull();
    publish();
    const s = await svc.check();
    expect(s.phase).toBe('available');
    expect(s.available?.version).toBe('0.2.0');
  });

  it('is not configured without an address or a signing key, and says so', async () => {
    const svc = new UpdateService({ ...cfg(), updateUrl: '' }, deps());
    expect(svc.status().configured).toBe(false);
    await expect(svc.check()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(new UpdateService({ ...cfg(), publicKeyPem: null }, deps()).status().configured).toBe(false);
    expect(new UpdateService({ ...cfg(), updateUrl: 'http://x.example.com/l.json' }, deps()).status().configured).toBe(false);
  });

  it('never starts during a call, and refuses when it cannot tell', async () => {
    const svc = new UpdateService(cfg(), deps());
    await svc.check();
    call = 'busy';
    await expect(svc.apply()).rejects.toMatchObject({ code: 'CALL_IN_PROGRESS' });
    expect(launched).toEqual([]);
    expect(stopped).toBe(0);
    expect(fs.existsSync(`${app}.new`)).toBe(false);
    call = 'unknown';
    await expect((async () => { await svc.check(); await svc.apply(); })()).rejects.toMatchObject({ code: 'CALL_STATE_UNKNOWN' });
    expect(launched).toEqual([]);
  });

  it('downloads, verifies, stages and hands over to the runner, then stops the program', async () => {
    const svc = new UpdateService(cfg(), deps());
    await svc.check();
    const s = await svc.apply();
    expect(s.phase).toBe('installing');
    expect(launched).toHaveLength(1);
    const job = JSON.parse(fs.readFileSync(launched[0], 'utf8')) as UpdateJob;
    expect(job).toMatchObject({ appDir: app, stagingDir: `${app}.new`, backupDir: `${app}.backup`, fromVersion: '0.1.2', toVersion: '0.2.0' });
    expect(fs.readFileSync(path.join(`${app}.new`, 'VERSION.json'), 'utf8')).toContain('0.2.0');
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(1);
    // the running program is untouched until the runner swaps it
    expect(fs.readFileSync(path.join(app, 'VERSION.json'), 'utf8')).toContain('0.1.2');
  });

  it('discards a package whose bytes differ from the signed checksum, and stops nothing', async () => {
    const svc = new UpdateService(cfg(), deps());
    await svc.check();
    fs.appendFileSync(zip, 'x'); // the signed manifest still names the original bytes
    await expect(svc.apply()).rejects.toMatchObject({ code: expect.stringMatching(/SIZE_MISMATCH|HASH_MISMATCH/) });
    expect(fs.existsSync(`${app}.new`)).toBe(false);
    expect(launched).toEqual([]);
    expect(stopped).toBe(0);
  });

  it('discards a signed package that contains customer data or a different version', async () => {
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(path.join(bad, 'config'), { recursive: true });
    writeProgram(bad, '0.2.0');
    fs.writeFileSync(path.join(bad, 'config', 'gateway.env'), 'GATEWAY_API_KEY=stolen');
    zipOf(bad, zip);
    publish();
    const svc = new UpdateService(cfg(), deps());
    await svc.check();
    await expect(svc.apply()).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE' });
    expect(launched).toEqual([]);

    const wrong = path.join(tmp, 'wrong');
    fs.mkdirSync(wrong);
    writeProgram(wrong, '0.9.9');
    zipOf(wrong, zip);
    publish();
    const svc2 = new UpdateService(cfg(), deps());
    await svc2.check();
    await expect(svc2.apply()).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
  });

  it('shows the result of an update attempt even when the runner writes it after this program started (rollback order)', async () => {
    const svc = new UpdateService(cfg(), deps());
    expect(svc.status().lastResult).toBeNull();
    fs.mkdirSync(path.join(data, 'updates'), { recursive: true });
    fs.writeFileSync(path.join(data, 'updates', 'result.json'), JSON.stringify({ outcome: 'rolled_back', fromVersion: '0.1.2', toVersion: '0.2.0', at: '', reason: 'x' }));
    expect(svc.status().lastResult?.outcome).toBe('rolled_back');
  });

  it('validateStaged requires a complete program', () => {
    const d = path.join(tmp, 'half');
    fs.mkdirSync(d);
    expect(() => validateStaged(d, '1.0.0')).toThrow(UpdateError);
  });

  it('verifyPackageFile checks size and hash', async () => {
    await verifyPackageFile(zip, { packageSha256: sha(zip), packageSize: fs.statSync(zip).size });
    await expect(verifyPackageFile(zip, { packageSha256: '0'.repeat(64), packageSize: fs.statSync(zip).size })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });
});

describe('update runner: swap, health check, rollback', () => {
  let job: UpdateJob;
  let data: string;
  let started: string[];
  let alive: boolean;
  let healthy: boolean;
  let startReturns: number | null;

  const deps = (): RunnerDeps => ({
    isAlive: () => alive,
    startProgram: (appDir) => {
      started.push(fs.readFileSync(path.join(appDir, 'VERSION.json'), 'utf8'));
      return startReturns;
    },
    stopProgram: async () => undefined,
    healthy: async () => healthy,
    sleep: async () => {
      alive = false; // the old supervisor exits while we wait
    },
    now: () => new Date(),
    log: () => undefined,
  });

  beforeEach(() => {
    const app = path.join(tmp, 'app');
    data = path.join(tmp, 'data');
    for (const d of [app, data]) fs.mkdirSync(d);
    writeProgram(app, '0.1.2');
    writeProgram(`${app}.new`, '0.2.0');
    // customer data that must survive every outcome
    fs.writeFileSync(path.join(data, 'gateway.sqlite'), 'DB');
    fs.mkdirSync(path.join(data, 'config'));
    fs.writeFileSync(path.join(data, 'config', 'gateway.env'), 'GATEWAY_API_KEY=keep-me');
    job = { appDir: app, stagingDir: `${app}.new`, backupDir: `${app}.backup`, fromVersion: '0.1.2', toVersion: '0.2.0', supervisorPid: 99, dataDir: data, gatewayPort: 4000, dashboardPort: 3000, statusPort: 4010, resultFile: path.join(data, 'updates', 'result.json'), healthTimeoutMs: 1000, stopTimeoutMs: 5000 };
    started = [];
    alive = true;
    healthy = true;
    startReturns = 1234;
  });

  const version = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8')) as { version: string }).version;
  const dataIntact = () => {
    expect(fs.readFileSync(path.join(data, 'gateway.sqlite'), 'utf8')).toBe('DB');
    expect(fs.readFileSync(path.join(data, 'config', 'gateway.env'), 'utf8')).toBe('GATEWAY_API_KEY=keep-me');
  };

  it('swaps in the new version, keeps the old one as the backup, and leaves customer data alone', async () => {
    const r = await runUpdate(job, deps());
    expect(r.outcome).toBe('updated');
    expect(version(job.appDir)).toBe('0.2.0');
    expect(version(job.backupDir)).toBe('0.1.2');
    expect(fs.existsSync(job.stagingDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(job.resultFile, 'utf8')).outcome).toBe('updated');
    dataIntact();
  });

  it('rolls back to the previous version when the new one is not healthy', async () => {
    healthy = false;
    const r = await runUpdate(job, deps());
    expect(r.outcome).toBe('rolled_back');
    expect(r.restored).toBe(true);
    expect(version(job.appDir)).toBe('0.1.2');
    expect(fs.existsSync(`${job.appDir}.failed`)).toBe(false);
    expect(started.map((s) => JSON.parse(s).version)).toEqual(['0.2.0', '0.1.2']); // new tried first, then the old one restarted
    expect(r.reason).toMatch(/healthy/);
    dataIntact();
  });

  it('rolls back when the new program cannot be started at all', async () => {
    startReturns = null;
    const r = await runUpdate(job, deps());
    expect(r.outcome).toBe('rolled_back');
    expect(version(job.appDir)).toBe('0.1.2');
    dataIntact();
  });

  it('changes nothing when the old program will not stop', async () => {
    const d = deps();
    d.sleep = async () => undefined; // never exits
    const r = await runUpdate({ ...job, stopTimeoutMs: 0 }, d);
    expect(r.outcome).toBe('failed');
    expect(version(job.appDir)).toBe('0.1.2');
    expect(fs.existsSync(job.stagingDir)).toBe(true);
    expect(started).toEqual([]);
    dataIntact();
  });

  it('replaces an older backup left by the previous update', async () => {
    writeProgram(job.backupDir, '0.0.9');
    await runUpdate(job, deps());
    expect(version(job.backupDir)).toBe('0.1.2');
  });
});

describe('the release tool and the product agree', () => {
  it('publishes a package the product accepts end to end (and the private key stays outside the repository)', async () => {
    const tool = path.resolve(__dirname, '../../../tools/release/release.mjs');
    const keyFile = path.join(tmp, 'keys', 'update.key');
    const pub = path.join(tmp, 'keys', 'public-key.pem');
    execFileSync(process.execPath, [tool, 'keygen', '--key', keyFile, '--public', pub]);
    const app = path.join(tmp, 'stage-app');
    fs.mkdirSync(app);
    writeProgram(app, '0.3.0');
    const out = path.join(tmp, 'out');
    execFileSync(process.execPath, [tool, 'publish', '--key', keyFile, '--app', app, '--base-url', 'https://updates.example.com/sizh/', '--out', out, '--notes', 'Test release']);
    const manifest = fs.readFileSync(path.join(out, 'latest.json'));
    const m = verifyManifest(manifest, fs.readFileSync(path.join(out, 'latest.json.sig'), 'utf8'), fs.readFileSync(pub, 'utf8'), '0.1.2', new Date());
    expect(m).toMatchObject({ version: '0.3.0', packageUrl: 'https://updates.example.com/sizh/SIZH-IT-Solution-0.3.0.zip', notes: 'Test release' });
    await verifyPackageFile(path.join(out, 'SIZH-IT-Solution-0.3.0.zip'), m);
    // a different key does not verify it
    expect(code(() => verifyManifest(manifest, fs.readFileSync(path.join(out, 'latest.json.sig'), 'utf8'), PUBLIC, '0.1.2', new Date()))).toBe('BAD_SIGNATURE');
    // and the tool refuses to keep a private key inside the repository
    const inRepo = path.resolve(__dirname, '../../../should-not-exist.key');
    expect(() => execFileSync(process.execPath, [tool, 'keygen', '--key', inRepo, '--public', pub + '2'], { stdio: 'pipe' })).toThrow();
    expect(fs.existsSync(inRepo)).toBe(false);
  });
});

describe('recovery of an interrupted update', () => {
  let app: string;
  let data: string;
  const deps = (alive = false) => ({ isAlive: () => alive, now: () => new Date(), log: () => undefined, sleep: async () => undefined });
  const version = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8')) as { version: string }).version;
  const journal = (state: string) => {
    fs.mkdirSync(path.join(data, 'updates'), { recursive: true });
    fs.writeFileSync(
      journalFile(data),
      JSON.stringify({ version: 1, state, appDir: app, stagingDir: `${app}.new`, backupDir: `${app}.backup`, fromVersion: '0.1.2', toVersion: '0.2.0', runnerPid: 999999, at: '' })
    );
  };
  const dataIntact = () => {
    expect(fs.readFileSync(path.join(data, 'gateway.sqlite'), 'utf8')).toBe('DB');
    expect(fs.readFileSync(path.join(data, 'config', 'gateway.env'), 'utf8')).toBe('GATEWAY_API_KEY=keep-me');
  };
  const result = () => JSON.parse(fs.readFileSync(path.join(data, 'updates', 'result.json'), 'utf8')) as { outcome: string; reason: string };

  beforeEach(() => {
    app = path.join(tmp, 'app');
    data = path.join(tmp, 'data');
    fs.mkdirSync(path.join(data, 'config'), { recursive: true });
    fs.writeFileSync(path.join(data, 'gateway.sqlite'), 'DB');
    fs.writeFileSync(path.join(data, 'config', 'gateway.env'), 'GATEWAY_API_KEY=keep-me');
  });

  it('does nothing when no update was interrupted', async () => {
    writeProgram(app, '0.1.2');
    expect((await recoverInterruptedUpdate(data, deps())).status).toBe('none');
    expect(version(app)).toBe('0.1.2');
  });

  it('restores the previous version when the crash came between the two renames (no program folder at all)', async () => {
    writeProgram(`${app}.backup`, '0.1.2');
    writeProgram(`${app}.new`, '0.2.0');
    journal('moving-aside');
    const r = await recoverInterruptedUpdate(data, deps());
    expect(r.status).toBe('recovered');
    expect(version(app)).toBe('0.1.2');
    expect(fs.existsSync(journalFile(data))).toBe(false);
    expect(result().outcome).toBe('recovered');
    dataIntact();
  });

  it('undoes a new version that was put in place but never confirmed healthy', async () => {
    writeProgram(app, '0.2.0');
    writeProgram(`${app}.backup`, '0.1.2');
    journal('installing');
    expect((await recoverInterruptedUpdate(data, deps())).status).toBe('recovered');
    expect(version(app)).toBe('0.1.2');
    expect(fs.existsSync(`${app}.failed`)).toBe(false);
    dataIntact();
  });

  it('finishes forward when the new version had been confirmed healthy', async () => {
    writeProgram(app, '0.2.0');
    writeProgram(`${app}.backup`, '0.1.2');
    journal('verified');
    const r = await recoverInterruptedUpdate(data, deps());
    expect(r.result?.outcome).toBe('updated');
    expect(version(app)).toBe('0.2.0');
    expect(version(`${app}.backup`)).toBe('0.1.2');
  });

  it('replaces a half-copied program folder with the intact backup, renaming rather than deleting first', async () => {
    fs.mkdirSync(path.join(app, 'gateway'), { recursive: true });
    fs.writeFileSync(path.join(app, 'gateway', 'partial.js'), 'x');
    writeProgram(`${app}.backup`, '0.1.2');
    journal('installing');
    expect((await recoverInterruptedUpdate(data, deps())).status).toBe('recovered');
    expect(version(app)).toBe('0.1.2');
  });

  it('uses the staged new version when it is the only complete copy left', async () => {
    writeProgram(`${app}.new`, '0.2.0');
    journal('moving-aside');
    const r = await recoverInterruptedUpdate(data, deps());
    expect(r.status).toBe('recovered');
    expect(version(app)).toBe('0.2.0');
    dataIntact();
  });

  it('never touches anything while the runner is still alive', async () => {
    writeProgram(`${app}.backup`, '0.1.2');
    writeProgram(`${app}.new`, '0.2.0');
    journal('moving-aside');
    expect((await recoverInterruptedUpdate(data, deps(true))).status).toBe('in_progress');
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.existsSync(`${app}.backup`)).toBe(true);
    expect(fs.existsSync(journalFile(data))).toBe(true);
  });

  it('keeps the journal and deletes nothing when no complete copy exists', async () => {
    fs.mkdirSync(`${app}.backup`);
    fs.writeFileSync(path.join(`${app}.backup`, 'stray.txt'), 'x');
    journal('moving-aside');
    const r = await recoverInterruptedUpdate(data, deps());
    expect(r.status).toBe('unrecoverable');
    expect(fs.existsSync(path.join(`${app}.backup`, 'stray.txt'))).toBe(true);
    expect(fs.existsSync(journalFile(data))).toBe(true);
    dataIntact();
  });

  it('leaves a good previous version alone when the update never reached the swap', async () => {
    writeProgram(app, '0.1.2');
    writeProgram(`${app}.new`, '0.2.0');
    journal('started');
    const r = await recoverInterruptedUpdate(data, deps());
    expect(r.status).toBe('recovered');
    expect(version(app)).toBe('0.1.2');
  });

  it('the runner writes a journal at each step and removes it when it finishes', async () => {
    writeProgram(app, '0.1.2');
    writeProgram(`${app}.new`, '0.2.0');
    const seen: string[] = [];
    const job: UpdateJob = { appDir: app, stagingDir: `${app}.new`, backupDir: `${app}.backup`, fromVersion: '0.1.2', toVersion: '0.2.0', supervisorPid: 99, dataDir: data, gatewayPort: 4000, dashboardPort: 3000, statusPort: 4010, resultFile: path.join(data, 'updates', 'result.json'), healthTimeoutMs: 1000, stopTimeoutMs: 1000 };
    const d: RunnerDeps = {
      isAlive: () => false,
      startProgram: () => {
        seen.push(JSON.parse(fs.readFileSync(journalFile(data), 'utf8')).state);
        return 1;
      },
      stopProgram: async () => undefined,
      healthy: async () => true,
      sleep: async () => undefined,
      now: () => new Date(),
      log: () => undefined,
    };
    await runUpdate(job, d);
    expect(seen).toEqual(['installing']);
    expect(fs.existsSync(journalFile(data))).toBe(false);
  });
});
