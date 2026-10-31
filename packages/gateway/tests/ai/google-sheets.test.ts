import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseServiceAccount } from '../../src/integrations/google-sheets/auth.js';
import { recordProblem, toRow } from '../../src/integrations/google-sheets/service.js';
import { SheetsConfigStore } from '../../src/integrations/google-sheets/store.js';
import { SHEET_COLUMNS, SheetRecord } from '../../src/integrations/google-sheets/types.js';
import { BOT_EMAIL, FakeGoogle, makeSheets, MASTER, MemoryBackend, PRIVATE_KEY, PUBLIC_KEY, SHEET_ID, serviceAccountJson } from './sheets-helpers.js';

const record = (over: Partial<SheetRecord> = {}): SheetRecord => ({
  key: 'call:abc:contact',
  type: 'contact',
  recordedAt: '2026-10-29T12:00:00.000Z',
  callId: 'abc',
  campaignId: null,
  contactId: null,
  direction: 'inbound',
  name: 'Maza',
  phone: '9876543210',
  email: 'maza@outlook.com',
  outcome: null,
  detail: null,
  ...over,
});

describe('the service account key: validated, encrypted at rest, never shown', () => {
  it('accepts a real key file and keeps only the email and the private key', () => {
    expect(parseServiceAccount(serviceAccountJson())).toEqual({ clientEmail: BOT_EMAIL, privateKey: PRIVATE_KEY.trim() });
  });

  it.each([
    ['not JSON', 'hello'],
    ['empty', '   '],
    ['an OAuth client file', JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } })],
    ['a wrong type', serviceAccountJson({ type: 'authorized_user' })],
    ['no email', serviceAccountJson({ client_email: '' })],
    ['a bad email', serviceAccountJson({ client_email: 'not-an-email' })],
    ['no private key', serviceAccountJson({ private_key: '' })],
    ['a private key that is not a key', serviceAccountJson({ private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' })],
    ['an oversized file', 'x'.repeat(25_000)],
  ])('rejects %s', (_label, text) => {
    expect(() => parseServiceAccount(text)).toThrow(/.+/);
  });

  it('stores the key encrypted: the settings table holds neither the key nor the account email', () => {
    const { backend, store } = makeSheets();
    const stored = [...backend.values.entries()].filter(([k]) => k.includes('credential'));
    expect(stored).toHaveLength(1);
    expect(stored[0][1]).not.toContain('PRIVATE KEY');
    expect(stored[0][1]).not.toContain(BOT_EMAIL);
    expect(stored[0][1]).toMatch(/^v1:/); // the same envelope as the AI provider keys
    expect(store.resolveCredential()).toEqual({ clientEmail: BOT_EMAIL, privateKey: PRIVATE_KEY.trim() });
  });

  it('the status shown to the dashboard has no key, no token and no key file text', () => {
    const { store, google, service } = makeSheets();
    void google;
    void service;
    const text = JSON.stringify(store.status());
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(crypto.createHash('sha256').update(PRIVATE_KEY).digest('hex'));
    expect(text).not.toMatch(/abc123/); // the key id inside the file
    expect(store.status().credential).toEqual({ stored: true, serviceAccountEmail: BOT_EMAIL, undecryptable: false });
  });

  it('without a master key a credential cannot be stored (409), and nothing is written', () => {
    const backend = new MemoryBackend();
    const store = new SheetsConfigStore(backend, undefined);
    expect(() => store.setCredential(serviceAccountJson())).toThrow(/AI_SECRETS_MASTER_KEY/);
    expect(backend.values.size).toBe(0);
  });

  it('a stored key that can no longer be decrypted is reported, not used', () => {
    const { backend } = makeSheets();
    const other = new SheetsConfigStore(backend, 'a-different-master-key-1234');
    expect(other.resolveCredential()).toBeNull();
    expect(other.status().credential).toMatchObject({ stored: true, undecryptable: true, serviceAccountEmail: null });
  });

  it('turning it on needs a key and a spreadsheet; removing the key turns it off', () => {
    const store = new SheetsConfigStore(new MemoryBackend(), MASTER);
    expect(() => store.update({ enabled: true })).toThrow(/spreadsheet ID/);
    store.update({ spreadsheetId: SHEET_ID });
    expect(() => store.update({ enabled: true })).toThrow(/service account key/);
    store.setCredential(serviceAccountJson());
    expect(store.update({ enabled: true }).enabled).toBe(true);
    store.deleteCredential();
    expect(store.config().enabled).toBe(false);
    expect(store.hasCredential()).toBe(false);
  });

  it('settings are validated: a pasted URL is not an ID, unknown fields and odd tab names are refused', () => {
    const store = new SheetsConfigStore(new MemoryBackend(), MASTER);
    expect(() => store.update({ spreadsheetId: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` })).toThrow(/ID from the sheet URL/);
    expect(() => store.update({ spreadsheetId: 'short' })).toThrow();
    expect(() => store.update({ sheetName: 'a/b' })).toThrow(/tab name/);
    expect(() => store.update({ sheetName: 'x'.repeat(101) })).toThrow();
    expect(() => store.update({ privateKey: 'nope' })).toThrow();
  });
});

describe('signing in to Google', () => {
  it('sends a correctly signed JWT to Google\'s own token endpoint, never to the file\'s token_uri, and reuses the token', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record());
    await service.saveRecord(record({ key: 'call:two:contact', callId: 'two' }));
    expect(google.count('token')).toBe(1); // cached until a minute before it expires
    expect(google.calls.filter((c) => c.kind === 'token').every((c) => c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
    const [head, claims, signature] = google.assertions[0].split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect(payload).toMatchObject({ iss: BOT_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token' });
    expect(crypto.createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(PUBLIC_KEY, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(google.calls.filter((c) => c.kind !== 'token').every((c) => c.authorization === 'Bearer ya29.fake-access-token-for-tests')).toBe(true);
  });

  it('a rejected sign-in is reported with Google\'s reason and without the key or the token', async () => {
    const { google, service } = makeSheets();
    google.failures.push({ kind: 'token', status: 400, message: 'Invalid JWT Signature.' });
    const result = await service.saveRecord(record());
    expect(result).toMatchObject({ ok: false, code: 'auth_failed' });
    const text = JSON.stringify(result);
    expect(text).toMatch(/invalid_grant/);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('ya29');
    expect(google.rows).toHaveLength(0);
  });
});

describe('connection test: read-only, step by step', () => {
  it('passes on a ready sheet without writing anything, and says it did not check write access', async () => {
    const { google, service, store } = makeSheets();
    const result = await service.test();
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(['Service account key', 'Google sign-in and spreadsheet access', 'Tab', 'Header row', 'Write access']);
    expect(result.steps.find((s) => s.name === 'Header row')?.detail).toMatch(/will be written/);
    expect(result.steps.find((s) => s.name === 'Write access')?.detail).toMatch(/never writes/);
    expect(google.count('append') + google.count('update')).toBe(0);
    expect(google.rows).toHaveLength(0);
    expect(store.lastTest()).toEqual(result);
  });

  it('names the problem and the fix: no key, wrong sheet, missing tab, a sheet that is not shared, a foreign header', async () => {
    const noKey = new SheetsConfigStore(new MemoryBackend(), MASTER);
    const { SheetsService } = await import('../../src/integrations/google-sheets/service.js');
    expect((await new SheetsService({ store: noKey }).test()).advice).toMatch(/Paste the service account key/);

    const noTab = makeSheets({ config: { sheetName: 'Leads' } });
    const missing = await noTab.service.test();
    expect(missing.ok).toBe(false);
    expect(missing.steps.at(-1)?.detail).toMatch(/no tab named "Leads"/);

    const denied = makeSheets();
    denied.google.failures.push({ kind: 'describe', status: 403, message: 'The caller does not have permission' });
    const refused = await denied.service.test();
    expect(refused.ok).toBe(false);
    expect(refused.advice).toBe(`Share the spreadsheet with ${BOT_EMAIL} as an Editor.`);

    const foreign = makeSheets();
    foreign.google.rows = [['Name', 'Phone'], ['Existing', '123']];
    const mismatch = await foreign.service.test();
    expect(mismatch.ok).toBe(false);
    expect(mismatch.steps.at(-1)?.detail).toMatch(/never overwritten/);
    expect(foreign.google.rows).toEqual([['Name', 'Phone'], ['Existing', '123']]);
  });
});

describe('saving records: validated, deduplicated, corrected, and confirmed by Google', () => {
  it('writes the header on an empty tab, then the row; reports created only after Google confirmed', async () => {
    const { google, service } = makeSheets();
    const result = await service.saveRecord(record());
    expect(result).toEqual({ ok: true, status: 'created', row: 2 });
    expect(google.rows[0]).toEqual([...SHEET_COLUMNS]);
    expect(google.rows[1]).toEqual(['call:abc:contact', '2026-10-29T12:00:00.000Z', 'contact', 'abc', '', '', 'inbound', 'Maza', '9876543210', 'maza@outlook.com', '', '']);
    expect(google.calls.filter((c) => c.kind === 'append').every((c) => c.url.includes('valueInputOption=RAW'))).toBe(true); // text, never a formula or a number
  });

  it('saving the same details again changes nothing and adds no row', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record());
    const again = await service.saveRecord(record({ recordedAt: '2026-10-29T12:05:00.000Z' }));
    expect(again).toEqual({ ok: true, status: 'unchanged', row: 2 });
    expect(google.dataRows).toHaveLength(1);
    expect(google.count('append')).toBe(1);
    expect(google.dataRows[0][1]).toBe('2026-10-29T12:00:00.000Z'); // the first write's time is kept
  });

  it('a correction updates the same row instead of adding another', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record());
    const fixed = await service.saveRecord(record({ email: 'maza.k@outlook.com', recordedAt: '2026-10-29T12:06:00.000Z' }));
    expect(fixed).toEqual({ ok: true, status: 'updated', row: 2 });
    expect(google.dataRows).toHaveLength(1);
    expect(google.dataRows[0][9]).toBe('maza.k@outlook.com');
    expect(google.dataRows[0][1]).toBe('2026-10-29T12:06:00.000Z');
  });

  it('a later save for the same contact adds what it knows and keeps what was confirmed earlier', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record({ phone: null, email: null }));
    await service.saveRecord(record({ name: null, email: null }));
    await service.saveRecord(record({ name: null, phone: null }));
    expect(google.dataRows).toHaveLength(1);
    expect(google.dataRows[0].slice(7, 10)).toEqual(['Maza', '9876543210', 'maza@outlook.com']);
  });

  it('different calls and different contacts are different rows', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record());
    await service.saveRecord(record({ key: 'call:def:contact', callId: 'def', name: 'Ravi' }));
    await service.saveRecord(record({ key: 'campaign:c1:7:contact', callId: 'ghi', campaignId: 'c1', contactId: 7, direction: 'outbound' }));
    expect(google.dataRows.map((r) => r[0])).toEqual(['call:abc:contact', 'call:def:contact', 'campaign:c1:7:contact']);
  });

  it('two saves racing for the same key produce one row', async () => {
    const { google, service } = makeSheets();
    google.delayMs = 5;
    const results = await Promise.all([service.saveRecord(record()), service.saveRecord(record()), service.saveRecord(record({ phone: '9123456780' }))]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(google.dataRows).toHaveLength(1);
  });

  it('is NOT reported as saved when Google does not confirm the write', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record({ key: 'call:setup:contact', callId: 'setup' })); // header and a first row exist
    google.unconfirmedWrites = true;
    const result = await service.saveRecord(record({ key: 'call:new:contact', callId: 'new' }));
    expect(result).toMatchObject({ ok: false, code: 'unconfirmed' });
    expect((result as { message: string }).message).toMatch(/not known to be saved/);
  });

  it('is NOT reported as saved when Google answers with an error; the reason names the fix and exposes nothing', async () => {
    const cases: Array<[number, RegExp, string]> = [
      [403, /Share the spreadsheet with the service account/, 'permission'],
      [404, /spreadsheet was not found/, 'not_found'],
      [429, /rate limiting/, 'rate_limited'],
      [500, /returned an error \(500/, 'google_error'],
    ];
    for (const [status, message, code] of cases) {
      const { google, service } = makeSheets();
      google.failures.push({ kind: 'read', status });
      const result = await service.saveRecord(record());
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe(code);
      expect((result as { message: string }).message).toMatch(message);
      expect(JSON.stringify(result)).not.toContain('ya29');
    }
  });

  it('a network failure is a failure, and the retry afterwards cannot duplicate the row', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record({ key: 'call:warm:contact', callId: 'warm' }));
    const real = google.fetch;
    let drop = true;
    const flaky = { ...google, fetch: (async (url: string, init?: RequestInit) => {
      if (drop && url.includes(':append')) {
        drop = false;
        await real(url, init); // Google wrote the row, but the answer never arrived
        throw new Error('socket hang up');
      }
      return real(url, init);
    }) as typeof real };
    const { SheetsService } = await import('../../src/integrations/google-sheets/service.js');
    const svc = new SheetsService({ store: (service as unknown as { options: { store: SheetsConfigStore } }).options.store, fetchImpl: flaky.fetch });
    const first = await svc.saveRecord(record());
    expect(first).toMatchObject({ ok: false, code: 'network' });
    const second = await svc.saveRecord(record());
    expect(second).toMatchObject({ ok: true, status: 'unchanged' });
    expect(google.dataRows.filter((r) => r[0] === 'call:abc:contact')).toHaveLength(1);
  });

  it('refuses to write into a tab that already holds something else', async () => {
    const { google, service } = makeSheets();
    google.rows = [['Name', 'Phone'], ['Existing', '123']];
    const result = await service.saveRecord(record());
    expect(result).toMatchObject({ ok: false, code: 'header_mismatch' });
    expect(google.rows).toEqual([['Name', 'Phone'], ['Existing', '123']]);
  });

  it('does nothing while switched off, and never contacts Google', async () => {
    const { google, service } = makeSheets({ enabled: false });
    expect(await service.saveRecord(record())).toMatchObject({ ok: false, code: 'disabled' });
    expect(google.calls).toHaveLength(0);
  });
});

describe('validation before anything is written', () => {
  it.each([
    ['a short phone number', { phone: '12345' }, /7 to 15 digits/],
    ['letters in a phone number', { phone: '98765abcde' }, /7 to 15 digits/],
    ['an email without a domain', { email: 'maza@' }, /not valid/],
    ['an email with spaces', { email: 'ma za@outlook.com' }, /not valid/],
    ['an over-long name', { name: 'x'.repeat(81) }, /1 to 80/],
    ['nothing to save', { name: null, phone: null, email: null }, /nothing to save/],
    ['no key', { key: '' }, /no valid key/],
    ['no call id', { callId: '' }, /no call id/],
    ['a bad time', { recordedAt: 'yesterday' }, /valid time/],
  ])('refuses %s, with no request to Google', async (_label, over, message) => {
    const { google, service } = makeSheets();
    const result = await service.saveRecord(record(over as Partial<SheetRecord>));
    expect(result).toMatchObject({ ok: false, code: 'invalid_record' });
    expect((result as { message: string }).message).toMatch(message);
    expect(google.calls).toHaveLength(0);
  });

  it('an outcome needs an outcome; a contact needs a detail', () => {
    expect(recordProblem(record({ type: 'outcome', name: null, phone: null, email: null, outcome: null }))).toMatch(/outcome is missing/);
    expect(recordProblem(record({ type: 'outcome', name: null, phone: null, email: null, outcome: 'answered' }))).toBeNull();
  });

  it('keeps formula-looking text inert and strips control characters; absent details stay empty cells', () => {
    const row = toRow(record({ name: '=HYPERLINK("http://evil")', detail: '@SUM(1)\u0007\nline', phone: null, email: null }));
    expect(row[7]).toBe(`'=HYPERLINK("http://evil")`);
    expect(row[11]).toBe(`'@SUM(1) line`);
    expect(row[8]).toBe('');
    expect(row[9]).toBe('');
  });

  it('normalises what is written: the phone has no spaces, the email is lower case, and nothing is invented', async () => {
    const { google, service } = makeSheets();
    await service.saveRecord(record({ phone: '98765 43210', email: 'Maza@Outlook.com', name: '  Maza   K  ' }));
    expect(google.dataRows[0].slice(7, 10)).toEqual(['Maza K', '9876543210', 'maza@outlook.com']);
  });
});
