import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../src/ai/audio.js';
import { agentFor } from '../src/ai/directions.js';
import { AiSettingsService } from '../src/ai/settings.js';
import { createMockProviders } from '../src/ai/providers/mock.js';
import { LlmProvider } from '../src/ai/providers/types.js';
import { createGatewayServer } from '../src/server.js';
import { aiEnv, FORMAT_8K, makeConfig, noiseFloorPcm, sleep, speechPcm } from './ai/helpers.js';
import { FakeGoogle, MemoryBackend, PRIVATE_KEY, serviceAccountJson, SHEET_ID } from './ai/sheets-helpers.js';
import { ToolLlm } from './ai/tool-llm.js';

/**
 * Inbound and outbound agent configuration, tool calling and Google Sheets through the real gateway wiring, with a mock modem,
 * mock providers and a fake Google. Mocked end to end: it says nothing about a real modem, model or Google account.
 */
vi.setConfig({ testTimeout: 30_000 }); // whole calls, each step waiting on the one before
const KEY = 'agent-directions-key-123456';
const MASTER = 'a-long-master-key-for-tests-only';
const BASE_ENV = {
  AI_SECRETS_MASTER_KEY: MASTER,
  AI_AUTO_HANDLE: 'all',
  AI_AUTO_REPLIES: 'true',
  AI_AUTO_ANSWER: 'true',
  AI_AUTO_ANSWER_RINGS: '2',
  AI_AUTO_ACTIVATE_USB_AUDIO: 'true',
  AI_AUDIO_INBOUND_VERIFIED: 'true',
  AI_AUDIO_OUTBOUND_VERIFIED: 'true',
  AI_PLAYBACK_GUARD_MS: '0',
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function gateway(opts: { env?: Record<string, string | undefined>; stt?: string[]; llm?: LlmProvider; google?: FakeGoogle } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-sheets-'));
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 60 });
  const source = new ManualAudioSource(FORMAT_8K, true);
  const sink = new CollectingAudioSink(FORMAT_8K, true, 0);
  const google = opts.google ?? new FakeGoogle();
  const providers = createMockProviders({ stt: opts.stt ?? ['hello there', 'one more thing'], llm: ['First answer here.', 'Second answer here.'] });
  if (opts.llm) (providers as { llm: LlmProvider }).llm = opts.llm;
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: {
      env: aiEnv({ ...BASE_ENV, ...opts.env }),
      providers,
      fetchImpl: google.fetch,
      allowSimulatedHardware: true,
      transports: () => ({ source, sink }),
      idleWaitsMs: [60_000, 60_000, 60_000],
      automationAudioWaitMs: 1500,
      automationPollMs: 20,
      automationActivation: { settleMs: 0, retryMs: 20, attempts: 3 },
    },
  });
  await modem.initialize();
  server.aiRuntime.start();
  cleanups.push(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const api = (m: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) => {
    const r = request(server.app)[m](url).set('x-api-key', KEY);
    return body ? r.send(body) : r;
  };
  const urc = (raw: string, type: string, extra: object = {}) => modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false, ...extra } as never);
  const ring = () => {
    urc('RING', 'RING');
    urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
  };
  const callerSays = async () => {
    await vi.waitFor(() => expect(server.aiOrchestrator.getSessions()[0]?.conversation.phase).toBe('listening'), { timeout: 5000 });
    source.push(speechPcm(1200));
    source.push(noiseFloorPcm(1300));
  };
  const configureSheets = async (config: object = {}) => {
    expect((await api('put', '/api/integrations/google-sheets/credential', { serviceAccountJson: serviceAccountJson() })).status).toBe(200);
    const saved = await api('put', '/api/integrations/google-sheets', { spreadsheetId: SHEET_ID, sheetName: 'Calls', enabled: true, ...config });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  };
  return { server, sink, source, providers, google, api, ring, callerSays, configureSheets };
}

