import { FetchLike, redactSecrets } from '../../ai/providers/http.js';
import { ServiceAccountAuth } from './auth.js';
import { SheetsError } from './types.js';

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const REQUEST_TIMEOUT_MS = 10_000;

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

/** A tab name is used inside A1 notation, so it is quoted; control characters and the characters Sheets forbids are refused. */
export function validSheetName(name: string): boolean {
  return name.length >= 1 && name.length <= 100 && !/[\u0000-\u001f[\]*?:/\\]/.test(name);
}

export const rangeOf = (sheetName: string, cells: string): string => `'${sheetName.replace(/'/g, "''")}'!${cells}`;

export interface ValuesResponse {
  values?: string[][];
}
export interface WriteResponse {
  updatedRows: number;
  updatedRange: string | null;
}

/** The few Sheets REST calls this integration needs. Each throws a SheetsError whose message says what to fix; none returns credentials. */
export class SheetsClient {
  constructor(
    private readonly auth: ServiceAccountAuth,
    private readonly fetchImpl: FetchLike
  ) {}

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const token = await this.auth.accessToken(signal);
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (signal?.aborted) throw new SheetsError('cancelled', 'The request was cancelled.', 499);
      throw new SheetsError('network', `Could not reach Google Sheets (${redactSecrets((error as Error).message ?? 'network error')}).`, 502);
    }
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return payload;
    const google = typeof payload?.error?.message === 'string' ? redactSecrets(payload.error.message).slice(0, 160) : '';
    if (response.status === 403 || response.status === 401) {
      throw new SheetsError('permission', `Google denied access (${google || response.status}). Share the spreadsheet with the service account's email as an Editor, and make sure the Google Sheets API is enabled.`, 502);
    }
    if (response.status === 404) throw new SheetsError('not_found', 'The spreadsheet was not found. Check the spreadsheet ID, and that it is shared with the service account.', 502);
    if (response.status === 429) throw new SheetsError('rate_limited', 'Google Sheets is rate limiting requests. Try again shortly.', 502);
    if (response.status === 400) throw new SheetsError('bad_request', `Google rejected the request (${google || 'bad request'}).`, 502);
    throw new SheetsError('google_error', `Google Sheets returned an error (${response.status}${google ? `: ${google}` : ''}).`, 502);
  }

  /** The spreadsheet's title and its tab names. Read-only. */
  async describe(spreadsheetId: string, signal?: AbortSignal): Promise<{ title: string; tabs: string[] }> {
    const data = await this.call('GET', `${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`, undefined, signal);
    return { title: String(data?.properties?.title ?? ''), tabs: (data?.sheets ?? []).map((s: any) => String(s?.properties?.title ?? '')) };
  }

  async read(spreadsheetId: string, range: string, signal?: AbortSignal): Promise<string[][]> {
    const data: ValuesResponse = await this.call('GET', `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, undefined, signal);
    return (data?.values ?? []).map((row) => row.map((c) => String(c ?? '')));
  }

  /** RAW: what is sent is stored as text, never parsed as a formula, a date or a number (a phone number keeps its leading zero). */
  async append(spreadsheetId: string, range: string, row: string[], signal?: AbortSignal): Promise<WriteResponse> {
    const data = await this.call(
      'POST',
      `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: [row] },
      signal
    );
    return { updatedRows: Number(data?.updates?.updatedRows ?? 0), updatedRange: typeof data?.updates?.updatedRange === 'string' ? data.updates.updatedRange : null };
  }

  async update(spreadsheetId: string, range: string, row: string[], signal?: AbortSignal): Promise<WriteResponse> {
    const data = await this.call('PUT', `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: [row] }, signal);
    return { updatedRows: Number(data?.updatedRows ?? 0), updatedRange: typeof data?.updatedRange === 'string' ? data.updatedRange : null };
  }
}
