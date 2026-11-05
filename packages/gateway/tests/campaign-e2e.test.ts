import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../src/ai/audio.js';
import { createMockProviders } from '../src/ai/providers/mock.js';
import { createGatewayServer } from '../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, speechPcm } from './ai/helpers.js';

/**
 * One campaign call through the real gateway wiring, with a mock modem and mock providers: the API starts it, the runner dials
 * through the call manager, the other side answers, the AI attaches, the contact's details reach THIS call's prompt and
 * greeting, the caller asks to stop, and the call ends. Mocked end to end: it says nothing about a real modem or provider.
 */
const KEY = 'campaign-e2e-key-123456';
const ENV = {
  AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only',
  AI_AUTO_HANDLE: 'outbound',
  AI_AUTO_REPLIES: 'true',
  AI_AUTO_ACTIVATE_USB_AUDIO: 'true',
  AI_AUDIO_INBOUND_VERIFIED: 'true',
  AI_AUDIO_OUTBOUND_VERIFIED: 'true',
  AI_GREETING: 'The global greeting.',
  AI_PLAYBACK_GUARD_MS: '0',
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function gateway(env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-e2e-'));
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 60 });
  const source = new ManualAudioSource(FORMAT_8K, true);
  const sink = new CollectingAudioSink(FORMAT_8K, true, 0);
  const providers = createMockProviders({
    stt: ['I would like a quote for a website', 'please stop calling me'],
    llm: ['Happy to help with a quote today.', 'Understood, I will not call again. Goodbye.'],
  });
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: {
      env: aiEnv({ ...ENV, ...env }),
      providers,
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
  const api = (m: 'get' | 'post' | 'patch', url: string, body?: object) => {
    const r = request(server.app)[m](url).set('x-api-key', KEY);
    return body ? r.send(body) : r;
  };
  return { server, sink, source, providers, api };
}

const CSV = ['Name,Phone,Title,Company,Consent', 'Asha Verma,9876543210,CTO,Northwind,yes', 'Bo Lee,9123456789,Dev,Beta,yes'].join('\n');
const MAPPING = { phone: 'Phone', name: 'Name', designation: 'Title', company: 'Company', consent: 'Consent' };

