import crypto from 'node:crypto';

/**
 * Encrypts provider API keys for storage in the gateway database (AES-256-GCM, key derived from the
 * operator's AI_SECRETS_MASTER_KEY with scrypt and a per-value salt). The master key lives only in the
 * environment, so a copy of the SQLite file alone reveals nothing. Plaintext keys are returned only to
 * server-side provider construction, never to the API.
 */
const VERSION = 'v1';
const MIN_MASTER_KEY_CHARS = 16;

export class SecretCipher {
  constructor(private readonly masterKey: string) {
    if (masterKey.length < MIN_MASTER_KEY_CHARS) {
      throw new Error(`AI_SECRETS_MASTER_KEY must be at least ${MIN_MASTER_KEY_CHARS} characters`);
    }
  }

  encrypt(plain: string): string {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(this.masterKey, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  /** Throws a generic error (never the ciphertext or key) if the value is corrupt or the master key changed. */
  decrypt(blob: string): string {
    const [version, salt, iv, tag, data] = blob.split(':');
    if (version !== VERSION || !salt || !iv || !tag || data === undefined) throw new Error('stored secret has an unknown format');
    try {
      const key = crypto.scryptSync(this.masterKey, Buffer.from(salt, 'base64'), 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('stored secret could not be decrypted (wrong AI_SECRETS_MASTER_KEY or corrupt value)');
    }
  }
}

/** "••••1234": never more than the last four characters, and nothing for short keys. */
export function maskSecret(secret: string): string {
  return secret.length >= 12 ? `••••${secret.slice(-4)}` : '••••';
}
