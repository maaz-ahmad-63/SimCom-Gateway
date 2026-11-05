import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

/**
 * What happens to an eligible real call, state by state. The live blocker found on 2026-10-28: both audio confirmations were saved
 * and calls attached, but only in passive mode, because "Automatic replies" was off. These tests pin each state and its reason.
 */
const KEY = 'auto-attach-states-key-123456';
const AUTO = { AI_AUTO_ANSWER: 'true', AI_AUTO_ANSWER_RINGS: '2', AI_AUTO_ACTIVATE_USB_AUDIO: 'true', AI_AUTO_HANDLE: 'inbound', AI_GREETING: 'Hi there.' };
const VERIFIED = { AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function harness(env: Record<string, string | undefined>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  const commands: string[] = [];
  const original = modem.executeCommand.bind(modem);
  modem.executeCommand = async (command, timeoutMs) => {
    commands.push(command);
    return original(command, timeoutMs);
  };
  const source = new ManualAudioSource(FORMAT_8K, true);
  const sink = new CollectingAudioSink(FORMAT_8K, true, 0);
  const providers = createMockProviders({ stt: ['first question', 'second question'], llm: ['First answer here.', 'Second answer here.'] });
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: {
      env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', AI_PLAYBACK_GUARD_MS: '0', ...env }),
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
  const alerts: string[] = [];
  server.eventBus.on('gateway:alert', (a) => void alerts.push(a.message));
  const urc = (raw: string, type: string, extra: object = {}) => modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false, ...extra } as never);
  const ring = () => {
    urc('RING', 'RING');
    urc('+CLIP: "+10000000000",145', 'CLIP', { phoneNumber: '+10000000000', typeOfAddress: 145 });
  };
  const callerSays = async () => {
    await vi.waitFor(() => {
      const s = server.aiOrchestrator.getSessions()[0];
      expect(!s || s.conversation.phase === 'listening' || s.conversation.phase === 'stopped').toBe(true);
    });
    source.push(speechPcm(1200));
    source.push(noiseFloorPcm(1300));
  };
  const count = (re: RegExp) => commands.filter((c) => re.test(c)).length;
  return { server, modem, sink, providers, alerts, ring, urc, callerSays, count };
}

describe('automatic attachment, state by state', () => {
  it('automatic replies OFF (the live setting): attaches in passive mode, transcribes, and never speaks, whatever is confirmed', async () => {
    const h = await harness({ ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'false' });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    const session = h.server.aiOrchestrator.getSessions()[0];
    expect(session.mode).toBe('passive');
    expect(session.conversation).toMatchObject({ enabled: false, phase: 'stopped' }); // "Conversation mode: Stopped"
    await h.callerSays();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()[0].totals.turns).toBeGreaterThan(0), { timeout: 4000 });
    await sleep(100);
    expect(h.providers.llm.requests).toHaveLength(0); // no reply was generated
    expect(h.providers.tts.requests).toHaveLength(0); // and nothing was synthesized, greeting included
    expect(h.sink.playCalls).toBe(0);
    expect(h.alerts.some((a) => /attached to the call \(passive: transcription only/.test(a))).toBe(true);
  });

  it('automatic replies ON with both confirmations: attaches in active mode, greets, and answers', async () => {
    const h = await harness({ ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' });
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.sink.played.length).toBe(1), { timeout: 4000 });
    expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('active');
    expect(h.providers.tts.requests).toEqual(['Hi there.']);
    await h.callerSays();
    await vi.waitFor(() => expect(h.providers.llm.requests).toHaveLength(1), { timeout: 4000 });
  });

  it('manual confirmation mode: automatic replies ON but a confirmation missing: stays passive, never half-active, with the reason on the readiness list', async () => {
    const h = await harness({ ...AUTO, AI_AUDIO_AUTO_VERIFY: 'false', AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUTO_REPLIES: 'true' }); // outbound not confirmed
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('passive');
    expect(h.sink.playCalls).toBe(0);
    const readiness = h.server.aiRuntime.readiness();
    expect(readiness.ok).toBe(false);
    expect(readiness.blockers.join(' ')).toMatch(/outbound-audio: audibility of written PCM on the call has not been confirmed/);
    expect(readiness.passiveOk).toBe(true);
  });

  it('manual confirmation mode: arriving audio frames are not proof of speech: bytes alone never make it ready to reply', async () => {
    const h = await harness({ ...AUTO, AI_AUDIO_AUTO_VERIFY: 'false', AI_AUTO_REPLIES: 'true' }); // nothing confirmed; USB audio flows
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    const readiness = h.server.aiRuntime.readiness();
    expect(readiness.checks.find((c) => c.name === 'inbound-wire')?.status).toBe('pass');
    expect(readiness.checks.find((c) => c.name === 'inbound-audio')?.status).toBe('unverified');
    expect(readiness.ok).toBe(false);
    expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('passive');
  });

  it('duplicate ring and call events give one session and one USB registration, and the next call starts clean', async () => {
    const h = await harness({ ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'true' });
    for (let i = 0; i < 3; i++) h.ring();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    // (A ring cycle arriving after the call is ACTIVE is deliberately not injected: the call manager answers that with a hang-up
    // command. See the report: that is a separate finding, not changed here.)
    h.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN'); // a repeated begin
    await sleep(150);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1);
    expect(h.count(/^AT\+CPCMREG=1$/)).toBe(1);
    const first = h.server.aiOrchestrator.getSessions()[0].callId;

    h.urc('VOICE CALL: END: 9', 'VOICE_CALL_END', { durationSeconds: 9 });
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0), { timeout: 4000 });
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull());

    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.server.aiOrchestrator.getSessions()).toHaveLength(1), { timeout: 4000 });
    expect(h.server.aiOrchestrator.getSessions()[0].callId).not.toBe(first);
    expect(h.server.aiOrchestrator.getSessions()[0].mode).toBe('active');
  });

  it('an attachment that cannot happen says why, once, and leaves no half-attached session', async () => {
    const h = await harness({ ...AUTO, ...VERIFIED, AI_AUTO_REPLIES: 'false', AI_STT: 'nova-3', DEEPGRAM_API_KEY: '' }); // the selected STT has no key
    h.ring();
    h.ring();
    await vi.waitFor(() => expect(h.alerts.some((a) => /DEEPGRAM_API_KEY|configuration or provider keys are incomplete/.test(a))).toBe(true), { timeout: 4000 });
    await sleep(100);
    expect(h.server.aiOrchestrator.getSessions()).toHaveLength(0);
    expect(h.sink.playCalls).toBe(0);
  });
});
