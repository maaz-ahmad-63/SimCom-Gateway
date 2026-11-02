import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DiscoveryPanel } from '../src/components/hardware/HardwarePanels';
import { MessageList } from '../src/components/sms/SmsPanels';
import { discoverySummary, DiscoveryView, HardwareStatus } from '../src/lib/hardware-ops';
import { hardwareView, portText } from '../src/lib/hardware-mode';
import { InboxState, inboxNotices, listState, pollDelayMs, smsApi, SmsApiError, unseenSmsAlerts } from '../src/lib/sms';

const inbox = (over: Partial<InboxState> = {}): InboxState => ({
  running: true, syncing: false, pending: false, waiting: null, lastSyncAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
  storage: { name: 'ME', used: 1, total: 100 }, storageFull: false, indications: { cnmi: [2, 1, 0, 0, 0], notifies: true }, notificationsSeen: 0, storageMismatch: null,
  polling: { mode: 'off', intervalMs: null }, ...over,
});

describe('what the inbox list shows', () => {
  const base = { loading: false, error: null, count: 0, inbox: inbox(), folder: 'inbox' as const };

  it('is "empty" only when the gateway answered with no messages', () => {
    expect(listState(base)).toMatchObject({ kind: 'empty', text: expect.stringMatching(/appear here by themselves/) });
    expect(listState({ ...base, folder: 'sent' })).toMatchObject({ kind: 'empty', text: 'No sent messages yet.' });
    expect(listState({ ...base, count: 2 })).toEqual({ kind: 'messages', text: '' });
    expect(listState({ ...base, loading: true })).toMatchObject({ kind: 'loading' });
  });

  it('says the watcher is off instead of just "no messages"', () => {
    expect(listState({ ...base, inbox: inbox({ running: false }) }).text).toMatch(/not watching for new ones/);
  });

  it('distinguishes an offline gateway, a rejected key, missing setup and other failures', () => {
    for (const code of ['GATEWAY_UNREACHABLE', 'GATEWAY_TIMEOUT', 'NETWORK_ERROR', 'CLIENT_TIMEOUT']) {
      const view = listState({ ...base, error: new SmsApiError(502, code, 'x') });
      expect(view.kind, code).toBe('offline');
      expect(view.text).toMatch(/not answering/);
      expect(view.text).not.toMatch(/No received messages/);
    }
    expect(listState({ ...base, error: new SmsApiError(502, 'PROXY_KEY_REJECTED', 'x') }).kind).toBe('auth');
    expect(listState({ ...base, error: new SmsApiError(503, 'PROXY_NOT_CONFIGURED', 'x') }).kind).toBe('setup');
    expect(listState({ ...base, error: new SmsApiError(403, 'PROXY_FORBIDDEN_HOST', 'x') }).kind).toBe('setup');
    expect(listState({ ...base, error: new SmsApiError(500, 'SMS_STORE_UNAVAILABLE', 'The SMS store is not available') })).toEqual({ kind: 'error', text: 'The inbox could not be read: The SMS store is not available' });
  });

  it('keeps showing messages it already has when a later read fails', () => {
    expect(listState({ ...base, count: 3, error: new SmsApiError(502, 'GATEWAY_UNREACHABLE', 'x') }).kind).toBe('messages');
  });
});

describe('how the page keeps the list current', () => {
  it('polls the stored list every 30 s, and every 2 minutes while the gateway keeps failing, never stopping', () => {
    expect([0, 1, 2, 3, 10].map(pollDelayMs)).toEqual([30_000, 30_000, 30_000, 120_000, 120_000]);
  });

  it('reacts to every new "SMS:" realtime notice once, including two that arrive together', () => {
    const seen = new Set<string>();
    const alerts = [
      { message: 'SMS: 1 new message received', timestamp: 't2' },
      { message: 'Call ended', timestamp: 't1' },
      { message: 'SMS: 1 new message received', timestamp: 't0' },
    ];
    const first = unseenSmsAlerts(alerts, seen);
    expect(first).toEqual(['t2|SMS: 1 new message received', 't0|SMS: 1 new message received']);
    first.forEach((k) => seen.add(k));
    expect(unseenSmsAlerts(alerts, seen)).toEqual([]);
  });

  it('explains the fallback poll when the modem does not announce messages', () => {
    const notices = inboxNotices(inbox({ indications: { cnmi: [2, 0, 0, 0, 0], notifies: false }, polling: { mode: 'fallback', intervalMs: 120_000 } }), false);
    expect(notices.find((n) => n.key === 'indications')?.text).toMatch(/checks it every 120 s instead/);
    const noPoll = inboxNotices(inbox({ indications: { cnmi: [2, 0, 0, 0, 0], notifies: false }, polling: { mode: 'off', intervalMs: null } }), false);
    expect(noPoll.find((n) => n.key === 'indications')?.text).toMatch(/only when you press Refresh/);
  });
});

