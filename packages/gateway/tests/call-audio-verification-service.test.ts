import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallSession, CallStateChangeEvent, UrcEvent } from '@sim-gateway/shared';
import { AudioVerificationStore } from '../src/ai/audio-verification-store.js';
import { CallAudioVerificationService, observeTurn } from '../src/ai/call-audio-verification-service.js';
import type { CallAudioVerification } from '../src/ai/call-audio-verifier.js';
import type { ConversationEvent, TurnResult } from '../src/ai/conversation.js';
import { runMigrations, SCHEMA_VERSION } from '../src/db/migrations.js';

/**
 * The service runs one verifier per call from events that already exist. These tests drive it with the same event shapes the gateway
 * emits (call state changes, conversation turns, sink errors, the modem's DTMF URC) and a real SQLite database with the real migrations.
 */

const session = (id: string, direction: 'inbound' | 'outbound' = 'inbound') => ({ id, direction }) as unknown as CallSession;
const state = (callId: string, currentState: string, direction: 'inbound' | 'outbound' = 'inbound') =>
  ({ callId, previousState: 'IDLE', currentState, timestamp: new Date().toISOString(), session: session(callId, direction) }) as unknown as CallStateChangeEvent;
const metrics = (over: Record<string, unknown> = {}) => ({ lateFrames: 0, riskFrames: 0, bytesWritten: 0, underruns: 0, slowWrites: 0, playbackCompleted: null, playbackStoppedBy: null, ...over });
const turn = (callId: string, over: Partial<TurnResult> & { m?: Record<string, unknown> } = {}): ConversationEvent => {
  const { m, ...rest } = over;
  return { type: 'turn', callId, result: { turnId: 1, status: 'completed', endRequested: false, assessment: { decision: 'ok' }, transcriptWords: 4, sttConfidence: 0.9, metrics: metrics(m), ...rest } as unknown as TurnResult };
};
const dtmf = (digit: string) => ({ type: 'CUSTOM', raw: '+RXDTMF: <redacted>', payload: { kind: 'dtmf', digit } }) as unknown as UrcEvent;

let db: Database.Database;
let events: EventEmitter;
let orchestrator: EventEmitter;
let modem: EventEmitter;
let wire: string | undefined;
let attached: boolean;
let enabled: boolean;
let simulated: boolean;
let alerts: string[];
let logs: string[];
let pushed: CallAudioVerification[];
let svc: CallAudioVerificationService;
let store: AudioVerificationStore;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  events = new EventEmitter();
  orchestrator = new EventEmitter();
  modem = new EventEmitter();
  wire = 'flowing';
  attached = true;
  enabled = true;
  simulated = false;
  alerts = [];
  logs = [];
  pushed = [];
  store = new AudioVerificationStore(db);
  svc = new CallAudioVerificationService({
    events: events as never,
    conversations: orchestrator as never,
    modem: modem as never,
    wireState: () => wire,
    pipelineActive: () => attached,
    enabled: () => enabled,
    simulated: () => simulated,
    store,
    log: (level, m) => logs.push(`${level} ${m}`),
    alert: (level, m) => alerts.push(`${level} ${m}`),
    pollMs: 60_000,
  });
  svc.start();
  svc.onUpdate((v) => pushed.push(v));
});
afterEach(() => {
  svc.stop();
  db.close();
});

const answer = (id: string, direction: 'inbound' | 'outbound' = 'inbound') => {
  events.emit('call:state_changed', state(id, direction === 'inbound' ? 'INBOUND_RINGING' : 'DIALING', direction));
  events.emit('call:state_changed', state(id, 'ACTIVE', direction));
  svc.poll();
};
const end = (id: string) => events.emit('call:ended', session(id));

