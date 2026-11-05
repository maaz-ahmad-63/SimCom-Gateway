import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCampaignsRouter } from '../src/api/routes/campaigns.js';
import { CallContextEntry } from '../src/campaigns/call-context.js';
import { parseCsv } from '../src/campaigns/csv.js';
import { analyzeRows } from '../src/campaigns/import.js';
import { CampaignError, PROMPT_MAX_CHARS } from '../src/campaigns/store.js';
import { FIVE, makeHarness, MAP } from './campaign-harness.js';

/**
 * Editing a campaign after it has run. The rules under test: a completed campaign can be edited (name, settings, prompt, model, and
 * its contact list), editing never restarts anything, a replaced list leaves every earlier contact, attempt and call link in place,
 * and each call uses the configuration that was in force when it was placed.
 */

type Harness = ReturnType<typeof makeHarness>;

/** Run a harness campaign to the end: five contacts, one call each, then the campaign completes by itself. */
async function runToCompletion(h: Harness): Promise<void> {
  h.store.start(h.campaign.id);
  for (let i = 0; i < 30; i++) {
    if ((await h.runner.tick()) === 'completed') return;
    h.advance(11_000);
  }
  throw new Error('the campaign did not complete');
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const attemptRows = (h: Harness) => h.db.prepare('SELECT contact_id, call_id, outcome, config_version, prompt_sha, llm_key FROM campaign_attempts ORDER BY id').all() as Array<Record<string, any>>;

function app(h: Harness, problem: (key: string | null) => string | null = (key) => (key === 'good_model' || key === null ? null : `The model '${key}' is not in the Model Hub`)) {
  const a = express();
  a.use(express.json());
  a.use('/api/campaigns', createCampaignsRouter({ store: h.store, runner: h.runner, blockers: () => [], llm: { problem, choices: () => [] }, now: () => new Date(h.clock.now) }));
  return a;
}

describe('a completed campaign can be edited', () => {
  it('changes its name, settings, prompt and model without restarting it or touching its history', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    expect(h.store.require(h.campaign.id).status).toBe('completed');
    const placed = h.dialer.placed.length;
    const historyBefore = attemptRows(h);
    const countsBefore = h.store.counts(h.campaign.id);

    h.store.rename(h.campaign.id, 'Spring outreach (second round)');
    h.store.updateSettings(h.campaign.id, { maxAttempts: 4, greetingTemplate: 'Hello {name}' });
    const edited = h.store.saveConfig(h.campaign.id, { prompt: 'You are a friendly assistant for a dental clinic.', llmKey: 'good_model' });

    expect(edited).toMatchObject({ name: 'Spring outreach (second round)', status: 'completed' }); // still completed: nothing was restarted
    expect(edited.settings).toMatchObject({ maxAttempts: 4, greetingTemplate: 'Hello {name}' });
    expect(edited.config).toMatchObject({ version: 1, prompt: 'You are a friendly assistant for a dental clinic.', llmKey: 'good_model' });
    expect(await h.runner.tick()).toBe('idle'); // the runner has nothing to do: a completed campaign is not picked up again
    expect(h.dialer.placed).toHaveLength(placed);
    expect(h.store.counts(h.campaign.id)).toEqual(countsBefore);
    expect(attemptRows(h)).toEqual(historyBefore);
  });

  it('still protects what was confirmed at the start: the consent mode and the country code do not change afterwards', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    expect(() => h.store.updateSettings(h.campaign.id, { consentMode: 'attested' })).toThrow(/consent mode/);
    expect(() => h.store.updateSettings(h.campaign.id, { defaultCountryCode: '44' })).toThrow(/country code/);
  });

  it('a running campaign cannot be renamed or have its settings changed (pause it first), but its prompt can be: that only affects later calls', async () => {
    const h = makeHarness();
    h.store.start(h.campaign.id);
    expect(() => h.store.rename(h.campaign.id, 'x')).toThrow(/Pause the campaign/);
    expect(() => h.store.updateSettings(h.campaign.id, { maxAttempts: 3 })).toThrow(/Pause the campaign/);
    expect(h.store.saveConfig(h.campaign.id, { prompt: 'New instructions' }).config.version).toBe(1);
    expect(h.store.require(h.campaign.id).status).toBe('running');
  });
});

