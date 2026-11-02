import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageDetail, MessageList } from '../src/components/sms/SmsPanels';
import { smsDisplayText, StoredSms } from '../src/lib/sms';
import { decodeSmsText } from '../src/lib/sms-text';

/** What the SIM7600 prints in text mode for a UCS-2 message: four hex digits per UTF-16 code unit. */
const ucs2Hex = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')).join('');

describe('decoding UCS-2 hex', () => {
  it('decodes ASCII, including the message from the screenshot', () => {
    expect(decodeSmsText(ucs2Hex('Hello'))).toEqual({ text: 'Hello', rawText: '00480065006C006C006F', encoding: 'ucs2' });
    expect(decodeSmsText('006B0020006F00660020005200730020').text).toBe('k of Rs ');
  });

  it('decodes Hindi, mixed Hindi/English, the rupee sign and emoji (surrogate pairs)', () => {
    for (const text of ['नमस्ते', 'आपका रिचार्ज सफल रहा', 'Recharge ₹299 अभी करें 😊', 'Pack Expired! 🙏 कृपया recharge करें', 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ', 'வணக்கம்', 'خوش آمدید']) {
      const decoded = decodeSmsText(ucs2Hex(text));
      expect(decoded.encoding, text).toBe('ucs2');
      expect(decoded.text, text).toBe(text);
      expect(decoded.rawText).toBe(ucs2Hex(text));
    }
  });

  it('accepts lowercase hex and surrounding whitespace, and keeps the raw text exactly', () => {
    const raw = `${ucs2Hex('ok')}\r`.toLowerCase();
    expect(decodeSmsText(raw)).toEqual({ text: 'ok', rawText: raw, encoding: 'ucs2' });
  });

  it('returns empty and missing text as empty, unchanged', () => {
    expect(decodeSmsText('')).toEqual({ text: '', rawText: '', encoding: 'text' });
    expect(decodeSmsText(null)).toEqual({ text: '', rawText: '', encoding: 'text' });
    expect(decodeSmsText(undefined)).toEqual({ text: '', rawText: '', encoding: 'text' });
  });

  it('leaves malformed input as it is: odd length, non-hex, unpaired surrogates', () => {
    for (const raw of ['006B002', '006G0020', 'D83D0041', 'DE000041', '00480065006C006C006', 'D83D']) {
      expect(decodeSmsText(raw), raw).toEqual({ text: raw, rawText: raw, encoding: 'text' });
    }
  });

  it('never decodes text that is already readable, and decoding twice changes nothing', () => {
    for (const text of ['Hello', 'नमस्ते', 'Recharge ₹299 😊', 'Your OTP is 482913', 'Pack Expired!Your Unlimited Pack']) {
      expect(decodeSmsText(text)).toEqual({ text, rawText: text, encoding: 'text' });
    }
    const once = decodeSmsText(ucs2Hex('आपका रिचार्ज'));
    expect(decodeSmsText(once.text)).toEqual({ text: once.text, rawText: once.text, encoding: 'text' });
  });

  it('leaves GSM-7 text that merely looks like hex alone', () => {
    for (const raw of [
      'CAFEBABE', // U+CAFE U+BABE: Hangul, not a plausible script here
      'BEEFDEAD', // an unpaired surrogate
      '12345678', // a short number (OTP, account): digits only stay digits
      '482913004821', // likewise
      '1234567812345678', // 16 digits, but U+1234 is Ethiopic and U+5678 CJK
      '002E002E002E', // only punctuation, no letter or digit
      'ABCD',
    ]) {
      expect(decodeSmsText(raw).encoding, raw).toBe('text');
      expect(decodeSmsText(raw).text, raw).toBe(raw);
    }
  });

  it('decodes a long all-digit UCS-2 string (4 or more characters of ASCII text)', () => {
    expect(decodeSmsText(ucs2Hex('2026')).text).toBe('2026'); // 0032003000320036: 16 digits
  });
});

describe('what the dashboard shows', () => {
  const sms = (over: Partial<StoredSms>): StoredSms => ({
    id: 1, direction: 'received', source: 'modem', storage: 'SM', index: 2, address: 'VM-VIINFO', text: '', time: '2026-10-16T07:51:42.000Z',
    modemStatus: 'REC READ', read: true, sendStatus: null, messageReference: null, errorCode: null, errorMessage: null, onModem: true,
    firstSeenAt: '2026-10-28T09:13:00.000Z', lastSeenAt: '2026-10-28T09:13:00.000Z', ...over,
  });

  it('uses the gateway\'s decoding as given and never decodes again', () => {
    expect(smsDisplayText(sms({ text: 'नमस्ते', rawText: ucs2Hex('नमस्ते'), textEncoding: 'ucs2' }))).toEqual({ text: 'नमस्ते', rawText: ucs2Hex('नमस्ते'), encoding: 'ucs2' });
    // A newer gateway decided this is plain text: it stays exactly as is, even if it looks like hex.
    expect(smsDisplayText(sms({ text: '00480065006C006C006F', rawText: '00480065006C006C006F', textEncoding: 'text' })).text).toBe('00480065006C006C006F');
  });

  it('decodes received UCS-2 hex from an older gateway, and never touches sent messages', () => {
    expect(smsDisplayText(sms({ text: ucs2Hex('Upgrade now 😊') })).text).toBe('Upgrade now 😊');
    expect(smsDisplayText(sms({ direction: 'sent', source: 'gateway', text: '00480065006C006C006F' })).text).toBe('00480065006C006C006F');
  });

  it('renders the decoded text in the list and the detail, with the modem\'s original one click away', () => {
    const message = sms({ text: ucs2Hex('आपका रिचार्ज सफल रहा ₹299') });
    const list = renderToStaticMarkup(React.createElement(MessageList, { messages: [message], selectedId: null, onSelect: () => undefined, emptyText: '' }));
    expect(list).toContain('आपका रिचार्ज सफल रहा ₹299');
    expect(list).not.toContain('0906');
    const detail = renderToStaticMarkup(React.createElement(MessageDetail, { message, modemCopy: { text: ucs2Hex('आपका'), status: 'REC READ' }, busy: false, error: null, onReadFromModem: () => undefined }));
    expect(detail).toContain('आपका रिचार्ज सफल रहा ₹299');
    expect(detail).toContain('Received as UCS-2 (16-bit) text');
    expect(detail).toContain(ucs2Hex('आपका रिचार्ज सफल रहा ₹299')); // the original, inside the collapsed section
    expect(detail).toContain('Modem copy (REC READ): <span class="whitespace-pre-wrap break-words text-slate-100">आपका</span>');
    const plain = renderToStaticMarkup(React.createElement(MessageDetail, { message: sms({ text: 'Pack Expired!' }), modemCopy: null, busy: false, error: null, onReadFromModem: () => undefined }));
    expect(plain).not.toContain('Received as UCS-2');
  });
});

describe('one decoder', () => {
  it('the dashboard copy is identical to the gateway copy (apart from the cross-reference line)', () => {
    const dashboard = fs.readFileSync(path.resolve(__dirname, '../src/lib/sms-text.ts'), 'utf8');
    const gatewayFile = path.resolve(__dirname, '../../gateway/src/sms/text-decoding.ts');
    if (!fs.existsSync(gatewayFile)) return; // the gateway half is delivered as a patch; checked once it is applied
    const gateway = fs.readFileSync(gatewayFile, 'utf8');
    const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/\(The (gateway|dashboard) has the same function in [^)]+\)/, '');
    expect(strip(gateway)).toBe(strip(dashboard));
  });
});
