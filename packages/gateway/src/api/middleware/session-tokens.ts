import crypto from 'node:crypto';

/**
 * Short-lived local session tokens for the dashboard installed on this computer.
 *
 * The packaged dashboard's SERVER (same computer) exchanges the master API key for a token; the browser only ever holds the token. A
 * token is random, kept only in this process's memory (a gateway restart ends every session), expires after `ttlMs`, and is accepted
 * wherever the API key is (REST and the live connection). It grants nothing the key does not, and it cannot be used to mint another
 * token: minting needs the master key itself and a loopback caller.
 */
export const SESSION_TOKEN_PREFIX = 'st_';
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_TOKENS = 64;

export class SessionTokens {
  private readonly tokens = new Map<string, number>(); // sha256(token) -> expires at (ms)

  constructor(
    private readonly ttlMs = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  private static hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /** A new token. Only its hash is kept, so the map itself holds nothing usable. */
  issue(): { token: string; expiresAt: string; ttlMs: number } {
    this.prune();
    while (this.tokens.size >= MAX_TOKENS) {
      const oldest = this.tokens.keys().next().value as string;
      this.tokens.delete(oldest);
    }
    const token = `${SESSION_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    const expires = this.now() + this.ttlMs;
    this.tokens.set(SessionTokens.hash(token), expires);
    return { token, expiresAt: new Date(expires).toISOString(), ttlMs: this.ttlMs };
  }

  /** True only for a token this process issued that has not expired. */
  verify(token: string | undefined | null): boolean {
    if (typeof token !== 'string' || !token.startsWith(SESSION_TOKEN_PREFIX) || token.length !== SESSION_TOKEN_PREFIX.length + 64) return false;
    const h = SessionTokens.hash(token);
    const expires = this.tokens.get(h);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.tokens.delete(h);
      return false;
    }
    return true;
  }

  private prune(): void {
    const t = this.now();
    for (const [h, exp] of this.tokens) if (exp <= t) this.tokens.delete(h);
  }
}

/** A loopback peer: the caller is a program on this computer. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || /^127\./.test(address) || /^::ffff:127\./.test(address);
}
