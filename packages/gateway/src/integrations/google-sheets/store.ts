import { z } from 'zod';
import { SecretCipher } from '../../ai/secrets.js';
import type { SettingsBackend } from '../../ai/settings.js';
import { SpreadsheetIdSchemaPart } from './schema.js';
import { ServiceAccount, parseServiceAccount } from './auth.js';
import { DEFAULT_SHEETS_CONFIG, SHEET_COLUMNS, SheetsConfig, SheetsError, SheetsStatus, SheetsTestResult } from './types.js';

const CONFIG_KEY = 'integrations.google_sheets';
const TEST_KEY = 'integrations.google_sheets.last_test';
/** Same encrypted-at-rest scheme and master key as the AI provider keys; a different record, because a key file is far longer than an API key. */
const CREDENTIAL_KEY = 'integrations.google_sheets.credential';

export const sheetsConfigPatchSchema = z
  .object({
    enabled: z.boolean(),
    spreadsheetId: SpreadsheetIdSchemaPart.or(z.literal('')),
    sheetName: z.string().trim().min(1).max(100),
    inboundTools: z.boolean(),
    outboundTools: z.boolean(),
    logOutcomes: z.boolean(),
  })
  .partial()
  .strict();

export class SheetsConfigStore {
  private readonly cipher: SecretCipher | null;

  constructor(
    private readonly backend: SettingsBackend,
    masterKey?: string
  ) {
    const key = masterKey?.trim();
    this.cipher = key ? new SecretCipher(key) : null;
  }

  get secretStorageAvailable(): boolean {
    return this.cipher !== null;
  }

  config(): SheetsConfig {
    const raw = this.backend.getSetting(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SHEETS_CONFIG };
    try {
      const parsed = JSON.parse(raw) as Partial<SheetsConfig>;
      return { ...DEFAULT_SHEETS_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return { ...DEFAULT_SHEETS_CONFIG };
    }
  }

  /** Validates and saves a partial update. Turning the integration on needs a credential and a spreadsheet first. */
  update(patch: unknown): SheetsConfig {
    const parsed = sheetsConfigPatchSchema.safeParse(patch);
    if (!parsed.success) {
      throw new SheetsError('invalid_settings', parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; '));
    }
    const next = { ...this.config(), ...parsed.data };
    if (/[\u0000-\u001f[\]*?:/\\]/.test(next.sheetName)) throw new SheetsError('invalid_settings', 'sheetName: a tab name cannot contain control characters or any of [ ] * ? : / \\');
    if (next.enabled) {
      if (!next.spreadsheetId) throw new SheetsError('invalid_settings', 'Enter the spreadsheet ID before turning the integration on.', 409);
      if (!this.hasCredential()) throw new SheetsError('invalid_settings', 'Store the service account key before turning the integration on.', 409);
    }
    this.backend.setSetting(CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  hasCredential(): boolean {
    return this.backend.getSetting(CREDENTIAL_KEY) !== null;
  }

  /** Validates the key file, then stores it encrypted. The file's text is never kept anywhere else. */
  setCredential(text: unknown): { serviceAccountEmail: string } {
    if (!this.cipher) {
      throw new SheetsError('storage_unavailable', 'Credential storage is not enabled: set AI_SECRETS_MASTER_KEY (16+ random characters) in the gateway .env and restart.', 409);
    }
    const account = parseServiceAccount(text);
    this.backend.setSetting(CREDENTIAL_KEY, this.cipher.encrypt(JSON.stringify({ clientEmail: account.clientEmail, privateKey: account.privateKey })));
    // A new key invalidates the last test, and the integration must be re-enabled deliberately only if it was off.
    this.backend.deleteSetting(TEST_KEY);
    return { serviceAccountEmail: account.clientEmail };
  }

  deleteCredential(): void {
    this.backend.deleteSetting(CREDENTIAL_KEY);
    this.backend.deleteSetting(TEST_KEY);
    // Without a key the integration cannot work; leaving it switched on would only fail on every call.
    const config = this.config();
    if (config.enabled) this.backend.setSetting(CONFIG_KEY, JSON.stringify({ ...config, enabled: false }));
  }

  /** Server-side use only (signing in to Google). Returns null when there is none or it cannot be decrypted. */
  resolveCredential(): ServiceAccount | null {
    const stored = this.backend.getSetting(CREDENTIAL_KEY);
    if (!stored || !this.cipher) return null;
    try {
      const parsed = JSON.parse(this.cipher.decrypt(stored)) as ServiceAccount;
      return typeof parsed?.clientEmail === 'string' && typeof parsed?.privateKey === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  recordTest(result: SheetsTestResult): void {
    this.backend.setSetting(TEST_KEY, JSON.stringify(result));
  }

  lastTest(): SheetsTestResult | null {
    const raw = this.backend.getSetting(TEST_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SheetsTestResult;
    } catch {
      return null;
    }
  }

  status(): SheetsStatus {
    const stored = this.hasCredential();
    const account = stored ? this.resolveCredential() : null;
    return {
      config: this.config(),
      credential: { stored, serviceAccountEmail: account?.clientEmail ?? null, undecryptable: stored && account === null },
      secretStorageAvailable: this.secretStorageAvailable,
      lastTest: this.lastTest(),
      columns: SHEET_COLUMNS,
    };
  }
}
