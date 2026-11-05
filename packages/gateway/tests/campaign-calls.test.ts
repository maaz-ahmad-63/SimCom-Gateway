import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCampaignsRouter } from '../src/api/routes/campaigns.js';
import { CallAnalysisStore, FILTERS, parseAiResult, ruleClassification } from '../src/campaigns/call-analysis.js';
import { CallAnalysisService, CampaignCallRecords, csvCell } from '../src/campaigns/call-records.js';
import { parseCsv } from '../src/campaigns/csv.js';
import { analyzeRows } from '../src/campaigns/import.js';
import { makeHarness, MAP } from './campaign-harness.js';

/**
 * Campaign call records: the table, the detail, the counts and the export come from the same saved rows and the same classification;
 * a real conversation is analysed once by the model and a person's correction is laid over it without changing it.
 */

type Harness = ReturnType<typeof makeHarness>;

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    outcome: 'quotation_requested',
    interest: 'high',
    sentiment: 'positive',
    summary: 'The administrator asked for a quotation and pricing by email.',
    requirements: ['AI voice agent for appointment reminders'],
    objections: [],
    next_action: 'Send a quotation by email.',
    callback: { requested: false, when: null, note: null },
    quotation_requested: true,
    demo_requested: false,
    ...over,
  });

/** Five finished campaign attempts, each with a call row, shaped as: 1 conversation, 2 no answer, 3 conversation, 4 failed, 5 one-word reply. */
async function seeded() {
  const h = makeHarness();
  h.store.start(h.campaign.id);
  for (let i = 0; i < 30; i++) {
    if ((await h.runner.tick()) === 'completed') break;
    h.advance(11_000);
  }
  const attempts = h.db.prepare('SELECT id, call_id FROM campaign_attempts ORDER BY id').all() as Array<{ id: number; call_id: string }>;
  expect(attempts).toHaveLength(5);
  const outcomes = ['completed', 'no_answer', 'completed', 'failed', 'completed'];
  const durations = [64, 0, 41, 0, 8];
  attempts.forEach((a, i) => {
    h.db.prepare('UPDATE campaign_attempts SET outcome = ?, error = ? WHERE id = ?').run(outcomes[i] === 'completed' ? 'answered' : outcomes[i], outcomes[i] === 'failed' ? 'modem error' : null, a.id);
    h.db
      .prepare("INSERT INTO calls (id, direction, remote_number, state, started_at, answered_at, ended_at, duration_seconds, outcome, termination_reason, is_simulated) VALUES (?, 'outbound', ?, 'IDLE', ?, ?, ?, ?, ?, ?, 0)")
      .run(a.call_id, '+000', '2026-10-28T10:00:00.000Z', outcomes[i] === 'completed' ? '2026-10-28T10:00:05.000Z' : null, '2026-10-28T10:01:00.000Z', durations[i], outcomes[i], 'normal');
  });
  const turn = (callId: string, at: string, transcript: string | null, replyText: string | null) =>
    h.db
      .prepare("INSERT INTO ai_turns (call_id, at, status, transcript, reply, stt_seconds, llm_prompt_tokens, llm_completion_tokens, tts_chars, stt_key, llm_key, tts_key, mock) VALUES (?, ?, 'completed', ?, ?, 2, 100, 20, 50, 'k', 'k', 'k', 0)")
      .run(callId, at, transcript, replyText);
  turn(attempts[0].call_id, '2026-10-28T10:00:06.000Z', null, 'Hello, this is the assistant calling about our service.');
  turn(attempts[0].call_id, '2026-10-28T10:00:20.000Z', 'हाँ बताइए, हम अस्पताल के लिए कुछ देख रहे हैं', 'Great, can I send details?');
  turn(attempts[0].call_id, '2026-10-28T10:00:40.000Z', 'Yes, please send a quotation by email', 'Sure, I will arrange that.');
  turn(attempts[2].call_id, '2026-10-28T10:00:20.000Z', 'We already use a system', 'I understand.');
  turn(attempts[2].call_id, '2026-10-28T10:00:40.000Z', 'No thanks', 'Thank you for your time.');
  turn(attempts[4].call_id, '2026-10-28T10:00:20.000Z', 'hello?', 'Hi there.');
  return { h, attempts };
}

