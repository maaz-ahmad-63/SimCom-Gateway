import type { IModemAdapter } from '@sim-gateway/shared';

/**
 * SIM and mobile-network diagnostics.
 *
 * Every reading is taken through the modem adapter's own serialized AT command queue (never a second path to the port), and only while
 * the gateway is idle: no call exists, and the modem is READY. A reading that cannot be taken is reported as skipped with the reason,
 * never filled in. The raw replies are kept beside every conclusion so a technician can check it.
 */

export type SimState = 'ready' | 'pin_required' | 'puk_required' | 'not_inserted' | 'error' | 'unknown';
export type SignalLevel = 'very_weak' | 'weak' | 'fair' | 'good' | 'excellent' | 'unknown';

export interface Registration {
  /** The +CxREG <stat> value, or null when the modem did not answer or the answer could not be read. */
  stat: number | null;
  /** The <n> (unsolicited-result mode) value, kept for troubleshooting. */
  mode: number | null;
  registered: boolean;
  text: string;
  raw: string | null;
}

export interface Signal {
  rssi: number | null;
  ber: number | null;
  dbm: number | null;
  level: SignalLevel;
  text: string;
  raw: string | null;
}

export type VerdictCode = 'ok' | 'sim_not_ready' | 'registration_denied' | 'no_network' | 'searching' | 'voice_unconfirmed' | 'weak_signal' | 'signal_unknown' | 'unreadable';

export interface Verdict {
  code: VerdictCode;
  severity: 'ok' | 'info' | 'warning' | 'error' | 'critical';
  title: string;
  explanation: string;
  action: string;
  /** True when the modem did not give enough information for a reliable conclusion. */
  uncertain: boolean;
}

export interface NetworkSnapshot {
  takenAt: string;
  source: 'hardware' | 'simulated' | 'skipped';
  /** Why no reading was taken (call in progress, modem not ready, simulated modem). */
  skippedBecause: string | null;
  sim: { state: SimState; raw: string | null };
  signal: Signal;
  /** Circuit-switched (voice), LTE/EPS and packet-domain registration. */
  registration: { cs: Registration; eps: Registration; ps: Registration };
  operator: string | null;
  verdict: Verdict;
}

// ---- parsing ---------------------------------------------------------------------------------------------------------------------------

const REG_TEXT: Record<number, string> = {
  0: 'not registered, not searching',
  1: 'registered (home network)',
  2: 'searching for a network',
  3: 'registration denied',
  4: 'unknown',
  5: 'registered (roaming)',
  6: 'registered for SMS only (home)',
  7: 'registered for SMS only (roaming)',
  8: 'emergency calls only',
  9: 'registered (home, CSFB not preferred)',
  10: 'registered (roaming, CSFB not preferred)',
};

/** Whether a <stat> value means the modem can use the network for normal service. 6 and 7 (SMS only) and 8 (emergency only) cannot place a normal call. */
export const isRegisteredStat = (stat: number | null): boolean => stat === 1 || stat === 5 || stat === 9 || stat === 10;

export function parseRegistration(raw: string | null, command: 'CREG' | 'CEREG' | 'CGREG'): Registration {
  const none: Registration = { stat: null, mode: null, registered: false, text: 'no answer from the modem', raw };
  if (!raw) return none;
  const m = new RegExp(`\\+${command}:\\s*(\\d+)(?:\\s*,\\s*(\\d+))?`, 'i').exec(raw);
  if (!m) return { ...none, text: 'the answer could not be read' };
  // The query form is "+CREG: <n>,<stat>"; an unsolicited form is "+CREG: <stat>".
  const hasTwo = m[2] !== undefined;
  const stat = Number(hasTwo ? m[2] : m[1]);
  const mode = hasTwo ? Number(m[1]) : null;
  return { stat, mode, registered: isRegisteredStat(stat), text: REG_TEXT[stat] ?? `unknown status ${stat}`, raw };
}

export function parseSimState(raw: string | null): { state: SimState; raw: string | null } {
  if (!raw) return { state: 'unknown', raw };
  if (/\+CPIN:\s*READY/i.test(raw)) return { state: 'ready', raw };
  if (/\+CPIN:\s*SIM PIN\b/i.test(raw)) return { state: 'pin_required', raw };
  if (/\+CPIN:\s*SIM PUK\b/i.test(raw)) return { state: 'puk_required', raw };
  if (/CME ERROR:\s*(10|SIM not inserted)/i.test(raw)) return { state: 'not_inserted', raw };
  if (/ERROR/i.test(raw)) return { state: 'error', raw };
  return { state: 'unknown', raw };
}

