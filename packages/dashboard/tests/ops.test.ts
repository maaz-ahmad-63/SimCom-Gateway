import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertCard, ConnectionBanner } from '../src/components/ops/AlertCenter';
import { BackupsPanel, ComponentRow, NetworkPanel } from '../src/components/ops/HealthView';
import { alertSummary, bannerAlerts, formatBytes, linkState, NetworkReading, OpsAlert, reconnectDelayMs, sortAlerts, timeAgo } from '../src/lib/ops';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const alert = (over: Partial<OpsAlert> = {}): OpsAlert => ({
  id: 1,
  key: 'modem:disconnected',
  component: 'modem',
  severity: 'critical',
  title: 'Modem disconnected',
  message: 'The gateway cannot reach the modem, so calls cannot be placed or received.',
  action: 'Check that the modem is plugged in and powered.',
  retry: 'recheck',
  status: 'active',
  count: 3,
  firstAt: '2026-11-04T11:50:00.000Z',
  lastAt: '2026-11-04T11:59:00.000Z',
  acknowledgedAt: null,
  dismissedAt: null,
  resolvedAt: null,
  ...over,
});

describe('alerts in customer words', () => {
  it('shows what happened, where, when and what to do, without a stack trace', () => {
    const html = renderToStaticMarkup(React.createElement(AlertCard, { alert: alert(), now: NOW, onAcknowledge: () => {}, onRecheck: () => {}, onDetails: () => {} }));
    expect(html).toContain('Modem disconnected');
    expect(html).toContain('Critical');
    expect(html).toContain('modem');
    expect(html).toContain('What to do: ');
    expect(html).toContain('Check that the modem is plugged in');
    expect(html).toContain('Started 10 minutes ago');
    expect(html).toContain('seen 3 times');
    expect(html).toContain('Check again');
    expect(html).toContain('Technical details');
    expect(html).not.toMatch(/at Object\.|node_modules|Error:/);
    expect(html).toContain('role="alert"');
  });

  it('offers Dismiss only for notices that are not critical, and Check again only when it is safe', () => {
    const crit = renderToStaticMarkup(React.createElement(AlertCard, { alert: alert(), onDismiss: () => {}, onAcknowledge: () => {} }));
    expect(crit).not.toContain('>Dismiss<');
    expect(crit).toContain('>Acknowledge<');
    const warn = renderToStaticMarkup(React.createElement(AlertCard, { alert: alert({ severity: 'warning', retry: null }), onDismiss: () => {}, onRecheck: () => {} }));
    expect(warn).toContain('>Dismiss<');
    expect(warn).not.toContain('Check again');
    const resolved = renderToStaticMarkup(React.createElement(AlertCard, { alert: alert({ status: 'resolved', resolvedAt: '2026-11-04T11:59:30.000Z' }), now: NOW, onDismiss: () => {}, onRecheck: () => {}, onAcknowledge: () => {} }));
    expect(resolved).toContain('resolved');
    expect(resolved).not.toContain('>Acknowledge<');
  });

  it('keeps a critical alert in the banner until it is acknowledged, and orders worst first', () => {
    const list = [alert({ id: 1, severity: 'warning' }), alert({ id: 2, severity: 'critical' }), alert({ id: 3, severity: 'error' })];
    expect(sortAlerts(list).map((a) => a.id)).toEqual([2, 3, 1]);
    expect(bannerAlerts(list).map((a) => a.id)).toEqual([2]);
    expect(bannerAlerts([alert({ acknowledgedAt: '2026-11-04T11:59:00.000Z' })])).toEqual([]);
    expect(alertSummary([])).toBe('No problems');
    expect(alertSummary(list)).toBe('1 critical, 1 error, 1 warning');
  });
});

describe('losing the gateway', () => {
  it('is judged from how long ago the last answer came, not from one failed request', () => {
    expect(linkState({ lastSuccessAt: NOW - 2000, failures: 0, now: NOW })).toMatchObject({ state: 'live', stale: false });
    expect(linkState({ lastSuccessAt: NOW - 2000, failures: 1, now: NOW })).toMatchObject({ state: 'reconnecting' });
    expect(linkState({ lastSuccessAt: NOW - 120_000, failures: 4, now: NOW })).toMatchObject({ state: 'lost', stale: true });
    expect(linkState({ lastSuccessAt: null, failures: 0, now: NOW }).state).toBe('reconnecting');
    expect(linkState({ lastSuccessAt: null, failures: 2, now: NOW }).state).toBe('lost');
    expect(linkState({ lastSuccessAt: NOW - 90_000, failures: 0, now: NOW })).toMatchObject({ state: 'live', stale: true });
    expect(linkState({ lastSuccessAt: NOW - 120_000, failures: 4, now: NOW }).message).toMatch(/out of date/);
  });

  it('backs off between reconnect attempts but never waits more than half a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(reconnectDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('shows nothing while connected and a clear banner when not', () => {
    expect(renderToStaticMarkup(React.createElement(ConnectionBanner, { state: 'live', message: '', onRetry: () => {} }))).toBe('');
    const lost = renderToStaticMarkup(React.createElement(ConnectionBanner, { state: 'lost', message: 'Lost contact', onRetry: () => {} }));
    expect(lost).toContain('Gateway not reachable');
    expect(lost).toContain('Try now');
    expect(renderToStaticMarkup(React.createElement(ConnectionBanner, { state: 'reconnecting', message: 'x', onRetry: () => {} }))).toContain('Reconnecting');
  });
});

