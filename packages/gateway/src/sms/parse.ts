/**
 * Parsing and validation for SMS text mode on a SIM7600. Pure functions: no modem access, so every rule here is tested
 * with literal modem output.
 */

export type SmsStatus = 'REC UNREAD' | 'REC READ' | 'STO UNSENT' | 'STO SENT' | 'ALL';

export interface SmsMessage {
  /** Index in the current storage (AT+CPMS?). */
  index: number;
  /** As the modem reports it: REC UNREAD, REC READ, STO UNSENT, STO SENT. */
  status: string;
  direction: 'received' | 'sent' | 'unknown';
  /** Sender (received) or destination (stored sent message). */
  address: string | null;
  /** Service-centre timestamp as an ISO string with the offset the network gave; the raw text if it could not be read. */
  timestamp: string | null;
  text: string;
}

/** Split one line of modem output on commas, honouring double quotes (a timestamp contains a comma). */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** With AT+CSCS="UCS2" the modem reports addresses and text as hex UCS-2; anything else is returned unchanged. */
export function decodeUcs2Hex(value: string): string {
  if (!/^(?:[0-9A-Fa-f]{4})+$/.test(value)) return value;
  let out = '';
  for (let i = 0; i < value.length; i += 4) out += String.fromCharCode(parseInt(value.slice(i, i + 4), 16));
  return out;
}

