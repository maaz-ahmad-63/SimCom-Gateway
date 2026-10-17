import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTestResponseReadiness, AiTestResponseResult } from '@sim-gateway/shared';
import { GatewayApiClient } from '../src/lib/api-client';
import { testResponseRows } from '../src/lib/ai-readiness';
import { TestResponsePanel } from '../src/components/ai/TestResponseCard';

const result = (over: Partial<AiTestResponseResult> = {}): AiTestResponseResult => ({
  callId: 'call-1',
  startedAt: '2026-10-17T08:00:00.000Z',
  mock: false,
  transcriptAgeSeconds: 4,
  llm: { status: 'ok', ms: 420, error: null, chars: 31, promptTokens: 40, completionTokens: 9 },
  tts: { status: 'ok', ms: 380, error: null, chars: 31, bytes: 48000, seconds: 3 },
  playbackSubmission: { status: 'ok', ms: 3010, error: null, bytesWritten: 48000, bytesTotal: 48000 },
  playbackCompletion: { status: 'ok', ms: 3010, error: null, stoppedBy: null },
  format: '8000 Hz 16-bit mono LE PCM',
  heardByRemote: 'unknown',
  note: 'Bytes accepted by the audio port do not prove the remote party heard anything.',
  ...over,
});

const ready = (over: Partial<AiTestResponseReadiness> = {}): AiTestResponseReadiness => ({
  allowed: true,
  blockers: [],
  transcriptAgeSeconds: 6,
  format: '8000 Hz 16-bit mono LE PCM',
  last: null,
  ...over,
});

const render = (props: Partial<React.ComponentProps<typeof TestResponsePanel>> = {}) =>
  renderToStaticMarkup(
    React.createElement(TestResponsePanel, {
      readiness: ready(),
      result: null,
      busy: false,
      confirming: false,
      onAsk: vi.fn(),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      ...props,
    })
  );

describe('test response stages', () => {
  it('lists the four stages separately, in order', () => {
    const rows = testResponseRows(result());
    expect(rows.map((r) => r.key)).toEqual(['llm', 'tts', 'playbackSubmission', 'playbackCompletion']);
    expect(rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(rows[2].detail).toBe('48000 of 48000 bytes');
  });

  it('keeps a failed stage and the stages after it distinct', () => {
    const rows = testResponseRows(
      result({
        tts: { status: 'failed', ms: 90, error: 'cartesia tts: HTTP 401: authentication failed', chars: null, bytes: null, seconds: null },
        playbackSubmission: { status: 'not-run', ms: null, error: null, bytesWritten: null, bytesTotal: null },
        playbackCompletion: { status: 'not-run', ms: null, error: null, stoppedBy: null },
      })
    );
    expect(rows.map((r) => r.status)).toEqual(['ok', 'failed', 'not-run', 'not-run']);
    expect(rows[1].error).toMatch(/authentication failed/);
  });
});

describe('test response panel', () => {
  it('disables the action and lists every blocker when the gateway says it is not allowed', () => {
    const html = render({ readiness: ready({ allowed: false, blockers: ['session: the AI is not attached to this call', 'transcript: no voiced transcript has been recorded for this call yet'] }) });
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('not attached to this call');
    expect(html).toContain('no voiced transcript');
  });

  it('enables it when allowed, and asks for a second confirmation that names the consequences', () => {
    const html = render();
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('Generate &amp; Play Test Response');
    expect(html).toContain('the agent stays passive');

    const confirm = render({ confirming: true });
    expect(confirm).toContain('speak one reply to the remote party now');
    expect(confirm).toContain('Both are billed. It happens once.');
  });

  it('never says the reply was heard, even when every stage succeeded', () => {
    const html = render({ result: result() });
    expect(html).toContain('LLM generation');
    expect(html).toContain('Playback submitted to audio port');
    expect(html).toContain('Playback written to the end');
    expect(html).toContain('not proof it was heard');
    expect(html).toMatch(/Heard by the remote party: <strong>unknown<\/strong>/);
  });

  it('shows each error next to its own stage and flags offline mock runs', () => {
    const html = render({
      result: result({
        mock: true,
        llm: { status: 'failed', ms: 12, error: 'groq llm: HTTP 429: rate limited or out of quota', chars: null, promptTokens: null, completionTokens: null },
        tts: { status: 'not-run', ms: null, error: null, chars: null, bytes: null, seconds: null },
        playbackSubmission: { status: 'not-run', ms: null, error: null, bytesWritten: null, bytesTotal: null },
        playbackCompletion: { status: 'not-run', ms: null, error: null, stoppedBy: null },
      }),
    });
    expect(html).toContain('rate limited');
    expect(html).toContain('FAILED'.toLowerCase());
    expect(html).toContain('Offline mock providers were used');
  });
});

describe('API client', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts one request with both explicit confirmations to the call-specific route', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => result() }) as never;
    const client = new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'gw-key-123456' });
    await client.playAiTestResponse('call-1');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(url).toBe('http://127.0.0.1:4000/api/ai/calls/call-1/test-response');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ confirmBilling: true, confirmPlayToCaller: true });
  });
});
