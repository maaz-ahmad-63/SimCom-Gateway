import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/campaigns/phone.js';

const ok = (raw: string, cc: string | null, e164: string) => expect(normalizePhone(raw, cc), `${JSON.stringify(raw)} with default ${cc}`).toEqual({ ok: true, e164 });
const rejected = (raw: string, cc: string | null | undefined, reason?: RegExp) => {
  const r = normalizePhone(raw, cc);
  expect(r.ok, `${JSON.stringify(raw)} with default ${cc} must be rejected, not guessed`).toBe(false);
  if (reason && !r.ok) expect(r.reason).toMatch(reason);
};

describe('phone numbers: one documented rule, never a guess', () => {
  it('keeps an Indian 10-digit number that begins with 91 local (the number that used to be dialled as someone else)', () => {
    ok('9123456789', '91', '+919123456789');
    ok('9198765432', '91', '+919198765432');
    ok('9112345678', '91', '+919112345678');
    ok('09123456789', '91', '+919123456789'); // with the national trunk 0
    ok('91 23456 789', '91', '+919123456789'); // spaces
  });

  it('places ordinary Indian numbers', () => {
    ok('9876543210', '91', '+919876543210');
    ok('98765-43210', '91', '+919876543210');
    ok('(98765) 43210', '91', '+919876543210');
    ok('8765432109', '91', '+918765432109');
    ok('7000000001', '91', '+917000000001');
    ok('6123456789', '91', '+916123456789');
    ok('09876543210', '91', '+919876543210');
    ok('9876543210.0', '91', '+919876543210'); // a spreadsheet float
  });

  it('accepts a number whose + was lost, only when its length can only be code + number', () => {
    ok('919876543210', '91', '+919876543210');
    ok('919123456789', '91', '+919123456789'); // 12 digits: 91 + 9123456789
    rejected('91234567890', '91', /not a valid India number/); // 11 digits: neither a local number nor code + number
    rejected('9198765432100', '91'); // 13 digits
    rejected('919123456', '91'); // 9 digits
  });

  it('takes explicit + and 00 numbers exactly as written and never reinterprets them', () => {
    ok('+919876543210', '91', '+919876543210');
    ok('+91 98765 43210', null, '+919876543210');
    ok('00919876543210', '91', '+919876543210');
    ok('00 91 98765 43210', null, '+919876543210');
    ok('+14155550132', '91', '+14155550132'); // another country's number with an Indian default
    ok('+447911123456', '91', '+447911123456');
    ok('+61412345678', null, '+61412345678');
    ok('+6591234567', null, '+6591234567');
    ok('+971501234567', null, '+971501234567');
    ok('+4915112345678', '91', '+4915112345678'); // a country the table does not know: taken as written
    rejected('+9123456789', '91', /not a valid India number/); // a + number is never "fixed" into a local one
    rejected('+91123456789', null, /not a valid India number/); // typo: 9 national digits
    rejected('+911234567890', null, /not a valid India number/); // an Indian number cannot start with 1
  });

  it('applies other countries by their own rules', () => {
    ok('(415) 555-0132', '1', '+14155550132');
    ok('4155550132', '1', '+14155550132');
    ok('14155550132', '1', '+14155550132'); // 1 + number
    rejected('1234567890', '1', /not a valid the US\/Canada number/); // no NANP area code starts with 1
    rejected('555-0132', '1');
    ok('07911123456', '44', '+447911123456');
    ok('7911123456', '44', '+447911123456');
    ok('447911123456', '44', '+447911123456');
    ok('0412345678', '61', '+61412345678');
    ok('412345678', '61', '+61412345678');
    ok('91234567', '65', '+6591234567');
    ok('0501234567', '971', '+971501234567');
  });

  it('rejects what it cannot place, saying why, instead of dialling something else', () => {
    rejected('9876543210', null, /country code/);
    rejected('9876543210', '', /country code/);
    rejected('9876543210', '49', /write the number as \+49/); // a country the table does not know: no guessing
    rejected('', '91', /empty/);
    rejected('abc', '91');
    rejected('98;ATD123', '91');
    rejected('+91+9876543210', '91');
    rejected('112', '91'); // emergency and short codes can never be dialled
    rejected('911', '1');
    rejected('999', '44');
    rejected('+1234', null, /too short/);
    rejected('+0123456789', null, /never starts with 0/);
    rejected('+12345678901234567', null, /too long/);
    rejected('+11111111111', null, /every digit is the same/);
    rejected('0000000000', '91');
  });

  it('never turns a valid local number into any number but itself (checked over thousands of numbers)', () => {
    let seed = 20261029;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const digits = (first: string, n: number) => first + Array.from({ length: n - 1 }, () => String(next() % 10)).join('');
    for (let i = 0; i < 3000; i++) {
      const local = digits(String(2 + (next() % 8)), 10); // any valid Indian national number
      expect(normalizePhone(local, '91')).toEqual({ ok: true, e164: `+91${local}` });
    }
    for (let i = 0; i < 2000; i++) {
      const local = '91' + digits(String(next() % 10), 8); // every national number that happens to start with 91
      expect(normalizePhone(local, '91')).toEqual({ ok: true, e164: `+91${local}` });
    }
    for (let i = 0; i < 1500; i++) {
      const local = digits(String(2 + (next() % 8)), 3) + digits(String(2 + (next() % 8)), 7); // NANP-shaped
      expect(normalizePhone(local, '1')).toEqual({ ok: true, e164: `+1${local}` });
    }
  });
});