describe('formatting never invents a value', () => {
  it('says never, unknown and just now plainly', () => {
    expect(timeAgo(null, NOW)).toBe('never');
    expect(timeAgo('not a date', NOW)).toBe('unknown');
    expect(timeAgo(new Date(NOW - 3000).toISOString(), NOW)).toBe('just now');
    expect(timeAgo(new Date(NOW - 90 * 60_000).toISOString(), NOW)).toBe('2 hours ago');
    expect(formatBytes(17_400_000_000)).toBe('16.2 GB');
  });
});

const reading = (over: Partial<NetworkReading> = {}): NetworkReading => ({
  takenAt: new Date(NOW - 20_000).toISOString(),
  source: 'hardware',
  skippedBecause: null,
  sim: { state: 'ready', raw: '+CPIN: READY' },
  signal: { rssi: 20, ber: 0, dbm: -73, level: 'excellent', text: 'excellent (-73 dBm)', raw: '+CSQ: 20,0' },
  registration: { cs: { stat: 1, registered: true, text: 'registered (home network)', raw: '+CREG: 0,1' }, eps: { stat: 1, registered: true, text: 'registered (home network)', raw: '+CEREG: 0,1' }, ps: { stat: null, registered: false, text: 'no answer from the modem', raw: null } },
  operator: 'Vi India',
  verdict: { code: 'ok', severity: 'ok', title: 'Mobile network ready', explanation: 'Registered (home network), signal excellent (-73 dBm).', action: '', uncertain: false },
  ...over,
});

describe('health page pieces', () => {
  it('shows the SIM and network with raw replies kept for support, and says when it cannot be sure', () => {
    const html = renderToStaticMarkup(React.createElement(NetworkPanel, { reading: reading(), now: NOW, onRefresh: () => {}, busy: false }));
    for (const text of ['Mobile network ready', 'Vi India', '-73 dBm', 'Voice registration', 'LTE registration', 'Data registration', 'No answer', 'Raw modem replies', '+CSQ: 20,0']) expect(html, text).toContain(text);
    const uncertain = renderToStaticMarkup(
      React.createElement(NetworkPanel, { reading: reading({ verdict: { code: 'voice_unconfirmed', severity: 'warning', title: 'Voice service not confirmed', explanation: 'e', action: 'Place a test call.', uncertain: true }, skippedBecause: 'A call is in progress.' }), now: NOW, onRefresh: () => {}, busy: false })
    );
    expect(uncertain).toContain('did not give enough information');
    expect(uncertain).toContain('Latest attempt skipped: A call is in progress.');
    expect(renderToStaticMarkup(React.createElement(NetworkPanel, { reading: null, onRefresh: () => {}, busy: false }))).toContain('No reading yet');
    expect(renderToStaticMarkup(React.createElement(NetworkPanel, { reading: reading({ signal: { rssi: 99, ber: 99, dbm: null, level: 'unknown', text: 'unknown', raw: '+CSQ: 99,99' } }), now: NOW, onRefresh: () => {}, busy: false }))).toContain('Unknown');
  });

  it('shows each component with its status and when it was checked', () => {
    const html = renderToStaticMarkup(React.createElement(ComponentRow, { c: { id: 'storage', label: 'Storage and recordings', status: 'warning', summary: '1.4 GB free', observedAt: new Date(NOW - 5 * 60_000).toISOString() }, now: NOW }));
    expect(html).toContain('Storage and recordings');
    expect(html).toContain('Disk space for data and call recordings.');
    expect(html).toContain('Warning');
    expect(html).toContain('checked 5 minutes ago');
  });

  it('lists backups, explains that a restore waits for the next start, and asks before staging one', () => {
    const idle = { status: 'idle' } as never;
    const html = renderToStaticMarkup(
      React.createElement(BackupsPanel, { backups: [{ name: 'manual-20261104100000.sqlite', bytes: 5_200_000, createdAt: new Date(NOW - 3_600_000).toISOString(), kind: 'manual' }], pending: { name: 'manual-20261104100000.sqlite', stagedAt: new Date(NOW).toISOString() }, onCreate: () => {}, onRestore: () => {}, onCancel: () => {}, create: idle, restore: idle })
    );
    expect(html).toContain('manual-20261104100000.sqlite');
    expect(html).toContain('5 MB');
    expect(html).toContain('applied the next time the application starts');
    expect(html).toContain('Cancel the restore');
    expect(html).toContain('Back up now');
    expect(html).toContain('Restore…');
    expect(renderToStaticMarkup(React.createElement(BackupsPanel, { backups: [], pending: null, onCreate: () => {}, onRestore: () => {}, onCancel: () => {}, create: idle, restore: idle }))).toContain('No backups yet');
  });
});
