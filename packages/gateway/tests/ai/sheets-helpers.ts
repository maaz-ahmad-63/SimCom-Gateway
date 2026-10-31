import crypto from 'node:crypto';
import type { FetchLike } from '../../src/ai/providers/http.js';
import { SettingsBackend } from '../../src/ai/settings.js';
import { SheetsService } from '../../src/integrations/google-sheets/service.js';
import { SheetsConfigStore } from '../../src/integrations/google-sheets/store.js';

export const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
export const MASTER = 'a-long-master-key-for-tests-only';
export const BOT_EMAIL = 'caller-bot@voice-project.iam.gserviceaccount.com';

const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
export { PRIVATE_KEY, PUBLIC_KEY };

/** A service account key file as Google issues it (the token_uri is hostile on purpose: it must never be used). */
export const serviceAccountJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'service_account', project_id: 'voice-project', private_key_id: 'abc123', private_key: PRIVATE_KEY, client_email: BOT_EMAIL, token_uri: 'https://evil.example/token', ...over });

export class MemoryBackend implements SettingsBackend {
  readonly values = new Map<string, string>();
  getSetting(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setSetting(key: string, value: string): void {
    this.values.set(key, value);
  }
  deleteSetting(key: string): void {
    this.values.delete(key);
  }
}

export interface GoogleCall {
  method: string;
  url: string;
  kind: 'token' | 'describe' | 'read' | 'append' | 'update';
  range?: string;
  body?: any;
  authorization?: string | null;
}

/**
 * A stateful stand-in for Google: the OAuth token endpoint and the Sheets values API over one in-memory tab. Nothing here reaches a
 * network. Failure modes are set per test (an HTTP error for the next call, or a write Google "accepts" without confirming).
 */
export class FakeGoogle {
  rows: string[][] = [];
  tabs = ['Calls'];
  title = 'Leads 2026';
  readonly calls: GoogleCall[] = [];
  assertions: string[] = [];
  /** HTTP error returned for the next matching call(s). */
  failures: Array<{ kind: GoogleCall['kind'] | 'any'; status: number; message?: string; times?: number }> = [];
  /** Answer writes with 200 but without the confirmation fields. */
  unconfirmedWrites = false;
  /** Delay (ms) before each Sheets call answers, to widen race windows. */
  delayMs = 0;

  readonly fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers as HeadersInit);
    const u = new URL(url);
    const body = typeof init?.body === 'string' && u.hostname !== 'oauth2.googleapis.com' ? JSON.parse(init.body) : init?.body;
    const respond = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (u.hostname === 'oauth2.googleapis.com') {
      this.calls.push({ method, url, kind: 'token' });
      const form = new URLSearchParams(String(body));
      this.assertions.push(form.get('assertion') ?? '');
      const failure = this.takeFailure('token');
      if (failure) return respond(failure.status, { error: 'invalid_grant', error_description: failure.message ?? 'Invalid JWT Signature.' });
      return respond(200, { access_token: 'ya29.fake-access-token-for-tests', expires_in: 3600, token_type: 'Bearer' });
    }
    if (u.hostname !== 'sheets.googleapis.com') throw new Error(`unexpected host ${u.hostname}`);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));

    const path = decodeURIComponent(u.pathname.replace('/v4/spreadsheets/', ''));
    const [id, ...rest] = path.split('/values/');
    const authorization = headers.get('authorization');
    if (id !== SHEET_ID) {
      this.calls.push({ method, url, kind: 'describe', authorization });
      return respond(404, { error: { message: 'Requested entity was not found.' } });
    }
    if (rest.length === 0) {
      this.calls.push({ method, url, kind: 'describe', authorization });
      const failure = this.takeFailure('describe');
      if (failure) return respond(failure.status, { error: { message: failure.message ?? 'The caller does not have permission' } });
      return respond(200, { properties: { title: this.title }, sheets: this.tabs.map((title) => ({ properties: { title } })) });
    }
    const target = rest[0];
    const append = target.endsWith(':append');
    const range = (append ? target.slice(0, -':append'.length) : target).replace(/^'.*?'!/, '');
    const kind: GoogleCall['kind'] = append ? 'append' : method === 'PUT' ? 'update' : 'read';
    this.calls.push({ method, url, kind, range, body, authorization });
    const failure = this.takeFailure(kind);
    if (failure) return respond(failure.status, { error: { message: failure.message ?? 'denied' } });

    if (kind === 'read') return respond(200, { range, majorDimension: 'ROWS', values: this.read(range) });
    const row = (body as { values: string[][] }).values[0];
    if (kind === 'append') {
      this.rows.push([...row]);
      const n = this.rows.length;
      return respond(200, this.unconfirmedWrites ? {} : { updates: { updatedRows: 1, updatedRange: `Calls!A${n}:L${n}` } });
    }
    const rowNumber = Number(/^A(\d+):/.exec(range)?.[1] ?? 0);
    while (this.rows.length < rowNumber) this.rows.push([]);
    this.rows[rowNumber - 1] = [...row];
    return respond(200, this.unconfirmedWrites ? {} : { updatedRows: 1, updatedRange: `Calls!${range}` });
  };

  private takeFailure(kind: GoogleCall['kind']) {
    const i = this.failures.findIndex((f) => f.kind === kind || f.kind === 'any');
    if (i === -1) return null;
    const f = this.failures[i];
    f.times = (f.times ?? 1) - 1;
    if (f.times <= 0) this.failures.splice(i, 1);
    return f;
  }

  private read(range: string): string[][] {
    if (range === 'A:A') {
      const col = this.rows.map((r) => (r[0] ? [r[0]] : []));
      while (col.length && col[col.length - 1].length === 0) col.pop();
      return col;
    }
    const single = /^A(\d+):L\d+$/.exec(range);
    if (single) {
      const row = this.rows[Number(single[1]) - 1];
      return row && row.some((c) => c !== '') ? [row] : [];
    }
    throw new Error(`unexpected range ${range}`);
  }

  count(kind: GoogleCall['kind']): number {
    return this.calls.filter((c) => c.kind === kind).length;
  }

  /** Data rows (everything under the header). */
  get dataRows(): string[][] {
    return this.rows.slice(1);
  }
}

/** A configured, enabled service over a fake Google. */
export function makeSheets(options: { enabled?: boolean; config?: Record<string, unknown>; google?: FakeGoogle } = {}) {
  const google = options.google ?? new FakeGoogle();
  const backend = new MemoryBackend();
  const store = new SheetsConfigStore(backend, MASTER);
  store.setCredential(serviceAccountJson());
  store.update({ spreadsheetId: SHEET_ID, sheetName: 'Calls', ...(options.config ?? {}) });
  if (options.enabled !== false) store.update({ enabled: true });
  const service = new SheetsService({ store, fetchImpl: google.fetch, now: () => Date.parse('2026-10-29T12:00:00.000Z') });
  return { google, backend, store, service };
}
