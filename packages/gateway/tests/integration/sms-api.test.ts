import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';

describe('Integration: SMS REST API (mock modem; no SMS is ever transmitted)', () => {
  let server: GatewayServerInstance;
  let modem: MockModemAdapter;
  let dir: string;
  const key = 'test-secret-sms-api-12345';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-api-'));
    modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    // .env (loaded by the config module) says MODEM_DRIVER=hardware: pin the mock driver and a mock audio adapter so no
    // code path here can touch a COM port.
    server = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'gateway.sqlite') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
    await modem.initialize();
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    modem.sms.sent.length = 0;
    modem.sms.messages.length = 0;
    modem.sms.commands.length = 0;
    modem.sms.failNextSend = null;
    modem.sms.cmgf = 1;
    modem.sms.csca = '+919800000000';
    modem.sms.csmp = '17,167,0,0';
    modem.sms.cscs = 'GSM';
    modem.sms.csmpWrite = 'accept';
  });

  const api = {
    get: (url: string) => request(server.app).get(url).set('x-api-key', key),
    post: (url: string) => request(server.app).post(url).set('x-api-key', key),
  };

  it('requires the API key on every SMS endpoint', async () => {
    for (const [method, url] of [
      ['post', '/api/gateway/sms/send'],
      ['get', '/api/gateway/sms'],
      ['get', '/api/gateway/sms/1'],
      ['get', '/api/gateway/sms/status'],
    ] as const) {
      const res = await request(server.app)[method](url).send({ to: '+919876543210', message: 'x' });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    const wrong = await request(server.app).post('/api/gateway/sms/send').set('x-api-key', 'nope').send({ to: '+919876543210', message: 'x' });
    expect(wrong.status).toBe(401);
    expect(modem.sms.sent).toHaveLength(0);
    expect(modem.sms.commands).toEqual([]);
  });

  describe('POST /api/gateway/sms/send', () => {
    it('sends { to, message } and returns the reference', async () => {
      const res = await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello from the gateway' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, to: '+919876543210', messageReference: 1, characters: 22, settingsChanged: [], isSimulated: true });
      expect(modem.sms.sent).toEqual([{ to: '+919876543210', text: 'Hello from the gateway' }]);
      // Only reads of the modem's SMS settings were issued before the send.
      expect(modem.sms.commands).toEqual(['AT+CMGF?', 'AT+CSCS?', 'AT+CSCA?', 'AT+CSMP?', 'AT+CMGS="+919876543210"']);
    });

    it('rejects a bad body with 400 and sends nothing', async () => {
      const cases: Array<[unknown, number, string]> = [
        [{}, 400, 'VALIDATION_ERROR'],
        [{ to: '+919876543210' }, 400, 'VALIDATION_ERROR'],
        [{ message: 'x' }, 400, 'VALIDATION_ERROR'],
        [{ to: '+919876543210', message: 'x', extra: 1 }, 400, 'VALIDATION_ERROR'],
        [{ to: 9876543210, message: 'x' }, 400, 'VALIDATION_ERROR'],
        [{ to: '9876543210', message: 'x' }, 400, 'INVALID_DESTINATION'],
        [{ to: '+919876543210;AT+CFUN=0', message: 'x' }, 400, 'INVALID_DESTINATION'],
        [{ to: '+919876543210', message: '   ' }, 400, 'INVALID_MESSAGE'],
        [{ to: '+919876543210', message: 'a\u001ab' }, 400, 'INVALID_MESSAGE'],
        [{ to: '+919876543210', message: 'a'.repeat(161) }, 400, 'MESSAGE_TOO_LONG'],
        [{ to: '+919876543210', message: 'mail a@b.com' }, 400, 'UNSUPPORTED_CHARACTERS'],
      ];
      for (const [body, status, code] of cases) {
        const res = await api.post('/api/gateway/sms/send').send(body as object);
        expect(res.status, JSON.stringify(body)).toBe(status);
        expect(res.body.code, JSON.stringify(body)).toBe(code);
        expect(res.body.success).toBe(false);
      }
      expect(modem.sms.sent).toHaveLength(0);
    });

    it('reports a modem rejection with its code and a hint, and does not retry', async () => {
      modem.sms.failNextSend = { cms: 'Invalid text mode parameter' };
      const res = await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' });
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ success: false, code: 'SMS_CMS_ERROR', details: { cmsCode: 305, cmsText: 'Invalid text mode parameter' } });
      expect(res.body.details.hint).toMatch(/AT\+CSMP/);
      expect(res.body.details.snapshot).toMatchObject({ charset: 'GSM', csmp: { fo: 17 } });
      expect(modem.sms.sent).toHaveLength(0);
      expect(modem.sms.commands.filter((c) => c.startsWith('AT+CMGS'))).toHaveLength(1); // one attempt

      // Nothing sticks: the next request works.
      expect((await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello again' })).status).toBe(200);
    });

    it('reports the two timeouts differently: nothing sent, or outcome unknown', async () => {
      modem.sms.failNextSend = { timeout: 'prompt' };
      const noPrompt = await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' });
      expect(noPrompt.status).toBe(504);
      expect(noPrompt.body.code).toBe('SMS_PROMPT_TIMEOUT');

      modem.sms.failNextSend = { timeout: 'completion' };
      const unknown = await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' });
      expect(unknown.status).toBe(504);
      expect(unknown.body.code).toBe('SMS_OUTCOME_UNKNOWN');
      expect(unknown.body.error).toMatch(/MAY have been sent/);
    });

    it('refuses a send when the service centre is not set, instead of guessing one', async () => {
      modem.sms.csca = '';
      const res = await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SMSC_NOT_SET');
      expect(modem.sms.sent).toHaveLength(0);
      expect(modem.sms.csca).toBe(''); // and it was not written
    });

    it('says when it had to switch the modem to text mode', async () => {
      modem.sms.cmgf = 0;
      const res = await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' });
      expect(res.status).toBe(200);
      expect(res.body.settingsChanged).toEqual(['AT+CMGF=1 (the modem was in PDU mode)']);
      expect(modem.sms.cmgf).toBe(1);
    });

    it('is busy while another SMS operation runs: exactly one of two simultaneous sends goes out', async () => {
      const send = (message: string) => api.post('/api/gateway/sms/send').send({ to: '+919876543210', message });
      const [a, b] = await Promise.all([send('one'), send('two')]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const refused = a.status === 409 ? a : b;
      expect(refused.body.code).toBe('SMS_BUSY');
      expect(modem.sms.sent).toHaveLength(1);
    });
  });

  describe('GET /api/gateway/sms and /:index', () => {
    it('lists stored incoming messages', async () => {
      modem.addIncomingSms('+911234567890', 'Meeting at 5');
      modem.addIncomingSms('+919999999999', 'RING', 'REC READ', '26/10/27,19:00:00+22');
      const res = await api.get('/api/gateway/sms');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, count: 2, markedRead: false, isSimulated: true });
      expect(res.body.messages).toEqual([
        { index: 1, status: 'REC UNREAD', direction: 'received', address: '+911234567890', timestamp: '2026-10-27T18:00:00+05:30', text: 'Meeting at 5', rawText: 'Meeting at 5', textEncoding: 'text' },
        { index: 2, status: 'REC READ', direction: 'received', address: '+919999999999', timestamp: '2026-10-27T19:00:00+05:30', text: 'RING', rawText: 'RING', textEncoding: 'text' },
      ]);
      expect(res.body.storage).toMatchObject({ name: 'ME', used: 2 });
    });

    it('filters by status, and leaves unread messages unread unless asked', async () => {
      modem.addIncomingSms('+911234567890', 'Unread one');
      modem.addIncomingSms('+919999999999', 'Read one', 'REC READ');
      expect((await api.get('/api/gateway/sms?status=unread')).body.messages.map((m: any) => m.text)).toEqual(['Unread one']);
      expect((await api.get('/api/gateway/sms?status=unread')).body.count).toBe(1); // still unread
      const marked = await api.get('/api/gateway/sms?status=unread&markRead=true');
      expect(marked.body).toMatchObject({ count: 1, markedRead: true });
      expect((await api.get('/api/gateway/sms?status=unread')).body.count).toBe(0); // now read
      expect((await api.get('/api/gateway/sms?status=bogus')).status).toBe(400);
    });

    it('reads one message by index, 404 for a missing one, 400 for a bad index', async () => {
      modem.addIncomingSms('+911234567890', 'Hello there');
      const found = await api.get('/api/gateway/sms/1');
      expect(found.status).toBe(200);
      expect(found.body.message).toMatchObject({ index: 1, text: 'Hello there', address: '+911234567890', status: 'REC UNREAD' });
      expect((await api.get('/api/gateway/sms/42')).status).toBe(404);
      expect((await api.get('/api/gateway/sms/42')).body.code).toBe('SMS_NOT_FOUND');
      expect((await api.get('/api/gateway/sms/abc')).status).toBe(400);
      expect((await api.get('/api/gateway/sms/0')).body.code).toBe('INVALID_INDEX');
    });
  });

  describe('GET /api/gateway/sms/status', () => {
    it('shows the SMS configuration and whether a send would be accepted, without changing anything', async () => {
      const ok = await api.get('/api/gateway/sms/status');
      expect(ok.status).toBe(200);
      expect(ok.body.assessment).toEqual({ canSend: true, problems: [], warnings: [] });
      expect(ok.body.settings).toMatchObject({ textMode: true, serviceCentre: 'set', charset: 'GSM' });

      modem.sms.csmp = '16,167,0,0';
      const bad = await api.get('/api/gateway/sms/status');
      expect(bad.body.assessment.canSend).toBe(false);
      expect(bad.body.assessment.problems[0]).toMatch(/not an SMS-SUBMIT/);
      expect(modem.sms.csmp).toBe('16,167,0,0'); // not "fixed"
    });
  });

  describe('the persistent inbox: GET /inbox and POST /sync', () => {
    beforeEach(() => {
      server.db.prepare('DELETE FROM sms_messages').run(); // test isolation only; the gateway itself never deletes messages
    });

    it('require the API key', async () => {
      expect((await request(server.app).get('/api/gateway/sms/inbox')).status).toBe(401);
      expect((await request(server.app).post('/api/gateway/sms/sync')).status).toBe(401);
    });

    it('Refresh reads the modem, stores new messages once, and leaves them unread', async () => {
      modem.addIncomingSms('+911234567890', 'Hello inbox');
      const first = await api.post('/api/gateway/sms/sync');
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ success: true, listed: 1, added: 1, storageFull: false, storage: { name: 'ME', used: 1, total: 100 } });
      expect(first.body.inbox).toMatchObject({ running: expect.any(Boolean), storageFull: false });

      const second = await api.post('/api/gateway/sms/sync');
      expect(second.body).toMatchObject({ listed: 1, added: 0 }); // no duplicate

      const inbox = await api.get('/api/gateway/sms/inbox');
      expect(inbox.status).toBe(200);
      expect(inbox.body).toMatchObject({ success: true, total: 1, unread: 1 });
      expect(inbox.body.messages[0]).toMatchObject({ direction: 'received', address: '+911234567890', text: 'Hello inbox', modemStatus: 'REC UNREAD', read: false });
      expect(modem.sms.messages[0].status).toBe('REC UNREAD'); // opening/refreshing the inbox did not mark it read
      expect(modem.sms.commands.filter((c) => c.startsWith('AT+CMGL="')).every((c) => c === 'AT+CMGL="ALL",1')).toBe(true);
    });

    it('lists sent messages beside received ones, with an uncertain send kept visible', async () => {
      modem.addIncomingSms('+911234567890', 'Incoming');
      await api.post('/api/gateway/sms/sync');
      await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Outgoing ok' });
      modem.sms.failNextSend = { timeout: 'completion' };
      expect((await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Outgoing unsure' })).body.code).toBe('SMS_OUTCOME_UNKNOWN');

      const sent = await api.get('/api/gateway/sms/inbox?direction=sent');
      expect(sent.body.messages.map((m: any) => [m.text, m.sendStatus]).sort()).toEqual([
        ['Outgoing ok', 'sent'],
        ['Outgoing unsure', 'unknown'],
      ]);
      expect((await api.get('/api/gateway/sms/inbox?direction=received')).body.total).toBe(1);
      expect((await api.get('/api/gateway/sms/inbox')).body.total).toBe(3);
      expect((await api.get('/api/gateway/sms/inbox?direction=bogus')).status).toBe(400);
      expect(modem.sms.sent).toHaveLength(1); // the uncertain one was not sent again
    });

    it('the inbox view works during a call (database only), while Refresh is refused and sends no AT command', async () => {
      modem.addIncomingSms('+911234567890', 'Stored before the call');
      await api.post('/api/gateway/sms/sync');
      await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.sms.commands.length = 0;
      try {
        const view = await api.get('/api/gateway/sms/inbox');
        expect(view.status).toBe(200);
        expect(view.body.total).toBe(1);
        const refresh = await api.post('/api/gateway/sms/sync');
        expect(refresh.status).toBe(409);
        expect(refresh.body.code).toBe('CALL_IN_PROGRESS');
        expect(modem.sms.commands).toEqual([]);
      } finally {
        await server.callManager.hangup('test cleanup');
      }
    });

    it('reports a failed read to the caller and a full storage in the response', async () => {
      modem.sms.failNextList = 'CMS ERROR: SIM busy';
      const failed = await api.post('/api/gateway/sms/sync');
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({ success: false, code: 'SMS_CMS_ERROR' });

      modem.sms.storageTotal = 1;
      modem.addIncomingSms('+911234567890', 'Fills the storage');
      const full = await api.post('/api/gateway/sms/sync');
      expect(full.body).toMatchObject({ storageFull: true, storage: { used: 1, total: 1 } });
      modem.sms.storageTotal = 100;
    });

    it('a new-message notification from the modem reaches the inbox through the server wiring', async () => {
      server.smsInbox.start();
      try {
        await vi.waitFor(() => expect(server.smsInbox.state().syncing).toBe(false));
        modem.receiveSms('+911234567890', 'Announced by +CMTI');
        await vi.waitFor(() => expect(server.smsStore.list().messages.some((m) => m.text === 'Announced by +CMTI')).toBe(true), { timeout: 4000 });
        expect((await api.get('/api/gateway/sms/inbox')).body.messages.some((m: any) => m.text === 'Announced by +CMTI')).toBe(true);
      } finally {
        server.smsInbox.stop();
      }
    });
  });

  describe('POST /api/gateway/sms/text-parameters (AT+CSMP=17,167,0,0)', () => {
    const CONFIRM = 'APPLY AT+CSMP=17,167,0,0';

    it('requires the API key', async () => {
      const res = await request(server.app).post('/api/gateway/sms/text-parameters').send({ confirm: CONFIRM });
      expect(res.status).toBe(401);
      expect(modem.sms.commands).toEqual([]);
    });

    it('requires the exact confirmation text and does nothing without it', async () => {
      modem.sms.csmp = '17,11,0,246';
      for (const body of [{}, { confirm: 'yes' }, { confirm: 'apply at+csmp=17,167,0,0' }, { confirm: CONFIRM, extra: 1 }]) {
        const res = await api.post('/api/gateway/sms/text-parameters').send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await api.post('/api/gateway/sms/text-parameters').send({ confirm: 'yes' })).body.code).toBe('CONFIRMATION_REQUIRED');
      expect(modem.sms.csmp).toBe('17,11,0,246');
      expect(modem.sms.commands).toEqual([]);
    });

    it('fixes the real modem\'s situation end to end: status says it cannot send, apply, verify, then a send works', async () => {
      modem.sms.csmp = '17,11,0,246'; // as found on the real modem
      modem.sms.cscs = 'IRA';

      const before = await api.get('/api/gateway/sms/status');
      expect(before.body.assessment.canSend).toBe(false);
      expect(before.body.assessment.problems[0]).toMatch(/246 is 8-bit data, class 2/);
      expect((await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' })).body.code).toBe('SMS_PARAMS_INVALID');
      expect(modem.sms.sent).toHaveLength(0);

      modem.sms.commands.length = 0;
      const applied = await api.post('/api/gateway/sms/text-parameters').send({ confirm: CONFIRM });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({
        success: true,
        changed: true,
        verified: true,
        command: 'AT+CSMP=17,167,0,0',
        old: { fo: 17, vp: 11, pid: 0, dcs: 246 },
        new: { fo: 17, vp: 167, pid: 0, dcs: 0 },
        persisted: false,
      });
      expect(modem.sms.commands).toEqual(['AT+CSMP?', 'AT+CSMP=17,167,0,0', 'AT+CSMP?']);
      expect(modem.sms.csmp).toBe('17,167,0,0');
      expect(modem.sms.csca).toBe('+919800000000'); // the service centre was not touched
      expect(modem.sms.cscs).toBe('IRA'); // nor the charset

      expect((await api.get('/api/gateway/sms/status')).body.assessment.canSend).toBe(true);
      expect((await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' })).status).toBe(200);
    });

    it('is a no-op when the values are already standard', async () => {
      const res = await api.post('/api/gateway/sms/text-parameters').send({ confirm: CONFIRM });
      expect(res.body).toMatchObject({ success: true, changed: false, command: null });
      expect(modem.sms.commands).toEqual(['AT+CSMP?']);
    });

    it('reports a rejected write and a write the modem silently ignored', async () => {
      modem.sms.csmp = '17,11,0,246';
      modem.sms.csmpWrite = 'reject';
      const rejected = await api.post('/api/gateway/sms/text-parameters').send({ confirm: CONFIRM });
      expect(rejected.status).toBe(502);
      expect(rejected.body.code).toBe('SMS_CMS_ERROR');
      expect(rejected.body.details.old).toMatchObject({ dcs: 246 });
      expect(modem.sms.csmp).toBe('17,11,0,246');

      modem.sms.csmpWrite = 'ignore';
      const ignored = await api.post('/api/gateway/sms/text-parameters').send({ confirm: CONFIRM });
      expect(ignored.status).toBe(502);
      expect(ignored.body.code).toBe('CSMP_VERIFY_FAILED');
      expect(ignored.body.details).toMatchObject({ requested: { dcs: 0 }, actual: { dcs: 246 } });
      modem.sms.csmpWrite = 'accept';
    });

    it('is refused during a call with no AT command sent', async () => {
      modem.sms.csmp = '17,11,0,246';
      await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.sms.commands.length = 0;
      try {
        const res = await api.post('/api/gateway/sms/text-parameters').send({ confirm: CONFIRM });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CALL_IN_PROGRESS');
        expect(modem.sms.commands).toEqual([]);
        expect(modem.sms.csmp).toBe('17,11,0,246');
      } finally {
        await server.callManager.hangup('test cleanup');
      }
    });
  });

  describe('protecting calls', () => {
    it('refuses every SMS endpoint during a call and sends no SMS command to the modem', async () => {
      await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.sms.commands.length = 0;
      try {
        for (const res of [
          await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'Hello' }),
          await api.get('/api/gateway/sms'),
          await api.get('/api/gateway/sms/1'),
          await api.get('/api/gateway/sms/status'),
        ]) {
          expect(res.status).toBe(409);
          expect(res.body.code).toBe('CALL_IN_PROGRESS');
        }
        expect(modem.sms.commands).toEqual([]);
        expect(modem.sms.sent).toHaveLength(0);
      } finally {
        await server.callManager.hangup('test cleanup');
      }
    });

    it('works again once the call has ended, and the rest of the gateway is unaffected', async () => {
      expect((await api.post('/api/gateway/sms/send').send({ to: '+919876543210', message: 'After the call' })).status).toBe(200);
      expect((await api.get('/api/gateway/health')).status).toBe(200);
    });
  });
});
