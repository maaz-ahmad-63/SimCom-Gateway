import { createLogger } from '../../core/logger.js';
import { FetchLike } from '../../ai/providers/http.js';
import { ServiceAccount, ServiceAccountAuth } from './auth.js';
import { rangeOf, SheetsClient, SPREADSHEET_ID, validSheetName } from './client.js';
import { SheetsConfigStore } from './store.js';
import { SaveResult, SHEET_COLUMNS, SheetRecord, SheetsConfig, SheetsError, SheetsTestResult, SheetsTestStep } from './types.js';

const LAST_COLUMN = 'L';
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const clean = (v: string | null, max: number): string | null => {
  if (v === null) return null;
  const text = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text === '' ? null : text;
};

/** The problem with a record, or null when it is fit to be written. Nothing is repaired or guessed: a bad value is refused. */
export function recordProblem(r: SheetRecord): string | null {
  if (!r.key || r.key.length > 200) return 'the record has no valid key';
  if (!r.callId || r.callId.length > 80) return 'the record has no call id';
  if (Number.isNaN(Date.parse(r.recordedAt))) return 'the record has no valid time';
  if (r.phone !== null && !/^\+?\d{7,15}$/.test(r.phone)) return 'the phone number must be 7 to 15 digits';
  if (r.email !== null && (r.email.length > 254 || !EMAIL.test(r.email))) return 'the email address is not valid';
  if (r.name !== null && (r.name.length < 1 || r.name.length > 80)) return 'the name must be 1 to 80 characters';
  if (r.type === 'contact' && r.name === null && r.phone === null && r.email === null) return 'there is nothing to save: no name, phone number or email address';
  if (r.type === 'outcome' && (!r.outcome || r.outcome.length > 40)) return 'the outcome is missing';
  return null;
}

/** A cell starting with = or @ would be read as a formula by whoever exports the sheet; a leading apostrophe keeps it plain text. */
const cell = (v: string | number | null): string => {
  if (v === null) return '';
  const text = String(v);
  return /^[=@\t]/.test(text) ? `'${text}` : text;
};

export function toRow(r: SheetRecord): string[] {
  return [
    r.key,
    r.recordedAt,
    r.type,
    r.callId,
    r.campaignId ?? '',
    r.contactId === null ? '' : String(r.contactId),
    r.direction,
    cell(clean(r.name, 80)),
    r.phone ?? '',
    r.email ?? '',
    cell(clean(r.outcome, 40)),
    cell(clean(r.detail, 300)),
  ];
}

const sameExceptTime = (a: string[], b: string[]): boolean => SHEET_COLUMNS.every((_, i) => i === 1 || (a[i] ?? '') === (b[i] ?? ''));

export interface SheetsServiceOptions {
  store: SheetsConfigStore;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/**
 * Writes call records to the operator's Google Sheet. Each record has a key: saving the same key again corrects that row (a
 * correction by the caller) or does nothing (the same details twice), so a retry or a repeat can never create a duplicate. A write
 * counts as done only when Google's response says the row was written; anything else is reported as not saved. Writes are one at a
 * time, so two records cannot race for the same row. The first row of the tab is the column header: it is written when the tab is
 * empty and refused when it holds anything else, so existing data is never overwritten.
 */
export class SheetsService {
  private readonly logger = createLogger('GoogleSheets');
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private cached: { account: ServiceAccount; client: SheetsClient } | null = null;

  constructor(private readonly options: SheetsServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
  }

  get store(): SheetsConfigStore {
    return this.options.store;
  }

  /** Whether the save-contact tool may be offered on a call in `mode`. */
  toolsEnabled(mode: 'inbound' | 'outbound'): boolean {
    const c = this.store.config();
    return c.enabled && this.store.hasCredential() && (mode === 'inbound' ? c.inboundTools : c.outboundTools);
  }

  outcomesEnabled(): boolean {
    const c = this.store.config();
    return c.enabled && c.logOutcomes && this.store.hasCredential();
  }

