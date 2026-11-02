import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CallDetailPanel, CallErrors, TurnCard } from '../src/components/observability/CallDetailPanel';
import { callLogHref, callSummaryLine, isValidCallId, RequestGate, searchWithCall, selectedCallFromSearch } from '../src/lib/call-logs';
import { TraceEvent, TurnLatency, TurnTrace } from '../src/lib/observability';

const none: TurnLatency = { utteranceMs: null, endpointMs: null, sttMs: null, sttWaitedMs: null, tftMs: null, tftAvailable: null, sttMode: null, maxLateMs: null, lateFrames: null, riskFrames: null, loopLagMaxMs: null, llmTotalMs: null, ttsFirstMs: null, ttsTotalMs: null, firstAudioMs: null, endToEndMs: null, playMs: null, turnMs: null };
const turn = (over: Partial<TurnTrace> = {}): TurnTrace => ({ turnId: 'call-A:t1', index: 1, at: '2026-10-28T10:00:01.000Z', status: 'completed', reason: null, cancelSource: null, transcript: 'what time do you open', reply: 'We open at nine.', failingStage: null, failureDetail: null, latency: { ...none, sttMs: 300, endToEndMs: 1500 }, retries: 0, events: [] as TraceEvent[], ...over });

describe('the selected call lives in the URL', () => {
  it('reads and writes ?call= and keeps other parameters', () => {
    expect(selectedCallFromSearch('?call=abc-123')).toBe('abc-123');
    expect(selectedCallFromSearch('call=3bb2954f-6d66-4009-9f03-afd227939c24&x=1')).toBe('3bb2954f-6d66-4009-9f03-afd227939c24');
    expect(selectedCallFromSearch('')).toBeNull();
    expect(searchWithCall('?x=1', 'call-B')).toBe('?x=1&call=call-B');
    expect(searchWithCall('?x=1&call=call-A', 'call-B')).toBe('?x=1&call=call-B'); // switching replaces, never stacks
    expect(searchWithCall('?x=1&call=call-A', null)).toBe('?x=1');
    expect(searchWithCall('?call=call-A', null)).toBe('');
    expect(callLogHref('call-A')).toBe('/observability?call=call-A');
  });

  it('refuses anything that is not a plausible call id', () => {
    for (const bad of ['', 'a b', '<script>', "x'; DROP", 'a/b', 'x'.repeat(81), '../etc']) {
      expect(isValidCallId(bad), bad).toBe(false);
      expect(selectedCallFromSearch(`?call=${encodeURIComponent(bad)}`)).toBeNull();
    }
    expect(isValidCallId('call-1:t2')).toBe(true);
    expect(searchWithCall('', "bad id'")).toBe(''); // never written into the URL
  });
});

describe('a slow earlier response never replaces the call now on screen', () => {
  it('lets only the newest request apply its result, whatever order they finish in', async () => {
    const gate = new RequestGate();
    const shown: string[] = [];
    const load = async (id: string, delayMs: number) => {
      const ticket = gate.begin();
      await new Promise((r) => setTimeout(r, delayMs));
      if (gate.isCurrent(ticket)) shown.push(id);
    };
    // The viewer clicks A (slow), then B (fast): B must win, and A's late answer must be dropped.
    await Promise.all([load('call-A', 40), load('call-B', 5)]);
    expect(shown).toEqual(['call-B']);
    const open = gate.begin();
    gate.cancel(); // the viewer closed the drawer
    expect(gate.isCurrent(open)).toBe(false);
  });
});

describe('what the call detail shows', () => {
  it('shows what the caller said and what the agent replied, for each turn', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn: turn() }));
    expect(html).toContain('Caller said');
    expect(html).toContain('what time do you open');
    expect(html).toContain('Agent replied');
    expect(html).toContain('We open at nine.');
    expect(html).toContain('1500 ms'.replace('1500 ms', '1.50 s'));
  });

  it('says text was not stored instead of leaving a blank or inventing it', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn: turn({ transcript: null, reply: null }) }));
    expect(html.match(/not stored/g)).toHaveLength(2);
  });

  it('shows a cancelled turn as cancelled, with who cancelled it', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn: turn({ status: 'cancelled', cancelSource: 'caller-speech', reply: null }) }));
    expect(html).toContain('Cancelled by caller-speech');
    expect(html).toContain('not counted as a response time');
  });

  it('lists every error of the call with its stage, provider and code, and nothing when there are none', () => {
    const html = renderToStaticMarkup(React.createElement(CallErrors, { errors: [{ at: '2026-10-28T10:00:02.123Z', turnId: 'call-F:t1', stage: 'provider-attempt', detail: 'HTTP 503', provider: 'deepgram', httpStatus: 503, attempt: 1 }] }));
    expect(html).toContain('Errors (1)');
    expect(html).toContain('call-F:t1');
    expect(html).toContain('HTTP 503');
    expect(html).toContain('deepgram');
    expect(renderToStaticMarkup(React.createElement(CallErrors, { errors: [] }))).toBe('');
  });

  it('starts in a loading state for the call it was asked for, and never shows another call before its own data arrives', () => {
    const a = renderToStaticMarkup(React.createElement(CallDetailPanel, { key: 'call-A', callId: 'call-A', onClose: () => {} }));
    const b = renderToStaticMarkup(React.createElement(CallDetailPanel, { key: 'call-B', callId: 'call-B', onClose: () => {} }));
    expect(a).toContain('call-A');
    expect(a).toContain('Loading this call');
    expect(a).not.toContain('detail-body');
    expect(b).toContain('call-B');
    expect(b).not.toContain('call-A');
  });

  it('summarises a call in one line', () => {
    expect(callSummaryLine({ status: 'completed', durationSeconds: 5, turns: 1, failedTurns: 0 })).toBe('1 turn');
    expect(callSummaryLine({ status: 'failed', durationSeconds: 5, turns: 3, failedTurns: 1, cancelledTurns: 2 })).toBe('3 turns · 1 failed · 2 cancelled');
  });
});
