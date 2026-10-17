import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallStateChangeEvent } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { createGatewayServer, GatewayServerInstance } from '../src/server.js';

const NUMBER = '+919111222333';

describe('call-state diagnostics', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-diag-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: 'diag-key', sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
    await modem.initialize();
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const changes: CallStateChangeEvent[] = [];
    server.eventBus.on('call:state_changed', (e) => changes.push(e));
    const rows = (callId: string) =>
      (server.db.prepare("SELECT current_state AS state, payload FROM call_events WHERE call_id = ? AND event_type = 'STATE_CHANGED' ORDER BY id").all(callId) as Array<{ state: string; payload: string | null }>).map((r) => ({
        state: r.state,
        payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
      }));
    const urc = (raw: string, type: string) =>
      modem.emit('urc', { raw, type, timestamp: new Date().toISOString(), isSimulated: false } as never);
    return { server, modem, changes, rows, urc };
  }

  it('keeps what moved a dialing call to ACTIVE: VOICE CALL: BEGIN', async () => {
    const h = await harness();
    const call = await h.server.callManager.dial({ phoneNumber: NUMBER });
    h.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
    const active = h.changes.find((c) => c.currentState === 'ACTIVE')!;
    expect(active).toMatchObject({ previousState: 'DIALING', trigger: 'urc:VOICE_CALL_BEGIN', triggerLine: 'VOICE CALL: BEGIN' });

    const rows = h.rows(call.id);
    expect(rows.map((r) => r.state)).toEqual(['DIALING', 'ACTIVE']);
    expect(rows[0].payload).toMatchObject({ trigger: 'api:dial' });
    expect(rows[1].payload).toMatchObject({ trigger: 'urc:VOICE_CALL_BEGIN', triggerLine: 'VOICE CALL: BEGIN' });
    expect(typeof rows[1].payload!.at).toBe('string'); // timestamp of the transition itself
  });

  it('tells CONNECT apart from VOICE CALL: BEGIN', async () => {
    const h = await harness();
    const call = await h.server.callManager.dial({ phoneNumber: NUMBER });
    h.urc('CONNECT', 'VOICE_CALL_BEGIN');
    expect(h.rows(call.id)[1].payload).toMatchObject({ trigger: 'urc:VOICE_CALL_BEGIN', triggerLine: 'CONNECT' });
  });

  it('records who ended the call', async () => {
    const h = await harness();
    const byApi = await h.server.callManager.dial({ phoneNumber: NUMBER });
    h.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
    await h.server.callManager.hangup('operator');
    expect(h.rows(byApi.id).at(-1)).toMatchObject({ state: 'TERMINATING', payload: { trigger: 'hangup-requested>urc:VOICE_CALL_END' } });

    const remote = await h.server.callManager.dial({ phoneNumber: NUMBER });
    h.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
    h.urc('NO CARRIER', 'NO_CARRIER');
    expect(h.rows(remote.id).at(-1)).toMatchObject({ state: 'TERMINATING', payload: { trigger: 'urc:NO_CARRIER', triggerLine: 'NO CARRIER' } });
  });

  it('never stores a phone number, even when a transition comes from a URC that carries one', async () => {
    const h = await harness();
    const call = await h.server.callManager.dial({ phoneNumber: NUMBER });
    h.urc('VOICE CALL: BEGIN', 'VOICE_CALL_BEGIN');
    h.urc(`+CLIP: "${NUMBER}",145`, 'CLIP'); // busy, ignored; must not leak anywhere
    await h.server.callManager.hangup();

    const all = JSON.stringify(h.server.db.prepare('SELECT payload, event_type FROM call_events').all());
    expect(all).not.toContain('9111222333');
    expect(JSON.stringify(h.changes.map((c) => ({ t: c.trigger, l: c.triggerLine })))).not.toContain('9111222333');
    expect(call.id).toBeTruthy();
  });

  it('leaves a transition without a known cause unlabelled instead of guessing', async () => {
    const h = await harness();
    h.urc('RING', 'RING');
    const ring = h.changes.find((c) => c.currentState === 'INBOUND_RINGING')!;
    expect(ring.trigger).toBe('urc:RING');
    expect(ring.triggerLine).toBeUndefined(); // RING is not on the identifier-free list
  });
});

describe('modem initialization diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  const logs = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0]));

  function adapterWith(respond: (written: string, transport: FakeSerialTransport) => void) {
    const transport = new FakeSerialTransport('COM14', 115200);
    const adapter = new Sim7600HardwareAdapter({ atPort: 'COM14', atBaudRate: 115200, commandTimeoutMs: 300, dialTimeoutMs: 1000, autoReconnect: false, transport });
    transport.onWrite((written) => respond(written, transport));
    return adapter;
  }

  it('logs start and success with attempt number and duration, and nothing sensitive', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = adapterWith((w, t) => t.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : 'OK\r\n'));
    await adapter.initialize();
    await adapter.close();
    const lines = logs(info).filter((l) => l.includes('Modem init'));
    expect(lines.some((l) => /Modem init start: attempt=1 port=COM14 baud=115200 previousState=DISCONNECTED/.test(l))).toBe(true);
    expect(lines.some((l) => /Modem init ok: attempt=1 port=COM14 durationMs=\d+/.test(l))).toBe(true);
  });

  it('names the step that failed, so a stuck INITIALIZING can be traced', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = adapterWith((w, t) => {
      if (w.includes('AT+CLIP')) return; // never answers
      t.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : 'OK\r\n');
    });
    await expect(adapter.initialize()).rejects.toThrow();
    const failed = logs(error).find((l) => l.includes('Modem init failed'))!;
    expect(failed).toMatch(/attempt=1 port=COM14 step=AT\+CLIP durationMs=\d+ autoReconnect=false/);
    expect(adapter.getConnectionState()).toBe('ERROR');
    await adapter.close();
  });

  it('logs the reconnect schedule when auto-reconnect is on, and counts attempts', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const transport = new FakeSerialTransport('COM14', 115200);
    const adapter = new Sim7600HardwareAdapter({
      atPort: 'COM14',
      atBaudRate: 115200,
      commandTimeoutMs: 100,
      dialTimeoutMs: 1000,
      autoReconnect: true,
      reconnectIntervalMs: 50,
      transport,
    } as never);
    transport.onWrite((w) => transport.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: SIM PIN\r\nOK\r\n' : 'OK\r\n'));
    const first = adapter.initialize().catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(logs(warn).some((l) => /Modem reconnect scheduled: attempt=1 delayMs=50 port=COM14/.test(l))).toBe(true);
    await adapter.close();
    vi.useRealTimers();
  });
});
