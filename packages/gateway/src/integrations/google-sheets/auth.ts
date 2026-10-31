import crypto from 'node:crypto';
import { FetchLike, redactSecrets } from '../../ai/providers/http.js';
import { SheetsError } from './types.js';

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MAX_CREDENTIAL_CHARS = 20_000;

/**
 * Reads a Google service-account key file (the JSON downloaded from the Cloud console). Only the two fields that are used are kept;
 * the token URL in the file is ignored so a pasted file can never point the signing key at another host.
 */
export function parseServiceAccount(text: unknown): ServiceAccount {
  if (typeof text !== 'string' || text.trim() === '') throw new SheetsError('invalid_credential', 'Paste the service account JSON key file.');
  if (text.length > MAX_CREDENTIAL_CHARS) throw new SheetsError('invalid_credential', 'That is too large to be a service account key file.');
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SheetsError('invalid_credential', 'That is not valid JSON. Paste the whole key file you downloaded from Google Cloud.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'service_account') {
    throw new SheetsError('invalid_credential', 'That is not a service account key (its "type" must be "service_account"). OAuth client files are not supported.');
  }
  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) throw new SheetsError('invalid_credential', 'The key file has no valid client_email.');
  if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/.test(privateKey)) {
    throw new SheetsError('invalid_credential', 'The key file has no valid private_key.');
  }
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    throw new SheetsError('invalid_credential', 'The private_key in the file could not be read: download a fresh key file.');
  }
  return { clientEmail, privateKey };
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * Service-account access tokens (the OAuth 2.0 JWT-bearer flow). The signed assertion and the token stay in this process: they are
 * never logged, returned by the API, or placed in an error. A token is reused until a minute before it expires.
 */
export class ServiceAccountAuth {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = () => Date.now()
  ) {}

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    this.inflight ??= this.fetchToken(signal).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private assertion(): string {
    const issued = Math.floor(this.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 }));
    const signature = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.account.privateKey);
    return `${head}.${claims}.${b64url(signature)}`;
  }

  private async fetchToken(signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.assertion() }).toString(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (error instanceof SheetsError) throw error;
      throw new SheetsError('auth_network', `Could not reach Google to sign in (${redactSecrets((error as Error).message ?? 'network error')}).`, 502);
    }
    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || typeof body?.access_token !== 'string') {
      // Google's error code (invalid_grant, ...) is safe and useful; its description is kept short and scrubbed.
      const why = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
      const hint = typeof body?.error_description === 'string' ? `: ${redactSecrets(body.error_description).slice(0, 120)}` : '';
      throw new SheetsError('auth_failed', `Google rejected the service account (${why}${hint}). Check that the key is current and the Google Sheets API is enabled for its project.`, 502);
    }
    const lifetime = Number(body.expires_in);
    this.token = { value: body.access_token, expiresAt: this.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000 };
    return this.token.value;
  }
}