describe('migration and store', () => {
  it('migration 012 creates the table (011 was already used by ops alerts)', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    const names = (db.prepare("SELECT name FROM _schema_migrations ORDER BY version").all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain('011_ops_alerts_and_call_diagnostics');
    expect(names[names.indexOf('011_ops_alerts_and_call_diagnostics') + 1]).toBe('012_call_audio_verification');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='call_audio_verifications'").get()).toBeTruthy();
    // 013 (why a call was not recorded) is additive and follows it.
    expect(names[names.indexOf('012_call_audio_verification') + 1]).toBe('013_call_recording_skips');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='call_recording_skips'").get()).toBeTruthy();
  });

  it('a corrupt row reads as missing, never as a guessed result', () => {
    db.prepare("INSERT INTO call_audio_verifications (call_id, started_at, updated_at, inbound_status, transport_status, audibility_status, result_json) VALUES ('x', 't', 't', 'verified', 'verified', 'verified', '{not json')").run();
    expect(store.get('x')).toBeNull();
    db.prepare("INSERT INTO call_audio_verifications (call_id, started_at, updated_at, inbound_status, transport_status, audibility_status, result_json) VALUES ('y', 't', 't', 'verified', 'verified', 'verified', '{\"inbound\":{\"status\":\"great\"}}')").run();
    expect(store.get('y')).toBeNull();
  });
});

describe('a call verified from its own events', () => {
  it('runs the full inbound path: answered, speech with transcripts, agent audio delivered, saved and pushed at each step', async () => {
    answer('call-A');
    orchestrator.emit('conversation', turn('call-A', { m: { bytesWritten: 24000, playbackCompleted: true } }));
    orchestrator.emit('conversation', turn('call-A'));
    end('call-A');
    const saved = store.get('call-A')!;
    expect(saved).toMatchObject({ callId: 'call-A', direction: 'inbound', final: true });
    expect(saved.inbound.status).toBe('verified');
    expect(saved.transport.status).toBe('verified');
    expect(saved.audibility.status).toBe('unable'); // writes and a caller response never prove hearing
    expect(saved.audibility.evidence.some((e) => /Caller responded/.test(e.detail))).toBe(true);
    expect(pushed.length).toBeGreaterThanOrEqual(4);
    expect(pushed.at(-1)!.final).toBe(true);
    expect(svc.current()!.callId).toBe('call-A');
    expect(svc.recent(5)[0]).toMatchObject({ callId: 'call-A', inbound: 'verified', transport: 'verified', audibility: 'unable', final: true });
  });

  it('records the call direction, and an outbound call works the same way', () => {
    answer('call-out', 'outbound');
    end('call-out');
    expect(store.get('call-out')!.direction).toBe('outbound');
  });

  it('a sink error from the conversation fails transport for that call only', () => {
    answer('call-B');
    orchestrator.emit('conversation', { type: 'error', callId: 'call-B', stage: 'sink', message: 'Audio port is not streaming; refusing to write playback' });
    expect(svc.get('call-B')!.transport.status).toBe('failed');
    orchestrator.emit('conversation', { type: 'error', callId: 'call-B', stage: 'llm', message: 'llm down' });
    expect(svc.get('call-B')!.transport.reason).toMatch(/not streaming/);
  });

  it('a remote key press counts only for an armed test on that call', () => {
    answer('call-C');
    orchestrator.emit('conversation', turn('call-C', { m: { bytesWritten: 16000, playbackCompleted: true } }));
    modem.emit('urc', dtmf('1')); // not armed: ignored
    expect(svc.get('call-C')!.audibility.status).toBe('verifying');
    expect(svc.armKeyTest('call-C', '1')).toBe(true);
    modem.emit('urc', dtmf('1'));
    expect(svc.get('call-C')!.audibility).toMatchObject({ status: 'verified', source: 'remote-key-press' });
    expect(svc.armKeyTest('no-such-call', '1')).toBe(false);
  });

  it('the wire is sampled while the call is up; a stream that stops fails inbound', () => {
    answer('call-D');
    wire = 'stalled';
    svc.poll();
    svc.poll();
    expect(svc.get('call-D')!.inbound.status).toBe('verifying');
    svc.poll();
    expect(svc.get('call-D')!.inbound.status).toBe('failed');
  });
});

