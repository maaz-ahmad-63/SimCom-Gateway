import fs from 'node:fs';

/**
 * What a service printed before it stopped, turned into one safe sentence for the supervisor log and the status page.
 *
 * A child that dies at once (a missing module, a port in use) explains itself only on its standard error. Without this the customer and
 * support see "exited (code 1)" and nothing else. The child writes straight into a file (not a pipe), so it can never block on, or be
 * killed by, a full or broken pipe if the supervisor itself goes away.
 */

const MAX_DETAIL = 600;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(GATEWAY_API_KEY|AI_SECRETS_MASTER_KEY|[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD))\s*[=:]\s*\S+/gi, '$1=<redacted>'],
  [/\bx-(?:api-key|supervisor-token)\s*[:=]\s*\S+/gi, 'x-…=<redacted>'],
  [/\bBearer\s+\S+/gi, 'Bearer <redacted>'],
  [/SIMGATEWAY-SECRETS-KEY-V1:[0-9a-f]+/gi, '<redacted key>'],
  [/\b(?:sk|gsk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g, '<redacted>'],
  [/\b[0-9a-f]{32,}\b/gi, '<redacted>'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/g, '<redacted>'],
];

/** Removes colour codes and anything that looks like a credential. */
export function sanitizeChildOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  let s = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
  for (const [re, by] of SECRET_PATTERNS) s = s.replace(re, by);
  return s;
}

/**
 * The most useful short explanation in a service's output: the first error line and the line after it (Node prints the missing module or
 * the failing call there), else the last few lines. Sanitized and limited in length; null when there is nothing to say.
 */
export function summarizeFailure(raw: string): string | null {
  const lines = sanitizeChildOutput(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\^+$/.test(l) && !/^at\s/.test(l) && !/^node:internal/.test(l) && !/^throw err;?$/.test(l) && !/^Node\.js v\d/.test(l));
  if (lines.length === 0) return null;
  const i = lines.findIndex((l) => /\b(Error|ERR_[A-Z_]+|Cannot find module|EADDRINUSE|EACCES|EPERM|ENOENT)\b/.test(l));
  const picked = i >= 0 ? lines.slice(i, i + 2) : lines.slice(-3);
  const s = picked.join(' | ');
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
}

/** The last `bytes` of a file, or '' if it cannot be read. */
export function readTail(file: string, bytes = 16 * 1024): string {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Reads what the service wrote to `file`, returns the summary, and replaces the file's content with the sanitized tail so that no raw
 * output (which could, in principle, contain something sensitive) is kept on disk after the service stopped.
 */
export function collectFailure(file: string): string | null {
  const raw = readTail(file);
  if (!raw) return null;
  try {
    fs.writeFileSync(file, sanitizeChildOutput(raw));
  } catch {
    /* the summary below is still returned */
  }
  return summarizeFailure(raw);
}
