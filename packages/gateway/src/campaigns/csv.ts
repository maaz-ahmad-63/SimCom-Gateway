/**
 * A small, strict CSV reader (RFC 4180: quoted fields, doubled quotes, CRLF/LF/CR, a UTF-8 BOM) with hard limits, because
 * the text arrives from a browser upload. It only parses: nothing here reads a file, touches the database or dials.
 */
export const CSV_LIMITS = { maxChars: 900_000, maxRows: 5000, maxColumns: 40, maxCellChars: 2000 } as const;

export interface ParsedCsv {
  delimiter: ',' | ';' | '\t';
  headers: string[];
  /** Data rows, each padded or trimmed to the header count. */
  rows: string[][];
  /** Row-level notes (ragged rows, an unterminated quote). The file is still usable unless `fatal` is set. */
  warnings: string[];
  fatal: string | null;
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let best: ',' | ';' | '\t' = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t'] as const) {
    let inQuotes = false;
    let count = 0;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(input: string): ParsedCsv {
  const empty = (fatal: string): ParsedCsv => ({ delimiter: ',', headers: [], rows: [], warnings: [], fatal });
  if (typeof input !== 'string' || input.trim() === '') return empty('the file is empty');
  if (input.length > CSV_LIMITS.maxChars) return empty(`the file is larger than ${Math.round(CSV_LIMITS.maxChars / 1000)} KB`);
  const text = input.replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);

  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let quoted = false;
  const warnings: string[] = [];
  const endCell = () => {
    row.push(cell.length > CSV_LIMITS.maxCellChars ? cell.slice(0, CSV_LIMITS.maxCellChars) : cell);
    cell = '';
    quoted = false;
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0].trim() === '')) records.push(row); // a blank line is not a record
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '' && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (ch === delimiter) endCell();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') endRow();
    else cell += ch;
    if (records.length > CSV_LIMITS.maxRows + 1) return empty(`more than ${CSV_LIMITS.maxRows} rows`);
  }
  if (inQuotes) warnings.push('a quoted value was never closed; the rest of the file was read as part of it');
  if (cell !== '' || row.length > 0) endRow();

  if (records.length === 0) return empty('the file has no rows');
  const rawHeaders = records[0].map((h) => h.trim());
  if (rawHeaders.length > CSV_LIMITS.maxColumns) return empty(`more than ${CSV_LIMITS.maxColumns} columns`);
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, i) => {
    const base = h === '' ? `column_${i + 1}` : h;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base}_${n}`;
  });

  const rows: string[][] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.length !== headers.length) warnings.push(`row ${r + 1} has ${rec.length} value(s) but the header has ${headers.length}`);
    rows.push(headers.map((_, c) => (rec[c] ?? '').trim()));
  }
  if (rows.length === 0) return { delimiter, headers, rows, warnings, fatal: 'the file has a header but no contacts' };
  return { delimiter, headers, rows, warnings: warnings.slice(0, 50), fatal: null };
}

export interface ColumnMapping {
  phone: string;
  name?: string;
  designation?: string;
  company?: string;
  context?: string;
  consent?: string;
  optOut?: string;
  /** Other columns to pass to the agent as labelled fields. */
  extra?: string[];
}

const GUESSES: Record<Exclude<keyof ColumnMapping, 'extra'>, RegExp> = {
  phone: /^(phone|phone[ _-]?(number|no)|mobile|mobile[ _-]?(number|no)|cell|cell[ _-]?phone|contact[ _-]?(number|no)|number|msisdn|tel|telephone)$/i,
  name: /^(name|full[ _-]?name|contact[ _-]?name|first[ _-]?name|customer|customer[ _-]?name)$/i,
  designation: /^(designation|title|job[ _-]?title|role|position)$/i,
  company: /^(company|company[ _-]?name|organi[sz]ation|employer|business|account)$/i,
  context: /^(context|custom[ _-]?context|notes?|details|comments?|remarks?|talking[ _-]?points?)$/i,
  consent: /^(consent|consent[ _-]?status|opt[ _-]?in|permission|permission[ _-]?to[ _-]?call)$/i,
  optOut: /^(opt[ _-]?out|do[ _-]?not[ _-]?call|dnc|unsubscribe[d]?|stop)$/i,
};

/** Best guess of which column is which, from the header names. Only a suggestion: the operator confirms it. */
export function suggestMapping(headers: string[]): Partial<ColumnMapping> {
  const out: Partial<ColumnMapping> = {};
  const used = new Set<string>();
  for (const key of Object.keys(GUESSES) as Array<keyof typeof GUESSES>) {
    const hit = headers.find((h) => !used.has(h) && GUESSES[key].test(h.trim()));
    if (hit) {
      out[key] = hit;
      used.add(hit);
    }
  }
  return out;
}