function setup(h: Harness, complete?: ConstructorParameters<typeof CallAnalysisService>[0]['complete']) {
  const store = new CallAnalysisStore(h.db);
  const records = new CampaignCallRecords(h.db, store);
  const analysis = new CallAnalysisService({ db: h.db, records, store, complete });
  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', createCampaignsRouter({ store: h.store, runner: h.runner, blockers: () => [], calls: { records, analysis, store } }));
  return { store, records, analysis, app };
}

const completeWith = (text: string) => async () => ({ text, promptTokens: 300, completionTokens: 90, llmKey: 'm1' });

describe('what a call came to without reading it', () => {
  it('classifies from how the call ended and says nothing it does not know', async () => {
    const { h } = await seeded();
    const { records } = setup(h);
    const items = records.list(h.campaign.id, { sort: 'startedAt', dir: 'asc' }).items;
    const by = Object.fromEntries(items.map((i) => [i.callId, i]));
    expect(by['call-2'].classification).toMatchObject({ outcome: 'no_answer', source: 'rule', summary: 'No answer. No conversation took place.' });
    expect(by['call-4'].classification).toMatchObject({ outcome: 'failed' });
    expect(by['call-4'].classification.summary).toContain('modem error');
    expect(by['call-5'].classification.outcome).toBe('incomplete'); // one reply from the caller
    expect(by['call-1'].classification).toMatchObject({ outcome: 'answered', source: 'rule' }); // a conversation, not yet read by the model
    expect(by['call-1'].analysis.status).toBe('pending');
    expect(by['call-2'].analysis.status).toBe('not_needed');
    // values that were never recorded stay unavailable
    expect(by['call-1'].sipNumber).toBeNull();
    expect(by['call-2'].sentiment).toBeNull();
    expect(by['call-2'].cost.usd).toBeNull();
    expect(by['call-2'].transcript.available).toBe(false);
  });

  it('treats a number that asked not to be called as do-not-call, but not an operator\'s later manual entry', async () => {
    const { h } = await seeded();
    const { records } = setup(h);
    h.store.addDoNotCall('+919876543210', 'asked on the call', 'spoken');
    expect(records.list(h.campaign.id, { filter: 'do_not_call' }).items.map((i) => i.callId)).toEqual(['call-1']);
    h.store.removeDoNotCall('+919876543210');
    h.store.addDoNotCall('+919876543210', 'testing', 'operator');
    expect(records.list(h.campaign.id, { filter: 'do_not_call' }).total).toBe(0);
  });

  it('rule classification handles transcripts being switched off and unfinished calls', () => {
    const base = { attemptOutcome: 'answered', error: null, durationSeconds: 30, callerTurns: 0, turns: 3, transcriptStored: false, optedOut: false, finished: true };
    expect(ruleClassification(base).summary).toMatch(/Transcripts were switched off/);
    expect(ruleClassification({ ...base, finished: false }).outcome).toBe('incomplete');
    expect(ruleClassification({ ...base, turns: 0 }).summary).toMatch(/disconnected before the agent could explain/);
  });
});