/** "26/10/27,18:00:00+22" (yy/MM/dd,hh:mm:ss and the offset from UTC in quarter hours) to ISO 8601 with that offset. */
export function parseScts(raw: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})$/.exec(raw.trim());
  if (!m) return raw;
  const [, yy, mo, dd, hh, mi, ss, sign, quarters] = m;
  const minutes = Number(quarters) * 15;
  const offset = `${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return `20${yy}-${mo}-${dd}T${hh}:${mi}:${ss}${offset}`;
}

function directionOf(status: string): SmsMessage['direction'] {
  if (status.startsWith('REC')) return 'received';
  if (status.startsWith('STO')) return 'sent';
  return 'unknown';
}

function build(index: number, fields: string[], text: string, charset: string | null): SmsMessage {
  const ucs2 = charset === 'UCS2';
  const status = fields[0] ?? '';
  const address = fields[1] ? (ucs2 ? decodeUcs2Hex(fields[1]) : fields[1]) : null;
  const scts = fields[3] ? parseScts(fields[3]) : null;
  return { index, status, direction: directionOf(status), address, timestamp: scts, text: ucs2 ? decodeUcs2Hex(text) : text };
}

/** The lines of a response without its final OK (the queue appends one on success). */
function bodyLines(response: string): string[] {
  const lines = response.split('\n');
  if (lines.length > 0 && lines[lines.length - 1].trim() === 'OK') lines.pop();
  return lines;
}

/**
 * AT+CMGL="ALL" in text mode:
 *   +CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"
 *   message text (possibly several lines)
 * `+CMGL:` marks the start of each message, so a text line is never mistaken for one unless it begins with `+CMGL:`.
 */
export function parseCmgl(response: string, charset: string | null = null): SmsMessage[] {
  const messages: SmsMessage[] = [];
  let header: { index: number; fields: string[] } | null = null;
  let text: string[] = [];
  const flush = () => {
    if (header) messages.push(build(header.index, header.fields, text.join('\n'), charset));
    header = null;
    text = [];
  };
  for (const line of bodyLines(response)) {
    const m = /^\+CMGL:\s*(.*)$/.exec(line);
    if (m) {
      flush();
      const fields = parseCsvLine(m[1]);
      const index = Number(fields[0]);
      if (Number.isInteger(index)) header = { index, fields: fields.slice(1) };
    } else if (header) {
      text.push(line);
    }
  }
  flush();
  return messages;
}

/** AT+CMGR=<index> in text mode: one `+CMGR:` header (no index in it) and the text. Null when there is no message. */
export function parseCmgr(response: string, index: number, charset: string | null = null): SmsMessage | null {
  const lines = bodyLines(response);
  const at = lines.findIndex((l) => l.startsWith('+CMGR:'));
  if (at === -1) return null;
  const fields = parseCsvLine(lines[at].replace(/^\+CMGR:\s*/, ''));
  return build(index, fields, lines.slice(at + 1).join('\n'), charset);
}

export function parseCmgf(response: string): number | null {
  const m = /\+CMGF:\s*(\d)/.exec(response);
  return m ? Number(m[1]) : null;
}

export function parseCscs(response: string): string | null {
  const m = /\+CSCS:\s*"([^"]*)"/.exec(response);
  return m ? m[1].toUpperCase() : null;
}

/** The service-centre number; '' when the modem reports none; null when the reply was not understood. */
export function parseCsca(response: string): string | null {
  const m = /\+CSCA:\s*"([^"]*)"/.exec(response);
  return m ? m[1] : null;
}

export interface Csmp {
  /** First octet of an SMS-SUBMIT. */
  fo: number;
  /** Validity period: a number (relative format) or the text the modem gave (absolute / enhanced formats). */
  vp: number | string;
  pid: number;
  dcs: number;
}

export function parseCsmp(response: string): Csmp | null {
  const m = /\+CSMP:\s*(.*)$/m.exec(response);
  if (!m) return null;
  const f = parseCsvLine(m[1]);
  const fo = Number(f[0]);
  const pid = Number(f[2] ?? 0);
  const dcs = Number(f[3] ?? 0);
  if (![fo, pid, dcs].every(Number.isFinite) || f[0] === '') return null;
  const vp: number | string = f[1] !== undefined && f[1] !== '' && /^\d+$/.test(f[1]) ? Number(f[1]) : (f[1] ?? '');
  return { fo, vp, pid, dcs };
}

/**
 * The standard text-mode parameters: first octet 17 (SMS-SUBMIT, relative validity period), validity 167 (one day),
 * protocol id 0, data coding scheme 0 (plain GSM text). The only value the gateway ever writes to AT+CSMP, and only on
 * an explicit, authorized request.
 */
export const STANDARD_CSMP: Csmp = { fo: 17, vp: 167, pid: 0, dcs: 0 };
export const STANDARD_CSMP_COMMAND = 'AT+CSMP=17,167,0,0';

export const csmpEquals = (a: Csmp, b: Csmp): boolean => a.fo === b.fo && String(a.vp) === String(b.vp) && a.pid === b.pid && a.dcs === b.dcs;

/**
 * Whether AT+CSMP? describes a valid text-mode SMS-SUBMIT. Only combinations that are definitely wrong block a send;
 * anything merely unusual is a warning. This is the check that explains "+CMS ERROR: Invalid text mode parameter" before
 * it happens instead of guessing after it.
 */
export function checkCsmp(csmp: Csmp): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if ((csmp.fo & 0x03) !== 1) blocking.push(`AT+CSMP first octet ${csmp.fo} is not an SMS-SUBMIT (its low two bits must be 01)`);
  const vpf = csmp.fo & 0x18;
  if (vpf === 0x10 && (typeof csmp.vp !== 'number' || csmp.vp < 0 || csmp.vp > 255)) {
    blocking.push(`AT+CSMP first octet ${csmp.fo} says the validity period is relative, but it is '${csmp.vp}' (it must be a number 0-255)`);
  }
  if ((vpf === 0x18 || vpf === 0x08) && typeof csmp.vp === 'number') {
    warnings.push(`AT+CSMP first octet ${csmp.fo} says the validity period is absolute/enhanced, but it is the number ${csmp.vp}`);
  }
  if (csmp.dcs >= 0 && csmp.dcs <= 0x3f && ((csmp.dcs >> 2) & 0x03) === 3) {
    blocking.push(`AT+CSMP data coding scheme ${csmp.dcs} uses a reserved alphabet`);
  } else if ((csmp.dcs & 0xf0) === 0xf0 && (csmp.dcs & 0x04) !== 0) {
    // Coding group 1111: bit 2 set means 8-bit data, and the low two bits are the message class (class 2 = SIM-specific).
    blocking.push(`AT+CSMP data coding scheme ${csmp.dcs} is 8-bit data, class ${csmp.dcs & 0x03}${(csmp.dcs & 0x03) === 2 ? ' (SIM-specific)' : ''}, not plain text (0 is plain GSM text)`);
  } else if (csmp.dcs === 8 || csmp.dcs === 4) {
    warnings.push(`AT+CSMP data coding scheme ${csmp.dcs} means ${csmp.dcs === 8 ? 'UCS-2' : '8-bit data'}; this endpoint sends plain GSM/ASCII text`);
  }
  return { blocking, warnings };
}

export interface CpmsStorage {
  name: string;
  used: number;
  total: number;
}

/** +CPMS: "ME",12,100,"ME",12,100,"ME",12,100  (read, write and receive storage). */
export function parseCpms(response: string): { read: CpmsStorage; write: CpmsStorage; receive: CpmsStorage } | null {
  const m = /\+CPMS:\s*(.*)$/m.exec(response);
  if (!m) return null;
  const f = parseCsvLine(m[1]);
  if (f.length < 9) return null;
  const at = (i: number): CpmsStorage => ({ name: f[i], used: Number(f[i + 1]), total: Number(f[i + 2]) });
  return { read: at(0), write: at(3), receive: at(6) };
}

/**
 * AT+CPMS=? lists the storages the modem accepts for each role:
 *   +CPMS: ("SM","ME","SR"),("SM","ME","SR"),("SM","ME","SR")   (read/delete, write/send, receive)
 */
export function parseCpmsSupport(response: string): { read: string[]; write: string[]; receive: string[] } | null {
  const m = /\+CPMS:\s*(.*)$/m.exec(response);
  if (!m) return null;
  const groups = [...m[1].matchAll(/\(([^)]*)\)/g)].map((g) =>
    g[1]
      .split(',')
      .map((v) => v.trim().replace(/^"|"$/g, '').toUpperCase())
      .filter(Boolean)
  );
  if (groups.length === 0) return null;
  return { read: groups[0] ?? [], write: groups[1] ?? [], receive: groups[2] ?? [] };
}

export function parseIntegers(response: string, prefix: string): number[] | null {
  const m = new RegExp(`\\+${prefix}:\\s*([0-9, ]+)`).exec(response);
  return m ? m[1].split(',').map((v) => Number(v.trim())) : null;
}

// ---------------------------------------------------------------------------------------------- validation

export class SmsValidationError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'SmsValidationError';
  }
}

/** International format only: "+" and 7 to 15 digits, no spaces or punctuation (E.164). */
export function normalizeDestination(value: unknown): string {
  const to = typeof value === 'string' ? value.trim() : '';
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    throw new SmsValidationError("'to' must be an international number: '+' followed by 7 to 15 digits, for example +919876543210", 'INVALID_DESTINATION');
  }
  return to;
}

/** One SMS holds 160 GSM-7 characters; the extension characters ^ { } \ [ ~ ] | take two. */
export const SMS_MAX_SEPTETS = 160;

const EXTENSION = new Set(['^', '{', '}', '\\', '[', '~', ']', '|']);
/** Characters whose ASCII code and GSM 7-bit code are the same, so they mean the same under either charset. */
const GSM_SAFE = /^[A-Za-z0-9 !"#%&'()*+,\-./:;<=>?\r\n]*$/;

/** A message that is not empty and holds no control characters (Ctrl+Z would end it early, Escape would cancel it). */
export function checkMessageBasics(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SmsValidationError("'message' must be a non-empty string", 'INVALID_MESSAGE');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new SmsValidationError("'message' contains control characters (Ctrl+Z and Escape end or cancel a message at the modem)", 'INVALID_MESSAGE');
  }
  return value;
}

/**
 * What the modem's current character set (AT+CSCS?) can carry. The text is sent exactly as given, so it must mean the
 * same under that set: with "IRA" any printable ASCII does; with "GSM" only the characters whose ASCII and GSM codes agree
 * ('@', '$', '_' and the brackets differ, so they are refused instead of being sent as something else); "UCS2", "HEX"
 * and the rest need an encoding this endpoint does not do, and are refused rather than guessed.
 */
export function checkMessageForCharset(text: string, charset: string | null): { septets: number } {
  const set = charset ?? 'GSM'; // unknown (the query failed): the strictest of the two plain sets
  if (set === 'IRA') {
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7e\r\n]*$/.test(text)) throw new SmsValidationError("The modem charset is IRA (ASCII); 'message' holds characters outside printable ASCII", 'UNSUPPORTED_CHARACTERS');
  } else if (set === 'GSM') {
    if (!GSM_SAFE.test(text)) {
      throw new SmsValidationError(
        "The modem charset is GSM; 'message' holds characters that differ between ASCII and the GSM alphabet (such as @ $ _ [ ] { } \\ ^ ~ |) or are not plain text. Use letters, digits, spaces and . , ! ? ' \" ( ) - / : ; + * & % # = < >",
        'UNSUPPORTED_CHARACTERS'
      );
    }
  } else {
    throw new SmsValidationError(`The modem charset is ${set}, which this endpoint does not encode for; the gateway does not change it automatically`, 'UNSUPPORTED_CHARSET');
  }
  let septets = 0;
  for (const ch of text) septets += EXTENSION.has(ch) ? 2 : 1;
  if (septets > SMS_MAX_SEPTETS) {
    throw new SmsValidationError(`'message' is ${septets} characters; one SMS holds ${SMS_MAX_SEPTETS} (longer, concatenated messages are not supported)`, 'MESSAGE_TOO_LONG');
  }
  return { septets };
}