/** AT+CSQ: 0 is -113 dBm or less, 31 is -51 dBm or more, 99 means "not known or not detectable". */
export function signalFromCsq(raw: string | null): Signal {
  const empty = (text: string): Signal => ({ rssi: null, ber: null, dbm: null, level: 'unknown', text, raw });
  if (!raw) return empty('no answer from the modem');
  const m = /\+CSQ:\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (!m) return empty('the answer could not be read');
  const rssi = Number(m[1]);
  const ber = Number(m[2]);
  if (rssi === 99 || rssi > 31) return { rssi, ber, dbm: null, level: 'unknown', text: 'the modem cannot measure the signal right now (reported as unknown)', raw };
  const dbm = -113 + 2 * rssi;
  const level: SignalLevel = rssi <= 1 ? 'very_weak' : rssi <= 9 ? 'weak' : rssi <= 14 ? 'fair' : rssi <= 19 ? 'good' : 'excellent';
  const words: Record<SignalLevel, string> = { very_weak: 'very weak', weak: 'weak', fair: 'fair', good: 'good', excellent: 'excellent', unknown: 'unknown' };
  const shown = rssi === 0 ? '-113 dBm or less' : rssi === 31 ? '-51 dBm or more' : `${dbm} dBm`;
  return { rssi, ber, dbm, level, text: `${words[level]} (${shown})`, raw };
}