describe('analysis of a real conversation', () => {
  it('reads only real conversations, stores the original result, and feeds the table and the counts alike', async () => {
    const { h, attempts } = await seeded();
    const requests: string[] = [];
    const { records, analysis, store } = setup(h, async (r) => {
      requests.push(r.user);
      return { text: r.user.includes('quotation') ? reply() : reply({ outcome: 'not_interested', interest: 'none', sentiment: 'negative', summary: 'The contact declined: they already use a system.', objections: ['already has a system'], quotation_requested: false, next_action: 'Do not follow up.' }), promptTokens: 300, completionTokens: 90, llmKey: 'm1' };
    });
    const results = [];
    for (const a of attempts) results.push((await analysis.analyze(h.campaign.id, a.id)).status);
    expect(results).toEqual(['analysed', 'skipped', 'analysed', 'skipped', 'skipped']); // no answer, failed and the one-word reply are never sent to the model
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('Caller: हाँ बताइए'); // the original Hindi text is sent as saved
    expect(requests[0]).not.toContain('+919876543210'); // the number is never sent
    expect((await analysis.analyze(h.campaign.id, attempts[0].id)).status).toBe('skipped'); // not analysed twice unless asked

    expect(store.runs(attempts[0].id)).toHaveLength(1);
    const list = records.list(h.campaign.id);
    for (const filter of FILTERS) expect(records.list(h.campaign.id, { filter }).total, filter).toBe(records.analytics(h.campaign.id).counts[filter]);
    const counts = records.analytics(h.campaign.id).counts;
    expect(counts).toMatchObject({ quotation: 1, interested: 1, not_interested: 1, no_answer: 1, failed: 1, incomplete: 1, all: 5 });
    expect(list.items.find((i) => i.callId === 'call-1')!.classification).toMatchObject({ outcome: 'quotation_requested', source: 'ai', sentiment: 'positive' });
    expect(records.analytics(h.campaign.id).analysed).toBe(2);
  });

  it('keeps a failed analysis visible and falls back to the rules', async () => {
    const { h, attempts } = await seeded();
    const { records, analysis } = setup(h, completeWith('sorry, I cannot do that'));
    expect((await analysis.analyze(h.campaign.id, attempts[0].id)).status).toBe('failed');
    const row = records.list(h.campaign.id).items.find((i) => i.callId === 'call-1')!;
    expect(row.classification.source).toBe('rule');
    expect(row.analysis.status).toBe('failed');
    expect(row.analysis.error).toMatch(/JSON/);
    expect(parseAiResult('{"outcome":"interested"}').ok).toBe(false);
  });

  it('is unavailable, not invented, when no model can be used', async () => {
    const { h, attempts } = await seeded();
    const { analysis, app } = setup(h);
    expect((await analysis.analyze(h.campaign.id, attempts[0].id)).status).toBe('skipped');
    const res = await request(app).post(`/api/campaigns/${h.campaign.id}/calls/${attempts[0].id}/analyze`);
    expect(res.status).toBe(503);
  });
});

describe('a person can correct the result without losing the original', () => {
  it('lays the correction over the AI result and removes it again', async () => {
    const { h, attempts } = await seeded();
    const { app, analysis, store } = setup(h, completeWith(reply()));
    await analysis.analyze(h.campaign.id, attempts[0].id);
    const base = `/api/campaigns/${h.campaign.id}/calls/${attempts[0].id}`;
    const put = await request(app).put(`${base}/classification`).send({ outcome: 'demo_requested', note: 'Confirmed by phone', summary: '' });
    expect(put.status).toBe(200);
    expect(put.body.call.classification).toMatchObject({ outcome: 'demo_requested', source: 'manual', correctedFields: ['outcome'], demoRequested: true, quotationRequested: false });
    expect(put.body.call.analysisDetail.original).toMatchObject({ outcome: 'quotation_requested' }); // the AI's answer is untouched
    expect(store.runs(attempts[0].id)).toHaveLength(1);
    expect((await request(app).get(`/api/campaigns/${h.campaign.id}/analytics`)).body.counts).toMatchObject({ demo: 1, quotation: 0 });

    const bad = await request(app).put(`${base}/classification`).send({ outcome: 'sold_it' });
    expect(bad.status).toBe(400);
    expect((await request(app).put(`${base}/classification`).send({})).status).toBe(400);

    const del = await request(app).delete(`${base}/classification`);
    expect(del.body.call.classification).toMatchObject({ outcome: 'quotation_requested', source: 'ai' });
  });
});

