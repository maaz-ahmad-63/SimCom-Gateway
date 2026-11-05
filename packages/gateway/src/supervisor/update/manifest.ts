import crypto from 'node:crypto';

/**
 * The signed description of a release. The publisher signs the EXACT bytes of latest.json with an Ed25519 private key that never leaves
 * the release machine; the installed product holds only the public key. The signature is detached (latest.json.sig, base64), so nothing
 * has to be re-serialised before it is checked, and a changed byte anywhere (version, package address, hash) makes it fail.
 */

export const PRODUCT_ID = 'sizh-it-solution';
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

export interface UpdateManifest {
  schema: 1;
  product: typeof PRODUCT_ID;
  version: string;
  /** The oldest version that may update straight to this one. */
  minimumVersion?: string;
  packageUrl: string;
  packageSha256: string;
  packageSize: number;
  publishedAt: string;
  /** After this moment the manifest is refused, so an old signed manifest cannot be replayed forever. */
  expiresAt: string;
  notes?: string;
}

export type UpdateErrorCode =
  | 'NOT_CONFIGURED' | 'INSECURE_URL' | 'FETCH_FAILED' | 'TOO_LARGE' | 'BAD_SIGNATURE' | 'BAD_MANIFEST' | 'EXPIRED' | 'NOT_NEWER'
  | 'TOO_OLD' | 'HASH_MISMATCH' | 'SIZE_MISMATCH' | 'UNSAFE_PACKAGE' | 'INVALID_PACKAGE' | 'CALL_IN_PROGRESS' | 'CALL_STATE_UNKNOWN'
  | 'NOT_WRITABLE' | 'BUSY' | 'NO_UPDATE';

export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode, message: string) {
    super(message);
  }
}

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a is older than b. Throws on anything that is not major.minor.patch. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Not a version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Throws BAD_SIGNATURE unless `signatureB64` is a valid Ed25519 signature of exactly these bytes under the pinned key. */
export function verifySignature(manifestBytes: Buffer, signatureB64: string, publicKeyPem: string): void {
  let ok = false;
  try {
    const sig = Buffer.from(signatureB64.trim(), 'base64');
    ok = sig.length === 64 && crypto.verify(null, manifestBytes, crypto.createPublicKey(publicKeyPem), sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new UpdateError('BAD_SIGNATURE', 'The update information is not signed by SIZH IT Solution, so it was ignored.');
}

export function parseManifest(bytes: Buffer): UpdateManifest {
  let m: Partial<UpdateManifest>;
  try {
    m = JSON.parse(bytes.toString('utf8')) as Partial<UpdateManifest>;
  } catch {
    throw new UpdateError('BAD_MANIFEST', 'The update information could not be read.');
  }
  const bad = (why: string) => new UpdateError('BAD_MANIFEST', `The update information is not valid (${why}).`);
  if (m.schema !== 1 || m.product !== PRODUCT_ID) throw bad('wrong product or format');
  if (typeof m.version !== 'string' || !parseVersion(m.version)) throw bad('version');
  if (m.minimumVersion !== undefined && (typeof m.minimumVersion !== 'string' || !parseVersion(m.minimumVersion))) throw bad('minimum version');
  if (typeof m.packageUrl !== 'string' || !isHttps(m.packageUrl)) throw new UpdateError('INSECURE_URL', 'The update package address is not a secure (https) address.');
  if (typeof m.packageSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.packageSha256)) throw bad('package hash');
  if (!Number.isInteger(m.packageSize) || (m.packageSize as number) <= 0 || (m.packageSize as number) > MAX_PACKAGE_BYTES) throw bad('package size');
  if (typeof m.publishedAt !== 'string' || Number.isNaN(Date.parse(m.publishedAt))) throw bad('publish date');
  if (typeof m.expiresAt !== 'string' || Number.isNaN(Date.parse(m.expiresAt))) throw bad('expiry date');
  return { ...(m as UpdateManifest), packageSha256: m.packageSha256.toLowerCase() };
}

/** Everything that decides whether a downloaded manifest may be acted on. Order matters: signature first, so nothing unsigned is parsed further. */
export function verifyManifest(manifestBytes: Buffer, signatureB64: string, publicKeyPem: string, currentVersion: string, now: Date): UpdateManifest {
  verifySignature(manifestBytes, signatureB64, publicKeyPem);
  const m = parseManifest(manifestBytes);
  if (Date.parse(m.expiresAt) <= now.getTime()) throw new UpdateError('EXPIRED', 'The update information has expired. Check again later.');
  if (compareVersions(m.version, currentVersion) <= 0) throw new UpdateError('NOT_NEWER', 'No newer version is available.');
  if (m.minimumVersion && compareVersions(currentVersion, m.minimumVersion) < 0) {
    throw new UpdateError('TOO_OLD', `This version is too old to update directly. Install version ${m.minimumVersion} or newer first.`);
  }
  return m;
}
