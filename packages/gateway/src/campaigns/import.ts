import { ColumnMapping, ParsedCsv } from './csv.js';
import { cleanField, isReservedFieldKey } from './personalization.js';
import { normalizePhone } from './phone.js';
import { CampaignSettings, parseConsent, parseOptOut } from './policy.js';
import { ImportRow } from './store.js';

export interface AnalysisResult {
  rows: ImportRow[];
  summary: {
    total: number;
    callable: number;
    invalidNumber: number;
    duplicate: number;
    optedOut: number;
    doNotCall: number;
    consentDeclined: number;
    /** Callable now, but no consent value in the file: skipped at start unless consent is attested for the whole list. */
    consentUnknown: number;
  };
  /** The first problems, for the preview screen (never the full list of a 5000-row file). */
  problems: Array<{ rowNumber: number; reason: string }>;
}

export function validateMapping(headers: string[], mapping: ColumnMapping): string[] {
  const errors: string[] = [];
  const known = new Set(headers);
  if (!mapping.phone) errors.push('choose the column that holds the phone number');
  const named: Array<[string, string | undefined]> = [
    ['phone', mapping.phone],
    ['name', mapping.name],
    ['designation', mapping.designation],
    ['company', mapping.company],
    ['context', mapping.context],
    ['consent', mapping.consent],
    ['opt-out', mapping.optOut],
  ];
  for (const [label, column] of named) if (column && !known.has(column)) errors.push(`the ${label} column "${column}" is not in the file`);
  for (const column of mapping.extra ?? []) {
    if (!known.has(column)) errors.push(`the extra column "${column}" is not in the file`);
    else if (isReservedFieldKey(column)) errors.push(`the extra column "${column}" uses a name reserved for the agent's own context fields or instructions: rename the column in the file`);
  }
  const chosen = named.map(([, c]) => c).filter((c): c is string => !!c);
  if (new Set(chosen).size !== chosen.length) errors.push('each column can only be used for one field');
  return errors;
}

/**
 * Turn parsed CSV rows into contacts, deciding for each whether it can ever be called. This only reads: no database access
 * other than the do-not-call lookup the caller supplies, and nothing dials.
 */
export function analyzeRows(csv: ParsedCsv, mapping: ColumnMapping, settings: Pick<CampaignSettings, 'defaultCountryCode' | 'consentMode'>, isDoNotCall: (e164: string) => boolean): AnalysisResult {
  const index = new Map(csv.headers.map((h, i) => [h, i]));
  const cell = (row: string[], column: string | undefined): string => (column ? (row[index.get(column) ?? -1] ?? '') : '');
  const summary = { total: csv.rows.length, callable: 0, invalidNumber: 0, duplicate: 0, optedOut: 0, doNotCall: 0, consentDeclined: 0, consentUnknown: 0 };
  const problems: AnalysisResult['problems'] = [];
  const seen = new Map<string, number>();
  const rows: ImportRow[] = [];
  const note = (rowNumber: number, reason: string) => {
    if (problems.length < 100) problems.push({ rowNumber, reason });
  };

  csv.rows.forEach((row, i) => {
    const rowNumber = i + 2; // the file's own row number: the header is row 1
    const phoneRaw = cell(row, mapping.phone);
    const phone = normalizePhone(phoneRaw, settings.defaultCountryCode);
    const extra: Record<string, string> = {};
    for (const column of mapping.extra ?? []) {
      const value = cleanField(cell(row, column), 200);
      if (value) extra[column] = value;
    }
    const base = {
      rowNumber,
      name: cleanField(cell(row, mapping.name), 80),
      phoneRaw: phoneRaw.slice(0, 40),
      designation: cleanField(cell(row, mapping.designation), 80),
      company: cleanField(cell(row, mapping.company), 120),
      context: cleanField(cell(row, mapping.context), 600),
      extra,
      consent: parseConsent(cell(row, mapping.consent)),
      optOut: parseOptOut(cell(row, mapping.optOut)),
    };
    const skip = (reason: string, e164: string | null, counter: keyof typeof summary): void => {
      summary[counter]++;
      note(rowNumber, reason);
      rows.push({ ...base, phoneE164: e164, status: 'skipped', skipReason: reason });
    };

    if (!phone.ok) return skip(phone.reason, null, 'invalidNumber');
    const firstRow = seen.get(phone.e164);
    if (firstRow !== undefined) return skip(`duplicate of row ${firstRow}`, null, 'duplicate'); // a second copy is never queued
    seen.set(phone.e164, rowNumber);
    if (base.optOut) return skip('opted out (marked in the file)', phone.e164, 'optedOut');
    if (isDoNotCall(phone.e164)) return skip('on the do-not-call list', phone.e164, 'doNotCall');
    if (base.consent === 'no') return skip('consent declined or withdrawn', phone.e164, 'consentDeclined');
    if (base.consent === 'unknown') summary.consentUnknown++;
    summary.callable++;
    rows.push({ ...base, phoneE164: phone.e164, status: 'queued', skipReason: null });
  });
  return { rows, summary, problems };
}