describe('an incoming message, from the gateway response to the screen', () => {
  it('shows sender, text, time and unread status exactly as the gateway stored them', async () => {
    // The response the gateway sends for GET /api/gateway/sms/inbox (shape checked in the gateway tests).
    const gatewayBody = {
      success: true,
      total: 1,
      unread: 1,
      inbox: inbox({ notificationsSeen: 1 }),
      messages: [
        { id: 7, direction: 'received', source: 'modem', storage: 'ME', index: 1, address: '+911234567890', text: 'Hello from a phone', time: '2026-10-27T12:30:00.000Z', modemStatus: 'REC UNREAD', read: false, sendStatus: null, messageReference: null, errorCode: null, errorMessage: null, onModem: true, firstSeenAt: '2026-10-27T12:30:05.000Z', lastSeenAt: '2026-10-27T12:30:05.000Z' },
      ],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(gatewayBody), { status: 200, headers: { 'content-type': 'application/json' } }));
    const response = await smsApi.inbox('received', fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(React.createElement(MessageList, { messages: response.messages, selectedId: null, onSelect: () => undefined, emptyText: '' }));
    expect(html).toContain('From +911234567890');
    expect(html).toContain('Hello from a phone');
    expect(html).toContain('Unread');
    expect(html).toMatch(/2026/);
  });
});

describe('the page source', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../src/app/sms/page.tsx'), 'utf8');

  it('opening the page reads the stored list only: the modem is read only by the Refresh button', () => {
    expect(page).toMatch(/useEffect\(\(\) => \{\s*setLoading\(true\);\s*setSelectedId\(null\);\s*void load\(true\);/);
    const syncCalls = page.match(/smsApi\.sync\(/g) ?? [];
    expect(syncCalls).toHaveLength(1);
    const refresh = page.slice(page.indexOf('const refresh = async'), page.indexOf('const check = useMemo'));
    expect(refresh).toContain('smsApi.sync(');
  });

  it('never stops polling for good, never marks read, never deletes, never retries a send', () => {
    expect(page).not.toMatch(/MAX_POLL_ERRORS/);
    expect(page).toMatch(/pollDelayMs\(/);
    expect(page).not.toMatch(/markRead\s*[:=]|method:\s*['"]DELETE['"]|AT\+CMGD/i);
    expect((page.match(/smsApi\.send\(/g) ?? []).length).toBe(1);
  });
});

describe('port discovery on the dashboard', () => {
  const view = (over: Partial<DiscoveryView> = {}): DiscoveryView => ({
    mode: 'discovery', explicit: { at: null, audio: null }, selector: null, lastScanAt: '2026-10-28T08:00:00.000Z', ok: true, code: null, message: null, warnings: [],
    at: 'COM20', audio: 'COM19', device: { id: '1E0E:9001:6&ABCD&0', vendorId: '1E0E', productId: '9001' },
    modems: [{ id: '1E0E:9001:6&ABCD&0', at: 'COM20', audio: 'COM19', problems: [], interfaces: [] }], ...over,
  });

  it('summarizes discovered, explicit, failed and not-yet-run states from what the gateway reported', () => {
    expect(discoverySummary(view())).toEqual({ state: 'ok', text: 'Discovered automatically: AT COM20, USB audio COM19 on modem 1E0E:9001:6&ABCD&0' });
    expect(discoverySummary(view({ mode: 'explicit', explicit: { at: 'COM33', audio: 'COM34' }, warnings: ['COM33 (set explicitly) is not present'] }))).toMatchObject({ state: 'warn', text: expect.stringMatching(/Ports set explicitly: AT COM33/) });
    expect(discoverySummary(view({ ok: false, code: 'MULTIPLE_MODEMS', message: '2 SIMCom modems are connected; the gateway does not guess which one to open.', at: null, audio: null, device: null }))).toEqual({ state: 'bad', text: '2 SIMCom modems are connected; the gateway does not guess which one to open.' });
    expect(discoverySummary(view({ ok: null }))).toMatchObject({ state: 'unknown' });
    expect(discoverySummary(null)).toMatchObject({ state: 'unknown' });
  });

  it('renders every modem found, marks the one in use, and names missing interfaces', () => {
    const status = { discovery: view({ modems: [view().modems[0], { id: '1E0E:9001:6&EEEE&0', at: 'COM40', audio: null, problems: ['no USB audio interface was found'], interfaces: [] }] }) } as unknown as HardwareStatus;
    const html = renderToStaticMarkup(React.createElement(DiscoveryPanel, { status }));
    expect(html).toContain('1E0E:9001:6&amp;ABCD&amp;0 (in use)');
    expect(html).toContain('audio not found');
    expect(html).toContain('no USB audio interface was found');
    expect(html).toContain('never writes them to .env');
  });

  it('shows an automatic port that has not been found as such, not as a COM number or "not configured"', () => {
    const relay = {
      relay: { gatewayUrl: 'http://127.0.0.1:4000', keyConfigured: true, keySource: 'repository-env' as const, urlSource: 'repository-env' as const },
      gateway: { ok: true as const, status: { gateway: { driverType: 'hardware', isSimulated: false }, modem: { connectionState: 'ERROR', configuredAtPort: 'auto', configuredAudioPort: 'auto' } } },
    };
    const hw = hardwareView(null, relay);
    expect(portText(hw, 'at')).toBe('automatic (modem not found yet)');
    expect(portText(hw, 'audio')).not.toMatch(/COM|not configured/);
  });
});
