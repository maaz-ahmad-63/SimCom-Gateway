import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrations.js';
import { GatewayRepository } from '../../src/db/repository.js';
import { AiSettingsService } from '../../src/ai/settings.js';
import { aiEnv } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

/** Settings over a real SQLite file, as the gateway keeps them. `restart()` is a new service on the same file. */
function store(env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-'));
  const file = path.join(dir, 'gateway.sqlite');
  const open = () => {
    const db = new Database(file);
    runMigrations(db);
    cleanups.push(() => db.close());
    return new AiSettingsService(new GatewayRepository(db), aiEnv({ AI_AUDIO_SAMPLE_RATE: '8000', ...env }));
  };
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = open();
  return {
    get settings() {
      return settings;
    },
    restart: () => {
      settings = open();
      return settings;
    },
    view: () => settings.view(settings.loadConfig()).attestations,
  };
}

const INBOUND = 'Call at 14:05: the transcript read what I said';
const OUTBOUND = 'Call at 14:20: the other phone heard both tones';

describe('audio confirmations persist', () => {
  it('survive a gateway restart with their notes, times and the rate they were made at', () => {
    const s = store();
    s.settings.setAttestation('inbound', INBOUND);
    s.settings.setAttestation('outbound', OUTBOUND);
    s.restart();
    const view = s.view();
    expect(view.inbound).toMatchObject({ confirmed: true, source: 'stored', note: INBOUND, sampleRate: 8000, stale: false, staleReason: null });
    expect(view.outbound).toMatchObject({ confirmed: true, note: OUTBOUND, sampleRate: 8000 });
    expect(Date.parse(view.inbound.confirmedAt!)).not.toBeNaN();
    expect(s.settings.loadConfig().config.audio).toMatchObject({ inboundVerified: true, outboundVerified: true });
  });

  it('are untouched by unrelated saves (provider, agent text, automation, timeouts)', () => {
    const s = store();
    s.settings.setAttestation('inbound', INBOUND);
    s.settings.setAttestation('outbound', OUTBOUND);
    const before = JSON.stringify(s.view());
    s.settings.update({ stt: 'nova-3' });
    s.settings.update({ agent: { greeting: 'Hello, how can I help?' } });
    s.settings.update({ automation: { idleFollowUps: false }, params: { ttsTimeoutMs: 9000 } });
    s.settings.update({ showTranscripts: true, language: 'en' });
    s.restart();
    expect(JSON.stringify(s.view())).toBe(before);
  });

  it('stay valid when only the TTS voice changes (the audio path is the same)', () => {
    const s = store();
    s.settings.setAttestation('inbound', INBOUND);
    s.settings.setAttestation('outbound', OUTBOUND);
    s.settings.update({ ttsVoice: 'kyle' });
    expect(s.view().inbound.confirmed).toBe(true);
    expect(s.view().outbound.confirmed).toBe(true);
  });

  it('are kept but do not count after a sample-rate change, never erased, and count again when the rate is switched back', () => {
    const s = store();
    s.settings.setAttestation('inbound', INBOUND);
    s.settings.setAttestation('outbound', OUTBOUND);
    s.settings.update({ audioSampleRate: 16000 });
    s.restart();
    const stale = s.view();
    expect(stale.inbound).toMatchObject({ confirmed: false, stale: true, note: INBOUND, sampleRate: 8000 });
    expect(stale.inbound.staleReason).toMatch(/Confirmed at 8000 Hz; the gateway is now set to 16000 Hz/);
    expect(s.settings.loadConfig().config.audio).toMatchObject({ inboundVerified: false, outboundVerified: false }); // never vouches for 16 kHz audio
    s.settings.update({ audioSampleRate: 8000 });
    expect(s.view().inbound).toMatchObject({ confirmed: true, stale: false, note: INBOUND });
    expect(s.settings.loadConfig().config.audio.inboundVerified).toBe(true);
  });

  it('re-verifying at the new rate replaces the old confirmation and its note', () => {
    const s = store();
    s.settings.setAttestation('inbound', INBOUND);
    s.settings.update({ audioSampleRate: 16000 });
    s.settings.setAttestation('inbound', 'Call at 15:10 at 16 kHz: transcript correct');
    expect(s.view().inbound).toMatchObject({ confirmed: true, stale: false, sampleRate: 16000, note: 'Call at 15:10 at 16 kHz: transcript correct' });
  });

  it('treats a confirmation saved before rates were recorded as made at the rate in force until it changes', () => {
    const s = store();
    // A record exactly as earlier versions wrote it: no sampleRate.
    s.settings['save']({ ...s.settings.getStored(), attestations: { inbound: { confirmedAt: '2026-10-26T11:18:06.359Z', note: INBOUND } } } as never);
    expect(s.view().inbound).toMatchObject({ confirmed: true, sampleRate: null });
    s.settings.update({ audioSampleRate: 16000 });
    expect(s.view().inbound).toMatchObject({ confirmed: false, stale: true, sampleRate: 8000 });
  });

  it('the live-transcript evidence the inbound confirmation needs follows the same rule', () => {
    const s = store();
    s.settings.recordInboundEvidence('call-1', 42);
    expect(s.settings.inboundEvidenceState()).toMatchObject({ valid: true });
    s.settings.update({ audioSampleRate: 16000 });
    const state = s.settings.inboundEvidenceState();
    expect(state.valid).toBe(false);
    expect(state.evidence).toMatchObject({ callId: 'call-1', sampleRate: 8000 }); // kept
    expect(state.staleReason).toMatch(/recorded at 8000 Hz/);
  });

  it('automatic replies cannot be switched on with confirmations made at another rate', () => {
    const s = store();
    s.settings.setAttestation('inbound', INBOUND);
    s.settings.setAttestation('outbound', OUTBOUND);
    s.settings.update({ audioSampleRate: 16000 });
    expect(() => s.settings.update({ automation: { autoReplies: true } })).toThrow(/both audio confirmations/);
  });

  it('only an explicit removal deletes a confirmation', () => {
    const s = store();
    s.settings.setAttestation('outbound', OUTBOUND);
    s.settings.clearAttestation('outbound');
    s.restart();
    expect(s.view().outbound).toMatchObject({ confirmed: false, source: 'none', note: null });
  });
});
