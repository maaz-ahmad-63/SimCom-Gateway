import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposeForm, MessageDetail, MessageList, NoticeList, SetupNotice } from '../src/components/sms/SmsPanels';
import {
  checkCompose,
  countSmsCharacters,
  describeSendError,
  describeSendResult,
  formatSmsTime,
  InboxState,
  inboxNotices,
  messageBadge,
  normalizeRecipient,
  setupProblem,
  smsApi,
  SmsApiError,
  smsRequest,
  StoredSms,
} from '../src/lib/sms';

afterEach(() => {
  vi.useRealTimers();
});

const sms = (over: Partial<StoredSms> = {}): StoredSms => ({
  id: 1, direction: 'received', source: 'modem', storage: 'ME', index: 3, address: '+911234567890', text: 'Hello there', time: '2026-10-27T12:30:00.000Z',
  modemStatus: 'REC UNREAD', read: false, sendStatus: null, messageReference: null, errorCode: null, errorMessage: null, onModem: true,
  firstSeenAt: '2026-10-27T12:31:00.000Z', lastSeenAt: '2026-10-27T12:31:00.000Z', ...over,
});

const inboxState = (over: Partial<InboxState> = {}): InboxState => ({
  running: true, syncing: false, pending: false, waiting: null, lastSyncAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
  storage: { name: 'ME', used: 3, total: 100 }, storageFull: false, indications: { cnmi: [2, 1, 0, 0, 0], notifies: true }, notificationsSeen: 0, storageMismatch: null, ...over,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('composing a message', () => {
  it('accepts a recipient typed with spaces or hyphens and sends only "+" and digits', () => {
    expect(normalizeRecipient(' +91 98765-43210 ')).toBe('+919876543210');
    expect(normalizeRecipient('+91 (98765) 43.210')).toBe('+919876543210');
    expect(checkCompose('+91 98765 43210', 'Hello')).toEqual({ to: '+919876543210', errors: {}, ok: true });
  });

  it('checks the recipient and the message, and says why', () => {
    expect(checkCompose('', 'Hi').errors.to).toMatch(/Enter the recipient/);
    expect(checkCompose('9876543210', 'Hi').errors.to).toMatch(/international format/);
    expect(checkCompose('+12345', 'Hi').errors.to).toMatch(/international format/);
    expect(checkCompose('+91abc', 'Hi').errors.to).toMatch(/international format/);
    expect(checkCompose('+919876543210', '   ').errors.message).toMatch(/Write a message/);
    expect(checkCompose('+919876543210', 'café').errors.message).toMatch(/plain characters/);
    expect(checkCompose('+919876543210', 'a'.repeat(161)).errors.message).toMatch(/160/);
    expect(checkCompose('+919876543210', 'a'.repeat(160)).ok).toBe(true);
    expect(checkCompose('+919876543210', 'two\nlines').ok).toBe(true);
  });

  it('counts the characters of one SMS the way the modem does', () => {
    expect(countSmsCharacters('Hello')).toBe(5);
    expect(countSmsCharacters('[x]')).toBe(5); // [ and ] take two
    expect(checkCompose('+919876543210', '['.repeat(81)).errors.message).toMatch(/162/);
  });
});

describe('talking to the relay (never with a key, never retried)', () => {
  it('sends the dashboard header to the same-origin relay and nothing that looks like a credential', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { success: true, messages: [], total: 0, unread: 0, inbox: null }));
    await smsApi.inbox('received', fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/sms/inbox?direction=received');
    expect(init?.headers).toEqual({ 'x-dashboard-sms': '1' });
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.stringify(init)).not.toMatch(/api-key|authorization|bearer/i);
  });

  it('posts a send as { to, message } and a refresh with no body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { success: true }));
    await smsApi.send('+919876543210', 'Hello', fetchImpl as never);
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/sms/send');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"to":"+919876543210","message":"Hello"}' });
    await smsApi.sync(fetchImpl as never);
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/sms/sync');
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'POST', body: undefined });
    await smsApi.modemMessage(7, fetchImpl as never);
    expect(fetchImpl.mock.calls[2][0]).toBe('/api/sms/7');
    await smsApi.status(fetchImpl as never);
    expect(fetchImpl.mock.calls[3][0]).toBe('/api/sms/status');
  });

  it('turns every API error into an SmsApiError with the gateway\'s code and details', async () => {
    const fetchImpl = async () => json(409, { success: false, code: 'CALL_IN_PROGRESS', error: 'A call is in progress', details: { x: 1 } });
    const error = await smsRequest('/sync', { method: 'POST', fetchImpl }).catch((e) => e as SmsApiError);
    expect(error).toBeInstanceOf(SmsApiError);
    expect(error).toMatchObject({ status: 409, code: 'CALL_IN_PROGRESS', message: 'A call is in progress', details: { x: 1 } });

    expect(await smsRequest('/inbox', { fetchImpl: async () => json(200, { success: false, code: 'X', error: 'no' }) }).catch((e) => e)).toMatchObject({ code: 'X' });
    expect(await smsRequest('/inbox', { fetchImpl: async () => new Response('<html>', { status: 502 }) }).catch((e) => e)).toMatchObject({ code: 'BAD_RESPONSE' });
    expect(await smsRequest('/inbox', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).catch((e) => e)).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('never retries a failed request', async () => {
    const calls = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await smsApi.send('+919876543210', 'Hello', calls as never).catch(() => {});
    expect(calls).toHaveBeenCalledTimes(1);
    const errors = vi.fn(async () => json(504, { success: false, code: 'SMS_OUTCOME_UNKNOWN', error: 'maybe sent' }));
    await smsApi.send('+919876543210', 'Hello', errors as never).catch(() => {});
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('stops waiting after the limit and reports it as a client timeout', async () => {
    vi.useFakeTimers();
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const pending = smsRequest('/send', { method: 'POST', body: {}, fetchImpl: hang as never, timeoutMs: 1000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ code: 'CLIENT_TIMEOUT' });
  });
});

describe('showing the outcome of a send', () => {
  it('treats an unknown outcome as its own state, never as a failure that is safe to repeat', () => {
    for (const code of ['SMS_OUTCOME_UNKNOWN', 'PROXY_TIMEOUT', 'PROXY_UNCERTAIN', 'CLIENT_TIMEOUT']) {
      const view = describeSendError(new SmsApiError(504, code, 'No answer.'));
      expect(view.state, code).toBe('uncertain');
      expect(view.detail).toMatch(/Check with the recipient before sending again/);
      expect(view.detail).toMatch(/will not retry by itself/);
    }
  });

  it('says plainly when nothing was sent, and shows the gateway\'s hint', () => {
    const view = describeSendError(new SmsApiError(502, 'SMS_CMS_ERROR', 'The modem refused the request: +CMS ERROR: 305', { hint: 'Check AT+CSMP.' }));
    expect(view).toMatchObject({ state: 'failed', notSent: true });
    expect(view.detail).toMatch(/refused/);
    expect(view.detail).toMatch(/Check AT\+CSMP\./);
    for (const code of ['CALL_IN_PROGRESS', 'SMS_BUSY', 'MODEM_NOT_READY', 'INVALID_DESTINATION', 'SMSC_NOT_SET', 'SMS_PARAMS_INVALID', 'GATEWAY_UNREACHABLE', 'PROXY_NOT_CONFIGURED']) {
      expect(describeSendError(new SmsApiError(409, code, 'x')), code).toMatchObject({ state: 'failed', notSent: true });
    }
    expect(describeSendError(new SmsApiError(500, 'SOMETHING_NEW', 'x'))).toMatchObject({ state: 'failed', notSent: false });
    expect(describeSendError(new Error('boom'))).toMatchObject({ state: 'failed' });
  });

  it('describes success without claiming delivery', () => {
    const view = describeSendResult({ success: true, to: '+919876543210', messageReference: 7, characters: 5, settingsChanged: [], warnings: [], isSimulated: false });
    expect(view.state).toBe('sent');
    expect(view.detail).toMatch(/reference 7/);
    expect(view.detail).toMatch(/Delivery to the phone is not confirmed/);
    expect(describeSendResult({ success: true, to: '+91', messageReference: null, characters: 1, settingsChanged: [], warnings: [], isSimulated: true }).detail).toMatch(/simulated/);
  });
});

describe('badges and notices', () => {
  it('labels messages by what is known about them', () => {
    expect(messageBadge(sms())).toEqual({ label: 'Unread', tone: 'warn' });
    expect(messageBadge(sms({ read: true, modemStatus: 'REC READ' }))).toEqual({ label: 'Read', tone: 'neutral' });
    expect(messageBadge(sms({ direction: 'sent', read: null, modemStatus: null, sendStatus: 'sent' }))).toEqual({ label: 'Sent', tone: 'good' });
    expect(messageBadge(sms({ direction: 'sent', read: null, modemStatus: null, sendStatus: 'unknown' }))).toEqual({ label: 'Outcome unknown', tone: 'warn' });
    expect(messageBadge(sms({ direction: 'sent', read: null, modemStatus: null, sendStatus: 'failed' }))).toEqual({ label: 'Not sent', tone: 'bad' });
  });

  it('formats times and tolerates a missing or odd one', () => {
    expect(formatSmsTime(null)).toBe('-');
    expect(formatSmsTime('garbage')).toBe('garbage');
    expect(formatSmsTime('2026-10-27T12:30:00.000Z')).toMatch(/2026/);
  });

  it('explains full storage, a storage mismatch, missing notifications, waiting and failures', () => {
    const keys = (inbox: InboxState | null, call = false) => inboxNotices(inbox, call).map((n) => n.key);
    expect(keys(inboxState())).toEqual([]);
    expect(keys(null, true)).toEqual(['call']);
    const full = inboxNotices(inboxState({ storageFull: true, storage: { name: 'ME', used: 100, total: 100 } }), false);
    expect(full[0]).toMatchObject({ key: 'full', tone: 'bad' });
    expect(full[0].text).toMatch(/100\/100/);
    expect(full[0].text).toMatch(/Nothing is deleted automatically/);
    expect(keys(inboxState({ storageMismatch: { indicated: 'SM', reading: 'ME' } }))).toEqual(['mismatch']);
    expect(keys(inboxState({ indications: { cnmi: [2, 0, 0, 0, 0], notifies: false } }))).toEqual(['indications']);
    expect(keys(inboxState({ running: false }))).toEqual(['stopped']);
    expect(keys(inboxState({ waiting: 'call', pending: true }))).toEqual(['waiting-call']);
    expect(keys(inboxState({ waiting: 'modem', pending: true }))).toEqual(['waiting-modem']);
    expect(keys(inboxState({ lastError: { code: 'SMS_CMS_ERROR', message: 'x', at: 'now' }, consecutiveFailures: 2, pending: true }))).toEqual(['error']);
    expect(inboxNotices(inboxState({ lastError: { code: 'SMS_CMS_ERROR', message: 'x', at: 'now' }, consecutiveFailures: 4, pending: false }), false)[0].text).toMatch(/Use Refresh/);
  });

  it('recognises setup problems of the relay and nothing else', () => {
    expect(setupProblem(new SmsApiError(503, 'PROXY_NOT_CONFIGURED', 'Set GATEWAY_API_KEY'))).toBe('Set GATEWAY_API_KEY');
    expect(setupProblem(new SmsApiError(502, 'PROXY_KEY_REJECTED', 'wrong key'))).toBe('wrong key');
    expect(setupProblem(new SmsApiError(403, 'PROXY_FORBIDDEN_HOST', 'open it as localhost'))).toBe('open it as localhost');
    expect(setupProblem(new SmsApiError(409, 'CALL_IN_PROGRESS', 'call'))).toBeNull();
    expect(setupProblem(null)).toBeNull();
  });
});

describe('the panels', () => {
  const render = (element: React.ReactElement) => renderToStaticMarkup(element);

  it('lists inbox messages with sender, time, status and a preview, and says when there are none', () => {
    const html = render(React.createElement(MessageList, { messages: [sms(), sms({ id: 2, read: true, modemStatus: 'REC READ', text: 'x'.repeat(200) })], selectedId: 2, onSelect: vi.fn(), emptyText: 'Nothing here' }));
    expect(html).toContain('From +911234567890');
    expect(html).toContain('Unread');
    expect(html).toContain('Hello there');
    expect(html).toContain('...'); // long text is shortened in the list
    expect(html).toContain('aria-current="true"');
    expect(render(React.createElement(MessageList, { messages: [], selectedId: null, onSelect: vi.fn(), emptyText: 'Nothing here' }))).toContain('Nothing here');
  });

  it('lists sent messages by recipient, with an unknown outcome visible', () => {
    const html = render(React.createElement(MessageList, { messages: [sms({ direction: 'sent', source: 'gateway', read: null, modemStatus: null, sendStatus: 'unknown', index: null })], selectedId: null, onSelect: vi.fn(), emptyText: '' }));
    expect(html).toContain('To +911234567890');
    expect(html).toContain('Outcome unknown');
  });

  it('shows the whole message, and never offers to mark it read', () => {
    const html = render(React.createElement(MessageDetail, { message: sms({ text: 'Line one\nLine two' }), modemCopy: null, busy: false, error: null, onReadFromModem: vi.fn() }));
    expect(html).toContain('Line one');
    expect(html).toContain('Line two');
    expect(html).toContain('Read this message from the modem');
    expect(html).toContain('without changing its read/unread status');
    expect(html).not.toMatch(/mark as read|mark read/i);
    expect(render(React.createElement(MessageDetail, { message: null, modemCopy: null, busy: false, error: null, onReadFromModem: vi.fn() }))).toContain('Select a message');
  });

  it('explains a message that is gone from the modem, and a send whose outcome is unknown or failed', () => {
    expect(render(React.createElement(MessageDetail, { message: sms({ onModem: false }), modemCopy: null, busy: false, error: null, onReadFromModem: vi.fn() }))).toMatch(/no longer in the modem(&#x27;|')s storage/);
    const unsure = render(React.createElement(MessageDetail, { message: sms({ direction: 'sent', read: null, modemStatus: null, sendStatus: 'unknown', errorMessage: 'no result', index: null }), modemCopy: null, busy: false, error: null, onReadFromModem: vi.fn() }));
    expect(unsure).toMatch(/not known whether this message was sent/);
    expect(unsure).toMatch(/was not retried/);
    expect(render(React.createElement(MessageDetail, { message: sms({ direction: 'sent', read: null, modemStatus: null, sendStatus: 'failed', index: null }), modemCopy: null, busy: false, error: null, onReadFromModem: vi.fn() }))).toMatch(/did not send this message/);
  });

  const compose = (over: Partial<React.ComponentProps<typeof ComposeForm>> = {}) =>
    render(
      React.createElement(ComposeForm, {
        to: '+919876543210', message: 'Hello', onTo: vi.fn(), onMessage: vi.fn(), onSend: vi.fn(), sending: false, check: checkCompose('+919876543210', 'Hello'),
        touched: true, view: null, needsAck: false, acked: false, onAck: vi.fn(), blockedReason: null, ...over,
      })
    );
  const sendDisabled = (html: string) => /<button[^>]*type="submit"[^>]*disabled=""/.test(html) || /<button[^>]*disabled=""[^>]*type="submit"/.test(html);

  it('enables Send only for a valid message, and shows the validation errors and the character count', () => {
    expect(sendDisabled(compose())).toBe(false);
    expect(compose()).toContain('5/160');
    const bad = compose({ to: '12', message: '', check: checkCompose('12', '') });
    expect(sendDisabled(bad)).toBe(true);
    expect(bad).toContain('international format');
    expect(bad).toContain('Write a message');
  });

  it('shows the sending state, and disables Send while it runs or during a call', () => {
    const sending = compose({ sending: true });
    expect(sending).toContain('Sending... this can take up to a minute');
    expect(sendDisabled(sending)).toBe(true);
    const blocked = compose({ blockedReason: 'A call is in progress. Sending is unavailable until it ends.' });
    expect(sendDisabled(blocked)).toBe(true);
    expect(blocked).toContain('A call is in progress');
  });

  it('after an unknown outcome, sending again needs an explicit confirmation', () => {
    const uncertain = describeSendError(new SmsApiError(504, 'SMS_OUTCOME_UNKNOWN', 'The message MAY have been sent.'));
    const locked = compose({ view: uncertain, needsAck: true, acked: false });
    expect(locked).toContain('Not sure whether it was sent');
    expect(locked).toContain('I have checked with the recipient');
    expect(sendDisabled(locked)).toBe(true);
    expect(sendDisabled(compose({ view: uncertain, needsAck: true, acked: true }))).toBe(false);
  });

  it('shows success and failure results distinctly', () => {
    expect(compose({ view: describeSendResult({ success: true, to: '+919876543210', messageReference: 3, characters: 5, settingsChanged: [], warnings: [], isSimulated: false }) })).toContain('The modem accepted the message');
    expect(compose({ view: describeSendError(new SmsApiError(409, 'CALL_IN_PROGRESS', 'A call is in progress')) })).toContain('The message was not sent');
  });

  it('renders notices and the setup instructions', () => {
    expect(render(React.createElement(NoticeList, { notices: [{ key: 'a', tone: 'bad', text: 'Storage is full' }] }))).toContain('Storage is full');
    expect(render(React.createElement(NoticeList, { notices: [] }))).toBe('');
    const setup = render(React.createElement(SetupNotice, { text: 'Set GATEWAY_API_KEY in the dashboard server environment' }));
    expect(setup).toContain('one-time setup');
    expect(setup).toContain('GATEWAY_API_KEY');
  });
});

describe('the browser code never holds the gateway key and never marks messages read', () => {
  const root = path.resolve(__dirname, '../src');
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const browserFiles = ['lib/sms.ts', 'components/sms/SmsPanels.tsx', 'app/sms/page.tsx'];

  it('uses no credential, no stored configuration and no environment in browser files', () => {
    for (const file of browserFiles) {
      const code = read(file);
      expect(code, file).not.toMatch(/x-api-key|getGatewayClientConfig|apiClient|localStorage|sessionStorage|process\.env|NEXT_PUBLIC_|Authorization|Bearer/i);
      expect(code, file).not.toMatch(/lib\/server|sms-proxy/);
    }
  });

  it('keeps the key in server files only, and never behind a NEXT_PUBLIC_ name', () => {
    for (const file of ['lib/server/sms-proxy.ts', 'lib/server/relay-env.ts', 'app/api/sms/[[...path]]/route.ts', 'app/api/gateway-status/route.ts']) {
      const code = read(file);
      expect(code, file).not.toMatch(/process\.env\.NEXT_PUBLIC_|['"`]NEXT_PUBLIC_/);
      expect(code, file).not.toMatch(/localStorage|sessionStorage|document\.|window\./);
    }
    expect(read('lib/server/sms-proxy.ts')).toMatch(/SERVER-ONLY/);
    // The key is read from the server environment in the route, and nowhere else in src (outside the Settings page and the older client config).
    const users = ['lib/sms.ts', 'components/sms/SmsPanels.tsx', 'app/sms/page.tsx', 'lib/server/sms-proxy.ts'].filter((f) => /process\.env\.GATEWAY_API_KEY/.test(read(f)));
    expect(users).toEqual([]);
    // The server routes get it from the server-side loader (the dashboard's own environment, then the repository .env).
    for (const route of ['app/api/sms/[[...path]]/route.ts', 'app/api/gateway-status/route.ts']) expect(read(route), route).toMatch(/resolveRelaySetup\(process\.env\)/);
    expect(read('lib/server/relay-env.ts')).toMatch(/SERVER-ONLY/);
  });

  it('never asks the gateway to mark messages read, and only calls the relay endpoints it needs', () => {
    for (const file of browserFiles) expect(read(file), file).not.toMatch(/markRead=|markRead:/);
    const calls = Array.from(read('lib/sms.ts').matchAll(/smsRequest<[^>]+>\(\s*[`'](\/[^`'$?]*)/g)).map((m) => m[1]);
    // '/' is the read-one-message path (`/${index}`)
    expect(new Set(calls)).toEqual(new Set(['/inbox', '/sync', '/status', '/send', '/']));
    expect(read('lib/sms.ts')).not.toMatch(/text-parameters/);
  });

  it('adds the SMS page to the navigation and leaves the other pages in place', () => {
    const nav = read('components/layout/Navigation.tsx');
    expect(nav).toMatch(/href: '\/sms', label: 'SMS'/);
    for (const href of ['/', '/dialer', '/ai', '/calls', '/hardware', '/settings']) expect(nav).toContain(`href: '${href}'`);
  });
});
