import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Constant-time string comparison using SHA-256 digests.
 * Prevents timing attacks regardless of string length.
 */
export function verifyApiKey(providedToken: string | undefined | null, expectedKey: string): boolean {
  if (!providedToken || typeof providedToken !== 'string') {
    return false;
  }

  const providedHash = crypto.createHash('sha256').update(providedToken).digest();
  const expectedHash = crypto.createHash('sha256').update(expectedKey).digest();

  return crypto.timingSafeEqual(providedHash, expectedHash);
}

/** The master API key, or (when given) a live local session token issued by this gateway. */
export function verifyCredential(provided: string | undefined | null, expectedKey: string, sessions?: { verify(token: string | undefined | null): boolean }): boolean {
  if (sessions?.verify(provided)) return true;
  return verifyApiKey(provided, expectedKey);
}

export function createAuthMiddleware(expectedApiKey: string, sessions?: { verify(token: string | undefined | null): boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check header x-api-key
    let token = req.headers['x-api-key'] as string | undefined;

    // Check Authorization: Bearer <token>
    if (!token && req.headers['authorization']) {
      const authHeader = req.headers['authorization'];
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
      }
    }

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing API key in x-api-key or Authorization header',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    if (!verifyCredential(token, expectedApiKey, sessions)) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid API key',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    next();
  };
}
