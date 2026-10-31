/**
 * Phone number validation for campaign contacts. A number is only ever dialled in E.164 form (+, then 8 to 15 digits,
 * first digit not zero). Nothing that could be mistaken for an AT command or a short/emergency code gets through:
 * the shortest accepted number has eight digits, so 112, 911, 999 and similar can never be dialled by a campaign.
 *
 * THE RULE for a number written without a country code (documented, and pinned by tests):
 *
 *   1. "+<digits>" and "00<digits>" are international: the digits are the number. They are never reinterpreted.
 *   2. Anything else is LOCAL to the campaign's default country code. The code is prepended, never guessed to be present,
 *      so a local number that merely begins with the same digits as the code (an Indian mobile starting 91, say) stays local.
 *   3. A local number must have exactly the length and leading digits of that country's numbers (one national trunk 0 is
 *      dropped first). The only other accepted shape is "<code><national number>" with the "+" lost (a spreadsheet
 *      habit): it is accepted only when its length is exactly code + national length, which a local number can never have.
 *   4. A country without an entry in the table below is not guessed at: the number must be written with + or 00.
 *   5. Whatever cannot be placed unambiguously is rejected with the reason, instead of being dialled as something else.
 */
export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: string };

interface Country {
  name: string;
  /** What the national significant number (no trunk 0, no country code) must look like. */
  national: RegExp;
  /** Its length, used for the message and for recognising a country code that was typed without the +. */
  length: number | [number, number];
}

const COUNTRIES: Record<string, Country> = {
  '91': { name: 'India', national: /^[2-9]\d{9}$/, length: 10 },
  '1': { name: 'the US/Canada', national: /^[2-9]\d{2}[2-9]\d{6}$/, length: 10 },
  '44': { name: 'the UK', national: /^[1-9]\d{8,9}$/, length: [9, 10] },
  '61': { name: 'Australia', national: /^[2-9]\d{8}$/, length: 9 },
  '65': { name: 'Singapore', national: /^[3689]\d{7}$/, length: 8 },
  '971': { name: 'the UAE', national: /^[2-9]\d{8}$/, length: 9 },
};

const lengths = (c: Country): number[] => {
  const l = c.length;
  if (typeof l === 'number') return [l];
  const out: number[] = [];
  for (let n = l[0]; n <= l[1]; n++) out.push(n);
  return out;
};

/** The country (from the table) an international digit string belongs to, longest code first, or null. */
function knownCountryOf(digits: string): { code: string; country: Country } | null {
  for (const code of Object.keys(COUNTRIES).sort((a, b) => b.length - a.length)) {
    if (digits.startsWith(code)) return { code, country: COUNTRIES[code] };
  }
  return null;
}

/** An international number must also be a plausible number of its country when we know the country. */
function checkInternational(digits: string): PhoneResult {
  if (digits.startsWith('0')) return { ok: false, reason: 'a country code never starts with 0' };
  if (digits.length < 8) return { ok: false, reason: `too short (${digits.length} digits; at least 8 are needed, which also keeps emergency and short codes out)` };
  if (digits.length > 15) return { ok: false, reason: `too long (${digits.length} digits; E.164 allows at most 15)` };
  if (/^(\d)\1+$/.test(digits)) return { ok: false, reason: 'every digit is the same, which is not a real number' };
  const known = knownCountryOf(digits);
  if (known && !known.country.national.test(digits.slice(known.code.length))) {
    return { ok: false, reason: `+${known.code} is ${known.country.name}, and "${digits.slice(known.code.length)}" is not a valid ${known.country.name} number (expected ${lengths(known.country).join(' or ')} digits)` };
  }
  return { ok: true, e164: `+${digits}` };
}

export function normalizePhone(raw: string, defaultCountryCode?: string | null): PhoneResult {
  let value = (raw ?? '').trim();
  if (value === '') return { ok: false, reason: 'phone number is empty' };
  // Spreadsheet exports often wrap numbers as ="9876..." or add a trailing .0; neither is part of the number.
  value = value.replace(/^="?|"$/g, '').replace(/\.0+$/, '');
  if (/[^\d+\s().\-]/.test(value)) return { ok: false, reason: 'phone number contains characters other than digits, spaces, ( ) - . and a leading +' };
  const hasPlus = value.startsWith('+');
  if (hasPlus && value.indexOf('+', 1) !== -1) return { ok: false, reason: 'a + may only appear at the start' };
  const digits = value.replace(/\D/g, '');
  if (digits === '') return { ok: false, reason: 'phone number has no digits' };

  // Rule 1: explicit international prefixes are taken as written.
  if (hasPlus) return checkInternational(digits);
  if (digits.startsWith('00')) return checkInternational(digits.slice(2));

  // Rules 2 to 4: a local number.
  const cc = (defaultCountryCode ?? '').replace(/\D/g, '');
  if (!cc) return { ok: false, reason: 'no country code: write the number as +<country code><number>, or set a default country code for the campaign' };
  const country = COUNTRIES[cc];
  if (!country) {
    return { ok: false, reason: `numbers without a + cannot be placed for country code ${cc} (only ${Object.keys(COUNTRIES).map((c) => '+' + c).join(', ')} are supported this way): write the number as +${cc}<number>` };
  }
  const sizes = lengths(country);
  const withoutTrunk = digits.startsWith('0') ? digits.slice(1) : digits;

  // A local number: exactly the national length (after at most one trunk 0), starting with a valid leading digit.
  if (sizes.includes(withoutTrunk.length) && country.national.test(withoutTrunk)) return checkInternational(cc + withoutTrunk);

  // "+" lost in a spreadsheet: <code><national>. Only when the length is exactly code + national, which a local number cannot be.
  if (digits.startsWith(cc) && sizes.includes(digits.length - cc.length) && country.national.test(digits.slice(cc.length))) return checkInternational(digits);

  const expected = sizes.join(' or ');
  return {
    ok: false,
    reason: `"${value.trim()}" is not a valid ${country.name} number: a local number has ${expected} digits (a leading 0 is allowed), or write it as +${cc}<${expected} digits>. It was not guessed at.`,
  };
}
