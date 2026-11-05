import { describe, expect, it } from 'vitest';
import { assess, isRegisteredStat, NetworkDiagnostics, parseOperator, parseRegistration, parseSimState, signalFromCsq } from '../src/ops/network.js';

describe('AT+CSQ', () => {
  it('converts valid readings to dBm and a plain level', () => {
    expect(signalFromCsq('+CSQ: 0,99')).toMatchObject({ rssi: 0, dbm: -113, level: 'very_weak' });
    expect(signalFromCsq('+CSQ: 5,0')).toMatchObject({ dbm: -103, level: 'weak' });
    expect(signalFromCsq('+CSQ: 12,0')).toMatchObject({ dbm: -89, level: 'fair' });
    expect(signalFromCsq('+CSQ: 17,0')).toMatchObject({ dbm: -79, level: 'good' });
    expect(signalFromCsq('+CSQ: 31,0')).toMatchObject({ dbm: -51, level: 'excellent' });
    expect(signalFromCsq('+CSQ: 31,0').text).toContain('-51 dBm or more');
  });

  it('treats 99 and unreadable answers as unknown, never as a number', () => {
    expect(signalFromCsq('+CSQ: 99,99')).toMatchObject({ rssi: 99, dbm: null, level: 'unknown' });
    expect(signalFromCsq('+CSQ: 40,0')).toMatchObject({ dbm: null, level: 'unknown' });
    expect(signalFromCsq('garbage')).toMatchObject({ rssi: null, dbm: null, level: 'unknown' });
    expect(signalFromCsq(null).text).toMatch(/no answer/);
  });
});

describe('registration and SIM replies', () => {
  it('reads both the query form and the unsolicited form, and keeps the raw reply', () => {
    expect(parseRegistration('+CREG: 0,1\r\nOK', 'CREG')).toMatchObject({ stat: 1, mode: 0, registered: true });
    expect(parseRegistration('+CEREG: 2', 'CEREG')).toMatchObject({ stat: 2, mode: null, registered: false, text: 'searching for a network' });
    expect(parseRegistration('+CGREG: 1,5', 'CGREG')).toMatchObject({ stat: 5, registered: true });
    expect(parseRegistration('+CREG: 1,3', 'CREG')).toMatchObject({ stat: 3, registered: false });
    expect(parseRegistration('+CREG: 1,6', 'CREG').registered).toBe(false); // SMS only cannot place a call
    expect(parseRegistration('+CREG: 1,1', 'CREG').raw).toContain('+CREG');
    expect(parseRegistration(null, 'CREG')).toMatchObject({ stat: null, registered: false });
    expect([1, 5, 9, 10].every(isRegisteredStat)).toBe(true);
  });

  it('classifies the SIM and the operator', () => {
    expect(parseSimState('+CPIN: READY').state).toBe('ready');
    expect(parseSimState('+CPIN: SIM PIN').state).toBe('pin_required');
    expect(parseSimState('+CPIN: SIM PUK').state).toBe('puk_required');
    expect(parseSimState('+CME ERROR: 10').state).toBe('not_inserted');
    expect(parseSimState('ERROR').state).toBe('error');
    expect(parseSimState(null).state).toBe('unknown');
    expect(parseOperator('+COPS: 0,0,"Airtel",7')).toBe('Airtel');
    expect(parseOperator('+COPS: 0')).toBeNull();
  });
});

const reg = (stat: number | null) => parseRegistration(stat === null ? null : `+CREG: 0,${stat}`, 'CREG');
const parts = (sim: string, csq: string | null, cs: number | null, eps: number | null, ps: number | null = null) => ({
  sim: parseSimState(sim),
  signal: signalFromCsq(csq),
  registration: { cs: reg(cs), eps: parseRegistration(eps === null ? null : `+CEREG: 0,${eps}`, 'CEREG'), ps: parseRegistration(ps === null ? null : `+CGREG: 0,${ps}`, 'CGREG') },
});