describe('replacing the CSV after the campaign has run', () => {
  const NEW_CSV = ['Name,Phone,Consent', 'Zoe,+919876543210,yes', 'Yan,+14155550999,yes', 'Xi,+442071234567,yes'].join('\n'); // the first number was in the old list too

  it('keeps every earlier contact, attempt and call link as history, makes the new list live, and leaves the campaign completed', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    const old = h.store.listContacts(h.campaign.id, { pageSize: 100 }).items;
    expect(old).toHaveLength(5);
    const attemptsBefore = attemptRows(h);
    const oldLinks = old.map((c) => [c.id, c.callId, c.status, c.lastOutcome]);

    const rows = analyzeRows(parseCsv(NEW_CSV), MAP, h.store.require(h.campaign.id).settings, () => false).rows;
    const counts = h.store.importContacts(h.campaign.id, rows, MAP, { csv: NEW_CSV, summary: { total: 3 } });

    // The live list is the new one, and its size is what the dashboard shows.
    expect(counts).toMatchObject({ total: 3, queued: 3 });
    expect(h.store.listContacts(h.campaign.id).items.map((c) => c.name)).toEqual(['Zoe', 'Yan', 'Xi']);
    expect(h.store.require(h.campaign.id)).toMatchObject({ status: 'completed', listVersion: 2 }); // not restarted, not resumed

    // The history is exactly as it was: same rows, same attempts, same calls and outcomes.
    const all = h.store.listContacts(h.campaign.id, { pageSize: 100, includeArchived: true }).items;
    const archived = all.filter((c) => c.archived);
    expect(archived).toHaveLength(5);
    expect(archived.map((c) => [c.id, c.callId, c.status, c.lastOutcome])).toEqual(oldLinks);
    expect(attemptRows(h)).toEqual(attemptsBefore);
    expect(h.store.attempts(old[0].id)).toHaveLength(1);

    // The campaign does not pick the new contacts up on its own.
    expect(await h.runner.tick()).toBe('idle');
    expect(h.dialer.placed).toHaveLength(5);
  });

  it('allows the same number in the new list as in the old one (only live contacts are unique)', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    const rows = analyzeRows(parseCsv(NEW_CSV), MAP, h.store.require(h.campaign.id).settings, () => false).rows;
    h.store.importContacts(h.campaign.id, rows, MAP);
    const same = h.store.listContacts(h.campaign.id, { includeArchived: true, pageSize: 100 }).items.filter((c) => c.phoneE164 === '+919876543210');
    expect(same.map((c) => c.archived).sort()).toEqual([false, true]);
  });

  it('sets aside old contacts that were still waiting, so they can never be dialled, and keeps the reason', () => {
    const h = makeHarness();
    h.store.start(h.campaign.id);
    h.store.pause(h.campaign.id, 'for the test');
    expect(h.store.counts(h.campaign.id).queued).toBe(5);
    const rows = analyzeRows(parseCsv(NEW_CSV), MAP, h.store.require(h.campaign.id).settings, () => false).rows;
    h.store.importContacts(h.campaign.id, rows, MAP);
    const old = h.store.listContacts(h.campaign.id, { includeArchived: true, pageSize: 100 }).items.filter((c) => c.archived);
    expect(old).toHaveLength(5);
    expect(old.every((c) => c.status === 'skipped' && c.skipReason === 'replaced by a newer contact list')).toBe(true);
    expect(h.store.counts(h.campaign.id)).toMatchObject({ total: 3, queued: 3 });
  });

  it('cannot replace the list while the campaign is running', () => {
    const h = makeHarness();
    h.store.start(h.campaign.id);
    const rows = analyzeRows(parseCsv(NEW_CSV), MAP, h.store.require(h.campaign.id).settings, () => false).rows;
    expect(() => h.store.importContacts(h.campaign.id, rows, MAP)).toThrow(CampaignError);
    expect(h.store.counts(h.campaign.id).total).toBe(5);
  });

  it('keeps the uploaded file exactly as sent, for auditing', async () => {
    const h = makeHarness();
    const a = app(h);
    const res = await request(a).post(`/api/campaigns/${h.campaign.id}/import`).send({ csv: NEW_CSV, mapping: MAP });
    expect(res.status).toBe(200);
    const list = (await request(a).get(`/api/campaigns/${h.campaign.id}/imports`)).body.imports;
    expect(list.map((i: { rowCount: number }) => i.rowCount)).toEqual([3]);
    const csv = await request(a).get(`/api/campaigns/${h.campaign.id}/imports/${list[0].id}/csv`);
    expect(csv.text).toBe(NEW_CSV);
  });
});