const CSV = ['Name,Phone,Consent', 'Asha Verma,9876543210,yes', 'Bo Lee,9123456789,yes'].join('\n');
const MAPPING = { phone: 'Phone', name: 'Name', consent: 'Consent' };
const HOURS = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC' };

async function startCampaign(h: Awaited<ReturnType<typeof gateway>>, settings: object = {}) {
  const created = await h.api('post', '/api/campaigns', { name: 'Directions', settings: { callingHours: HOURS, defaultCountryCode: '91', ...settings } });
  expect(created.status).toBe(201);
  const id = created.body.campaign.id as string;
  expect((await h.api('post', `/api/campaigns/${id}/import`, { csv: CSV, mapping: MAPPING })).body.summary).toMatchObject({ callable: 2 });
  const started = await h.api('post', `/api/campaigns/${id}/start`, { confirm: true, confirmName: 'Directions', acknowledgements: { realCalls: true, regulations: true, consent: true } });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const tick = h.server.campaignRunner.tick();
  await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()?.state).toBe('ACTIVE'), { timeout: 5000 });
  return { id, tick };
}

describe('separate inbound and outbound agent configuration', () => {
  const INBOUND = { AI_INBOUND_GREETING: 'Thank you for calling Acme, how can I help?', AI_INBOUND_INSTRUCTIONS: 'INBOUND ROLE: you are the Acme receptionist.' };
  const OUTBOUND = { AI_OUTBOUND_GREETING: 'Hi, this is Sam from Acme calling you back.', AI_OUTBOUND_INSTRUCTIONS: 'OUTBOUND ROLE: you are Acme\'s outreach agent.' };

  it('picks the prompt and greeting from the call direction, and keeps one shared engine and rule set', () => {
    const config = makeConfig({ AI_GREETING: 'Shared hello.', AI_SYSTEM_INSTRUCTIONS: 'SHARED RULES.', ...INBOUND, ...OUTBOUND });
    const inbound = agentFor(config, 'inbound');
    const outbound = agentFor(config, 'outbound');
    expect(inbound.greeting).toBe(INBOUND.AI_INBOUND_GREETING);
    expect(outbound.greeting).toBe(OUTBOUND.AI_OUTBOUND_GREETING);
    expect(inbound.systemPrompt).toBe(`${INBOUND.AI_INBOUND_INSTRUCTIONS}\n\n${config.promptBody}`);
    expect(outbound.systemPrompt).toBe(`${OUTBOUND.AI_OUTBOUND_INSTRUCTIONS}\n\n${config.promptBody}`);
    expect(inbound.systemPrompt).not.toContain('OUTBOUND ROLE');
    expect(outbound.systemPrompt).not.toContain('INBOUND ROLE');
    expect(inbound.systemPrompt).not.toContain('SHARED RULES'); // the direction's own instructions replace the shared ones
    expect(inbound.source).toEqual({ instructions: 'direction', greeting: 'direction' });
    // The built-in call rules are the same for both: one voice engine.
    expect(inbound.systemPrompt.endsWith(config.promptBody)).toBe(true);
    expect(outbound.systemPrompt.endsWith(config.promptBody)).toBe(true);
  });

  it('a direction with nothing of its own uses the shared settings, so an unconfigured gateway behaves as before', () => {
    const config = makeConfig({ AI_GREETING: 'Shared hello.', AI_SYSTEM_INSTRUCTIONS: 'SHARED RULES.', ...INBOUND });
    expect(agentFor(config, 'inbound').greeting).toBe(INBOUND.AI_INBOUND_GREETING);
    expect(agentFor(config, 'outbound')).toMatchObject({ greeting: 'Shared hello.', source: { instructions: 'shared', greeting: 'shared' } });
    expect(agentFor(config, 'outbound').systemPrompt).toBe(config.systemPrompt); // exactly the old combined prompt
    const plain = makeConfig();
    expect(agentFor(plain, 'inbound')).toMatchObject({ systemPrompt: plain.systemPrompt, greeting: null, source: { instructions: 'none', greeting: 'none' } });
  });

  it('is saved from the dashboard settings, survives a reload, and an empty value goes back to the shared one', () => {
    const backend = new MemoryBackend();
    const settings = new AiSettingsService(backend, aiEnv({ AI_GREETING: 'Shared hello.', AI_OUTBOUND_GREETING: 'From the env file.' }), MASTER);
    settings.update({ agent: { inboundGreeting: 'Hello inbound', inboundInstructions: 'Receptionist.', outboundGreeting: 'Hello outbound', outboundInstructions: 'Outreach.' } });
    const view = settings.view(settings.loadConfig()).agent;
    expect(view).toMatchObject({ inboundGreeting: 'Hello inbound', inboundInstructions: 'Receptionist.', outboundGreeting: 'Hello outbound', outboundInstructions: 'Outreach.', greeting: 'Shared hello.' });
    const config = new AiSettingsService(backend, aiEnv(), MASTER).loadConfig().config;
    expect(agentFor(config, 'inbound').greeting).toBe('Hello inbound');
    expect(agentFor(config, 'outbound').systemPrompt.startsWith('Outreach.')).toBe(true);
    settings.update({ agent: { outboundGreeting: '' } }); // cleared: beats the value in the env file, falls back to the shared greeting
    expect(agentFor(settings.loadConfig().config, 'outbound').greeting).toBe('Shared hello.');
    expect(() => settings.update({ agent: { outboundInstructions: 'x'.repeat(8001) } })).toThrow();
    expect(() => settings.update({ agent: { inboundGreeting: 'x'.repeat(501) } })).toThrow();
  });

  it('an inbound call is greeted and instructed with the inbound configuration only', async () => {
    const h = await gateway({ env: { ...INBOUND, ...OUTBOUND, AI_GREETING: 'Shared hello.' } });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 5000 });
    expect(h.providers.tts.requests).toEqual([INBOUND.AI_INBOUND_GREETING]);
    await h.callerSays();
    await vi.waitFor(() => expect(h.providers.llm.requests).toHaveLength(1), { timeout: 5000 });
    const system = h.providers.llm.requests[0].system;
    expect(system.startsWith(INBOUND.AI_INBOUND_INSTRUCTIONS)).toBe(true);
    expect(system).not.toContain('OUTBOUND ROLE');
    expect(h.server.aiRuntime.config.config.systemPrompt).not.toContain('INBOUND ROLE'); // the stored shared prompt is untouched
  });

  it('an outbound campaign call uses the outbound configuration; the campaign\'s own context and greeting template still win where set', async () => {
    const h = await gateway({ env: { ...INBOUND, ...OUTBOUND, AI_GREETING: 'Shared hello.' } });
    const { tick } = await startCampaign(h, { contextNote: 'follow-up on the quote' });
    await vi.waitFor(() => expect(h.providers.tts.requests.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(h.providers.tts.requests[0]).toBe(OUTBOUND.AI_OUTBOUND_GREETING); // no campaign template: the outbound greeting
    await h.callerSays();
    await vi.waitFor(() => expect(h.providers.llm.requests).toHaveLength(1), { timeout: 5000 });
    const system = h.providers.llm.requests[0].system;
    expect(system.startsWith(OUTBOUND.AI_OUTBOUND_INSTRUCTIONS)).toBe(true);
    expect(system).not.toContain('INBOUND ROLE');
    expect(system).toContain('contact_name: Asha Verma'); // the campaign's per-call context is still added
    expect(system).toContain('campaign_purpose: follow-up on the quote');
    expect(system).toContain('CAMPAIGN RULE');
    await h.server.callManager.hangup('test over');
    await tick;
  });

  it('a campaign greeting template beats the outbound greeting', async () => {
    const h = await gateway({ env: { ...OUTBOUND } });
    const { tick } = await startCampaign(h, { greetingTemplate: 'Hello {name}, Sarah here.' });
    await vi.waitFor(() => expect(h.providers.tts.requests.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(h.providers.tts.requests[0]).toBe('Hello Asha Verma, Sarah here.');
    await h.server.callManager.hangup('test over');
    await tick;
  });

  it('the dashboard API returns and saves the per-direction fields', async () => {
    const h = await gateway();
    const saved = await h.api('put', '/api/ai/agent', { inboundGreeting: 'In.', outboundGreeting: 'Out.', inboundInstructions: 'I.', outboundInstructions: 'O.' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ inboundGreeting: 'In.', outboundGreeting: 'Out.', inboundInstructions: 'I.', outboundInstructions: 'O.' });
    expect((await h.api('get', '/api/ai/agent')).body).toMatchObject({ inboundGreeting: 'In.', outboundGreeting: 'Out.' });
    expect((await h.api('put', '/api/ai/agent', { outboundGreeting: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('Google Sheets configuration API', () => {
  it('requires the gateway API key', async () => {
    const h = await gateway();
    for (const [m, u] of [['get', '/api/integrations/google-sheets'], ['put', '/api/integrations/google-sheets'], ['put', '/api/integrations/google-sheets/credential'], ['post', '/api/integrations/google-sheets/test']] as const) {
      expect((await request(h.server.app)[m](u)).status).toBe(401);
    }
  });

  it('stores the key encrypted, never returns it, reports model support, tests the connection read-only, and removes it', async () => {
    const h = await gateway();
    const before = await h.api('get', '/api/integrations/google-sheets');
    expect(before.body).toMatchObject({ config: { enabled: false }, credential: { stored: false }, secretStorageAvailable: true, modelTools: { supported: true, provider: 'groq' } });
    expect((await h.api('put', '/api/integrations/google-sheets', { enabled: true })).status).toBe(409); // nothing to enable yet

    const everything: string[] = [];
    const remember = (r: { body: unknown; text: string }) => everything.push(r.text);
    const key = await h.api('put', '/api/integrations/google-sheets/credential', { serviceAccountJson: serviceAccountJson() });
    remember(key);
    expect(key.body.credential).toEqual({ stored: true, serviceAccountEmail: 'caller-bot@voice-project.iam.gserviceaccount.com', undecryptable: false });

    const cfg = await h.api('put', '/api/integrations/google-sheets', { spreadsheetId: SHEET_ID, sheetName: 'Calls', enabled: true, logOutcomes: true });
    remember(cfg);
    expect(cfg.body.config).toMatchObject({ enabled: true, spreadsheetId: SHEET_ID, logOutcomes: true });

    const test = await h.api('post', '/api/integrations/google-sheets/test');
    remember(test);
    expect(test.body.result.ok).toBe(true);
    // The dashboard replaces its status with this one, so it must carry the model's tool support (it was undefined here once).
    expect(test.body.status.modelTools).toMatchObject({ supported: true, provider: 'groq' });
    expect(h.google.rows).toHaveLength(0); // the test wrote nothing
    expect(h.google.calls.filter((c) => c.kind === 'append' || c.kind === 'update')).toHaveLength(0);
    remember(await h.api('get', '/api/integrations/google-sheets'));
    remember(await h.api('get', '/api/ai/state'));
    remember(await h.api('get', '/api/ai/credentials'));

    // Nothing the API ever said holds the private key, a token, or a fragment of the key file.
    const all = everything.join('\n');
    expect(all).not.toContain('PRIVATE KEY');
    expect(all).not.toContain(PRIVATE_KEY.split('\n')[1]);
    expect(all).not.toContain('ya29');
    expect(all).not.toContain('abc123');

    const removed = await h.api('delete', '/api/integrations/google-sheets/credential');
    expect(removed.body).toMatchObject({ credential: { stored: false }, config: { enabled: false } });
  });

  it('refuses a bad key file and a bad spreadsheet setting with a reason, and stores nothing', async () => {
    const h = await gateway();
    const bad = await h.api('put', '/api/integrations/google-sheets/credential', { serviceAccountJson: '{"type":"authorized_user"}' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ success: false, code: 'invalid_credential' });
    expect(JSON.stringify(bad.body)).not.toContain('authorized_user');
    expect((await h.api('get', '/api/integrations/google-sheets')).body.credential.stored).toBe(false);
    expect((await h.api('put', '/api/integrations/google-sheets', { spreadsheetId: 'https://docs.google.com/spreadsheets/d/x/edit' })).status).toBe(400);
  });

  it('without AI_SECRETS_MASTER_KEY the key cannot be stored, and says why', async () => {
    const h = await gateway({ env: { AI_SECRETS_MASTER_KEY: '' } });
    const res = await h.api('put', '/api/integrations/google-sheets/credential', { serviceAccountJson: serviceAccountJson() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/AI_SECRETS_MASTER_KEY/);
  });

  it('a failing connection test names the fix (not shared with the service account)', async () => {
    const h = await gateway();
    await h.configureSheets();
    h.google.failures.push({ kind: 'describe', status: 403, message: 'The caller does not have permission' });
    const res = await h.api('post', '/api/integrations/google-sheets/test');
    expect(res.body.result).toMatchObject({ ok: false, advice: 'Share the spreadsheet with caller-bot@voice-project.iam.gserviceaccount.com as an Editor.' });
    expect((await h.api('get', '/api/integrations/google-sheets')).body.lastTest.ok).toBe(false);
  });
});

describe('tool calling and Google Sheets on a real campaign call (mocked modem, model and Google)', () => {
  const CALLS = [
    { text: 'Hello Asha. Did I get your name right, Maza?' }, // 1: asks to confirm
    { calls: [{ name: 'save_contact_details', args: { name: 'Maza' } }] }, // 2: after the caller confirms
    { text: 'Thank you, that is saved.' }, // 3: after the result
    { text: 'Understood, I will not call again. Goodbye.' },
  ];

  it('saves the confirmed name for this campaign contact, and logs one outcome row when the call ends', async () => {
    const llm = new ToolLlm(CALLS);
    const h = await gateway({ llm, stt: ['my name is Maza', 'yes that is right'] });
    await h.configureSheets({ logOutcomes: true });
    const { id, tick } = await startCampaign(h);
    const callId = h.server.callManager.getCurrentCall()!.id;

    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 }); // attached (no greeting is configured here)
    await h.callerSays();
    await vi.waitFor(() => expect(llm.requests.length).toBe(1), { timeout: 5000 });
    expect(llm.requests[0].tools?.map((t) => t.name)).toEqual(['save_contact_details']); // outbound tools are on
    await vi.waitFor(() => expect(h.sink.played.length).toBeGreaterThan(0), { timeout: 5000 }); // the agent's reply has been spoken
    await h.callerSays();
    await vi.waitFor(() => expect(h.google.dataRows.some((r) => r[2] === 'contact')).toBe(true), { timeout: 5000 });
    const contactId = h.server.campaignStore.listContacts(id).items.find((c) => c.name === 'Asha Verma')!.id;
    const contactRow = h.google.dataRows.find((r) => r[2] === 'contact')!;
    expect(contactRow.slice(0, 1).concat(contactRow.slice(3, 10))).toEqual([`campaign:${id}:${contactId}:contact`, callId, id, String(contactId), 'outbound', 'Maza', '', '']);

    // Google confirmed the write before the model was told "ok".
    await vi.waitFor(() => expect(llm.requests.length).toBe(3), { timeout: 5000 });
    expect(JSON.parse((llm.requests[2].messages.at(-1) as { content: string }).content)).toMatchObject({ ok: true, data: { status: 'created' } });

    await h.server.callManager.hangup('test over');
    expect(await tick).toBe('dialed');
    await vi.waitFor(() => expect(h.google.dataRows.some((r) => r[2] === 'outcome')).toBe(true), { timeout: 5000 });
    const outcome = h.google.dataRows.find((r) => r[2] === 'outcome')!;
    expect(outcome[0]).toBe(`call:${callId}:outcome`);
    expect(outcome[4]).toBe(id);
    expect(outcome[5]).toBe(String(contactId));
    expect(outcome[8]).toBe('+919876543210'); // the number the campaign dialled
    expect(outcome[10]).toBe('answered');
    expect(h.google.dataRows.filter((r) => r[2] === 'outcome')).toHaveLength(1); // one per call
  });

  it('a person who asks not to be called again is logged as opted out, with no name or number, and nothing more is saved for them', async () => {
    const llm = new ToolLlm([{ text: 'Understood, I will not call again. Goodbye.' }, { calls: [{ name: 'save_contact_details', args: { name: 'Maza' } }] }, { text: 'Nothing is saved.' }]);
    const h = await gateway({ llm, stt: ['please stop calling me', 'my name is Maza'] });
    await h.configureSheets({ logOutcomes: true });
    const { tick } = await startCampaign(h);
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 }); // attached (no greeting is configured here)
    await h.callerSays();
    await vi.waitFor(() => expect(h.server.campaignStore.isDoNotCall('+919876543210')).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(h.sink.played.length).toBeGreaterThan(0), { timeout: 5000 }); // the agent's reply has been spoken
    await h.callerSays();
    await vi.waitFor(() => expect(llm.requests.length).toBe(3), { timeout: 5000 });
    expect(JSON.parse((llm.requests[2].messages.at(-1) as { content: string }).content)).toMatchObject({ ok: false });
    expect(h.google.dataRows.filter((r) => r[2] === 'contact')).toHaveLength(0);

    await h.server.callManager.hangup('test over');
    await tick;
    await vi.waitFor(() => expect(h.google.dataRows.some((r) => r[2] === 'outcome')).toBe(true), { timeout: 5000 });
    const outcome = h.google.dataRows.find((r) => r[2] === 'outcome')!;
    expect(outcome[10]).toBe('opted_out');
    expect(outcome[7]).toBe(''); // no name
    expect(outcome[8]).toBe(''); // no number
  });

  it('a Google failure never stops or fails the campaign', async () => {
    const h = await gateway({ stt: ['hello there'] });
    await h.configureSheets({ logOutcomes: true });
    h.google.failures.push({ kind: 'any', status: 500, times: 50 });
    const { id, tick } = await startCampaign(h);
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 }); // attached (no greeting is configured here)
    await h.server.callManager.hangup('test over');
    expect(await tick).toBe('dialed');
    await sleep(100);
    const contact = h.server.campaignStore.listContacts(id).items.find((c) => c.name === 'Asha Verma')!;
    expect(contact.status).toBe('completed');
    expect(h.google.dataRows).toHaveLength(0);
  });

  it('with the integration off no tool is offered and nothing is ever sent to Google', async () => {
    const llm = new ToolLlm([{ text: 'Hello.' }]);
    const h = await gateway({ llm, stt: ['hello there'] });
    const { tick } = await startCampaign(h);
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 5000 }); // attached (no greeting is configured here)
    await h.callerSays();
    await vi.waitFor(() => expect(llm.requests.length).toBe(1), { timeout: 5000 });
    expect(llm.requests[0].tools).toBeUndefined();
    expect(llm.requests[0].system).not.toContain('TOOLS:');
    await h.server.callManager.hangup('test over');
    await tick;
    await sleep(50);
    expect(h.google.calls).toHaveLength(0);
  });

  it('inbound tools can be switched off while outbound stays on, per mode', async () => {
    const llm = new ToolLlm([{ text: 'Hello there.' }]);
    const h = await gateway({ llm, stt: ['hello there'] });
    await h.configureSheets({ inboundTools: false, outboundTools: true });
    h.ring();
    h.ring();
    await h.callerSays();
    await vi.waitFor(() => expect(llm.requests.length).toBe(1), { timeout: 5000 });
    expect(llm.requests[0].tools).toBeUndefined(); // an inbound call: the operator turned its tools off
  });
});
