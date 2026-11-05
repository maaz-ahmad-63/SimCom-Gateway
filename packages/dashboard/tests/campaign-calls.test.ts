import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CallDetailBody, TranscriptView } from '../src/components/campaigns/CampaignCallDetail';
import { CampaignCallsTable, MetricTiles } from '../src/components/campaigns/CampaignCallsSection';
import { callQueryString, CallAnalytics, CampaignCallDetail, CampaignCallRow, correctionPatch, costText, draftFromOverride, durationText, FILTER_OPTIONS, metricTiles, nextSort, pageCount, transcriptText } from '../src/lib/campaign-calls';

const classification = { outcome: 'quotation_requested' as const, interest: 'high' as const, sentiment: 'positive' as const, summary: 'The administrator asked for a quotation by email.', nextAction: 'Send a quotation.', requirements: ['voice agent'], objections: [], callback: { requested: false, when: null, note: null }, quotationRequested: true, demoRequested: false, callbackRequested: false, source: 'ai' as const, correctedFields: [], note: null };

const row = (over: Partial<CampaignCallRow> = {}): CampaignCallRow => ({
  attemptId: 7,
  callId: 'call-7',
  attempt: 1,
  startedAt: '2026-10-28T10:00:00.000Z',
  endedAt: '2026-10-28T10:01:00.000Z',
  contact: { id: 1, name: 'Asha Rao', designation: '', company: 'City Care', extra: {} },
  calledTo: '+919876543210',
  sipNumber: null,
  durationSeconds: 64,
  direction: 'outbound',
  status: 'answered',
  terminationReason: null,
  agent: { configVersion: 2, llmKey: 'm1' },
  sentiment: 'positive',
  cost: { usd: null, note: null },
  toolCalls: { count: 0, items: [] },
  transcript: { available: true, preview: 'Caller: हाँ बताइए', lines: 4, storedOff: false },
  classification,
  analysis: { status: 'analysed', error: null },
  ...over,
});

