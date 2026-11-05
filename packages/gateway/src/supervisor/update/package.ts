import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { UpdateError, UpdateManifest } from './manifest.js';

const execFileAsync = promisify(execFile);

/** Windows' own tar.exe (bsdtar, reads and writes zip). Found by full path, because a `tar` earlier on PATH (Git's GNU tar) reads "C:..." as a remote host. */
export const tarExe = (): string => (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar');

/** SHA-256 and size of a file, read as a stream. */
export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** The downloaded file must be exactly what the signed manifest names. */
export async function verifyPackageFile(file: string, manifest: Pick<UpdateManifest, 'packageSha256' | 'packageSize'>): Promise<void> {
  const { sha256, size } = await hashFile(file);
  if (size !== manifest.packageSize) throw new UpdateError('SIZE_MISMATCH', 'The downloaded update is not the expected size, so it was discarded.');
  if (sha256 !== manifest.packageSha256) throw new UpdateError('HASH_MISMATCH', 'The downloaded update does not match its signed checksum, so it was discarded.');
}

/** Top-level names a release may contain. Anything else (data, config, keys) is not part of the program and is refused. */
export const ALLOWED_TOP_LEVEL = new Set(['gateway', 'dashboard', 'runtime', 'update', 'VERSION.json', 'SimGateway.js', 'check-modem-driver.ps1']);
const FORBIDDEN = /(^|\/)(\.env[^/]*|gateway\.env|[^/]*\.sqlite[^/]*|SimGatewaySecrets|master\.key|supervisor\.token)(\/|$)/i;

/** Reasons an archive entry list is unsafe; empty when it is fine. Checked BEFORE anything is extracted. */
export function unsafeEntries(entries: string[]): string[] {
  const problems: string[] = [];
  for (const raw of entries) {
    const e = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (e === '' || e === '.' || e === './') continue;
    if (e.startsWith('/') || /^[A-Za-z]:/.test(e) || e.split('/').includes('..')) problems.push(`${raw}: path leaves the program folder`);
    else if (e.includes(':')) problems.push(`${raw}: stream or drive syntax`);
    else if (!ALLOWED_TOP_LEVEL.has(e.split('/')[0])) problems.push(`${raw}: not a program file`);
    else if (FORBIDDEN.test(e)) problems.push(`${raw}: customer data or keys never ship in an update`);
  }
  return problems;
}

/** Uses tar.exe, which ships with Windows 10 and later and reads zip. Nothing in the archive is ever run during extraction. */
export async function listArchive(archive: string): Promise<string[]> {
  const { stdout } = await execFileAsync(tarExe(), ['-tf', archive], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout.split(/\r?\n/).filter(Boolean);
}

export async function extractArchive(archive: string, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await execFileAsync(tarExe(), ['-xf', archive, '-C', dir], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** The extracted tree must look like a complete program of the announced version. */
export function validateStaged(dir: string, version: string): void {
  const need = ['VERSION.json', path.join('runtime', 'node.exe'), path.join('gateway', 'dist', 'supervisor', 'main.js'), path.join('dashboard', 'packages', 'dashboard', 'server.js')];
  for (const n of need) if (!fs.existsSync(path.join(dir, n))) throw new UpdateError('INVALID_PACKAGE', `The update is incomplete (${n} is missing).`);
  let v: string | undefined;
  try {
    v = (JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8').replace(/^﻿/, '')) as { version?: string }).version;
  } catch {
    /* handled below */
  }
  if (v !== version) throw new UpdateError('INVALID_PACKAGE', 'The update contains a different version than announced, so it was discarded.');
}