  private client(): SheetsClient {
    const account = this.store.resolveCredential();
    if (!account) throw new SheetsError('no_credential', 'No usable service account key is stored.', 409);
    if (!this.cached || this.cached.account.clientEmail !== account.clientEmail || this.cached.account.privateKey !== account.privateKey) {
      this.cached = { account, client: new SheetsClient(new ServiceAccountAuth(account, this.fetchImpl, this.now), this.fetchImpl) };
    }
    return this.cached.client;
  }

  private target(config: SheetsConfig): void {
    if (!SPREADSHEET_ID.test(config.spreadsheetId)) throw new SheetsError('not_configured', 'No valid spreadsheet ID is set.', 409);
    if (!validSheetName(config.sheetName)) throw new SheetsError('not_configured', 'The tab name is not valid.', 409);
  }

  /** Check, then write, as one step at a time. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The tab's first row must be empty (it is then written) or exactly our header. Returns whether the header was just written. */
  private async ensureHeader(client: SheetsClient, config: SheetsConfig, signal?: AbortSignal): Promise<void> {
    const first = (await client.read(config.spreadsheetId, rangeOf(config.sheetName, `A1:${LAST_COLUMN}1`), signal))[0] ?? [];
    if (first.every((c) => c.trim() === '')) {
      const written = await client.update(config.spreadsheetId, rangeOf(config.sheetName, `A1:${LAST_COLUMN}1`), [...SHEET_COLUMNS], signal);
      if (written.updatedRows !== 1) throw new SheetsError('unconfirmed', 'Google did not confirm that the header row was written.', 502);
      return;
    }
    if (!SHEET_COLUMNS.every((name, i) => (first[i] ?? '').trim() === name)) {
      throw new SheetsError('header_mismatch', `The first row of the tab "${config.sheetName}" is not this integration's header (${SHEET_COLUMNS.join(', ')}). Use an empty tab so existing data is never overwritten.`, 409);
    }
  }

  /**
   * Save one record. Resolves (never rejects) with a result whose `ok` is true only after Google confirmed the write.
   */
  saveRecord(record: SheetRecord, signal?: AbortSignal): Promise<SaveResult> {
    const fail = (code: string, message: string): SaveResult => ({ ok: false, code, message });
    // Tidied but never shortened: a name that is too long is refused below, not saved altered.
    const clean1: SheetRecord = { ...record, name: clean(record.name, Number.MAX_SAFE_INTEGER), email: record.email === null ? null : record.email.trim().toLowerCase(), phone: record.phone === null ? null : record.phone.replace(/[\s().-]/g, '') };
    const problem = recordProblem(clean1);
    if (problem) return Promise.resolve(fail('invalid_record', `Not saved: ${problem}.`));
    return this.exclusive(async (): Promise<SaveResult> => {
      try {
        const config = this.store.config();
        if (!config.enabled) return fail('disabled', 'Saving to Google Sheets is switched off.');
        this.target(config);
        const client = this.client();
        await this.ensureHeader(client, config, signal);
        const keys = await client.read(config.spreadsheetId, rangeOf(config.sheetName, 'A:A'), signal);
        const row = toRow(clean1);
        const index = keys.findIndex((r, i) => i > 0 && r[0] === clean1.key);
        if (index === -1) {
          const written = await client.append(config.spreadsheetId, rangeOf(config.sheetName, `A:${LAST_COLUMN}`), row, signal);
          if (written.updatedRows !== 1) return fail('unconfirmed', 'Google did not confirm that the row was written, so it is not known to be saved.');
          const rowNumber = Number(/(\d+)(?::[A-Z]+\d+)?$/.exec(written.updatedRange ?? '')?.[1] ?? 0);
          return { ok: true, status: 'created', row: rowNumber };
        }
        const rowNumber = index + 1;
        const existing = (await client.read(config.spreadsheetId, rangeOf(config.sheetName, `A${rowNumber}:${LAST_COLUMN}${rowNumber}`), signal))[0] ?? [];
        // A later save for the same contact adds what it knows and keeps what an earlier one confirmed (name, phone, email).
        if (clean1.type === 'contact') for (const i of [7, 8, 9]) if (row[i] === '' && (existing[i] ?? '') !== '') row[i] = existing[i];
        if (sameExceptTime(existing, row)) return { ok: true, status: 'unchanged', row: rowNumber };
        const written = await client.update(config.spreadsheetId, rangeOf(config.sheetName, `A${rowNumber}:${LAST_COLUMN}${rowNumber}`), row, signal);
        if (written.updatedRows !== 1) return fail('unconfirmed', 'Google did not confirm that the row was updated, so the correction is not known to be saved.');
        return { ok: true, status: 'updated', row: rowNumber };
      } catch (error) {
        if (error instanceof SheetsError) {
          this.logger.warn(`Save failed (${error.code})`);
          return fail(error.code, error.message);
        }
        this.logger.warn('Save failed (unexpected error)');
        return fail('error', 'The record could not be saved.');
      }
    });
  }

