#!/usr/bin/env node
// Release tool for SIZH IT Solution updates. Run by the publisher on the release machine, never by customers.
//
//   node tools/release/release.mjs keygen  --key <private-key-file> --public <public-key-pem>
//   node tools/release/release.mjs publish --key <private-key-file> --app <installer/stage/app> --base-url <https://host/dir/> --out <folder>
//                                          [--version x.y.z] [--notes "text"] [--minimum x.y.z] [--days 365]
//
// keygen   makes an Ed25519 key pair. The PRIVATE key must live outside this repository (the tool refuses a path inside it); keep it
//          offline or in a password manager. The PUBLIC key goes in installer/update/public-key.pem and is packaged with the product.
// publish  zips the staged program folder, then writes into --out: SIZH-IT-Solution-<version>.zip, latest.json and latest.json.sig.
//          Upload the zip, then latest.json and latest.json.sig. The signature covers the exact bytes of latest.json.
// It verifies its own output with the public key derived from the private key before it finishes.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(3);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const die = (m) => {
  console.error(`release: ${m}`);
  process.exit(1);
};
const inside = (child, parent) => {
  const rel = path.relative(parent, path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';

function keygen() {
  const keyFile = opt('key');
  const pubFile = opt('public');
  if (!keyFile || !pubFile) die('keygen needs --key <private-key-file> and --public <public-key-pem>');
  if (inside(keyFile, repo)) die('the private key must be stored OUTSIDE the repository. Choose another folder.');
  if (fs.existsSync(keyFile)) die(`${keyFile} already exists; it is not overwritten (a new key would orphan every installed copy).`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(path.resolve(keyFile)), { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(path.resolve(pubFile)), { recursive: true });
  fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`private key: ${keyFile}  (keep it secret and backed up; never commit it)`);
  console.log(`public key:  ${pubFile}  (commit this; it is packaged into the product)`);
}

function publish() {
  const keyFile = opt('key');
  const app = opt('app', path.join(repo, 'installer', 'stage', 'app'));
  const baseUrl = opt('base-url');
  const out = opt('out');
  if (!keyFile || !baseUrl || !out) die('publish needs --key, --base-url and --out');
  if (inside(keyFile, repo)) die('the private key is inside the repository; move it out and rotate it if it was ever committed.');
  if (!baseUrl.startsWith('https://')) die('--base-url must be an https address');
  if (inside(out, repo)) die('write the release files outside the repository');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const publicKey = crypto.createPublicKey(privateKey);
  const versionFile = path.join(app, 'VERSION.json');
  if (!fs.existsSync(versionFile)) die(`${versionFile} not found; build the package first`);
  const staged = JSON.parse(fs.readFileSync(versionFile, 'utf8').replace(/^\uFEFF/, '')).version;
  const version = opt('version', staged);
  if (version !== staged) die(`--version ${version} does not match the packaged version ${staged}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`not a version: ${version}`);
  for (const must of ['runtime/node.exe', 'gateway/dist/supervisor/main.js', 'dashboard/packages/dashboard/server.js']) {
    if (!fs.existsSync(path.join(app, must))) die(`the package is incomplete (${must})`);
  }
  fs.mkdirSync(out, { recursive: true });
  const zipName = `SIZH-IT-Solution-${version}.zip`;
  const zip = path.join(out, zipName);
  fs.rmSync(zip, { force: true });
  execFileSync(tar, ['-a', '-cf', zip, '-C', app, '.'], { stdio: 'inherit' });
  const bytes = fs.readFileSync(zip);
  const now = new Date();
  const manifest = {
    schema: 1,
    product: 'sizh-it-solution',
    version,
    ...(opt('minimum') ? { minimumVersion: opt('minimum') } : {}),
    packageUrl: new URL(zipName, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString(),
    packageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    packageSize: bytes.length,
    publishedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Number(opt('days', '365')) * 86_400_000).toISOString(),
    ...(opt('notes') ? { notes: opt('notes') } : {}),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = crypto.sign(null, manifestBytes, privateKey);
  if (!crypto.verify(null, manifestBytes, publicKey, signature)) die('self-check of the signature failed');
  fs.writeFileSync(path.join(out, 'latest.json'), manifestBytes);
  fs.writeFileSync(path.join(out, 'latest.json.sig'), signature.toString('base64'));
  console.log(`version ${version}: ${zipName} (${bytes.length} bytes, sha256 ${manifest.packageSha256.slice(0, 16)}…)`);
  console.log(`wrote ${out}\\latest.json and latest.json.sig. Upload the zip first, then latest.json and latest.json.sig.`);
}

const command = process.argv[2];
if (command === 'keygen') keygen();
else if (command === 'publish') publish();
else die('usage: release.mjs keygen|publish (see the comment at the top of this file)');