export function parseOperator(raw: string | null): string | null {
  const m = raw ? /\+COPS:[^"\n]*"([^"]+)"/i.exec(raw) : null;
  return m ? m[1] : null;
}

// ---- conclusion -----------------------------------------------------------------------------------------------------------------------

export function assess(s: Pick<NetworkSnapshot, 'sim' | 'signal' | 'registration'>): Verdict {
  const { sim, signal, registration: r } = s;
  if (sim.state !== 'ready' && sim.state !== 'unknown') {
    const why: Record<string, string> = {
      pin_required: 'The SIM is asking for its PIN.',
      puk_required: 'The SIM is locked and needs its PUK code.',
      not_inserted: 'No SIM card was detected in the modem.',
      error: 'The SIM returned an error.',
    };
    return { code: 'sim_not_ready', severity: 'critical', title: 'SIM not ready', explanation: why[sim.state] ?? 'The SIM is not ready.', action: 'Check that the SIM is inserted correctly and unlocked, then check again. A SIM that needs a PIN must be unlocked outside this application.', uncertain: false };
  }
  const answered = [r.cs, r.eps, r.ps].some((x) => x.stat !== null);
  if (sim.state === 'unknown' && !answered) {
    return { code: 'unreadable', severity: 'warning', title: 'Network status could not be read', explanation: 'The modem did not answer the SIM and registration queries, so nothing can be concluded about the SIM or the network.', action: 'Check the modem connection. If the modem shows as connected, wait a moment and check again.', uncertain: true };
  }
  if ([r.cs, r.eps, r.ps].some((x) => x.stat === 3)) {
    return { code: 'registration_denied', severity: 'error', title: 'Network registration denied', explanation: 'The mobile network refused to register this SIM. This usually means the SIM is blocked, not activated, or not allowed on this network.', action: 'Contact the SIM provider to check that the SIM is active and allowed to make voice calls.', uncertain: false };
  }
  if (!r.cs.registered && !r.eps.registered) {
    if (r.cs.stat === 2 || r.eps.stat === 2) {
      return { code: 'searching', severity: 'warning', title: 'Searching for a mobile network', explanation: 'The modem is looking for a network and is not registered yet. Calls cannot be placed until it registers.', action: 'Wait a minute. If this continues, check the antenna, the signal and that the SIM is active.', uncertain: false };
    }
    return { code: 'no_network', severity: 'error', title: 'Not registered on a mobile network', explanation: 'The modem is not registered on any mobile network, so calls cannot be placed.', action: 'Check the antenna and the signal where the modem is placed, and that the SIM is active with credit.', uncertain: false };
  }
  if (!r.cs.registered) {
    return { code: 'voice_unconfirmed', severity: 'warning', title: 'Voice service not confirmed', explanation: `The modem is registered for data (${r.eps.text}) but does not confirm voice (circuit-switched) registration (${r.cs.text}). On some networks voice is arranged at the moment of a call, so this is not proof that calls will fail.`, action: 'Place a test call when convenient. If calls fail, ask the SIM provider whether voice calls are enabled on this SIM and network.', uncertain: true };
  }
  if (signal.level === 'very_weak' || signal.level === 'weak') {
    return { code: 'weak_signal', severity: 'warning', title: 'Weak mobile signal', explanation: `The signal is ${signal.text}. Calls may fail to connect or may sound poor.`, action: 'Move the antenna, use an external antenna, or place the modem near a window.', uncertain: false };
  }
  if (signal.level === 'unknown') {
    return { code: 'signal_unknown', severity: 'info', title: 'Signal strength unknown', explanation: 'The modem is registered but did not report a usable signal reading.', action: 'No action is needed unless calls fail.', uncertain: true };
  }
  return { code: 'ok', severity: 'ok', title: 'Mobile network ready', explanation: `${r.cs.text.charAt(0).toUpperCase()}${r.cs.text.slice(1)}${s.signal.dbm !== null ? `, signal ${signal.text}` : ''}.`, action: '', uncertain: false };
}

const EMPTY_REG = (text: string): Registration => ({ stat: null, mode: null, registered: false, text, raw: null });

function skipped(at: string, why: string, source: NetworkSnapshot['source']): NetworkSnapshot {
  const unread = { sim: { state: 'unknown' as SimState, raw: null }, signal: signalFromCsq(null), registration: { cs: EMPTY_REG(why), eps: EMPTY_REG(why), ps: EMPTY_REG(why) } };
  return {
    takenAt: at,
    source,
    skippedBecause: why,
    ...unread,
    operator: null,
    verdict: { code: 'unreadable', severity: 'info', title: 'No reading taken', explanation: why, action: '', uncertain: true },
  };
}

export interface NetworkDeps {
  modem: IModemAdapter;
  /** True while a call exists or is being set up: no AT query is sent then. */
  isBusy: () => boolean;
  now?: () => Date;
  onSnapshot?: (s: NetworkSnapshot, previous: NetworkSnapshot | null) => void;
  logger?: { warn(message: string): void };
}

export class NetworkDiagnostics {
  private last: NetworkSnapshot | null = null;
  private running: Promise<NetworkSnapshot> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: NetworkDeps) {}

  snapshot(): NetworkSnapshot | null {
    return this.last;
  }

  /** Take a reading now. Returns the previous reading, marked skipped, when the gateway is busy; never queues AT work behind a call. */
  refresh(): Promise<NetworkSnapshot> {
    if (this.running) return this.running;
    this.running = this.take().finally(() => (this.running = null));
    return this.running;
  }

  private store(s: NetworkSnapshot): NetworkSnapshot {
    const previous = this.last;
    // A skipped reading never replaces a real one: the last real numbers stay, with the reason the newest attempt was skipped.
    if (s.source === 'skipped' && previous && previous.source === 'hardware') {
      this.last = { ...previous, skippedBecause: s.skippedBecause };
      return this.last;
    }
    this.last = s;
    try {
      this.deps.onSnapshot?.(s, previous);
    } catch {
      /* a listener must never break a reading */
    }
    return s;
  }

  private async take(): Promise<NetworkSnapshot> {
    const { modem } = this.deps;
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    if (modem.isSimulated) return this.store(skipped(at, 'The modem is simulated, so there is no SIM or mobile network to read.', 'simulated'));
    const state = modem.getConnectionState();
    if (state !== 'READY') return this.store(skipped(at, `The modem is ${state.toLowerCase()}, so the SIM and network cannot be read.`, 'skipped'));
    if (this.deps.isBusy()) return this.store(skipped(at, 'A call is in progress. The network is not queried during a call.', 'skipped'));

    const ask = async (command: string): Promise<string | null> => {
      // Re-checked before each command: a call that started in between wins and the remaining queries are dropped.
      if (this.deps.isBusy()) throw new Error('busy');
      try {
        return await modem.executeCommand(command, 4000);
      } catch (e) {
        if ((e as Error).message === 'busy') throw e;
        return null;
      }
    };
    try {
      const cpin = await ask('AT+CPIN?');
      const csq = await ask('AT+CSQ');
      const creg = await ask('AT+CREG?');
      const cereg = await ask('AT+CEREG?');
      const cgreg = await ask('AT+CGREG?');
      const cops = await ask('AT+COPS?');
      const parts = {
        sim: parseSimState(cpin),
        signal: signalFromCsq(csq),
        registration: { cs: parseRegistration(creg, 'CREG'), eps: parseRegistration(cereg, 'CEREG'), ps: parseRegistration(cgreg, 'CGREG') },
      };
      return this.store({ takenAt: at, source: 'hardware', skippedBecause: null, ...parts, operator: parseOperator(cops), verdict: assess(parts) });
    } catch (e) {
      if ((e as Error).message === 'busy') return this.store(skipped(at, 'A call started while the network was being read, so the reading was dropped.', 'skipped'));
      this.deps.logger?.warn(`Network reading failed: ${(e as Error).message}`);
      return this.store(skipped(at, 'The network reading failed.', 'skipped'));
    }
  }

  /** Read now and then every `everyMs` while idle. Does nothing for a simulated modem. */
  start(everyMs = 60_000): void {
    if (this.timer) return;
    setTimeout(() => void this.refresh().catch(() => undefined), 5_000).unref?.();
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
