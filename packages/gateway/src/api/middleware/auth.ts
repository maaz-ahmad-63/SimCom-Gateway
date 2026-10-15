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

export function createAuthMiddleware(expectedApiKey: string) {
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

    if (!verifyApiKey(token, expectedApiKey)) {
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
