import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AudioVerificationView } from '../src/components/ai/AudioVerificationPanel';
import { AspectResult, AudioVerificationResponse, CallAudioVerification, STATUS_LABEL, VerificationStatus } from '../src/lib/audio-verification';

const aspect = (a: AspectResult['aspect'], status: VerificationStatus, reason: string, extra: Partial<AspectResult> = {}): AspectResult => ({
  aspect: a,
  status,
  reason,
  source: status === 'pending' ? null : a === 'inbound' ? 'live-stt' : a === 'transport' ? 'playback' : 'caller-response',
  updatedAt: '2026-11-05T10:00:05.000Z',
  evidence: [],
  ...extra,
});
const call = (over: Partial<CallAudioVerification> = {}): CallAudioVerification => ({
  callId: 'call-1234abcd',
  direction: 'inbound',
  startedAt: '2026-11-05T10:00:00.000Z',
  activeAt: '2026-11-05T10:00:01.000Z',
  endedAt: '2026-11-05T10:02:00.000Z',
  final: true,
  simulated: false,
  inbound: aspect('inbound', 'verified', '2 caller utterances produced live transcripts'),
  transport: aspect('transport', 'verified', '3 agent replies were written to the modem audio port'),
  audibility: aspect('audibility', 'unable', 'no explicit confirmation from the caller side'),
  ...over,
});
const render = (data: AudioVerificationResponse, props: Partial<React.ComponentProps<typeof AudioVerificationView>> = {}) =>
  renderToStaticMarkup(React.createElement(AudioVerificationView, { data, onToggle: () => undefined, ...props }));

describe('Call Audio Verification panel', () => {
  it('has exactly the five statuses, with these names', () => {
    expect(Object.values(STATUS_LABEL)).toEqual(['Pending', 'Verifying', 'Verified', 'Failed', 'Unable to verify']);
  });

  it('shows the three results separately: transport Verified next to audibility Unable to verify, with call id, times, source and reason', () => {
    const html = render({ enabled: true, current: call(), recent: [] });
    expect(html).toContain('Caller audio intelligibility');
    expect(html).toContain('Agent audio transport');
    expect(html).toContain('Agent audio remote audibility');
    expect(html).toMatch(/data-testid="status-transport">Verified</);
    expect(html).toMatch(/data-testid="status-audibility">Unable to verify</);
    expect(html).toContain('call-1234abcd');
    expect(html).toContain('no explicit confirmation from the caller side');
    expect(html).toContain('Live transcription');
    expect(html).toMatch(/not that the caller heard it/); // the transport row says what it does not prove
    expect(html).not.toMatch(/All audio verified|Audio OK/i); // no global success flag
  });

  it('shows Pending, Verifying and Failed as they are', () => {
    const html = render({
      enabled: true,
      current: call({ final: false, endedAt: null, inbound: aspect('inbound', 'failed', 'no usable words'), transport: aspect('transport', 'pending', 'waiting for the agent to speak'), audibility: aspect('audibility', 'verifying', 'needs confirmation') }),
      recent: [],
    });
    expect(html).toMatch(/status-inbound">Failed/);
    expect(html).toMatch(/status-transport">Pending/);
    expect(html).toMatch(/status-audibility">Verifying/);
    expect(html).toContain('in progress');
  });

  it('a "can\'t hear you" warning is shown as a warning, and the status stays what the evidence says', () => {
    const html = render({
      enabled: true,
      current: call({ audibility: aspect('audibility', 'unable', 'no explicit confirmation', { evidence: [{ at: '2026-11-05T10:01:00.000Z', source: 'caller-phrase', kind: 'warning', detail: 'the caller said something like "I can\'t hear you"' }] }) }),
      recent: [],
    });
    expect(html).toMatch(/data-testid="warning-audibility">Warning: /);
    expect(html).toMatch(/status-audibility">Unable to verify/);
  });

  it('the switch is on by default and labelled, and off says the manual confirmations apply again', () => {
    const on = render({ enabled: true, current: null, recent: [] });
    const toggle = (html: string) => html.match(/<input[^>]*data-testid="auto-verify-toggle"[^>]*\/?>/)![0];
    expect(toggle(on)).toContain('aria-label="Verify call audio automatically"');
    expect(toggle(on)).toContain('checked=""');
    expect(on).toContain('No call has been verified yet');
    const off = render({ enabled: false, current: null, recent: [] });
    expect(toggle(off)).not.toContain('checked=""');
    expect(off).toMatch(/manual confirmations in Diagnostics are required again/);
  });

  it('says plainly when a call ran on simulated hardware', () => {
    const html = render({ enabled: true, current: call({ simulated: true }), recent: [] });
    expect(html).toContain('simulated: nothing can be verified');
  });

  it('offers the diagnostic key-press test only during a call in progress', () => {
    const live = render({ enabled: true, current: call({ final: false, endedAt: null }), recent: [] }, { onArmKeyTest: () => undefined });
    expect(live).toContain('Arm key-press audibility test');
    const done = render({ enabled: true, current: call(), recent: [] }, { onArmKeyTest: () => undefined });
    expect(done).not.toContain('Arm key-press audibility test');
  });
});

describe('Overview tab', () => {
  it('replaces the two manual cards with the panel and keeps manual confirmation only as a Diagnostics override', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ai', 'OverviewTab.tsx'), 'utf8');
    const panelAt = src.indexOf('<AudioVerificationPanel />');
    const diagAt = src.indexOf('data-testid="diagnostics-override"');
    expect(panelAt).toBeGreaterThan(0);
    expect(diagAt).toBeGreaterThan(panelAt);
    const diag = src.slice(diagAt, src.indexOf('</details>', diagAt));
    expect(diag).toContain('<AttestationCard kind="inbound" />');
    expect(diag).toContain('<AttestationCard kind="outbound" />');
    expect(diag).toMatch(/never changes the automatic results/);
    expect(src.slice(0, diagAt)).not.toContain('<AttestationCard');
  });
});

describe('API client', () => {
  it('reads and arms through the gateway routes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ enabled: true, current: null, recent: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { apiClient } = await import('../src/lib/api-client');
    await apiClient.getAudioVerification(5);
    await apiClient.armAudibilityKeyTest('call 1', '1');
    expect(calls[0].url).toMatch(/\/api\/ai\/audio-verification\?limit=5$/);
    expect(calls[1].url).toMatch(/\/api\/ai\/audio-verification\/call%201\/key-test$/);
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ key: '1' });
    vi.unstubAllGlobals();
  });
});