describe('the campaign prompt', () => {
  it('is limited to 10,000 characters: exactly 10,000 is saved, one more is refused, and nothing is cut off', () => {
    const h = makeHarness();
    const fits = 'a'.repeat(PROMPT_MAX_CHARS);
    expect(h.store.saveConfig(h.campaign.id, { prompt: fits }).config).toMatchObject({ version: 1, promptChars: PROMPT_MAX_CHARS });
    expect(h.store.activeConfig(h.campaign.id).prompt).toHaveLength(PROMPT_MAX_CHARS);

    let error: unknown;
    try {
      h.store.saveConfig(h.campaign.id, { prompt: 'b'.repeat(PROMPT_MAX_CHARS + 1) });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CampaignError);
    expect(error).toMatchObject({ code: 'PROMPT_TOO_LONG', status: 400 });
    expect((error as Error).message).toMatch(/10,001 characters; the limit is 10,000.*nothing was saved or cut off/);
    expect(h.store.activeConfig(h.campaign.id).prompt).toBe(fits); // the refused text changed nothing
    expect(h.store.configVersions(h.campaign.id)).toHaveLength(1);
  });

  it('is counted the way the dashboard counts it: a line break is one character', () => {
    const h = makeHarness();
    const text = `${'x'.repeat(PROMPT_MAX_CHARS - 1)}\r\n`; // 10,001 characters if CRLF counted twice
    expect(h.store.saveConfig(h.campaign.id, { prompt: text }).config.promptChars).toBe(PROMPT_MAX_CHARS);
  });

  it('is saved as an immutable version: a repeat creates nothing, a change creates the next, and older ones are kept', () => {
    const h = makeHarness();
    expect(h.store.require(h.campaign.id).config.version).toBe(0); // none yet: the campaign keeps its old behaviour
    h.store.saveConfig(h.campaign.id, { prompt: 'one' });
    h.store.saveConfig(h.campaign.id, { prompt: 'one' });
    h.store.saveConfig(h.campaign.id, { prompt: 'two', llmKey: 'good_model' });
    expect(h.store.configVersions(h.campaign.id).map((v) => [v.version, v.promptChars, v.llmKey, v.active])).toEqual([
      [2, 3, 'good_model', true],
      [1, 3, null, false],
    ]);
    expect(h.store.require(h.campaign.id).config.promptSha).toBe(sha('two'));
  });

  it('is not part of the campaign list (only its length), but is part of one campaign', async () => {
    const h = makeHarness();
    h.store.saveConfig(h.campaign.id, { prompt: 'Secret strategy: ask about the budget' });
    const a = app(h);
    const list = (await request(a).get('/api/campaigns')).body.campaigns[0];
    expect(list.config).toMatchObject({ promptChars: 37, prompt: '' });
    expect((await request(a).get(`/api/campaigns/${h.campaign.id}`)).body.campaign.config.prompt).toBe('Secret strategy: ask about the budget');
  });
});

