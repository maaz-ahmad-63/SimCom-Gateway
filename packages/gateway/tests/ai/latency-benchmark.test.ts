import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiInspectorEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { ScriptedLlm, ScriptedStt, ToneTts } from '../../src/ai/providers/mock.js';
import { ProviderSet } from '../../src/ai/providers/types.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

/**
 * How long the ENGINE makes a caller wait, with every provider's latency held fixed (taken from real logs:
 * speech-to-text 300 ms, first LLM words 150 ms, first synthesized audio 200 ms). Caller audio is paced in real time
 * through the real endpointer, orchestrator and session. It measures the engine's own waiting (silence detection and
 * overlap of stages), not any hardware, network or provider. Off by default (about 25 s); run it with AI_BENCH=1:
 *
 *   AI_BENCH=1 npx vitest run tests/ai/latency-benchmark.test.ts
 */
const run = process.env.AI_BENCH === '1';
const KEY = 'bench-key';
const CONFIRM = { enabled: true, confirmBilling: true, confirmPlayToCaller: true };
const STT_MS = 300;
const LLM_MS = 150;
const TTS_MS = 200;

async function feedRealtime(source: ManualAudioSource, pcm: Buffer): Promise<void> {
  const frame = 320; // 20 ms
  const start = performance.now();
  for (let i = 0, o = 0; o + frame <= pcm.length; o += frame, i++) {
    source.push(pcm.subarray(o, o + frame));
    const wait = start + (i + 1) * 20 - performance.now();
    if (wait > 1) await sleep(wait);
  }
}

describe.skipIf(!run)('latency benchmark: how long the engine makes the caller wait', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function setup(env: Record<string, string>, stt: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true, 0);
    const providers: ProviderSet = {
      stt: new ScriptedStt(stt, STT_MS),
      llm: new ScriptedLlm(['We can build that for you.', 'Yes, that is possible, and we can start this week.'], { delayMs: LLM_MS }),
      tts: new ToneTts(TTS_MS, () => false, { chunkMs: 100 }),
    };
    const server: GatewayServerInstance = createGatewayServer({
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
      },
    });
    await modem.initialize();
    server.aiRuntime.start();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const events: AiInspectorEvent[] = [];
    server.eventBus.on('ai:event', (e) => events.push(e));
    const api = (method: 'post', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
    const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
    await server.callManager.activateUsbAudioDiagnostic!();
    await sleep(60);
    await api('post', `/api/ai/calls/${call.id}/arm`);
    await api('post', `/api/ai/calls/${call.id}/conversation`).send(CONFIRM);
    const firstAudio = (n: number): number => {
      const lines = events.filter((e) => e.stage === 'call' && /First audio written/.test(e.detail ?? ''));
      return Number(lines[n - 1]?.data?.perceivedFirstAudioMs);
    };
    return { source, events, firstAudio, sink };
  }

  /** One caller turn: speak for `speakMs`, then stay silent until the reply is written. Returns ms from end of speech. */
  async function oneTurn(env: Record<string, string>, stt: string[]) {
    const h = await setup(env, stt);
    await feedRealtime(h.source, speechPcm(1500));
    await feedRealtime(h.source, noiseFloorPcm(2200));
    return h.firstAudio(1);
  }

  /** A caller who pauses briefly between phrases; the second turn is measured after the engine has seen those pauses. */
  async function secondTurnAfterPauses(env: Record<string, string>) {
    const h = await setup(env, ['one two three four', 'Can you start this week?']);
    for (let i = 0; i < 4; i++) {
      await feedRealtime(h.source, speechPcm(450));
      if (i < 3) await feedRealtime(h.source, noiseFloorPcm(220)); // a short mid-sentence pause, learned from
    }
    await feedRealtime(h.source, noiseFloorPcm(1800)); // first turn ends and is answered
    await feedRealtime(h.source, speechPcm(1400));
    await feedRealtime(h.source, noiseFloorPcm(1800));
    return h.firstAudio(2);
  }

  const results: Record<string, number> = {};
  it('measures every configuration', async () => {
    const q = 'What time do you open?';
    results['A  original defaults (1000 ms wait, no overlap)'] = await oneTurn({ AI_VAD_ADAPTIVE: 'false', AI_SPECULATIVE_STT: 'false', AI_VAD_MIN_SILENCE_MS: '1000' }, [q]);
    results['B  your current .env (800 ms wait, no overlap)'] = await oneTurn({ AI_VAD_ADAPTIVE: 'false', AI_SPECULATIVE_STT: 'false', AI_VAD_MIN_SILENCE_MS: '800' }, [q]);
    results['C  new defaults (800 ms ceiling, speculative STT)'] = await oneTurn({ AI_VAD_MIN_SILENCE_MS: '800' }, [q]);
    results['D  C plus early commit (opt-in)'] = await oneTurn({ AI_VAD_MIN_SILENCE_MS: '800', AI_EARLY_COMMIT: 'true' }, [q]);
    results['E  original defaults, 2nd turn of a quick talker'] = await secondTurnAfterPauses({ AI_VAD_ADAPTIVE: 'false', AI_SPECULATIVE_STT: 'false', AI_VAD_MIN_SILENCE_MS: '1000' });
    results['F  new defaults,      2nd turn of a quick talker'] = await secondTurnAfterPauses({ AI_VAD_MIN_SILENCE_MS: '1000' });

    const lines = Object.entries(results).map(([k, v]) => `${k.padEnd(56)} ${String(Math.round(v)).padStart(5)} ms from the end of speech to the first audio written`);
    console.log(`\nLATENCY BENCHMARK (providers fixed at STT ${STT_MS} ms, LLM ${LLM_MS} ms, TTS ${TTS_MS} ms)\n${lines.join('\n')}\n`);

    const [A, B, C, D, E, F] = Object.values(results);
    expect(B).toBeLessThan(A - 150); // 1000 -> 800 ms wait
    expect(C).toBeLessThan(B - 150); // speech-to-text now overlaps the pause
    expect(D).toBeLessThanOrEqual(C + 30); // early commit never makes it slower
    expect(F).toBeLessThan(E - 250); // adaptive silence for a caller with short pauses
    expect(Number.isFinite(A + B + C + D + E + F)).toBe(true);
  }, 90_000);
});
