import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Response headers for the API, and a limit on repeated wrong API keys.
 *
 * The limiter counts only FAILED authentications per client address. A correct key is never slowed down and clears the count, so normal
 * use is not affected; a script guessing keys is stopped after a handful of tries and told when to try again.
 */

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // API answers hold call data: they are never kept by a browser cache or a proxy.
    res.setHeader('Cache-Control', 'no-store');
    res.removeHeader('X-Powered-By');
    next();
  };
}

export class AuthFailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Seconds until another attempt is allowed, or 0 when the client may try. */
  blockedFor(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 2000) for (const k of this.hits.keys()) if (this.recent(k).length === 0) this.hits.delete(k);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}

/** Wraps the API-key middleware: refuses a client that keeps failing, and counts failures and successes. */
export function limitAuthFailures(inner: RequestHandler, limiter: AuthFailureLimiter, onBlocked?: (client: string) => void): RequestHandler {
  const clientOf = (req: Request) => req.socket.remoteAddress ?? 'unknown';
  return (req: Request, res: Response, next: NextFunction) => {
    const client = clientOf(req);
    const wait = limiter.blockedFor(client);
    if (wait > 0) {
      onBlocked?.(client);
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${wait} seconds.`, code: 'RATE_LIMITED' });
      return;
    }
    res.on('finish', () => {
      if (res.statusCode === 401) limiter.fail(client);
    });
    inner(req, res, (err?: unknown) => {
      if (!err) limiter.clear(client);
      next(err as Error | undefined);
    });
  };
}