  /** A read-only check of everything a save depends on. It never writes to the sheet. */
  async test(): Promise<SheetsTestResult> {
    const steps: SheetsTestStep[] = [];
    const step = (name: string, ok: boolean, detail: string): boolean => {
      steps.push({ name, ok, detail });
      return ok;
    };
    const finish = (advice: string | null): SheetsTestResult => {
      const result: SheetsTestResult = { ok: steps.every((s) => s.ok), at: new Date(this.now()).toISOString(), steps, advice };
      this.store.recordTest(result);
      return result;
    };
    const config = this.store.config();
    if (!this.store.hasCredential()) {
      step('Service account key', false, 'No key is stored.');
      return finish('Paste the service account key file, then test again.');
    }
    const account = this.store.resolveCredential();
    if (!account) {
      step('Service account key', false, 'A key is stored but cannot be decrypted (AI_SECRETS_MASTER_KEY missing or changed).');
      return finish('Store the service account key again.');
    }
    step('Service account key', true, `Stored for ${account.clientEmail}`);
    try {
      this.target(config);
    } catch (error) {
      step('Spreadsheet settings', false, (error as Error).message);
      return finish('Enter the spreadsheet ID and tab name, save, then test again.');
    }
    try {
      const client = this.client();
      const info = await client.describe(config.spreadsheetId);
      step('Google sign-in and spreadsheet access', true, `Opened "${info.title}"`);
      if (!info.tabs.includes(config.sheetName)) {
        step('Tab', false, `There is no tab named "${config.sheetName}". Tabs: ${info.tabs.slice(0, 8).join(', ') || 'none'}.`);
        return finish('Create the tab or correct its name.');
      }
      step('Tab', true, `"${config.sheetName}" exists`);
      const first = (await client.read(config.spreadsheetId, rangeOf(config.sheetName, `A1:${LAST_COLUMN}1`)))[0] ?? [];
      if (first.every((c) => c.trim() === '')) step('Header row', true, 'The tab is empty: the header will be written with the first record.');
      else if (SHEET_COLUMNS.every((name, i) => (first[i] ?? '').trim() === name)) step('Header row', true, 'The header matches.');
      else {
        step('Header row', false, 'The first row holds something else, and existing data is never overwritten.');
        return finish('Use an empty tab, or one whose first row is the header shown below.');
      }
      step('Write access', true, 'Not checked: this test never writes to your sheet. The service account must be an Editor; the first record saved confirms it.');
      return finish(null);
    } catch (error) {
      const e = error instanceof SheetsError ? error : new SheetsError('error', 'The test failed unexpectedly.');
      step('Google sign-in and spreadsheet access', false, e.message);
      return finish(e.code === 'permission' || e.code === 'not_found' ? `Share the spreadsheet with ${account.clientEmail} as an Editor.` : null);
    }
  }
}
