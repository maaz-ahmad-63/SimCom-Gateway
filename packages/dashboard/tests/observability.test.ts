import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnCard } from '../src/components/observability/CallDetailPanel';
import { OverviewCards } from '../src/components/observability/ObservabilityView';
import { playbackNote, breakdownRows, buildQuery, dayBoundary, ms, Overview, responseCodes, timelineRows, TraceEvent, TurnLatency, TurnTrace } from '../src/lib/observability';

const none: TurnLatency = { utteranceMs: null, endpointMs: null, sttMs: null, sttWaitedMs: null, tftMs: null, tftAvailable: null, sttMode: null, maxLateMs: null, lateFrames: null, riskFrames: null, loopLagMaxMs: null, llmTotalMs: null, ttsFirstMs: null, ttsTotalMs: null, firstAudioMs: null, endToEndMs: null, playMs: null, turnMs: null };
const ev = (id: number, over: Partial<TraceEvent> = {}): TraceEvent => ({ id, callId: 'c', turnId: 'c:t1', at: `2026-10-28T10:00:0${id}.000Z`, monoMs: 1000 + id * 100, stage: 'stt-result', status: 'ok', latencyMs: null, detail: null, data: null, provider: null, model: null, httpStatus: null, attempt: null, ...over });
const stat0 = { n: 0, avg: null, p50: null, p95: null };

describe('observability helpers', () => {
  it('builds queries without empty values and converts local days to UTC instants', () => {
    expect(buildQuery({ status: 'failed', provider: ' ', q: 'abc' }, { page: 2, pageSize: 25 })).toBe('?status=failed&q=abc&page=2&pageSize=25');
    expect(buildQuery({})).toBe('');
    const start = dayBoundary('2026-10-28', 'start')!;
    const end = dayBoundary('2026-10-28', 'end')!;
    expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000 - 1);
    expect(dayBoundary('garbage', 'start')).toBeUndefined();
  });

  it('shows missing measurements as a dash with a reason, never a zero', () => {
    expect(ms(null)).toBe('—');
    expect(ms(0)).toBe('0 ms');
    expect(ms(1500)).toBe('1.50 s');
    const rows = breakdownRows(none);
    expect(rows.map((r) => r.value)).toEqual(['—', '—', '—', '—', '—']);
    expect(rows.every((r) => r.note)).toBe(true);
    const batch = breakdownRows({ ...none, tftAvailable: false, tftMs: 999 });
    expect(batch[1]).toMatchObject({ value: 'n/a', note: 'provider does not stream' });
    expect(breakdownRows({ ...none, sttMs: 300, sttMode: 'speculative', sttWaitedMs: 40 })[0].note).toBe('request started during the pause · waited 40 ms');
  });

  it('orders the timeline by recording order and offsets it on the monotonic clock', () => {
    const rows = timelineRows([ev(3, { monoMs: 1350 }), ev(1, { monoMs: 1100 }), ev(2, { stage: 'provider-attempt', attempt: 2, monoMs: 1200, httpStatus: 503, status: 'failed', data: { willRetry: true } })]);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.offsetMs)).toEqual([0, 100, 250]);
    expect(rows[1]).toMatchObject({ label: 'Provider request (attempt 2)', retry: true });
    expect(responseCodes([ev(1), ev(2, { stage: 'provider-attempt', httpStatus: 503, status: 'failed' }), ev(3, { stage: 'provider-attempt', httpStatus: 200 })])).toEqual([503]);
  });
});

