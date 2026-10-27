import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient } from '../src/lib/api-client';
import { formatDuration, recorderState, recordingSummary, RecorderStatus, RecordingInfo } from '../src/lib/recordings';
import { RecordingPanel } from '../src/components/ai/RecordingCard';

const status = (over: Partial<RecorderStatus> = {}): RecorderStatus => ({
  enabled: true, consentAcknowledged: true, inactiveReason: null, dir: './call-recordings', active: null, lastError: null, retentionDays: 0, ...over,
});
const rec = (over: Partial<RecordingInfo> = {}): RecordingInfo => ({
  callId: '11111111-2222-4333-8444-555555555555', direction: 'inbound', startedAt: '2026-10-26T08:42:28.000Z', endedAt: '2026-10-26T08:43:28.000Z',
  complete: true, outcome: 'completed', sampleRate: 8000, isSimulated: false, truncated: false,
  tracks: { caller: { file: 'caller.wav', bytes: 960000, durationMs: 60000, hasAudio: true }, agent: { file: 'agent.wav', bytes: 960000, durationMs: 60000, hasAudio: true } }, ...over,
});

describe('recorder state', () => {
  it('distinguishes off, blocked by missing consent, armed, recording and failed', () => {
    expect(recorderState(null).label).toBe('Unknown');
    expect(recorderState(status({ enabled: false, inactiveReason: 'call recording is off' }))).toMatchObject({ label: 'Off', tone: 'neutral' });
    expect(recorderState(status({ inactiveReason: 'CALL_RECORDING_CONSENT_ACKNOWLEDGED is not true' }))).toMatchObject({ label: 'Blocked', tone: 'warn' });
    expect(recorderState(status())).toMatchObject({ label: 'Armed', tone: 'good' });
    expect(recorderState(status({ active: { callId: 'abcdef12-0000', startedAt: 'x', callerBytes: 1, agentBytes: 0 } })).label).toBe('Recording');
    expect(recorderState(status({ lastError: 'disk full' }))).toMatchObject({ label: 'Error', tone: 'bad', detail: 'disk full' });
  });

  it('formats durations and summarises what a recording does and does not contain', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(recordingSummary(rec())).toBe('complete');
    const s = recordingSummary(rec({ complete: false, isSimulated: true, truncated: true, tracks: { caller: { file: 'c', bytes: 0, durationMs: 0, hasAudio: false }, agent: { file: 'a', bytes: 0, durationMs: 0, hasAudio: false } } }));
    for (const part of ['incomplete', 'no caller audio was received', 'nothing was written to the caller', 'stopped at the time limit', 'simulated audio']) expect(s).toContain(part);
  });
});

describe('recording panel', () => {
  const render = (data: Parameters<typeof RecordingPanel>[0]['data'], error: string | null = null) =>
    renderToStaticMarkup(React.createElement(RecordingPanel, { data, error, onDownload: vi.fn() }));

  it('shows state, the recordings and per-track downloads, and says recordings are separate from diagnostic captures', () => {
    const html = render({ status: status(), recordings: [rec()] });
    expect(html).toContain('Armed');
    expect(html).toContain('Download caller.wav');
    expect(html).toContain('Download agent.wav');
    expect(html).toContain('1:00');
    expect(html).toContain('separate from the diagnostic captures');
  });

  it('shows why nothing is recorded and any error', () => {
    const html = render({ status: status({ enabled: true, inactiveReason: 'recording is enabled but CALL_RECORDING_CONSENT_ACKNOWLEDGED is not true' }), recordings: [] }, 'Gateway down');
    expect(html).toContain('Blocked');
    expect(html).toContain('CALL_RECORDING_CONSENT_ACKNOWLEDGED');
    expect(html).toContain('No recordings yet');
    expect(html).toContain('role="alert"');
  });
});

describe('recording API client', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const client = new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000/', apiKey: 'gw-key-123456' });

  it('downloads a track with the API key header and reports a refusal', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['wav']) }) as never;
    await client.downloadRecording('11111111-2222-4333-8444-555555555555', 'caller');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/gateway/recordings/11111111-2222-4333-8444-555555555555/caller.wav');
    expect(init.headers['x-api-key']).toBe('gw-key-123456');

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
    await expect(client.downloadRecording('x', 'agent')).rejects.toMatchObject({ statusCode: 404 });
  });
});