const table = (items: CampaignCallRow[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(CampaignCallsTable, {
      items,
      loading: false,
      error: null,
      sort: 'startedAt',
      dir: 'desc',
      onSort: () => {},
      recordings: null,
      openCallId: null,
      playing: false,
      player: { current: null },
      onRecording: () => {},
      onPlayingChange: () => {},
      onTranscript: () => {},
      onDetails: () => {},
      ...over,
    } as never)
  );

describe('campaign call table', () => {
  it('has every column the call history asks for', () => {
    const html = table([row()]);
    for (const label of ['Date &amp; time', 'Called to', 'SIP number', 'Duration', 'Direction', 'Status', 'Agent', 'Sentiment', 'Price / cost', 'Tool calls', 'Recording', 'Details', 'Summary / AI conclusion', 'Transcript', 'Campaign sales outcome']) expect(html, label).toContain(label);
  });

  it('shows the contact, the conclusion, a transcript preview with Read more, and never invents a value', () => {
    const html = table([row()]);
    expect(html).toContain('Asha Rao');
    expect(html).toContain('+919876543210');
    expect(html).toContain('The administrator asked for a quotation by email.');
    expect(html).toContain('हाँ बताइए');
    expect(html).toContain('Read more');
    expect(html).toContain('Not recorded'); // no SIM number is stored
    expect(html).toContain('Not available'); // no cost could be priced
    expect(html).toContain('Quotation requested');
  });

  it('says plainly when a transcript, a recording or a call is missing', () => {
    const html = table([row({ callId: null, durationSeconds: null, transcript: { available: false, preview: '', lines: 0, storedOff: false }, status: 'no_answer', sentiment: null, classification: { ...classification, outcome: 'no_answer', interest: null, sentiment: null, quotationRequested: false, summary: 'No answer. No conversation took place.', source: 'rule' }, analysis: { status: 'not_needed', error: null } })]);
    expect(html).toContain('No transcript');
    expect(html).toContain('No answer. No conversation took place.');
    expect(html).toContain('No recording for this call');
    expect(html).toContain('—');
    expect(table([row({ transcript: { available: false, preview: '', lines: 0, storedOff: true } })])).toContain('Not saved (transcripts off)');
  });

  it('marks a corrected result and a failed analysis, and shows empty and error states', () => {
    expect(table([row({ classification: { ...classification, source: 'manual', correctedFields: ['outcome'] } })])).toContain('Corrected by a person');
    expect(table([row({ analysis: { status: 'failed', error: 'x' } })])).toContain('Analysis failed');
    expect(table([])).toContain('No calls match.');
    expect(table([], { error: 'Gateway down' })).toContain('Gateway down');
    expect(table([row()], { sort: 'duration', dir: 'asc' })).toContain('aria-sort="ascending"');
  });
});

describe('metrics open exactly the calls they count', () => {
  const analytics: CallAnalytics = { totalCalls: 12, counts: { all: 12, interested: 5, quotation: 8, demo: 2, callback: 1, not_interested: 3, no_answer: 2, failed: 0, incomplete: 1, do_not_call: 0, answered: 9 }, analysed: 9, awaitingAnalysis: 1, corrected: 2, costUsd: null };

  it('gives one tile per filter with the gateway\'s own count, and honest coverage text', () => {
    const tiles = metricTiles(analytics);
    expect(tiles.find((t) => t.key === 'quotation')).toMatchObject({ label: 'Quotation requested', count: 8 });
    expect(tiles.map((t) => t.key)).toEqual(FILTER_OPTIONS.filter((f) => f.key !== 'all').map((f) => f.key));
    const html = renderToStaticMarkup(React.createElement(MetricTiles, { analytics, active: 'quotation', onPick: () => {} }));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('9 analysed by the AI');
    expect(html).toContain('1 conversation(s) waiting for analysis');
  });

  it('offers the filters the gateway implements, and no others', () => {
    const file = path.resolve(__dirname, '../../gateway/src/campaigns/call-analysis.ts');
    if (!fs.existsSync(file)) return;
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const block = /export const FILTERS = \[([^\]]*)\]/.exec(source);
    expect(block).not.toBeNull();
    const gateway = Array.from((block as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    for (const f of FILTER_OPTIONS) expect(gateway, f.key).toContain(f.key);
  });
});

describe('query, sort and paging helpers', () => {
  it('builds the same query for the table and the export, leaving empty values out', () => {
    expect(callQueryString({ filter: 'quotation', search: ' Asha ', sort: 'duration', dir: 'asc', page: 2, pageSize: 25 })).toBe('?search=Asha&filter=quotation&sort=duration&dir=asc&page=2&pageSize=25');
    expect(callQueryString({ filter: 'all', search: '  ', page: 1 })).toBe('');
  });

  it('flips a column and starts new ones in a sensible direction', () => {
    expect(nextSort({ sort: 'startedAt', dir: 'desc' }, 'startedAt')).toEqual({ sort: 'startedAt', dir: 'asc' });
    expect(nextSort({ sort: 'startedAt', dir: 'desc' }, 'name')).toEqual({ sort: 'name', dir: 'asc' });
    expect(nextSort({ sort: 'name', dir: 'asc' }, 'duration')).toEqual({ sort: 'duration', dir: 'desc' });
    expect(pageCount(0, 15)).toBe(1);
    expect(pageCount(31, 15)).toBe(3);
  });

  it('formats unavailable values as unavailable, not zero', () => {
    expect(durationText(null)).toBe('—');
    expect(durationText(65)).toBe('1:05');
    expect(costText({ usd: null })).toBe('Not available');
    expect(costText({ usd: 0.0042 })).toContain('0.0042');
    expect(costText({ usd: 1.5 })).toBe('$1.50');
  });
});

const detail = (over: Partial<CampaignCallDetail> = {}): CampaignCallDetail => ({
  ...row(),
  campaignId: 'c1',
  promptVersion: 2,
  promptSha: 'abcdef123456',
  attemptEndedAt: '2026-10-28T10:01:00.000Z',
  answeredAt: '2026-10-28T10:00:05.000Z',
  callOutcome: 'completed',
  simulated: false,
  error: null,
  models: { stt: 'stt-a', llm: 'm1', tts: null },
  contactDetails: { designation: 'Administrator', company: 'City Care', notes: '', phoneAsWritten: '9876543210', optedOutInFile: false },
  transcriptLines: [
    { speaker: 'Agent', at: '2026-10-28T10:00:06.000Z', text: 'Hello', turn: 1 },
    { speaker: 'Caller', at: '2026-10-28T10:00:20.000Z', text: 'हाँ बताइए', turn: 2 },
  ],
  tools: [],
  usage: { turns: 2, inputTokens: 200, outputTokens: 40 },
  analysisDetail: { original: { outcome: 'quotation_requested', interest: 'high', sentiment: 'positive', summary: 's', requirements: ['voice agent'], objections: [], nextAction: 'Send a quotation.', callback: { requested: false, when: null, note: null }, quotationRequested: true, demoRequested: false }, ranAt: '2026-10-28T10:02:00.000Z', model: 'm1', tokens: { input: 300, output: 90 }, runs: [], rule: classification, override: null },
  ...over,
});

const body = (call: CampaignCallDetail, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(CallDetailBody, {
      call,
      recording: { state: 'none', reason: 'This call was never answered, so there is nothing to record.' },
      showPlayer: false,
      onTogglePlayer: () => {},
      canAnalyze: true,
      analyzeState: { status: 'idle' },
      onAnalyze: () => {},
      draft: draftFromOverride(null),
      onDraft: () => {},
      correctState: { status: 'idle' },
      onSaveCorrection: () => {},
      onRemoveCorrection: () => {},
      ...over,
    } as never)
  );

describe('call detail', () => {
  it('shows the analysis, the call record, the full transcript and what was not recorded', () => {
    const html = body(detail());
    for (const text of ['AI sales analysis', 'Recommended next action', 'Extracted requirements', 'Objections', 'Callback', 'Quotation / demo', 'Full transcript', 'Tool calls', 'Call record', 'SIM / modem number', 'config version 2', 'Analysed by the AI from the transcript']) expect(html, text).toContain(text);
    expect(html).toContain('हाँ बताइए');
    expect(html).toContain('Not recorded'); // the SIM number and the text-to-speech model
    expect(html).toContain('The agent did not call any tools on this call.');
    expect(html).toContain('Analyse again');
  });

  it('shows rule-based calls honestly: no analysis fields are made up', () => {
    const html = body(detail({ classification: { ...classification, outcome: 'no_answer', interest: null, sentiment: null, nextAction: null, quotationRequested: false, source: 'rule', summary: 'No answer. No conversation took place.' }, analysis: { status: 'not_needed', error: null }, analysisDetail: { ...detail().analysisDetail, original: null }, transcriptLines: [] }));
    expect(html).toContain('From how the call ended (not read by the AI)');
    expect(html).toContain('Only a real conversation is analysed');
    expect(html).toContain('There is no transcript for this call');
    expect(html).toContain('Analyse this call');
  });

  it('keeps the original AI result visible beside a correction and offers to remove it', () => {
    const override = { outcome: 'demo_requested' as const, interest: null, summary: null, nextAction: null, note: 'Confirmed', updatedAt: '2026-10-28T11:00:00.000Z' };
    const html = body(detail({ classification: { ...classification, source: 'manual', correctedFields: ['outcome'], outcome: 'demo_requested' }, analysisDetail: { ...detail().analysisDetail, override } }), { draft: draftFromOverride(override) });
    expect(html).toContain('Corrected by a person (outcome)');
    expect(html).toContain('Remove correction');
    expect(html).toContain('The AI&#x27;s original answer stays saved');
    expect(html).toContain('Quotation requested'); // the original outcome is named in the correction note
  });

  it('explains an unavailable recording, a pending analysis and a failed one', () => {
    expect(body(detail())).toContain('never answered');
    expect(body(detail({ analysis: { status: 'pending', error: null } }))).toContain('has not been analysed yet');
    expect(body(detail({ analysis: { status: 'failed', error: 'timeout' } }))).toContain('The last analysis attempt failed: timeout');
    expect(body(detail(), { canAnalyze: false })).not.toContain('Analyse again');
  });

  it('renders a transcript as speaker lines, copies it as text, and explains a missing one', () => {
    const lines = detail().transcriptLines;
    const html = renderToStaticMarkup(React.createElement(TranscriptView, { lines }));
    expect(html).toContain('Agent');
    expect(html).toContain('Caller');
    expect(transcriptText(lines)).toBe('Agent: Hello\nCaller: हाँ बताइए');
    expect(renderToStaticMarkup(React.createElement(TranscriptView, { lines: [], storedOff: true }))).toContain('transcripts were switched off');
    expect(renderToStaticMarkup(React.createElement(TranscriptView, { lines: [] }))).toContain('There is no transcript');
  });
});

describe('correction draft', () => {
  it('sends only what a person filled in and nothing when nothing changed', () => {
    expect(correctionPatch(draftFromOverride(null))).toBeNull();
    expect(correctionPatch({ outcome: 'demo_requested', interest: '', summary: ' ', nextAction: '', note: 'x' })).toEqual({ outcome: 'demo_requested', interest: null, summary: null, nextAction: null, note: 'x' });
  });
});
