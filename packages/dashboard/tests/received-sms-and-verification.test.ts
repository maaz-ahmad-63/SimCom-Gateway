import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxState, inboxNotices, listState, smsRequest, SmsApiError } from '../src/lib/sms';

const inbox = (over: Partial<InboxState> = {}): InboxState => ({
  running: true, syncing: false, pending: false, waiting: null, lastSyncAt: '2026-10-28T08:43:37.766Z', lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
  storage: null, storageFull: false, indications: null, notificationsSeen: 0, storageMismatch: null, polling: { mode: 'fallback', intervalMs: 120_000 }, listMode: null, ...over,
});

/** What the live gateway reported before the fix: every read failed, nothing was ever stored. */
const failing = inbox({
  lastError: { code: 'MODEM_ERROR', message: "AT command 'AT+CMGL=\"ALL\"' failed: AT ERROR", at: '2026-10-28T08:43:37.800Z', command: 'AT+CMGL="ALL"', hint: 'The modem answered ERROR to AT+CMGL="ALL". Check the modem\'s SMS settings on the SMS page (Check settings, read-only); the stored messages are unaffected.' },
  consecutiveFailures: 9,
});

describe('received messages when reading fails', () => {
  it('says the reads are failing instead of "No received messages" (the reported screen)', () => {
    const view = listState({ loading: false, error: null, count: 0, inbox: failing, folder: 'inbox' });
    expect(view.kind).toBe('error');
    expect(view.text).toMatch(/none has been read from the modem: the last read failed \(MODEM_ERROR\)/);
    expect(view.text).not.toMatch(/No received messages yet/);
  });

  it('after an earlier successful read, says nothing is stored and why the latest read failed', () => {
    const view = listState({ loading: false, error: null, count: 0, inbox: { ...failing, lastSuccessAt: '2026-10-28T08:00:00.000Z' }, folder: 'inbox' });
    expect(view.text).toMatch(/^No received messages are stored: the last read failed \(MODEM_ERROR\)/);
  });

  it('still lists stored messages while the modem reads fail (the inbox is the database)', () => {
    expect(listState({ loading: false, error: null, count: 2, inbox: failing, folder: 'inbox' }).kind).toBe('messages');
    expect(listState({ loading: false, error: null, count: 0, inbox: failing, folder: 'sent' }).kind).toBe('empty');
  });

  it('the notice names the failing command, the count and what to do, from the gateway\'s sanitized diagnostics', () => {
    const text = inboxNotices(failing, false).find((n) => n.key === 'error')!.text;
    expect(text).toMatch(/failed \(MODEM_ERROR, 9 times in a row\)/);
    expect(text).toContain('Command: AT+CMGL="ALL".');
    expect(text).toMatch(/Check settings, read-only/);
    // An older gateway without hint/command still gets a useful line.
    const old = inboxNotices(inbox({ lastError: { code: 'MODEM_ERROR', message: 'AT ERROR', at: 'x' }, consecutiveFailures: 1 }), false).find((n) => n.key === 'error')!.text;
    expect(old).toMatch(/\(MODEM_ERROR, 1 time in a row\)\. AT ERROR/);
  });

  it('explains the standard listing once the gateway uses it', () => {
    const notice = inboxNotices(inbox({ listMode: 'standard', lastSuccessAt: 'x' }), false).find((n) => n.key === 'list-mode');
    expect(notice?.text).toMatch(/keeps each message Unread here/);
    expect(inboxNotices(inbox({ listMode: 'status-preserving' }), false).some((n) => n.key === 'list-mode')).toBe(false);
  });

  it('a database failure relayed from the gateway is reported as such, not as an empty inbox', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ success: false, code: 'SMS_STORE_ERROR', error: 'The gateway could not read its message database: SQLITE_CORRUPT' }), { status: 500, headers: { 'content-type': 'application/json' } });
    const error = (await smsRequest('/inbox', { fetchImpl }).catch((e: unknown) => e)) as SmsApiError;
    expect(error).toMatchObject({ code: 'SMS_STORE_ERROR', status: 500 });
    const view = listState({ loading: false, error, count: 0, inbox: null, folder: 'inbox' });
    expect(view.kind).toBe('error');
    expect(view.text).toMatch(/could not read its message database/);
    expect(view.text).toMatch(/not deleted/);
  });
});

describe('the audio confirmation card', () => {
  afterEach(() => {
    vi.doUnmock('../src/lib/context/AiContext');
    vi.resetModules();
  });

  const render = async (attestation: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('../src/lib/context/AiContext', () => ({
      useAi: () => ({ state: { settings: { attestations: { inbound: attestation, outbound: attestation } } }, refresh: async () => undefined }),
    }));
    const { AttestationCard } = await import('../src/components/ai/OverviewTab');
    return renderToStaticMarkup(React.createElement(AttestationCard, { kind: 'inbound' }));
  };
  const note = 'Call at 14:05: the transcript read what I said';

  it('after confirmation shows a static status with the saved note, time and rate, and a Re-verify action, not the form', async () => {
    const html = await render({ confirmed: true, confirmedAt: '2026-10-26T11:18:06.359Z', note, source: 'stored', sampleRate: 8000, stale: false, staleReason: null });
    expect(html).toContain('Confirmed (stored)');
    expect(html).toContain(note);
    expect(html).toMatch(/Confirmed .*2026.* at 8000 Hz\. Kept across reloads and restarts\./);
    expect(html).toContain('Re-verify');
    expect(html).toContain('Remove confirmation');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('I verified this');
  });

  it('after a rate change keeps the note visible, explains why it does not count, and asks for re-verification', async () => {
    const html = await render({ confirmed: false, confirmedAt: '2026-10-26T11:18:06.359Z', note, source: 'stored', sampleRate: 8000, stale: true, staleReason: 'Confirmed at 8000 Hz; the gateway is now set to 16000 Hz. Audio at the current rate has not been verified: re-verify on a real call, or switch back to 8000 Hz and this confirmation counts again.' });
    expect(html).toContain('Needs re-verification');
    expect(html).toContain(note);
    expect(html).toMatch(/the gateway is now set to 16000 Hz/);
    expect(html).toContain('Re-verify');
    expect(html).not.toContain('<textarea'); // the form appears only on an explicit Re-verify
  });

  it('without any confirmation shows the form, and the real-call requirement', async () => {
    const html = await render({ confirmed: false, confirmedAt: null, note: null, source: 'none', sampleRate: null, stale: false, staleReason: null });
    expect(html).toContain('Not confirmed');
    expect(html).toContain('<textarea');
    expect(html).toContain('I verified this');
    expect(html).toMatch(/Confirm only after a real call/);
  });

  it('a confirmation from the gateway .env is shown as such and cannot be removed from here', async () => {
    const html = await render({ confirmed: true, confirmedAt: null, note: null, source: 'env', sampleRate: null, stale: false, staleReason: null });
    expect(html).toContain('Confirmed (env)');
    expect(html).toContain('Set in the gateway .env');
    expect(html).not.toContain('Remove confirmation');
  });
});