describe('isolation, settings and simulation', () => {
  it('two calls in a row never share evidence; a finished call is never changed again', () => {
    answer('first');
    orchestrator.emit('conversation', turn('first'));
    orchestrator.emit('conversation', turn('first'));
    end('first');
    answer('second');
    orchestrator.emit('conversation', turn('first')); // a late event for the finished call
    const second = svc.get('second')!;
    expect(second.inbound.status).toBe('verifying');
    expect(second.inbound.evidence.filter((e) => e.kind === 'supporting')).toHaveLength(0);
    expect(store.get('first')!.inbound.status).toBe('verified');
    end('second');
    expect(store.get('second')!.inbound.status).toBe('unable');
    expect(store.get('first')!.inbound.status).toBe('verified');
  });

  it('switched off: nothing is created, saved or reported for new calls', () => {
    enabled = false;
    answer('off-call');
    orchestrator.emit('conversation', turn('off-call'));
    end('off-call');
    expect(svc.get('off-call')).toBeNull();
    expect(store.recent()).toEqual([]);
  });

  it('simulated hardware or providers: every result is Unable to verify, whatever the events say', () => {
    simulated = true;
    answer('sim');
    orchestrator.emit('conversation', turn('sim', { m: { bytesWritten: 8000, playbackCompleted: true } }));
    orchestrator.emit('conversation', turn('sim'));
    end('sim');
    const s = store.get('sim')!;
    expect([s.inbound.status, s.transport.status, s.audibility.status]).toEqual(['unable', 'unable', 'unable']);
  });

  it('a call without the AI pipeline says so instead of claiming silence', () => {
    attached = false;
    answer('no-ai');
    end('no-ai');
    expect(store.get('no-ai')!.inbound.reason).toMatch(/AI agent was not attached/);
  });
});

describe('warnings for repeated failures, without stopping calls', () => {
  it('one failure is logged; the same aspect failing on two calls in a row raises a warning', () => {
    for (const id of ['f1', 'f2']) {
      answer(id);
      orchestrator.emit('conversation', { type: 'error', callId: id, stage: 'sink', message: 'write EPIPE' });
      end(id);
      if (id === 'f1') expect(alerts).toEqual([]);
    }
    expect(logs.some((l) => /agent audio transport FAILED on call f1/.test(l))).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^warn Call audio check: agent audio transport failed on 2 calls in a row.*Calling continues/);
  });

  it('a verified call resets the streak', () => {
    answer('g1');
    orchestrator.emit('conversation', { type: 'error', callId: 'g1', stage: 'sink', message: 'x' });
    end('g1');
    answer('g2');
    orchestrator.emit('conversation', turn('g2', { m: { bytesWritten: 9000, playbackCompleted: true } }));
    end('g2');
    answer('g3');
    orchestrator.emit('conversation', { type: 'error', callId: 'g3', stage: 'sink', message: 'x' });
    end('g3');
    expect(alerts).toEqual([]);
  });
});

describe('turn observation mapping', () => {
  it('passes only counts, flags and delivery numbers from a turn result (no text)', () => {
    const r = { turnId: 1, status: 'completed', endRequested: false, assessment: { decision: 'ok' }, transcriptWords: 3, sttConfidence: 0.7, callerReportsNotHearing: true, transcript: 'secret words', metrics: metrics({ bytesWritten: 100, underruns: 2, playbackCompleted: true }) } as unknown as TurnResult;
    const o = observeTurn(r);
    expect(o).toMatchObject({ utterance: 'ok', transcriptWords: 3, sttConfidence: 0.7, callerReportsNotHearing: true, bytesWritten: 100, underruns: 2, playbackCompleted: true });
    expect(JSON.stringify(o)).not.toContain('secret words');
  });
});
