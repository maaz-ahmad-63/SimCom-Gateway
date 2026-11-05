import type { ColumnMapping } from './csv.js';

/**
 * Finding the contact name and phone columns of an arbitrary CSV. A campaign file may call them anything ("Hospital Name",
 * "Mobile Number", "Contact Number", "Telephone") and may carry any number of other columns, so nothing here depends on a fixed layout:
 *
 *  1. The header's wording decides first (a few tiers, from "Name" / "Phone" down to "<anything> Name" / "<anything> number").
 *  2. When no header gives it away, the VALUES decide (a column whose cells are mostly phone numbers).
 *  3. When more than one column is equally plausible, or the best guess is weak, the result is marked `ambiguous` and the person
 *     chooses; it is never silently guessed. A guess is only a suggestion either way: the operator confirms the mapping.
 *
 * Only the name and the phone are required. Everything else in the file is kept as custom fields by the import.
 */
export interface ColumnDetection {
  /** The best candidate (a suggestion to pre-select), or null when nothing in the file looks like it. */
  column: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Other plausible columns, most likely first. */
  candidates: string[];
  /** The person must choose: several equally plausible columns, a weak guess, or nothing found. */
  ambiguous: boolean;
  basis: 'header' | 'content' | 'none';
}

export interface DetectionResult {
  name: ColumnDetection;
  phone: ColumnDetection;
  /** Either required column needs the person's confirmation. */
  ambiguous: boolean;
  /** A ready-to-use mapping: the detected columns plus the optional fields (designation, company, notes, consent, opt-out) found by header. */
  mapping: Partial<ColumnMapping>;
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');

// ---- phone -----------------------------------------------------------------------------------------------------------------
const PHONE_PRIMARY = /^(phone|phone (number|no|num)|mobile|mobile (number|no|num|phone)|cell|cell (phone|number)|contact (number|no|num|phone)|tel|telephone|telephone (number|no)|msisdn|whatsapp( (number|no))?|number|primary (phone|mobile|number)|phone 1|mobile 1)$/;
const PHONE_WORD = /(phone|mobile|telephone|\btel\b|\bcell\b|whatsapp|msisdn|contact (number|no)|\bph\b)/;
const PHONE_SECONDARY = /(alt|alternate|alternative|secondary|other|second|office|work|home|landline|fax|emergency|reception|\b2\b|\btwo\b)/;

/** Whether a cell reads as a phone number: digits with the usual separators, 7 to 15 digits. Looks only; the import validates properly. */
export function looksLikePhone(value: string): boolean {
  const v = value.trim().replace(/^="?|"$/g, '');
  if (v === '' || /[^\d+\s().\-]/.test(v)) return false;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function phoneShare(rows: string[][], index: number): number {
  let filled = 0;
  let hits = 0;
  for (const row of rows.slice(0, 300)) {
    const cell = (row[index] ?? '').trim();
    if (cell === '') continue;
    filled++;
    if (looksLikePhone(cell)) hits++;
  }
  return filled === 0 ? 0 : hits / filled;
}

// ---- name ------------------------------------------------------------------------------------------------------------------
const NAME_PRIMARY = /^(name|full name|contact name|customer name|client name|person name|lead name|prospect name|patient name|doctor name|owner name|recipient|recipient name|contact person|display name)$/;
/** "<something> name" (Hospital Name, Business Name, Company Name ...), except the parts of a person's name and technical names. */
const NAME_COMPOUND = /^[a-z0-9][a-z0-9 ]* name$/;
const NAME_NOT_COMPOUND = /^(first|last|middle|sur|nick|user|file|sheet|host|domain|display|given|family|father|mother|spouse|maiden|brand|product|campaign|city|state|country|street|road|department|designation|job|alias|screen|login|account) ?name$/;
const NAME_PART = /^(first name|given name|forename|firstname)$/;
const NOT_A_NAME = /(email|e mail|mail|url|website|web|site|address|phone|mobile|tel|city|state|country|zip|pin|postal|date|time|id|status|notes?|comment|remark|consent|opt)/;

const PLACEHOLDER_NAME = /^(n\/?a|na|null|none|nil|unknown|-+|\.+|\?+|test|x+)$/i;

/** A name worth speaking: it has a letter or digit in it and is not a placeholder. */
export function isUsableName(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && /[\p{L}\p{N}]/u.test(v) && !PLACEHOLDER_NAME.test(v);
}

function nameShare(rows: string[][], index: number): number {
  let filled = 0;
  let hits = 0;
  for (const row of rows.slice(0, 300)) {
    const cell = (row[index] ?? '').trim();
    if (cell === '') continue;
    filled++;
    if (/\p{L}/u.test(cell) && !looksLikePhone(cell) && !/@/.test(cell) && !/^https?:\/\//i.test(cell) && cell.length <= 80) hits++;
  }
  return filled === 0 ? 0 : hits / filled;
}

const none = (): ColumnDetection => ({ column: null, confidence: 'none', candidates: [], ambiguous: true, basis: 'none' });

function pick(tier: string[], rest: string[], confidence: ColumnDetection['confidence']): ColumnDetection {
  return {
    column: tier[0],
    confidence: tier.length === 1 ? confidence : 'low',
    candidates: [...tier.slice(1), ...rest],
    ambiguous: tier.length > 1,
    basis: 'header',
  };
}

export function detectPhone(headers: string[], rows: string[][], exclude: Set<string> = new Set()): ColumnDetection {
  const idx = (h: string) => headers.indexOf(h);
  const available = headers.filter((h) => !exclude.has(h));
  const primary = available.filter((h) => PHONE_PRIMARY.test(norm(h)));
  const generic = available.filter((h) => !primary.includes(h) && PHONE_WORD.test(norm(h)) && !PHONE_SECONDARY.test(norm(h)));
  const secondary = available.filter((h) => !primary.includes(h) && !generic.includes(h) && PHONE_WORD.test(norm(h)));
  const bySpeed = (list: string[]) => [...list].sort((a, b) => phoneShare(rows, idx(b)) - phoneShare(rows, idx(a)));

  let found: ColumnDetection | null = null;
  if (primary.length > 0) found = pick(primary, [...generic, ...secondary], 'high');
  else if (generic.length > 0) found = pick(generic, secondary, 'high');
  else if (secondary.length > 0) found = { ...pick(bySpeed(secondary), [], 'medium'), confidence: secondary.length === 1 ? 'medium' : 'low' };

  const content = available
    .map((h) => ({ h, share: phoneShare(rows, idx(h)) }))
    .filter((c) => c.share >= 0.6)
    .sort((a, b) => b.share - a.share);

  if (found) {
    // The header says phone but the cells are not numbers, while another column is: let the person decide.
    const own = phoneShare(rows, idx(found.column as string));
    const better = content.find((c) => c.h !== found!.column);
    if (own < 0.3 && better) return { column: found.column, confidence: 'low', candidates: [better.h, ...found.candidates.filter((c) => c !== better.h)], ambiguous: true, basis: 'header' };
    return found;
  }
  if (content.length === 1) return { column: content[0].h, confidence: 'medium', candidates: [], ambiguous: false, basis: 'content' };
  if (content.length > 1) return { column: content[0].h, confidence: 'low', candidates: content.slice(1).map((c) => c.h), ambiguous: true, basis: 'content' };
  return none();
}

export function detectName(headers: string[], rows: string[][], exclude: Set<string> = new Set()): ColumnDetection {
  const idx = (h: string) => headers.indexOf(h);
  const available = headers.filter((h) => !exclude.has(h));
  const primary = available.filter((h) => NAME_PRIMARY.test(norm(h)));
  const compound = available.filter((h) => !primary.includes(h) && NAME_COMPOUND.test(norm(h)) && !NAME_NOT_COMPOUND.test(norm(h)) && !NAME_PART.test(norm(h)));
  const part = available.filter((h) => NAME_PART.test(norm(h)));
  if (primary.length > 0) return pick(primary, [...compound, ...part], 'high');
  if (compound.length > 0) return pick(compound, part, 'high');
  if (part.length > 0) return { column: part[0], confidence: 'low', candidates: part.slice(1), ambiguous: true, basis: 'header' };
  // No header says "name": offer the column whose cells look most like names, but always ask.
  const guess = available
    .filter((h) => !NOT_A_NAME.test(norm(h)))
    .map((h) => ({ h, share: nameShare(rows, idx(h)) }))
    .filter((c) => c.share >= 0.8)
    .sort((a, b) => b.share - a.share || idx(a.h) - idx(b.h));
  if (guess.length > 0) return { column: guess[0].h, confidence: 'low', candidates: guess.slice(1, 4).map((c) => c.h), ambiguous: true, basis: 'content' };
  return none();
}

const OPTIONAL: Record<'designation' | 'company' | 'context' | 'consent' | 'optOut', RegExp> = {
  designation: /^(designation|title|job title|role|position)$/,
  company: /^(company|company name|organi[sz]ation|employer|business|account)$/,
  context: /^(context|custom context|notes?|details|comments?|remarks?|talking points?)$/,
  consent: /^(consent|consent status|opt in|permission|permission to call)$/,
  optOut: /^(opt out|do not call|dnc|unsubscribed?|stop)$/,
};

/** Detect the two required columns, and fill the optional fields from their headers. */
export function detectColumns(headers: string[], rows: string[][]): DetectionResult {
  const phone = detectPhone(headers, rows);
  const name = detectName(headers, rows, new Set(phone.column ? [phone.column] : []));
  const mapping: Partial<ColumnMapping> = {};
  const used = new Set<string>();
  if (phone.column) {
    mapping.phone = phone.column;
    used.add(phone.column);
  }
  if (name.column) {
    mapping.name = name.column;
    used.add(name.column);
  }
  for (const key of Object.keys(OPTIONAL) as Array<keyof typeof OPTIONAL>) {
    const hit = headers.find((h) => !used.has(h) && OPTIONAL[key].test(norm(h)));
    if (hit) {
      mapping[key] = hit;
      used.add(hit);
    }
  }
  return { name, phone, ambiguous: name.ambiguous || phone.ambiguous, mapping };
}
