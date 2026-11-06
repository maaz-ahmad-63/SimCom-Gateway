import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient } from '../src/lib/api-client';
import {
  formatPosition,
  loadRecordingUrl,
  nextRecordingAction,
  progressPercent,
  RecordingAvailability,
  recordingAvailability,
  RecordingInfo,
} from '../src/lib/recordings';
import { PlayerViewProps, RecordingActionButton, RecordingPlayerView } from '../src/components/calls/RecordingPlayer';
import { rec } from './helpers/recordings';

const CALL = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

/** A canonical 44-byte-header PCM WAV, as the gateway serves. */
function wavBlob(samples = 800): Blob {
  const data = new Uint8Array(samples * 2);
  const h = new DataView(new ArrayBuffer(44));
  const tag = (o: number, s: string) => s.split('').forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); h.setUint32(4, 36 + data.length, true); tag(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, 8000, true); h.setUint32(28, 16000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); tag(36, 'data'); h.setUint32(40, data.length, true);
  return new Blob([h.buffer, data], { type: 'audio/wav' });
}

const call = (over: Partial<{ id: string; answeredAt: string | null; outcome: string | null }> = {}) => ({ id: CALL, answeredAt: '2026-10-26T08:42:30.000Z', outcome: 'completed', ...over });
const lookup = (...recs: RecordingInfo[]) => new Map(recs.map((r) => [r.callId, r]));

describe('does this call have a recording to play?', () => {
  it('available: the gateway says it can be played', () => {
    const r = rec();
    expect(recordingAvailability(call(), lookup(r))).toEqual({ state: 'available', recording: r });
  });

  it('unknown while the gateway has not answered: Play is offered and reports what happens when pressed', () => {
    expect(recordingAvailability(call(), null)).toEqual({ state: 'unknown' });
  });

  it('none, with a reason a person can act on, for each way a call can lack one', () => {
    const reason = (a: RecordingAvailability) => (a.state === 'none' ? a.reason : `(${a.state})`);
    // Never connected: nothing to record.
    expect(reason(recordingAvailability(call({ answeredAt: null, outcome: 'missed' }), lookup()))).toMatch(/never answered/);
    expect(reason(recordingAvailability(call({ answeredAt: null, outcome: null }), lookup()))).toMatch(/never answered/);
    // Answered but not recorded, from a gateway that did not note why (an older one, or a call from before it did).
    expect(reason(recordingAvailability(call(), lookup()))).toMatch(/No recording exists for this call.*Settings > Call Recording/);
    // Answered but not recorded, with the reason the gateway noted when the call connected: each says what happened.
    const skip = (status: string, why = 'x') => new Map([[CALL, { callId: CALL, status, reason: why, at: '2026-11-06T10:00:00.000Z' }]]);
    expect(reason(recordingAvailability(call(), lookup(), skip('off')))).toMatch(/switched off when this call connected/);
    expect(reason(recordingAvailability(call(), lookup(), skip('no-consent')))).toMatch(/consent acknowledgement had not been confirmed/);
    expect(reason(recordingAvailability(call(), lookup(), skip('start-failed', 'EACCES')))).toMatch(/could not start.*EACCES/);
    expect(reason(recordingAvailability(call(), lookup(), skip('config-error', 'recording configuration is invalid')))).toMatch(/Not recorded: recording configuration is invalid/);
    // A recording that exists always wins over a noted reason.
    expect(recordingAvailability(call(), lookup(rec()), skip('off')).state).toBe('available');
    // Recorded, but still being recorded or finished.
    expect(reason(recordingAvailability(call(), lookup(rec({ available: false, endedAt: null, file: null, complete: false }))))).toMatch(/still being recorded/);
    expect(reason(recordingAvailability(call(), lookup(rec({ available: false, file: null, complete: false }))))).toMatch(/still being finished/);
    expect(reason(recordingAvailability(call(), lookup(rec({ available: false, file: null, complete: false, error: 'disk full' }))))).toMatch(/could not be finished: disk full/);
    expect(reason(recordingAvailability(call(), lookup(rec({ available: false, endedAt: null, file: null, complete: false, error: 'disk full' }))))).toMatch(/failed: disk full/);
    // The file is gone (retention).
    expect(reason(recordingAvailability(call(), lookup(rec({ available: false }))))).toMatch(/no longer on the gateway/);
  });

  it('a call whose lookup lists another call is not mistaken for it', () => {
    expect(recordingAvailability(call({ id: OTHER }), lookup(rec())).state).toBe('none');
  });
});