describe('records of one campaign stay in that campaign', () => {
  it('never lists or opens another campaign\'s call', async () => {
    const { h, attempts } = await seeded();
    const { app } = setup(h);
    const other = h.store.create('Other', {});
    h.store.importContacts(other.id, analyzeRows(parseCsv('Name,Phone\nZed,+919812345670'), { phone: 'Phone', name: 'Name' }, other.settings, () => false).rows, { phone: 'Phone', name: 'Name' });
    expect((await request(app).get(`/api/campaigns/${other.id}/calls`)).body.total).toBe(0);
    expect((await request(app).get(`/api/campaigns/${other.id}/calls/${attempts[0].id}`)).status).toBe(404);
    expect((await request(app).put(`/api/campaigns/${other.id}/calls/${attempts[0].id}/classification`).send({ outcome: 'interested' })).status).toBe(404);
    expect((await request(app).get(`/api/campaigns/${other.id}/calls/export.csv`)).text).not.toContain('Hello');
    expect((await request(app).get(`/api/campaigns/${h.campaign.id}/calls`)).body.total).toBe(5);
  });
});

describe('table behaviour: search, sort, pages and the call detail', () => {
  it('searches names and transcripts, sorts, pages and opens a full detail with the original transcript', async () => {
    const { h, attempts } = await seeded();
    const { app } = setup(h);
    const url = `/api/campaigns/${h.campaign.id}/calls`;
    expect((await request(app).get(`${url}?search=quotation by email`)).body.items.map((i: any) => i.callId)).toEqual(['call-1']);
    expect((await request(app).get(`${url}?search=हाँ`)).body.total).toBe(1);
    const sorted = (await request(app).get(`${url}?sort=duration&dir=desc`)).body.items.map((i: any) => i.durationSeconds);
    expect(sorted).toEqual([64, 41, 8, 0, 0]);
    const page2 = (await request(app).get(`${url}?pageSize=2&page=3&sort=duration&dir=desc`)).body;
    expect(page2).toMatchObject({ total: 5, page: 3 });
    expect(page2.items).toHaveLength(1);
    expect((await request(app).get(`${url}?pageSize=500`)).status).toBe(400);

    const detail = (await request(app).get(`${url}/${attempts[0].id}`)).body.call;
    expect(detail.transcriptLines.map((l: any) => `${l.speaker}: ${l.text}`)).toEqual([
      'Agent: Hello, this is the assistant calling about our service.',
      'Caller: हाँ बताइए, हम अस्पताल के लिए कुछ देख रहे हैं',
      'Agent: Great, can I send details?',
      'Caller: Yes, please send a quotation by email',
      'Agent: Sure, I will arrange that.',
    ]);
    expect(detail).toMatchObject({ callId: 'call-1', direction: 'outbound', durationSeconds: 64, usage: { turns: 3, inputTokens: 300 }, tools: [] });
    expect(detail.contact.name).toBe('A');
    expect(detail.transcript.preview.length).toBeGreaterThan(10);
  });
});

describe('export', () => {
  it('exports exactly the filtered rows, keeps phone numbers intact and neutralises spreadsheet formulas', async () => {
    const { h, attempts } = await seeded();
    const { app, analysis } = setup(h, completeWith(reply({ summary: '=HYPERLINK("http://x")' })));
    await analysis.analyze(h.campaign.id, attempts[0].id);
    const res = await request(app).get(`/api/campaigns/${h.campaign.id}/calls/export.csv?filter=quotation`);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',+919876543210,'); // a phone number is not mangled
    expect(lines[1]).toContain("'=HYPERLINK"); // a formula is made plain text
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+919876543210')).toBe('+919876543210');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});
