import { describe, expect, it } from 'vitest';
import { cmsHint, parseCmsError } from '../src/sms/cms-errors.js';
import {
  checkCsmp,
  csmpEquals,
  STANDARD_CSMP,
  STANDARD_CSMP_COMMAND,
  checkMessageBasics,
  checkMessageForCharset,
  decodeUcs2Hex,
  normalizeDestination,
  parseCmgf,
  parseCmgl,
  parseCmgr,
  parseCpms,
  parseCsca,
  parseCscs,
  parseCsmp,
  parseCsvLine,
  parseIntegers,
  parseScts,
  SmsValidationError,
} from '../src/sms/parse.js';

describe('+CMS ERROR', () => {
  it('reads the text and the number forms, and knows what 305 (invalid text mode parameter) means', () => {
    expect(parseCmsError('CMS ERROR: Invalid text mode parameter')).toEqual({ code: 305, text: 'Invalid text mode parameter' });
    expect(parseCmsError('CMS ERROR: 305')).toEqual({ code: 305, text: 'invalid text mode parameter' });
    expect(parseCmsError('AT command failed: AT+CMGS -> CMS ERROR: SMSC address unknown')?.code).toBe(330);
    expect(parseCmsError('CMS ERROR: something new')).toEqual({ code: null, text: 'something new' });
    expect(parseCmsError('CME ERROR: SIM not inserted')).toBeNull();
  });

  it('points at AT+CSMP / AT+CSCS / AT+CSCA for 305 and never suggests an automatic fix', () => {
    const hint = cmsHint(305)!;
    expect(hint).toMatch(/AT\+CSMP/);
    expect(hint).toMatch(/AT\+CSCS/);
    expect(hint).toMatch(/AT\+CSCA/);
    expect(hint).toMatch(/did not change any of them and did not retry/);
    expect(cmsHint(330)).toMatch(/not set automatically/);
    expect(cmsHint(12345)).toBeNull();
  });
});

describe('modem reply parsing', () => {
  it('splits CSV honouring quotes (a timestamp holds a comma)', () => {
    expect(parseCsvLine('1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"')).toEqual(['1', 'REC READ', '+911234567890', '', '26/10/27,18:00:00+22']);
  });

  it('turns the service-centre timestamp into ISO with the network offset', () => {
    expect(parseScts('26/10/27,18:00:00+22')).toBe('2026-10-27T18:00:00+05:30');
    expect(parseScts('26/01/02,03:04:05-08')).toBe('2026-01-02T03:04:05-02:00');
    expect(parseScts('garbage')).toBe('garbage');
  });

  it('lists messages from AT+CMGL, including a multi-line text and one that looks like a call event', () => {
    const response = [
      '+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"',
      'RING',
      '+CMGL: 2,"REC UNREAD","+919999999999",,"26/10/27,18:05:00+22"',
      'first line',
      'second line',
      '+CMGL: 3,"STO SENT","+918888888888",,',
      'OK',
      'OK',
    ].join('\n');
    const messages = parseCmgl(response);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ index: 1, status: 'REC READ', direction: 'received', address: '+911234567890', timestamp: '2026-10-27T18:00:00+05:30', text: 'RING' });
    expect(messages[1]).toMatchObject({ index: 2, status: 'REC UNREAD', text: 'first line\nsecond line' });
    expect(messages[2]).toMatchObject({ index: 3, direction: 'sent', text: 'OK', timestamp: null });
    expect(parseCmgl('OK')).toEqual([]);
  });

  it('reads one message from AT+CMGR, an empty text, and the absence of a message', () => {
    expect(parseCmgr('+CMGR: "REC UNREAD","+911234567890",,"26/10/27,18:00:00+22"\nhello there\nOK', 4)).toMatchObject({ index: 4, text: 'hello there', status: 'REC UNREAD' });
    expect(parseCmgr('+CMGR: "REC READ","+911234567890",,"26/10/27,18:00:00+22"\n\nOK', 4)?.text).toBe('');
    expect(parseCmgr('OK', 4)).toBeNull();
  });

  it('decodes hex UCS-2 text and addresses when the charset is UCS2', () => {
    expect(decodeUcs2Hex('00480069')).toBe('Hi');
    expect(decodeUcs2Hex('not hex')).toBe('not hex');
    const message = parseCmgl('+CMGL: 1,"REC READ","002B003900310031",,"26/10/27,18:00:00+22"\n00480069\nOK', 'UCS2')[0];
    expect(message).toMatchObject({ address: '+911', text: 'Hi' });
  });

  it('reads the settings replies', () => {
    expect(parseCmgf('+CMGF: 1\nOK')).toBe(1);
    expect(parseCmgf('+CMGF: 0\nOK')).toBe(0);
    expect(parseCmgf('OK')).toBeNull();
    expect(parseCscs('+CSCS: "gsm"\nOK')).toBe('GSM');
    expect(parseCsca('+CSCA: "+919811009999",145\nOK')).toBe('+919811009999');
    expect(parseCsca('+CSCA: "",145\nOK')).toBe('');
    expect(parseCsca('ERROR')).toBeNull();
    expect(parseCsmp('+CSMP: 17,167,0,0\nOK')).toEqual({ fo: 17, vp: 167, pid: 0, dcs: 0 });
    expect(parseCsmp('+CSMP: 25,"26/10/27,18:00:00+22",0,0\nOK')).toMatchObject({ fo: 25, vp: '26/10/27,18:00:00+22' });
    expect(parseCpms('+CPMS: "ME",12,100,"SM",3,50,"ME",12,100\nOK')).toEqual({
      read: { name: 'ME', used: 12, total: 100 },
      write: { name: 'SM', used: 3, total: 50 },
      receive: { name: 'ME', used: 12, total: 100 },
    });
    expect(parseIntegers('+CNMI: 2,1,0,0,0\nOK', 'CNMI')).toEqual([2, 1, 0, 0, 0]);
  });
});