describe('what the recording button does when pressed', () => {
  const available: RecordingAvailability = { state: 'available', recording: rec() };
  const none: RecordingAvailability = { state: 'none', reason: 'x' };

  it('opens a call\'s row when it is not the open one (closing whichever was open: one player at a time)', () => {
    expect(nextRecordingAction(null, CALL, available)).toBe('open');
    expect(nextRecordingAction(OTHER, CALL, available)).toBe('open');
    expect(nextRecordingAction(OTHER, CALL, none)).toBe('open');
    expect(nextRecordingAction(null, CALL, { state: 'unknown' })).toBe('open');
  });

  it('pauses or resumes when its player is already open, and closes the explanation when there is no recording', () => {
    expect(nextRecordingAction(CALL, CALL, available)).toBe('toggle');
    expect(nextRecordingAction(CALL, CALL, { state: 'unknown' })).toBe('toggle');
    expect(nextRecordingAction(CALL, CALL, none)).toBe('close');
  });
});

describe('the Play button in the Actions column', () => {
  const button = (over: Partial<Parameters<typeof RecordingActionButton>[0]> = {}) =>
    html(React.createElement(RecordingActionButton, { availability: { state: 'available', recording: rec() }, open: false, playing: false, onClick: noop, ...over }));

  it('shows Play when a recording is available', () => {
    const out = button();
    expect(out).toContain('aria-label="Play recording"');
    expect(out).toContain('title="Play the recording of this call"');
    expect(out).toContain('aria-expanded="false"');
  });

  it('is offered while the gateway has not said (so a recording is never hidden by a failed lookup)', () => {
    expect(button({ availability: { state: 'unknown' } })).toContain('aria-label="Play recording"');
  });

  it('turns into Pause while this call is playing, and back to Play when paused', () => {
    expect(button({ open: true, playing: true })).toContain('aria-label="Pause recording"');
    expect(button({ open: true, playing: false })).toContain('aria-label="Play recording"');
    expect(button({ open: false, playing: true })).toContain('aria-label="Play recording"'); // another call is the one playing
  });

  it('is a muted "no recording" icon that carries the reason, instead of a Play that would fail', () => {
    const out = button({ availability: { state: 'none', reason: 'This call was never answered, so there is nothing to record.' } });
    expect(out).toContain('aria-label="No recording for this call"');
    expect(out).toContain('title="This call was never answered, so there is nothing to record."');
    expect(out).not.toContain('Play recording');
  });
});

describe('the player', () => {
  const base: PlayerViewProps = {
    phase: 'ready', error: null, playing: false, position: 0, duration: 60, recording: rec(), fileName: 'call-11111111.wav',
    url: 'blob:http://localhost/abc', onToggle: noop, onSeek: noop, onRetry: noop,
  };
  const view = (over: Partial<PlayerViewProps> = {}) => html(React.createElement(RecordingPlayerView, { ...base, ...over }));

  it('shows a loading state while the recording is fetched', () => {
    const out = view({ phase: 'loading', url: null });
    expect(out).toContain('Loading the recording');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('aria-label="Playback position"');
  });

  it('shows the failure reason with a way to try again', () => {
    const out = view({ phase: 'error', error: 'No recording exists for this call.', url: null });
    expect(out).toContain('role="alert"');
    expect(out).toContain('No recording exists for this call.');
    expect(out).toContain('Try again');
    expect(view({ phase: 'error', error: null, url: null })).toContain('The recording could not be played.');
  });

  it('paused: a Play control, the position slider, the time, and a download of the very file being played', () => {
    const out = view({ position: 12.4 });
    expect(out).toContain('aria-label="Play recording"');
    expect(out).toContain('aria-label="Playback position"');
    expect(out).toMatch(/max="60"/);
    expect(out).toMatch(/value="12.4"/);
    expect(out).toContain('0:12 / 1:00');
    expect(out).toContain('aria-valuenow="21"'); // 12.4 of 60 s
    expect(out).toMatch(/<a[^>]*href="blob:http:\/\/localhost\/abc"[^>]*download="call-11111111\.wav"|<a[^>]*download="call-11111111\.wav"[^>]*href="blob:http:\/\/localhost\/abc"/);
    expect(out).toContain('complete'); // the one-line description of the recording
  });

  it('playing: a Pause control instead, progress advancing', () => {
    expect(view({ playing: true, position: 30 })).toContain('aria-label="Pause recording"');
    expect(view({ playing: true, position: 30 })).toContain('0:30 / 1:00');
    expect(view({ playing: true, position: 30 })).toContain('aria-valuenow="50"');
  });

  it('copes with a length that is not known yet (no division by zero, a usable slider)', () => {
    const out = view({ duration: 0, position: 0 });
    expect(out).toContain('0:00 / 0:00');
    expect(out).toContain('aria-valuenow="0"');
    expect(out).toMatch(/max="1"/);
  });
});

