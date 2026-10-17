import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import {
  applyInspectorEvent,
  emptyInspector,
  formatLatency,
  INSPECTOR_STAGES,
  mergeInspectorEvents,
} from '../src/lib/ai-inspector';
import { TurnCard } from '../src/components/ai/InspectorTab';

let seq = 0;
const ev = (over: Partial<AiInspectorEvent>): AiInspectorEvent => ({
  seq: ++seq,
  callId: 'call-1',
  turnId: 'call-1:t1',
  timestamp: new Date(1_700_000_000_000 + seq * 100).toISOString(),
  stage: 'pcm-capture',
  status: 'ok',
  ...over,
});

const passiveTurn = (turnId = 'call-1:t1', withText = false): AiInspectorEvent[] => [
  ev({ turnId, stage: 'pcm-capture', data: { bytes: 32000 } }),
  ev({ turnId, stage: 'pcm-validation' }),
  ev({ turnId, stage: 'stt-submit' }),
  ev({ turnId, stage: 'stt-result', latencyMs: 420, ...(withText ? { text: 'what time do you open', role: 'caller' as const } : { data: { textHidden: true } }) }),
  ...(['llm-request', 'llm-response', 'tts-generated', 'playback'] as const).map((stage) =>
    ev({ turnId, stage, status: 'not-run', detail: 'passive mode: nothing is generated or sent to the caller' })
  ),
];

describe('inspector reducer', () => {
  it('lists all eight stages for a turn and marks a passive turn as transcribed only', () => {
    const state = mergeInspectorEvents(emptyInspector(), passiveTurn());
    expect(state.turns).toHaveLength(1);
    const turn = state.turns[0];
    expect(Object.keys(turn.stages)).toEqual([...INSPECTOR_STAGES]);
    expect(turn.stages['stt-result']).toMatchObject({ status: 'ok', latencyMs: 420 });
    expect(turn.stages['playback'].status).toBe('not-run');
    expect(turn.outcome).toBe('passive');
    expect(turn.failure).toBeNull();
  });

  it('ignores duplicate events delivered by both the live stream and the catch-up request', () => {
    const events = passiveTurn();
    const once = mergeInspectorEvents(emptyInspector(), events);
    const twice = mergeInspectorEvents(once, events);
    expect(twice.turns[0].stages['stt-result'].count).toBe(1);
    expect(JSON.stringify(twice.turns)).toBe(JSON.stringify(once.turns));
  });

  it('puts out-of-order catch-up events back in sequence', () => {
    const events = passiveTurn();
    const shuffled = [events[3], events[0], events[2], events[1], ...events.slice(4)];
    const state = mergeInspectorEvents(emptyInspector(), shuffled);
    expect(state.turns[0].stages['pcm-capture'].status).toBe('ok');
    expect(state.turns[0].stages['stt-result'].status).toBe('ok');
  });

  it('reports a failure on its own stage with the gateway reason, and keeps it', () => {
    let state = emptyInspector();
    for (const e of [
      ev({ turnId: 'c:t2', callId: 'c', stage: 'pcm-capture' }),
      ev({ turnId: 'c:t2', callId: 'c', stage: 'pcm-validation' }),
      ev({ turnId: 'c:t2', callId: 'c', stage: 'stt-submit' }),
      ev({ turnId: 'c:t2', callId: 'c', stage: 'stt-result', status: 'failed', detail: 'deepgram stt: HTTP 401: authentication failed' }),
      ev({ turnId: 'c:t2', callId: 'c', stage: 'llm-request', status: 'not-run', detail: 'speech-to-text failed' }),
    ]) {
      state = applyInspectorEvent(state, e);
    }
    const turn = state.turns[0];
    expect(turn.outcome).toBe('failed');
    expect(turn.failure).toEqual({ stage: 'stt-result', detail: 'deepgram stt: HTTP 401: authentication failed' });
    expect(turn.stages['llm-request'].status).toBe('not-run');
    // A later "ok" for the same stage must not hide the failure.
    state = applyInspectorEvent(state, ev({ turnId: 'c:t2', callId: 'c', stage: 'stt-result', status: 'ok' }));
    expect(state.turns[0].stages['stt-result'].status).toBe('failed');
  });

  it('treats cancellations and skipped audio as their own outcomes, not as success', () => {
    let state = emptyInspector();
    state = mergeInspectorEvents(state, [
      ev({ turnId: 'c:t3', callId: 'c', stage: 'pcm-capture' }),
      ev({ turnId: 'c:t3', callId: 'c', stage: 'pcm-validation', status: 'skipped', detail: 'not sent to STT: silent' }),
      ev({ turnId: 'c:t4', callId: 'c', stage: 'pcm-capture' }),
      ev({ turnId: 'c:t4', callId: 'c', stage: 'pcm-validation' }),
      ev({ turnId: 'c:t4', callId: 'c', stage: 'stt-result', status: 'cancelled', detail: 'cancelled before the transcript arrived' }),
    ]);
    const byId = Object.fromEntries(state.turns.map((t) => [t.turnId, t.outcome]));
    expect(byId).toEqual({ 'c:t3': 'skipped', 'c:t4': 'cancelled' });
  });

  it('collects call-level markers separately and keeps the most recent', () => {
    let state = emptyInspector();
    for (let i = 0; i < 60; i++) state = applyInspectorEvent(state, ev({ turnId: null, stage: 'call', detail: `marker ${i}` }));
    expect(state.turns).toHaveLength(0);
    expect(state.markers).toHaveLength(40);
    expect(state.markers.at(-1)?.detail).toBe('marker 59');
  });

  it('bounds how many turns it keeps', () => {
    let state = emptyInspector();
    for (let i = 0; i < 70; i++) state = mergeInspectorEvents(state, [ev({ turnId: `c:t${i}`, callId: 'c', stage: 'pcm-capture' })]);
    expect(state.turns).toHaveLength(40);
    expect(state.turns.at(-1)?.turnId).toBe('c:t69');
  });

  it('formats latency without inventing numbers', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(undefined)).toBe('—');
    expect(formatLatency(420.4)).toBe('420 ms');
    expect(formatLatency(1530)).toBe('1.53 s');
  });
});

describe('transcript rendering', () => {
  const render = (events: AiInspectorEvent[]) =>
    renderToStaticMarkup(React.createElement(TurnCard, { turn: mergeInspectorEvents(emptyInspector(), events).turns[0] }));

  it('shows every stage with its status, and the caller text only when the gateway sent it', () => {
    const shown = render(passiveTurn('call-1:t9', true));
    for (const label of ['PCM captured', 'PCM validated', 'Sent to STT', 'STT result', 'LLM request', 'LLM response', 'TTS generated', 'Playback to caller']) {
      expect(shown).toContain(label);
    }
    expect(shown).toContain('what time do you open');
    expect(shown).toContain('Transcribed only');
    expect(shown).toContain('not run');
    expect(shown).toContain('420 ms');

    const hidden = render(passiveTurn('call-1:t10', false));
    expect(hidden).not.toContain('what time do you open');
    expect(hidden).toContain('hidden because transcript display is off');
  });

  it('puts a failure in an alert naming the failed stage, and escapes text from the caller', () => {
    const html = render([
      ev({ turnId: 'x:t1', callId: 'x', stage: 'pcm-capture' }),
      ev({ turnId: 'x:t1', callId: 'x', stage: 'stt-result', status: 'failed', detail: 'timed out after 8000 ms', text: '<img src=x onerror=alert(1)>', role: 'caller' }),
    ]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('STT result failed');
    expect(html).toContain('timed out after 8000 ms');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
