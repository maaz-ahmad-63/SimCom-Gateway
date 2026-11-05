import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCampaignsRouter } from '../src/api/routes/campaigns.js';
import { parseCsv } from '../src/campaigns/csv.js';
import { analyzeRows } from '../src/campaigns/import.js';
import { makeHarness, MAP } from './campaign-harness.js';

type Harness = ReturnType<typeof makeHarness>;

async function runToCompletion(h: Harness) {
  h.store.start(h.campaign.id);
  for (let i = 0; i < 30; i++) {
    if ((await h.runner.tick()) === 'completed') return;
    h.advance(11_000);
  }
  throw new Error('did not complete');
}

const app = (h: Harness) => {
  const a = express();
  a.use(express.json());
  a.use('/api/campaigns', createCampaignsRouter({ store: h.store, runner: h.runner, blockers: () => [], now: () => new Date(h.clock.now) }));
  return a;
};
const body = (name: string) => ({ confirm: true, confirmName: name, acknowledgements: { realCalls: true, regulations: true, consent: true } });
const NEW = ['Name,Phone,Consent', 'F,+919812345670,yes', 'G,+919812345671,yes'].join('\n');

describe('running a finished campaign again', () => {
  it('calls only the new contacts after a new list is uploaded, and keeps every earlier call', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    const before = h.db.prepare('SELECT id, call_id, outcome FROM campaign_attempts ORDER BY id').all();
    const rows = analyzeRows(parseCsv(NEW), MAP, h.store.require(h.campaign.id).settings, () => false).rows;
    h.store.importContacts(h.campaign.id, rows, MAP);
    expect(h.store.require(h.campaign.id).status).toBe('completed'); // importing alone never starts anything

    const res = await request(app(h)).post(`/api/campaigns/${h.campaign.id}/restart`).send(body('Spring outreach'));
    expect(res.status).toBe(200);
    expect(res.body.campaign).toMatchObject({ status: 'running', finishedAt: null });
    const placed = h.dialer.placed.length;
    for (let i = 0; i < 20; i++) {
      if ((await h.runner.tick()) === 'completed') break;
      h.advance(11_000);
    }
    expect(h.dialer.placed.slice(placed).map((p) => p.e164)).toEqual(['+919812345670', '+919812345671']);
    expect(h.db.prepare('SELECT id, call_id, outcome FROM campaign_attempts ORDER BY id LIMIT 5').all()).toEqual(before); // earlier history untouched
    expect(h.store.require(h.campaign.id).status).toBe('completed');
  });

  it('needs the typed name, something waiting to call, and a finished campaign', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    const wrong = await request(app(h)).post(`/api/campaigns/${h.campaign.id}/restart`).send(body('nope'));
    expect(wrong.status).toBe(400);
    const empty = await request(app(h)).post(`/api/campaigns/${h.campaign.id}/restart`).send(body('Spring outreach'));
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('NOTHING_TO_CALL');
    expect(h.store.require(h.campaign.id).status).toBe('completed');

    const fresh = makeHarness();
    const draft = await request(app(fresh)).post(`/api/campaigns/${fresh.campaign.id}/restart`).send(body('Spring outreach'));
    expect(draft.body.code).toBe('BAD_STATE'); // a draft is started, not restarted
  });

  it('refuses while another campaign is running', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    h.store.importContacts(h.campaign.id, analyzeRows(parseCsv(NEW), MAP, h.store.require(h.campaign.id).settings, () => false).rows, MAP);
    const other = h.store.create('Other', { callingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC' } });
    h.store.importContacts(other.id, analyzeRows(parseCsv('Name,Phone,Consent\nZ,+919800000001,yes'), MAP, other.settings, () => false).rows, MAP);
    h.store.start(other.id);
    const res = await request(app(h)).post(`/api/campaigns/${h.campaign.id}/restart`).send(body('Spring outreach'));
    expect(res.body.code).toBe('ANOTHER_RUNNING');
  });
});