describe('text-mode parameter check (what explains "Invalid text mode parameter")', () => {
  it('accepts the normal defaults', () => {
    expect(checkCsmp({ fo: 17, vp: 167, pid: 0, dcs: 0 })).toEqual({ blocking: [], warnings: [] });
  });

  it('blocks values that are definitely wrong, and says why', () => {
    expect(checkCsmp({ fo: 16, vp: 167, pid: 0, dcs: 0 }).blocking[0]).toMatch(/not an SMS-SUBMIT/);
    expect(checkCsmp({ fo: 17, vp: 'abc', pid: 0, dcs: 0 }).blocking[0]).toMatch(/relative/);
    expect(checkCsmp({ fo: 17, vp: 999, pid: 0, dcs: 0 }).blocking[0]).toMatch(/0-255/);
    expect(checkCsmp({ fo: 17, vp: 167, pid: 0, dcs: 12 }).blocking[0]).toMatch(/reserved alphabet/);
  });

  it('blocks 8-bit data class 2 (data coding scheme 246, the value found on the real modem)', () => {
    const verdict = checkCsmp({ fo: 17, vp: 11, pid: 0, dcs: 246 });
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]).toMatch(/246 is 8-bit data, class 2 \(SIM-specific\)/);
    // 0xF0-0xF3 (GSM 7-bit data in coding group F) is not blocked, only 8-bit data (bit 2 set).
    expect(checkCsmp({ fo: 17, vp: 11, pid: 0, dcs: 240 }).blocking).toEqual([]);
  });

  it('knows the standard values and compares them without caring whether the validity period is text or a number', () => {
    expect(STANDARD_CSMP_COMMAND).toBe('AT+CSMP=17,167,0,0');
    expect(csmpEquals({ fo: 17, vp: 167, pid: 0, dcs: 0 }, STANDARD_CSMP)).toBe(true);
    expect(csmpEquals({ fo: 17, vp: '167', pid: 0, dcs: 0 }, STANDARD_CSMP)).toBe(true);
    expect(csmpEquals({ fo: 17, vp: 11, pid: 0, dcs: 246 }, STANDARD_CSMP)).toBe(false);
    expect(checkCsmp(STANDARD_CSMP)).toEqual({ blocking: [], warnings: [] });
  });

  it('only warns about unusual-but-valid combinations', () => {
    expect(checkCsmp({ fo: 17, vp: 167, pid: 0, dcs: 8 })).toMatchObject({ blocking: [], warnings: [expect.stringMatching(/UCS-2/)] });
    expect(checkCsmp({ fo: 25, vp: 167, pid: 0, dcs: 0 }).warnings[0]).toMatch(/absolute/);
  });
});

describe('destination and message validation', () => {
  it('accepts international numbers only', () => {
    expect(normalizeDestination(' +919876543210 ')).toBe('+919876543210');
    for (const bad of ['9876543210', '+91 98765 43210', '+91abc', '+0123456789', '+12345', '+9198765432101234', '', undefined, 5, '+919876543210;\r\nAT+CFUN=0', '+91"9876543210']) {
      expect(() => normalizeDestination(bad), String(bad)).toThrow(SmsValidationError);
    }
  });

  it('rejects empty text and control characters, including Ctrl+Z and Escape', () => {
    expect(checkMessageBasics('Hello')).toBe('Hello');
    expect(checkMessageBasics('two\nlines')).toBe('two\nlines');
    for (const bad of ['', '   ', undefined, 7, 'bad\x1ahere', 'bad\x1bhere', 'nul\x00']) {
      expect(() => checkMessageBasics(bad), JSON.stringify(bad)).toThrow(SmsValidationError);
    }
  });

  it('checks the text against the modem charset instead of sending something else', () => {
    expect(checkMessageForCharset('Hello, order #12 is ready (pick up at 5pm).', 'GSM').septets).toBe(43);
    expect(() => checkMessageForCharset('mail me at a@b.com', 'GSM')).toThrow(/differ between ASCII and the GSM alphabet/);
    expect(() => checkMessageForCharset('price is $5', 'GSM')).toThrow(SmsValidationError);
    expect(checkMessageForCharset('mail me at a@b.com $5 [x]', 'IRA').septets).toBe(27); // 25 characters; [ and ] count twice
    expect(() => checkMessageForCharset('café', 'IRA')).toThrow(/outside printable ASCII/);
    expect(() => checkMessageForCharset('Hello', 'UCS2')).toThrow(/UCS2/);
    expect(() => checkMessageForCharset('Hello', 'HEX')).toThrow(SmsValidationError);
    expect(checkMessageForCharset('Hello', null).septets).toBe(5); // unknown charset: judged by the strict plain set
  });

  it('enforces the single-message length in septets', () => {
    expect(checkMessageForCharset('a'.repeat(160), 'GSM').septets).toBe(160);
    expect(() => checkMessageForCharset('a'.repeat(161), 'GSM')).toThrow(/161 characters/);
    expect(() => checkMessageForCharset('['.repeat(81), 'IRA')).toThrow(/162 characters/); // each counts twice
  });
});