describe('observability rendering', () => {
  const failed: TurnTrace = {
    turnId: 'c:t1', index: 1, at: '2026-10-28T10:00:01.000Z', status: 'failed', reason: 'stt-failed', cancelSource: null, transcript: null, reply: null, failingStage: 'stt-result', failureDetail: 'HTTP 503: provider server error',
    latency: { ...none, sttMs: 812 }, retries: 2,
    events: [ev(1, { stage: 'provider-attempt', httpStatus: 503, status: 'failed', attempt: 1, provider: 'deepgram', data: { willRetry: true, outcome: 'http-error' } }), ev(2, { stage: 'provider-attempt', httpStatus: null, status: 'failed', attempt: 2, provider: 'deepgram', data: { willRetry: true, outcome: 'timeout' } }), ev(3, { status: 'failed', detail: 'HTTP 503: provider server error' })],
  };

  it('shows the failing stage, retries, timeouts and response codes for a failed turn', () => {
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn: failed }));
    expect(html).toContain('Failing stage');
    expect(html).toContain('stt-result');
    expect(html).toContain('Retries: 2');
    expect(html).toContain('Timeouts: 1');
    expect(html).toContain('response codes: 503');
    expect(html).toContain('812 ms');
    expect(html).toContain('not measured for this turn');
    expect(html).toContain('Provider request (attempt 2)');
  });

  it('renders a healthy turn without a diagnostics box', () => {
    const ok: TurnTrace = { ...failed, status: 'completed', failingStage: null, failureDetail: null, retries: 0, events: [ev(1)], latency: { ...none, sttMs: 100, tftMs: 200, tftAvailable: true, llmTotalMs: 400, ttsFirstMs: 90, endToEndMs: 640 } };
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn: ok }));
    expect(html).not.toContain('Failure diagnostics');
    expect(html).toContain('640 ms');
    expect(html).toContain('200 ms');
  });

  it('renders an empty overview as zeros and “no measurements”', () => {
    const o: Overview = {
      calls: { total: 0, successful: 0, failed: 0, withAiErrors: 0, byOutcome: {}, failureRate: null },
      turns: { total: 0, completed: 0, failed: 0, cancelled: 0, errorRatePercent: null },
      latencyMs: { endToEnd: stat0, tft: stat0, stt: stat0, llmTotal: stat0, ttsFirstAudio: stat0, ttsTotal: stat0, turn: stat0 },
      providers: { stt: [], llm: [], tts: [] }, sttModes: {}, cancellations: { total: 0, afterAudioStarted: 0, bySource: {} }, playback: { maxLateMs: stat0, loopLagMs: stat0, turnsWithLateFrames: 0, turnsWithGapRisk: 0 }, simulatedTurns: 0,
    };
    const html = renderToStaticMarkup(React.createElement(OverviewCards, { o }));
    expect(html).toContain('no measurements');
    expect(html).toContain('no calls');
    expect(html).not.toContain('NaN');
  });

  it('renders percentiles and sample sizes when there are measurements', () => {
    const s = { n: 4, avg: 550, p50: 500, p95: 700 };
    const o: Overview = {
      calls: { total: 3, successful: 1, failed: 1, withAiErrors: 1, byOutcome: {}, failureRate: 33.3 },
      turns: { total: 6, completed: 5, failed: 1, cancelled: 0, errorRatePercent: 16.7 },
      latencyMs: { endToEnd: s, tft: s, stt: s, llmTotal: s, ttsFirstAudio: s, ttsTotal: stat0, turn: s },
      providers: { stt: [], llm: [], tts: [] }, sttModes: { batch: 3, stream: 1 }, cancellations: { total: 2, afterAudioStarted: 1, bySource: { 'caller-speech': 2 } }, playback: { maxLateMs: { n: 2, avg: 40, p50: 30, p95: 67 }, loopLagMs: stat0, turnsWithLateFrames: 2, turnsWithGapRisk: 1 }, simulatedTurns: 0,
    };
    const html = renderToStaticMarkup(React.createElement(OverviewCards, { o }));
    expect(html).toContain('batch 3');
    expect(html).toContain('2 turn(s) with late frames, 1 past the write-ahead');
    expect(html).toContain('p95 67 ms');
    expect(html).toContain('caller-speech 2');
    expect(html).toContain('p50 500 ms');
    expect(html).toContain('p95 700 ms');
    expect(html).toContain('n=4');
    expect(html).toContain('16.7%');
  });
});

describe('cancelled turns and jitter', () => {
  it('labels a cancelled turn and never quotes it as a response time, and explains jitter', () => {
    const turn = { turnId: 'c:t2', index: 2, at: '2026-10-28T10:00:02.000Z', status: 'cancelled', reason: 'interrupted', cancelSource: 'caller-speech', failingStage: null, failureDetail: null, retries: 0, events: [], latency: { ...none, endToEndMs: null, maxLateMs: 67, lateFrames: 4, riskFrames: 2, loopLagMaxMs: 58 } } as TurnTrace;
    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn }));
    expect(html).toContain('Cancelled by caller-speech');
    expect(html).toContain('not counted as a response time');
    expect(html).toContain('worst frame 67 ms late (4 late, 2 past the write-ahead)');
    expect(html).toContain('longest event-loop stall 58 ms');
    expect(playbackNote(none)).toBe('playback jitter not measured');
  });
});
