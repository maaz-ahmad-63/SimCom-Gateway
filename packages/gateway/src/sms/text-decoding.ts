/**
 * Readable text for an SMS whose body the modem reported as UCS-2 hex.
 *
 * In text mode the SIM7600 gives a message the network sent with 16-bit (UCS-2) coding as a string of hex digits, four per
 * UTF-16 code unit ("006B0020006F0066" = "k of"), whatever the character set (AT+CSCS) is. Without the header details
 * (AT+CSDH=1) the listing does not say which messages those are, so the hex is recognised here, conservatively:
 *
 *  - only whole 4-digit groups of hex, with surrogate pairs (emoji) correctly paired;
 *  - every character must belong to a script or symbol block a real message here plausibly uses (Latin, Indic including
 *    Devanagari, Arabic, punctuation, currency including the rupee sign, symbols, emoji), and at least one must be a letter
 *    or digit; random digits seldom decode to that (12345678 would be U+1234 U+5678, Ethiopic and CJK: left alone);
 *  - a string of decimal digits only is decoded only from 16 digits (4 characters) up, so an OTP or account number of plain
 *    digits stays as it is.
 *
 * Anything else, including text that is already readable, is returned unchanged, so decoding twice changes nothing. The
 * original is always kept as `rawText`. Pure function, no I/O. (The dashboard has the same function in src/lib/sms-text.ts.)
 */

export type SmsTextEncoding = 'text' | 'ucs2';

export interface DecodedSmsText {
  /** What to show. */
  text: string;
  /** Exactly what the modem reported (and the gateway stored). */
  rawText: string;
  /** 'ucs2': `text` was decoded from UCS-2 hex. 'text': shown as received. */
  encoding: SmsTextEncoding;
}

const HEX_GROUPS = /^(?:[0-9A-Fa-f]{4})+$/;

const PLAUSIBLE: Array<[number, number]> = [
  [0x09, 0x0a],
  [0x0d, 0x0d],
  [0x20, 0x7e], // ASCII
  [0xa0, 0x24f], // Latin-1 supplement, Latin Extended-A/B
  [0x600, 0x6ff], // Arabic (Urdu)
  [0x900, 0xdff], // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2000, 0x206f], // general punctuation (including ZWJ/ZWNJ)
  [0x20a0, 0x20cf], // currency (the rupee sign U+20B9)
  [0x2100, 0x21ff], // letterlike symbols, arrows
  [0x2300, 0x23ff], // miscellaneous technical (watch, hourglass)
  [0x25a0, 0x27bf], // shapes, miscellaneous symbols, dingbats
  [0x2b00, 0x2bff], // arrows and stars
  [0xfe00, 0xfe0f], // variation selectors (emoji presentation)
  [0x1f000, 0x1faff], // emoji
];

const plausible = (cp: number) => PLAUSIBLE.some(([lo, hi]) => cp >= lo && cp <= hi);

/** A letter or digit in one of the accepted scripts: there must be at least one, or it is not text. */
const wordLike = (cp: number) =>
  (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f) || (cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x900 && cp <= 0xdff) || (cp >= 0x1f000 && cp <= 0x1faff);

/** Hex to UTF-16 code units to code points; null when the units are not valid UTF-16 (an unpaired surrogate). */
function codePoints(hex: string): number[] | null {
  const units: number[] = [];
  for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  const points: number[] = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = units[i + 1];
      if (next === undefined || next < 0xdc00 || next > 0xdfff) return null;
      points.push(0x10000 + ((u - 0xd800) << 10) + (next - 0xdc00));
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      return null;
    } else {
      points.push(u);
    }
  }
  return points;
}

export function decodeSmsText(raw: string | null | undefined): DecodedSmsText {
  const rawText = raw ?? '';
  const unchanged: DecodedSmsText = { text: rawText, rawText, encoding: 'text' };
  const hex = rawText.trim();
  if (!HEX_GROUPS.test(hex)) return unchanged;
  if (/^[0-9]+$/.test(hex) && hex.length < 16) return unchanged; // short plain digits: a number, not hex text
  const points = codePoints(hex);
  if (!points || points.length === 0) return unchanged;
  if (!points.every(plausible) || !points.some(wordLike)) return unchanged;
  return { text: String.fromCodePoint(...points), rawText, encoding: 'ucs2' };
}
