import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationReadiness, AiConversationView } from '@sim-gateway/shared';
import { GatewayApiClient } from '../src/lib/api-client';
import { conversationControl, conversationLatencies } from '../src/lib/ai-readiness';
import { ConversationPanel } from '../src/components/ai/ConversationPanel';

const view = (over: Partial<AiConversationView> = {}): AiConversationView => ({
  enabled: true,
  phase: 'listening',
  phaseSince: '2026-10-17T10:00:00.000Z',
  halfDuplex: true,
  ignoredWhileSpeakingSeconds: 3.2,
  endpointSilenceMs: 1000,
  lastTurn: { status: 'completed', reason: null, sttMs: 410, llmFirstTokenMs: 380, ttsFirstMs: 520, playMs: 2100, firstAudioMs: 1350, totalMs: 3500, lateFrames: 0 },
  lastError: null,
  ...over,
});

const ready = (over: Partial<AiConversationReadiness> = {}): AiConversationReadiness => ({ allowed: true, blockers: [], active: false, ...over });

describe('conversation control decisions', () => {
  it('is absent without a call', () => {
    expect(conversationControl(null, null, ready()).visible).toBe(false);
    expect(conversationControl({ state: 'IDLE' }, null, ready()).visible).toBe(false);
  });

  it('cannot be started before the call is answered', () => {
    for (const state of ['DIALING', 'OUTBOUND_RINGING', 'INBOUND_RINGING', 'TERMINATING']) {
      const c = conversationControl({ state }, null, ready());
      expect(c).toMatchObject({ visible: true, mode: 'start', enabled: false });
      expect(c.reason).toMatch(/must be ACTIVE/);
    }
  });

  it('starts only when the gateway says it is allowed, and shows the first blocker otherwise', () => {
    expect(conversationControl({ state: 'ACTIVE' }, null, ready())).toEqual({ visible: true, mode: 'start', enabled: true, reason: null });
    const blocked = conversationControl({ state: 'ACTIVE' }, null, ready({ allowed: false, blockers: ["inbound-wire: the USB audio stream is 'stalled', not flowing"] }));
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toMatch(/Caller audio arriving: the USB audio stream is 'stalled'/);
    expect(conversationControl({ state: 'ACTIVE' }, null, null).reason).toMatch(/Waiting for the gateway/);
  });

  it('offers Stop whenever the conversation is on for the call', () => {
    expect(conversationControl({ state: 'ACTIVE' }, view(), ready({ active: true }))).toEqual({ visible: true, mode: 'stop', enabled: true, reason: null });
    expect(conversationControl({ state: 'TERMINATING' }, view(), null).mode).toBe('stop');
  });
});

describe('latency rows', () => {
  it('lists stages in pipeline order and keeps a stage that did not run as unknown', () => {
    expect(conversationLatencies(view()).map((r) => r.label)).toEqual(['Pause before reply', 'Speech-to-text', 'LLM first token', 'TTS first audio', 'To first audio', 'Playback written', 'Whole turn (incl. speaking)']);
    const none = conversationLatencies(view({ lastTurn: null }));
    expect(none.map((r) => r.ms)).toEqual([1000, null, null, null, null, null, null]); // only the configured pause is known
    const failedEarly = conversationLatencies(view({ lastTurn: { status: 'failed', reason: 'llm-failed', sttMs: 300, llmFirstTokenMs: null, ttsFirstMs: null, playMs: null, firstAudioMs: null, totalMs: 900, lateFrames: 0 } }));
    expect(failedEarly.map((r) => r.ms)).toEqual([1000, 300, null, null, null, null, 900]);
  });
});

describe('conversation panel', () => {
  const render = (props: Partial<React.ComponentProps<typeof ConversationPanel>> = {}) =>
    renderToStaticMarkup(
      React.createElement(ConversationPanel, {
        control: conversationControl({ state: 'ACTIVE' }, view(), ready({ active: true })),
        conversation: view(),
        confirming: false,
        busy: false,
        onAsk: vi.fn(),
        onCancel: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        ...props,
      })
    );

  it('shows the live phase, per-stage latency and the honest playback wording while running', () => {
    const html = render({ conversation: view({ phase: 'speaking' }) });
    expect(html).toContain('Speaking');
    expect(html).toContain('Stop conversation');
    for (const label of ['Pause before reply', 'Speech-to-text', 'LLM first token', 'TTS first audio', 'To first audio', 'Playback written', 'Whole turn (incl. speaking)']) expect(html).toContain(label);
    expect(html).toContain('410 ms');
    expect(html).toContain('The caller waited about 2.35 s');
    expect(html).toContain('also counts the time spent speaking');
    expect(html).toContain('Whether the caller heard it is not verified');
    expect(html).toContain('Half-duplex');
    expect(html).toContain('3.2 s');
  });

  it('shows every pipeline phase by name', () => {
    for (const [phase, label] of [['stopped', 'Stopped'], ['listening', 'Listening'], ['transcribing', 'Transcribing'], ['generating', 'Generating reply'], ['speaking', 'Speaking']] as const) {
      expect(render({ conversation: view({ phase }) })).toContain(label);
    }
  });

  it('shows the last error with its stage, and says full duplex is unverified when half-duplex is off', () => {
    const html = render({ conversation: view({ halfDuplex: false, lastError: { stage: 'tts', message: 'cartesia tts: HTTP 401: authentication failed', at: 'x' } }) });
    expect(html).toContain('role="alert"');
    expect(html).toContain('tts: cartesia tts: HTTP 401');
    expect(html).toContain('Full duplex');
    expect(html).toContain('Not verified on this hardware');
  });

  it('asks for a second confirmation before starting, naming the consequences', () => {
    const start = conversationControl({ state: 'ACTIVE' }, null, ready());
    const idle = render({ control: start, conversation: null });
    expect(idle).toContain('Start conversation');
    expect(idle).not.toMatch(/<button[^>]* disabled=""/);
    const confirm = render({ control: start, conversation: null, confirming: true });
    expect(confirm).toContain('let the AI talk to the caller on this call');
    expect(confirm).toContain('billed');
    expect(confirm).toContain('this call only');
  });

  it('disables Start with the reason when the call or audio is not ready', () => {
    const control = conversationControl({ state: 'DIALING' }, null, ready());
    const html = render({ control, conversation: null });
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('must be ACTIVE');
  });
});

describe('API client', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const client = new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'gw-key-123456' });

  it('enabling carries both confirmations and nothing else; disabling carries none', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) }) as never;
    await client.setAiConversation('call-1', true);
    await client.setAiConversation('call-1', false);
    const calls = (global.fetch as any).mock.calls;
    expect(calls[0][0]).toBe('http://127.0.0.1:4000/api/ai/calls/call-1/conversation');
    expect(JSON.parse(calls[0][1].body)).toEqual({ enabled: true, confirmBilling: true, confirmPlayToCaller: true });
    expect(JSON.parse(calls[1][1].body)).toEqual({ enabled: false });
  });
});
