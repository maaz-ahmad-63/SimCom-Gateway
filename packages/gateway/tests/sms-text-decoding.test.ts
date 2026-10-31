import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { runMigrations } from '../src/db/migrations.js';
import { createGatewayServer } from '../src/server.js';
import { parseCmgl } from '../src/sms/parse.js';
import { SmsStore } from '../src/sms/sms-store.js';
import { decodeSmsText } from '../src/sms/text-decoding.js';

const ucs2Hex = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')).join('');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('the decoder (same rules as the dashboard)', () => {
  it('decodes ASCII, Hindi, mixed text and emoji, and leaves readable, empty, malformed and hex-looking text alone', () => {
    expect(decodeSmsText('006B0020006F00660020005200730020').text).toBe('k of Rs ');
    for (const text of ['नमस्ते', 'Recharge ₹299 अभी करें 😊']) expect(decodeSmsText(ucs2Hex(text))).toEqual({ text, rawText: ucs2Hex(text), encoding: 'ucs2' });
    for (const raw of ['', 'Hello', 'नमस्ते', '006B002', 'D83D0041', 'CAFEBABE', '12345678']) expect(decodeSmsText(raw)).toEqual({ text: raw, rawText: raw, encoding: 'text' });
  });
});

describe('stored messages', () => {
  function store() {
    const db = new Database(':memory:');
    runMigrations(db);
    cleanups.push(() => db.close());
    return { db, store: new SmsStore(db) };
  }

  it('the database keeps exactly what the modem reported; reading out decodes it and keeps the original beside it', () => {
    const { db, store: s } = store();
    const hex = ucs2Hex('आपका रिचार्ज सफल रहा ₹299');
    const [message] = parseCmgl(`+CMGL: 2,"REC READ","VM-VIINFO",,"26/10/16,13:21:42+22"\n${hex}\nOK`);
    expect(message.text).toBe(hex); // the parser does not decode (charset IRA): ingestion and dedupe are unchanged
    expect(s.upsertFromModem('SM', message)).toBe(true);
    expect(s.upsertFromModem('SM', message)).toBe(false); // the same raw text: no second copy
    expect((db.prepare('SELECT text FROM sms_messages').get() as { text: string }).text).toBe(hex);
    expect(s.list().messages[0]).toMatchObject({ text: 'आपका रिचार्ज सफल रहा ₹299', rawText: hex, textEncoding: 'ucs2' });
    expect(s.get(s.list().messages[0].id)).toMatchObject({ text: 'आपका रिचार्ज सफल रहा ₹299', rawText: hex });
  });

  it('messages stored before decoding existed are decoded on read-out without being rewritten or duplicated', () => {
    const { db, store: s } = store();
    const hex = '006B0020006F00660020005200730020';
    const [message] = parseCmgl(`+CMGL: 3,"REC READ","VM-VIINFO",,"26/10/16,13:21:42+22"\n${hex}\nOK`);
    s.upsertFromModem('SM', message); // as an earlier gateway stored it
    const before = db.prepare('SELECT * FROM sms_messages').all();
    expect(s.list().messages[0].text).toBe('k of Rs ');
    s.upsertFromModem('SM', message); // the next read of the storage
    expect(db.prepare('SELECT * FROM sms_messages').all().map((r: any) => ({ ...r, last_seen_at: null }))).toEqual(before.map((r: any) => ({ ...r, last_seen_at: null })));
  });

  it('sent messages are returned exactly as sent', () => {
    const { store: s } = store();
    s.recordSent({ to: '+911234567890', text: '00480065006C006C006F', status: 'sent', messageReference: 1 });
    expect(s.list({ direction: 'sent' }).messages[0]).toMatchObject({ text: '00480065006C006C006F', textEncoding: 'text' });
  });
});

describe('the API', () => {
  it('returns readable text from the inbox and from the modem listing, with the original available', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-text-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    const key = 'sms-text-decoding-key-1234567';
    const server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
    cleanups.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const hex = ucs2Hex('Pack Expired! 🙏 कृपया recharge करें');
    modem.addIncomingSms('VM-VIINFO', hex, 'REC READ');
    modem.addIncomingSms('VM-VIINFO', 'Plain GSM text', 'REC READ');

    await request(server.app).post('/api/gateway/sms/sync').set('x-api-key', key).expect(200);
    const inbox = await request(server.app).get('/api/gateway/sms/inbox?direction=received').set('x-api-key', key);
    const byRaw = Object.fromEntries(inbox.body.messages.map((m: any) => [m.rawText, m]));
    expect(byRaw[hex]).toMatchObject({ text: 'Pack Expired! 🙏 कृपया recharge करें', textEncoding: 'ucs2' });
    expect(byRaw['Plain GSM text']).toMatchObject({ text: 'Plain GSM text', textEncoding: 'text' });

    const listing = await request(server.app).get('/api/gateway/sms').set('x-api-key', key);
    expect(listing.body.messages.find((m: any) => m.rawText === hex)).toMatchObject({ text: 'Pack Expired! 🙏 कृपया recharge करें', textEncoding: 'ucs2' });
    const one = await request(server.app).get('/api/gateway/sms/1').set('x-api-key', key);
    expect(one.body.message).toMatchObject({ text: 'Pack Expired! 🙏 कृपया recharge करें', rawText: hex });

    // A second sync stores nothing new: the stored raw text and the dedupe key did not change.
    const again = await request(server.app).post('/api/gateway/sms/sync').set('x-api-key', key);
    expect(again.body.added).toBe(0);
    expect(server.smsStore.list({ direction: 'received' }).total).toBe(2);
  });
});