describe('progress and time', () => {
  it('measures progress, clamped, and never divides by zero', () => {
    expect(progressPercent(15, 60)).toBe(25);
    expect(progressPercent(90, 60)).toBe(100);
    expect(progressPercent(-3, 60)).toBe(0);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(Number.NaN, 60)).toBe(0);
    expect(progressPercent(5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('formats the position as minutes:seconds of the whole', () => {
    expect(formatPosition(0, 0)).toBe('0:00 / 0:00');
    expect(formatPosition(75.4, 273)).toBe('1:15 / 4:33');
    expect(formatPosition(Number.NaN, 61)).toBe('0:00 / 1:01');
  });
});

describe('loading the recording through the authenticated route', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
    vi.restoreAllMocks();
  });
  const client = new GatewayApiClient({ gatewayUrl: 'http://gw:4000/', apiKey: 'gw-key-123456' });
  const deps = (createObjectUrl = vi.fn(() => 'blob:copy')) => ({ download: (id: string) => client.downloadRecording(id), createObjectUrl });

  it('fetches with the API key, checks it is a WAV, and hands back a URL for the browser\'s own copy', async () => {
    const blob = wavBlob(1600);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob }) as never;
    const create = vi.fn(() => 'blob:copy');
    const loaded = await loadRecordingUrl(CALL, deps(create));
    expect(loaded).toEqual({ url: 'blob:copy', bytes: blob.size });
    expect(create).toHaveBeenCalledWith(blob);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe(`http://gw:4000/api/gateway/recordings/${CALL}/audio.wav`);
    expect(init.headers['x-api-key']).toBe('gw-key-123456'); // nothing is fetched without the key
  });

  it('says so, in plain words, when there is no recording, the key is refused, or the gateway is down', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
    await expect(loadRecordingUrl(CALL, deps())).rejects.toThrow('No recording exists for this call.');
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never;
    await expect(loadRecordingUrl(CALL, deps())).rejects.toThrow(/API key/);
    global.fetch = vi.fn().mockRejectedValue(new Error('down')) as never;
    await expect(loadRecordingUrl(CALL, deps())).rejects.toThrow(/Failed to connect to Gateway/);
  });

  it('refuses an empty answer and anything that is not a WAV, instead of failing silently in the player', async () => {
    const create = vi.fn(() => 'blob:copy');
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob([]) }) as never;
    await expect(loadRecordingUrl(CALL, deps(create))).rejects.toThrow(/empty recording/);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['<html>login</html>'], { type: 'text/html' }) }) as never;
    await expect(loadRecordingUrl(CALL, deps(create))).rejects.toThrow(/not send a WAV/);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['RIFF']) }) as never; // truncated header
    await expect(loadRecordingUrl(CALL, deps(create))).rejects.toThrow(/not send a WAV/);
    expect(create).not.toHaveBeenCalled(); // no browser copy is made of something that cannot be played
  });
});

describe('the Call History table and player (what the source guarantees)', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
  const table = read('src/components/calls/CallHistoryTable.tsx');
  const player = read('src/components/calls/RecordingPlayer.tsx');

  it('puts the recording button in the Actions column beside the existing View icon, which is unchanged', () => {
    const actions = table.slice(table.indexOf('justify-end gap-1'));
    expect(actions.indexOf('<RecordingActionButton')).toBeGreaterThan(-1);
    expect(actions.indexOf('<RecordingActionButton')).toBeLessThan(actions.indexOf('<Eye'));
    expect(table).toContain('title="Inspect Call Timeline"');
    expect(table).toContain('setSelectedCallId(call.id)');
  });

  it('asks the gateway about the calls on the page, and falls back to offering Play when it cannot', () => {
    expect(table).toContain('apiClient.getRecordings(ids)');
    expect(table).toMatch(/catch \{\s*setRecordings\(null\)/);
  });

  it('plays only a browser copy fetched with the API key: no recording URL is ever built in the page', () => {
    expect(player).not.toContain('audio.wav');
    expect(player).not.toMatch(/gatewayUrl|NEXT_PUBLIC/);
    expect(player).toContain('apiClient.downloadRecording');
    expect(player).toContain('URL.createObjectURL');
    expect(player).toContain('URL.revokeObjectURL'); // the copy is released when the player closes
    expect(table).not.toContain('audio.wav');
    expect(table).not.toMatch(/<audio/);
  });

  it('has pause and resume, a seekable position, loading and error states with retry', () => {
    for (const needle of ['Pause recording', 'Play recording', 'Playback position', 'Loading the recording', 'Try again', 'onTimeUpdate', 'currentTime']) expect(player).toContain(needle);
  });
});