describe('what each call is created with', () => {
  it('records the configuration version and prompt fingerprint of every attempt, and a later edit changes only later calls', async () => {
    const h = makeHarness();
    const seen: CallContextEntry[] = [];
    const register = h.contexts.register.bind(h.contexts);
    h.contexts.register = (entry) => {
      seen.push(entry);
      register(entry);
    };
    h.store.saveConfig(h.campaign.id, { prompt: 'PROMPT ONE: be brief.', llmKey: 'good_model' });
    h.store.start(h.campaign.id);
    await h.runner.tick(); // call 1, under version 1

    h.store.saveConfig(h.campaign.id, { prompt: 'PROMPT TWO: be thorough.', llmKey: null });
    h.advance(11_000);
    await h.runner.tick(); // call 2, under version 2

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ configVersion: 1, llmKey: 'good_model' });
    expect(seen[0].systemPrompt).toContain('PROMPT ONE: be brief.');
    expect(seen[0].systemPrompt).not.toContain('PROMPT TWO'); // the first call's snapshot did not change when the campaign was edited
    expect(seen[1]).toMatchObject({ configVersion: 2, llmKey: null });
    expect(seen[1].systemPrompt).toContain('PROMPT TWO: be thorough.');
    expect(attemptRows(h).map((r) => [r.config_version, r.prompt_sha, r.llm_key])).toEqual([
      [1, sha('PROMPT ONE: be brief.'), 'good_model'],
      [2, sha('PROMPT TWO: be thorough.'), null],
    ]);
  });
});

describe('editing over the API', () => {
  it('edits a completed campaign (name, settings, prompt, model) and reports it still completed with the new configuration', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    const a = app(h);
    const res = await request(a).patch(`/api/campaigns/${h.campaign.id}`).send({ name: 'Renamed', settings: { maxAttempts: 3 }, config: { prompt: 'Be helpful.', llmKey: 'good_model' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.campaign).toMatchObject({ name: 'Renamed', status: 'completed', config: { version: 1, prompt: 'Be helpful.', llmKey: 'good_model' } });
    expect(res.body.campaign.settings.maxAttempts).toBe(3);
    expect(res.body.counts.total).toBe(5);
  });

  it('refuses a prompt over the limit with a clear error and saves NOTHING from that request, not even the name', async () => {
    const h = makeHarness();
    const a = app(h);
    const res = await request(a).patch(`/api/campaigns/${h.campaign.id}`).send({ name: 'Should not stick', config: { prompt: 'z'.repeat(PROMPT_MAX_CHARS + 1) } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROMPT_TOO_LONG');
    expect(res.body.error).toMatch(/limit is 10,000/);
    expect(h.store.require(h.campaign.id)).toMatchObject({ name: 'Spring outreach', config: { version: 0 } });
  });

  it('refuses a model that is not available, and says why, before saving anything', async () => {
    const h = makeHarness();
    const a = app(h);
    const res = await request(a).patch(`/api/campaigns/${h.campaign.id}`).send({ config: { prompt: 'x', llmKey: 'no_such_model' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MODEL' });
    expect(res.body.error).toMatch(/not in the Model Hub/);
    expect(h.store.require(h.campaign.id).config.version).toBe(0);
  });

  it('replaces the CSV on a completed campaign over the API, reporting the new contact count and that the history was kept', async () => {
    const h = makeHarness();
    await runToCompletion(h);
    const a = app(h);
    const csv = 'Name,Phone,Consent,City\nZoe,+919876543210,yes,Pune\nYan,+14155550999,yes,Austin';
    const preview = await request(a).post('/api/campaigns/preview-csv').send({ csv, campaignId: h.campaign.id });
    expect(preview.body.detection.name.column).toBe('Name');
    const res = await request(a).post(`/api/campaigns/${h.campaign.id}/import`).send({ csv, mapping: { phone: 'Phone', name: 'Name', consent: 'Consent' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replacedEarlierList: true, listVersion: 2, status: 'completed', counts: { total: 2, queued: 2 }, customColumns: ['City'] });
    expect(attemptRows(h)).toHaveLength(5); // every earlier attempt is still there
  });
});

describe('a campaign with no saved prompt', () => {
  it('keeps the behaviour it always had: the gateway\'s outbound agent plus the older context block, nothing from the new path', async () => {
    const h = makeHarness();
    const seen: CallContextEntry[] = [];
    const register = h.contexts.register.bind(h.contexts);
    h.contexts.register = (entry) => {
      seen.push(entry);
      register(entry);
    };
    h.store.start(h.campaign.id);
    await h.runner.tick();
    expect(seen[0].systemPrompt).toBeUndefined();
    expect(seen[0].contextBlock).toContain('CALL CONTEXT');
    expect(seen[0].contextBlock).toContain('CAMPAIGN RULE');
    expect(seen[0].configVersion).toBe(0);
    expect(FIVE).toContain('A'); // (the harness list is the file the call was made from)
  });
});
