import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient } from '../src/lib/api-client';
import { formatDuration, recorderState, recordingSummary, RecorderStatus } from '../src/lib/recordings';
import { RecordingPanel } from '../src/components/ai/RecordingCard';
import { rec } from './helpers/recordings';

const CALL = '11111111-2222-4333-8444-555555555555';

const status = (over: Partial<RecorderStatus> = {}): RecorderStatus => ({
  enabled: true, consentAcknowledged: true, inactiveReason: null, dir: './call-recordings', active: null, lastError: null, retentionDays: 0, ...over,
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
    const s = recordingSummary(rec({ complete: false, isSimulated: true, truncated: true, hasCallerAudio: false, hasAgentAudio: false }));
    for (const part of ['incomplete', 'no caller audio was received', 'nothing was written to the caller', 'stopped at the time limit', 'simulated audio']) expect(s).toContain(part);
  });

  it('says when the caller\'s side was raised in the mix, so nothing about the audio is hidden', () => {
    const mix = { callerGainDb: 9.6, callerVoicedFrames: 200, callerSpeechDbfs: -27, agentSpeechDbfs: -15, callerPeak: 5000, agentPeak: 26000, clippedSamples: 0 };
    expect(recordingSummary(rec({ mix }))).toContain('caller raised 9.6 dB');
    expect(recordingSummary(rec({ mix: { ...mix, callerGainDb: 0 } }))).not.toContain('raised');
  });
});

describe('recording panel', () => {
  const render = (data: Parameters<typeof RecordingPanel>[0]['data'], error: string | null = null) =>
    renderToStaticMarkup(React.createElement(RecordingPanel, { data, error, onDownload: vi.fn() }));

  it('shows state, the recordings and ONE download per call, and says recordings are separate from diagnostic captures', () => {
    const html = render({ status: status(), recordings: [rec()] });
    expect(html).toContain('Armed');
    expect(html).toContain('Download recording.wav');
    expect(html).not.toContain('caller.wav');
    expect(html).not.toContain('agent.wav');
    expect(html).toContain('1:00');
    expect(html).toContain('separate from the diagnostic captures');
    expect(html).toContain('One WAV per call');
  });

  it('does not offer a download for a recording that is not ready', () => {
    const html = render({ status: status(), recordings: [rec({ available: false, file: null, complete: false })] });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Download recording\.wav<\/button>|<button[^>]*>Download recording\.wav<\/button>/);
    expect(html).toMatch(/disabled=""/);
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

  it('downloads the one combined recording with the API key header', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['wav']) }) as never;
    await client.downloadRecording(CALL);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4000/api/gateway/recordings/${CALL}/audio.wav`);
    expect(init.headers['x-api-key']).toBe('gw-key-123456');
  });

  it('turns a refusal into a message a person can act on', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
    await expect(client.downloadRecording('x')).rejects.toMatchObject({ statusCode: 404, code: 'RECORDING_NOT_FOUND', message: 'No recording exists for this call.' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never;
    await expect(client.downloadRecording(CALL)).rejects.toMatchObject({ statusCode: 401, message: expect.stringContaining('API key') });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    await expect(client.downloadRecording(CALL)).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('HTTP 500') });
    global.fetch = vi.fn().mockRejectedValue(new Error('connect refused')) as never;
    await expect(client.downloadRecording(CALL)).rejects.toMatchObject({ statusCode: 0, code: 'NETWORK_ERROR' });
  });

  it('asks about exactly the calls on a page, with the key', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: null, recordings: [] }) }) as never;
    await client.getRecordings([CALL, '66666666-7777-4888-9999-aaaaaaaaaaaa']);
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:4000/api/gateway/recordings?ids=${CALL},66666666-7777-4888-9999-aaaaaaaaaaaa`);
    expect(init.headers['x-api-key']).toBe('gw-key-123456');
    await client.getRecordings();
    expect((global.fetch as any).mock.calls[1][0]).toBe('http://127.0.0.1:4000/api/gateway/recordings');
  });
});