describe('the conclusion', () => {
  it('tells apart a SIM problem, no network, denied, searching and weak signal', () => {
    expect(assess(parts('+CPIN: SIM PIN', '+CSQ: 20,0', 1, 1))).toMatchObject({ code: 'sim_not_ready', severity: 'critical' });
    expect(assess(parts('+CME ERROR: 10', null, null, null)).explanation).toMatch(/No SIM/);
    expect(assess(parts('+CPIN: READY', '+CSQ: 20,0', 3, 3))).toMatchObject({ code: 'registration_denied', severity: 'error' });
    expect(assess(parts('+CPIN: READY', '+CSQ: 20,0', 0, 0))).toMatchObject({ code: 'no_network', severity: 'error' });
    expect(assess(parts('+CPIN: READY', '+CSQ: 20,0', 2, 2))).toMatchObject({ code: 'searching', severity: 'warning' });
    expect(assess(parts('+CPIN: READY', '+CSQ: 4,0', 1, 1))).toMatchObject({ code: 'weak_signal', severity: 'warning' });
    expect(assess(parts('+CPIN: READY', '+CSQ: 20,0', 1, 1))).toMatchObject({ code: 'ok', severity: 'ok' });
  });

  it('says when it cannot conclude, and does not call voice failed when only data is registered', () => {
    const none = assess(parts('', null, null, null));
    expect(none).toMatchObject({ code: 'unreadable', uncertain: true });
    const dataOnly = assess(parts('+CPIN: READY', '+CSQ: 20,0', 0, 1));
    expect(dataOnly).toMatchObject({ code: 'voice_unconfirmed', uncertain: true, severity: 'warning' });
    expect(assess(parts('+CPIN: READY', '+CSQ: 99,99', 1, 1))).toMatchObject({ code: 'signal_unknown', uncertain: true });
  });
});

function fakeModem(over: { state?: string; simulated?: boolean; answers?: Record<string, string> } = {}) {
  const sent: string[] = [];
  const answers = over.answers ?? { 'AT+CPIN?': '+CPIN: READY', 'AT+CSQ': '+CSQ: 18,0', 'AT+CREG?': '+CREG: 0,1', 'AT+CEREG?': '+CEREG: 0,1', 'AT+CGREG?': '+CGREG: 0,1', 'AT+COPS?': '+COPS: 0,0,"Jio",7' };
  const modem = {
    isSimulated: over.simulated ?? false,
    getConnectionState: () => over.state ?? 'READY',
    executeCommand: async (c: string) => {
      sent.push(c);
      if (!(c in answers)) throw new Error('timeout');
      return answers[c];
    },
  };
  return { modem: modem as never, sent };
}

describe('the diagnostics service only reads while idle, and only through the modem queue', () => {
  it('reads the six values and keeps the raw replies', async () => {
    const { modem, sent } = fakeModem();
    const svc = new NetworkDiagnostics({ modem, isBusy: () => false });
    const s = await svc.refresh();
    expect(sent).toEqual(['AT+CPIN?', 'AT+CSQ', 'AT+CREG?', 'AT+CEREG?', 'AT+CGREG?', 'AT+COPS?']);
    expect(s).toMatchObject({ source: 'hardware', operator: 'Jio', verdict: { code: 'ok' } });
    expect(s.signal.raw).toBe('+CSQ: 18,0');
    expect(svc.snapshot()).toBe(s);
  });

  it('sends nothing during a call, with the modem not ready, or with a simulated modem', async () => {
    const busy = fakeModem();
    expect((await new NetworkDiagnostics({ modem: busy.modem, isBusy: () => true }).refresh()).skippedBecause).toMatch(/call is in progress/);
    expect(busy.sent).toEqual([]);
    const down = fakeModem({ state: 'DISCONNECTED' });
    expect((await new NetworkDiagnostics({ modem: down.modem, isBusy: () => false }).refresh()).skippedBecause).toMatch(/disconnected/);
    expect(down.sent).toEqual([]);
    const sim = fakeModem({ simulated: true });
    expect((await new NetworkDiagnostics({ modem: sim.modem, isBusy: () => false }).refresh()).source).toBe('simulated');
    expect(sim.sent).toEqual([]);
  });

  it('drops the rest of a reading when a call starts in the middle, and never replaces a real reading with a skipped one', async () => {
    let calls = 0;
    const { modem, sent } = fakeModem();
    const svc = new NetworkDiagnostics({ modem, isBusy: () => ++calls > 4 }); // idle for the first checks, then a call starts
    const dropped = await svc.refresh();
    expect(dropped.skippedBecause).toMatch(/call started/);
    expect(sent.length).toBeLessThan(6);

    const ok = new NetworkDiagnostics({ modem: fakeModem().modem, isBusy: () => false });
    const real = await ok.refresh();
    const again = new NetworkDiagnostics({ modem: fakeModem().modem, isBusy: () => false });
    await again.refresh();
    let busy = false;
    const svc2 = new NetworkDiagnostics({ modem: fakeModem().modem, isBusy: () => busy });
    await svc2.refresh();
    busy = true;
    const kept = await svc2.refresh();
    expect(kept.source).toBe('hardware'); // the earlier real numbers are still there
    expect(kept.skippedBecause).toMatch(/call is in progress/);
    expect(real.source).toBe('hardware');
  });

  it('reports unanswered queries as unreadable, not as a failure of the network', async () => {
    const { modem } = fakeModem({ answers: {} });
    const s = await new NetworkDiagnostics({ modem, isBusy: () => false }).refresh();
    expect(s.verdict).toMatchObject({ code: 'unreadable', uncertain: true });
  });
});
