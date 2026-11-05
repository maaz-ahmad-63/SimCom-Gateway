import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateError } from '../src/supervisor/update/manifest.js';
import { makeNetwork } from '../src/supervisor/update/real.js';
import { UpdateConfig, UpdateDeps, UpdateService } from '../src/supervisor/update/service.js';

/**
 * GitHub Releases as the host. A scripted fetch plays GitHub's behaviour: the public address of a release asset answers with a redirect to
 * its storage host (a signed, temporary address), and only that second address serves the bytes. The real release tool publishes the files
 * and the real network, verification and staging code consumes them.
 */

const OWNER_REPO = 'example-owner/example-repo';
const LATEST = `https://github.com/${OWNER_REPO}/releases/latest/download/latest.json`;
const STORAGE = 'https://release-assets.githubusercontent.com/github-production-release-asset/123';
const tool = path.resolve(__dirname, '../../../tools/release/release.mjs');

let tmp: string;
let out: string;
let publicKey: string;
let zipName: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simgw-gh-'));
  const keyFile = path.join(tmp, 'keys', 'k.key');
  const pubFile = path.join(tmp, 'keys', 'p.pem');
  execFileSync(process.execPath, [tool, 'keygen', '--key', keyFile, '--public', pubFile]);
  publicKey = fs.readFileSync(pubFile, 'utf8');
  const tree = path.join(tmp, 'tree');
  for (const [rel, text] of Object.entries({ 'VERSION.json': JSON.stringify({ version: '0.3.0' }), 'runtime/node.exe': 'n', 'gateway/dist/supervisor/main.js': 'm', 'dashboard/packages/dashboard/server.js': 's' })) {
    const f = path.join(tree, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  out = path.join(tmp, 'out');
  const published = execFileSync(process.execPath, [tool, 'publish', '--key', keyFile, '--app', tree, '--github', OWNER_REPO, '--out', out, '--notes', 'GitHub test'], { encoding: 'utf8' });
  zipName = 'SIZH-IT-Solution-0.3.0.zip';
  published.split('\n'); // the printed commands are checked below
  lastPrinted = published;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
let lastPrinted = '';

const bytes = (name: string) => fs.readFileSync(path.join(out, name));

interface Hop {
  url: string;
  headers: Record<string, string>;
}
/** GitHub's behaviour: public asset address -> 302 -> storage address -> 200. `overrides` replace what an address answers. */
function githubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const log: Hop[] = [];
  const assets: Record<string, Buffer> = {
    [LATEST]: bytes('latest.json'),
    [`${LATEST}.sig`]: bytes('latest.json.sig'),
    [`https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`]: bytes(zipName),
  };
  const f = (async (url: string, init?: RequestInit) => {
    log.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (overrides[url]) return overrides[url]();
    if (assets[url]) return new Response(null, { status: 302, headers: { location: `${STORAGE}/${encodeURIComponent(path.basename(url))}?X-Amz-Signature=abc&X-Amz-Expires=300` } });
    if (url.startsWith(STORAGE)) {
      const name = decodeURIComponent(path.basename(new URL(url).pathname));
      const key = Object.keys(assets).find((k) => path.basename(k) === name)!;
      return new Response(new Uint8Array(assets[key]), { status: 200, headers: { 'content-length': String(assets[key].length) } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: f, log };
}

function service(fetchImpl: typeof fetch, over: Partial<UpdateConfig> = {}) {
  const app = path.join(tmp, 'app');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const launched: string[] = [];
  const net = makeNetwork(fetchImpl);
  const deps: UpdateDeps = { now: () => new Date(), ...net, callState: async () => 'idle', launchRunner: (j) => void launched.push(j), stopSupervisor: async () => undefined, log: () => undefined };
  const cfg: UpdateConfig = { updateUrl: LATEST, publicKeyPem: publicKey, currentVersion: '0.1.2', appDir: app, dataDir: data, gatewayPort: 4000, dashboardPort: 3000, statusPort: 4010, supervisorPid: 1, ...over };
  return { svc: new UpdateService(cfg, deps), app, launched };
}
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as UpdateError).code;
  }
  return undefined;
};

describe('the release tool for GitHub', () => {
  it('addresses the package at the tag-specific GitHub release and prints the draft commands without running them', () => {
    const m = JSON.parse(bytes('latest.json').toString());
    expect(m.packageUrl).toBe(`https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`);
    expect(m.notes).toBe('GitHub test');
    expect(lastPrinted).toContain('Nothing has been uploaded');
    expect(lastPrinted).toContain(`gh release create v0.3.0 --repo ${OWNER_REPO} --draft`);
    expect(lastPrinted).toContain('--draft=false --latest');
    expect(lastPrinted).toContain(`releases/latest/download/latest.json`);
    expect(fs.readdirSync(out).sort()).toEqual([zipName, 'latest.json', 'latest.json.sig']);
  });
  it('refuses a malformed repository name', () => {
    expect(() => execFileSync(process.execPath, [tool, 'publish', '--key', path.join(tmp, 'keys', 'k.key'), '--app', tmp, '--github', 'not a repo', '--out', out], { stdio: 'pipe' })).toThrow();
  });
});

describe('fetching the manifest and signature from GitHub', () => {
  it('follows the redirect to the storage address and verifies the signature', async () => {
    const gh = githubFetch();
    const { svc } = service(gh.fetch);
    const s = await svc.check();
    expect(s.available).toMatchObject({ version: '0.3.0', notes: 'GitHub test' });
    const urls = gh.log.map((h) => h.url);
    expect(urls[0]).toBe(LATEST);
    expect(urls[1]).toMatch(/^https:\/\/release-assets\.githubusercontent\.com\/.*latest\.json\?/);
    expect(urls).toContain(`${LATEST}.sig`);
    expect(urls.some((u) => u.includes('latest.json.sig?'))).toBe(true);
  });
  it('sends nothing but a fixed User-Agent on every hop, including the redirected one', async () => {
    const gh = githubFetch();
    await service(gh.fetch).svc.check();
    for (const hop of gh.log) expect(Object.keys(hop.headers)).toEqual(['user-agent']);
  });
  it('treats a repository with no release yet (404) as "nothing new", not as an error', async () => {
    const gh = githubFetch({ [LATEST]: () => new Response('Not Found', { status: 404 }) });
    const s = await service(gh.fetch).svc.check();
    expect(s.available).toBeNull();
    expect(s.error).toBeNull();
    expect(s.phase).toBe('idle');
  });
  it('rejects a manifest whose bytes were changed after signing', async () => {
    const m = JSON.parse(bytes('latest.json').toString());
    m.version = '9.9.9';
    const gh = githubFetch({ [LATEST]: () => new Response(JSON.stringify(m, null, 2), { status: 200 }) });
    expect(await codeOf(service(gh.fetch).svc.check())).toBe('BAD_SIGNATURE');
  });
  it('rejects a signature file that is really an HTML page, and a missing signature', async () => {
    const html = githubFetch({ [`${LATEST}.sig`]: () => new Response('<html>Sign in</html>', { status: 200 }) });
    expect(await codeOf(service(html.fetch).svc.check())).toBe('BAD_SIGNATURE');
    const missing = githubFetch({ [`${LATEST}.sig`]: () => new Response('Not Found', { status: 404 }) });
    expect(await codeOf(service(missing.fetch).svc.check())).toBe('NOT_PUBLISHED');
  });
  it('rejects a signature made with a different key', async () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const forged = crypto.sign(null, bytes('latest.json'), other.privateKey).toString('base64');
    const gh = githubFetch({ [`${LATEST}.sig`]: () => new Response(forged, { status: 200 }) });
    expect(await codeOf(service(gh.fetch).svc.check())).toBe('BAD_SIGNATURE');
  });
  it('refuses a redirect that leaves https, a redirect loop, a server error and an unreachable server', async () => {
    const downgrade = githubFetch({ [LATEST]: () => new Response(null, { status: 302, headers: { location: 'http://evil.example/latest.json' } }) });
    expect(await codeOf(service(downgrade.fetch).svc.check())).toBe('INSECURE_URL');
    expect(downgrade.log.some((h) => h.url.startsWith('http://'))).toBe(false); // it never even connected
    const loop = githubFetch({ [LATEST]: () => new Response(null, { status: 302, headers: { location: LATEST } }) });
    expect(await codeOf(service(loop.fetch).svc.check())).toBe('FETCH_FAILED');
    const broken = githubFetch({ [LATEST]: () => new Response('oops', { status: 500 }) });
    expect(await codeOf(service(broken.fetch).svc.check())).toBe('FETCH_FAILED');
    const down = githubFetch({
      [LATEST]: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await codeOf(service(down.fetch).svc.check())).toBe('FETCH_FAILED');
  });
  it('refuses an oversized manifest', async () => {
    const gh = githubFetch({ [LATEST]: () => new Response('x'.repeat(200_000), { status: 200 }) });
    expect(await codeOf(service(gh.fetch).svc.check())).toBe('TOO_LARGE');
  });
});

describe('downloading the application ZIP from GitHub', () => {
  it('follows the redirect, verifies size and SHA-256, extracts and hands over to the runner', async () => {
    const gh = githubFetch();
    const { svc, app, launched } = service(gh.fetch);
    await svc.check();
    const s = await svc.apply();
    expect(s.phase).toBe('installing');
    expect(launched).toHaveLength(1);
    expect(fs.readFileSync(path.join(`${app}.new`, 'VERSION.json'), 'utf8')).toContain('0.3.0');
    const zipHops = gh.log.filter((h) => h.url.includes(zipName));
    expect(zipHops.length).toBe(2); // the public address, then its redirect target
    expect(zipHops[1].url.startsWith(STORAGE)).toBe(true);
  });
  it('discards a ZIP whose bytes were altered (same size, different content)', async () => {
    const altered = Buffer.from(bytes(zipName));
    altered[altered.length - 20] ^= 0xff;
    const pub = `https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`;
    const gh = githubFetch({ [pub]: () => new Response(new Uint8Array(altered), { status: 200 }) });
    const { svc, app, launched } = service(gh.fetch);
    await svc.check();
    expect(await codeOf(svc.apply())).toBe('HASH_MISMATCH');
    expect(fs.existsSync(`${app}.new`)).toBe(false);
    expect(launched).toEqual([]);
  });
  it('stops a download that is larger than announced', async () => {
    const pub = `https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`;
    const gh = githubFetch({ [pub]: () => new Response(new Uint8Array(Buffer.concat([bytes(zipName), Buffer.alloc(4096)])), { status: 200 }) });
    const { svc, launched } = service(gh.fetch);
    await svc.check();
    expect(await codeOf(svc.apply())).toBe('SIZE_MISMATCH');
    expect(launched).toEqual([]);
  });
  it('discards a truncated download', async () => {
    const pub = `https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`;
    const gh = githubFetch({ [pub]: () => new Response(new Uint8Array(bytes(zipName).subarray(0, 1000)), { status: 200 }) });
    const { svc, launched } = service(gh.fetch);
    await svc.check();
    expect(await codeOf(svc.apply())).toBe('SIZE_MISMATCH');
    expect(launched).toEqual([]);
  });
  it('treats an HTML error page served with status 200 as an invalid download', async () => {
    const pub = `https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`;
    const gh = githubFetch({ [pub]: () => new Response('<html>rate limited</html>', { status: 200 }) });
    const { svc, launched } = service(gh.fetch);
    await svc.check();
    expect(['SIZE_MISMATCH', 'HASH_MISMATCH']).toContain(await codeOf(svc.apply()));
    expect(launched).toEqual([]);
  });
  it('fails cleanly when the asset has been removed from the release (404)', async () => {
    const pub = `https://github.com/${OWNER_REPO}/releases/download/v0.3.0/${zipName}`;
    const gh = githubFetch({ [pub]: () => new Response('Not Found', { status: 404 }) });
    const { svc, launched } = service(gh.fetch);
    await svc.check();
    expect(await codeOf(svc.apply())).toBe('NOT_PUBLISHED');
    expect(launched).toEqual([]);
  });
});

describe('the default update address', () => {
  it('is the public GitHub Releases "latest" address of this repository, and the asset names match what the release tool publishes', async () => {
    const { DEFAULT_UPDATE_URL, resolveUpdateUrl } = await import('../src/supervisor/update/config.js');
    expect(DEFAULT_UPDATE_URL).toBe('https://github.com/maaz-ahmad-63/SimCom-Gateway/releases/latest/download/latest.json');
    expect(path.basename(DEFAULT_UPDATE_URL)).toBe('latest.json'); // the release asset the tool writes
    expect(fs.readdirSync(out)).toContain('latest.json.sig'); // the product asks for `${url}.sig`
    expect(resolveUpdateUrl({}, {})).toBe(DEFAULT_UPDATE_URL);
    expect(resolveUpdateUrl({}, { UPDATE_URL: '' })).toBe(DEFAULT_UPDATE_URL);
  });
  it('can be replaced in gateway.env or by the environment, the environment winning', async () => {
    const { resolveUpdateUrl } = await import('../src/supervisor/update/config.js');
    expect(resolveUpdateUrl({}, { UPDATE_URL: 'https://mirror.example.org/latest.json' })).toBe('https://mirror.example.org/latest.json');
    expect(resolveUpdateUrl({ SIMGW_UPDATE_URL: 'https://test.example.org/latest.json' }, { UPDATE_URL: 'https://mirror.example.org/latest.json' })).toBe('https://test.example.org/latest.json');
  });
});