describe('a campaign call, end to end through the real wiring (mocked modem and providers)', () => {
  it('dials the first contact once, personalises only that call, records a spoken opt-out, and settles the contact', async () => {
    const { server, sink, source, providers, api } = await gateway();
    const promptBefore = server.aiRuntime.config.config.systemPrompt;

    const created = await api('post', '/api/campaigns', {
      name: 'E2E campaign',
      settings: {
        callingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC' },
        defaultCountryCode: '91',
        greetingTemplate: 'Hello {name}, this is Sarah calling about {company}.',
        contextNote: 'follow-up on the website quote',
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.campaign.id as string;
    const imported = await api('post', `/api/campaigns/${id}/import`, { csv: CSV, mapping: MAPPING });
    expect(imported.body.summary).toMatchObject({ callable: 2 });
    // Nothing has been dialled by importing, or by being ready to start.
    expect(server.callManager.getCurrentCall()).toBeNull();

    const started = await api('post', `/api/campaigns/${id}/start`, { confirm: true, confirmName: 'E2E campaign', acknowledgements: { realCalls: true, regulations: true, consent: true } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const tick = server.campaignRunner.tick(); // one call, from dial to hang-up
    await vi.waitFor(() => expect(server.callManager.getCurrentCall()?.state).toBe('ACTIVE'), { timeout: 5000 });
    const call = server.callManager.getCurrentCall()!;
    expect(call).toMatchObject({ direction: 'outbound', remoteNumber: '+919876543210', metadata: { campaignId: id } });

    // The personalised greeting, not the global one, and only for this call.
    await vi.waitFor(() => expect(providers.tts.requests.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(providers.tts.requests[0]).toBe('Hello Asha Verma, this is Sarah calling about Northwind.');
    expect(providers.tts.requests).not.toContain('The global greeting.');

    const callerSays = async () => {
      await vi.waitFor(() => {
        const s = server.aiOrchestrator.getSessions()[0];
        expect(s?.conversation.phase).toBe('listening');
      }, { timeout: 5000 });
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1300));
    };
    await callerSays();
    await vi.waitFor(() => expect(providers.llm.requests.length).toBe(1), { timeout: 5000 });
    const system = providers.llm.requests[0].system;
    expect(promptBefore.length).toBeGreaterThan(200);
    expect(system.startsWith(promptBefore)).toBe(true); // the saved prompt, intact and first
    expect(system.startsWith(promptBefore)).toBe(true); // the saved prompt, intact and first
    expect(system).toContain('contact_name: Asha Verma');
    expect(system).toContain('designation: CTO');
    expect(system).toContain('company: Northwind');
    expect(system).toContain('campaign_purpose: follow-up on the website quote');
    expect(system).toContain('CAMPAIGN RULE');
    expect(system).not.toContain('Bo Lee'); // the other contact is nowhere near this call
    expect(system).not.toMatch(/9876543210|9123456789/); // and no phone number is given to the model
    expect(server.aiRuntime.config.config.systemPrompt).toBe(promptBefore); // the global prompt was never modified

    // The caller asks not to be called again: the number is remembered at once.
    await vi.waitFor(() => expect(sink.played.length).toBeGreaterThan(1), { timeout: 5000 });
    await callerSays();
    await vi.waitFor(() => expect(server.campaignStore.isDoNotCall('+919876543210')).toBe(true), { timeout: 5000 });

    await server.callManager.hangup('test over');
    expect(await tick).toBe('dialed');

    const contacts = server.campaignStore.listContacts(id).items;
    expect(contacts[0]).toMatchObject({ name: 'Asha Verma', status: 'completed', attempts: 1, lastOutcome: 'answered', callId: call.id });
    expect(contacts[1]).toMatchObject({ name: 'Bo Lee', status: 'queued', attempts: 0 }); // untouched
    expect(server.campaignStore.attempts(contacts[0].id)).toEqual([expect.objectContaining({ callId: call.id, outcome: 'answered' })]);

    // Visible in the call log: which campaign placed it, and that the AI attached with the campaign context.
    const detail = (await api('get', `/api/observability/calls/${call.id}`)).body;
    expect(detail.call.campaign).toMatchObject({ campaignId: id, contactId: contacts[0].id, attempt: 1 });
    expect(JSON.stringify(detail.callEvents)).toContain('campaignContactId');

    // Pacing: the next contact is not dialled straight away, and no call is up.
    expect(await server.campaignRunner.tick()).toBe('waiting');
    expect(server.callManager.getCurrentCall()).toBeNull();
    expect(server.campaignRunner.status().waiting).toMatch(/s between calls/);

    // A later ordinary call carries nothing of the campaign contact.
    const review = (await api('get', `/api/campaigns/${id}`)).body;
    expect(review.counts).toMatchObject({ completed: 1, queued: 1 });
  }, 60_000);
});

const START = { confirm: true, confirmName: 'E2E campaign', acknowledgements: { realCalls: true, regulations: true, consent: true } };
const SETTINGS = { callingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC' }, defaultCountryCode: '91', agentAttachTimeoutSeconds: 5 };
const draft = async (api: Awaited<ReturnType<typeof gateway>>['api']) => {
  const created = await api('post', '/api/campaigns', { name: 'E2E campaign', settings: SETTINGS });
  const id = created.body.campaign.id as string;
  await api('post', `/api/campaigns/${id}/import`, { csv: CSV, mapping: MAPPING });
  return id;
};

describe('a campaign can START from an idle gateway (no call is up)', () => {
  // Readiness used to be asked as "is the AI in active mode right now?", which is only true during a call: so no campaign could ever
  // start. These pin what is checked instead, and that each missing piece is named.
  it('has no blockers when everything that can be known without a call is in place, and the start is accepted', async () => {
    const { server, api } = await gateway();
    expect(server.callManager.getCurrentCall()).toBeNull();
    expect(server.aiRuntime.mode).not.toBe('active'); // as it always is while idle
    expect(server.aiRuntime.campaignBlockers()).toEqual([]);
    expect((await api('get', '/api/campaigns/readiness')).body.blockers).toEqual([]);
    const id = await draft(api);
    expect((await api('post', `/api/campaigns/${id}/start`, START)).status).toBe(200);
    expect((await api('get', `/api/campaigns/${id}/review`)).body.blockers).toEqual([]);
  });

  it.each([
    ['automatic replies off (the agent would only transcribe)', { AI_AUTO_REPLIES: 'false' }, /Automatic replies is off/],
    ['automatic handling covers inbound calls only', { AI_AUTO_HANDLE: 'inbound' }, /Automatic handling must include outbound/],
    ['outgoing audio never confirmed (manual confirmation mode)', { AI_AUDIO_AUTO_VERIFY: 'false', AI_AUDIO_OUTBOUND_VERIFIED: 'false' }, /Outgoing audio has not been confirmed/],
    ['incoming audio never confirmed (manual confirmation mode)', { AI_AUDIO_AUTO_VERIFY: 'false', AI_AUDIO_INBOUND_VERIFIED: 'false' }, /Incoming audio has not been confirmed/],
    ['the speech-to-text key is missing', { DEEPGRAM_API_KEY: undefined }, /stt-key|provider-keys|not complete/],
    ['the AI is disabled', { AI_ENABLED: 'false' }, /not enabled/],
  ])('names the problem when %s, and refuses to start', async (_label, env, message) => {
    const { server, api } = await gateway(env);
    const blockers = server.aiRuntime.campaignBlockers();
    expect(blockers.join(' | ')).toMatch(message);
    const id = await draft(api);
    const refused = await api('post', `/api/campaigns/${id}/start`, START);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('AI_NOT_READY');
    expect(server.campaignStore.require(id).status).toBe('draft'); // nothing changed
  });
});

describe('an answered call whose AI agent never joins (real orchestrator, mocked modem)', () => {
  it('pauses the campaign and alerts, leaves the call connected, does not retry or call anyone else', async () => {
    // USB audio is never activated, so the agent never attaches: the person would hear silence.
    const { server, api } = await gateway({ AI_AUTO_ACTIVATE_USB_AUDIO: 'false' });
    const alerts: string[] = [];
    server.eventBus.on('gateway:alert', (a) => void alerts.push(`${a.level}: ${a.message}`));
    const id = await draft(api);
    expect((await api('post', `/api/campaigns/${id}/start`, START)).status).toBe(200);

    const started = Date.now();
    expect(await server.campaignRunner.tick()).toBe('paused');
    expect(Date.now() - started).toBeLessThan(15_000); // bounded by the 5 s setting, not by the length of the call

    const [first, second] = server.campaignStore.listContacts(id).items;
    expect(first).toMatchObject({ status: 'failed', attempts: 1, lastOutcome: 'agent_missing' });
    expect(first.lastError).toMatch(/heard silence/);
    expect(second).toMatchObject({ status: 'queued', attempts: 0 });
    expect(server.campaignStore.require(id)).toMatchObject({ status: 'paused', pauseReason: expect.stringMatching(/hang up from the Dialer page/) });
    expect(alerts.some((a) => /^error: Campaign paused: a call was answered but the AI agent did not attach/.test(a))).toBe(true);
    // The call itself was not touched: it is still up for the operator to end.
    expect(server.callManager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(await server.campaignRunner.tick()).toBe('idle'); // paused: nothing further is dialled
    await server.callManager.hangup('operator ended it');
  }, 60_000);
});
