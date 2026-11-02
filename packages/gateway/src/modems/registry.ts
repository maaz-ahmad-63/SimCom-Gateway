import { EventEmitter } from 'node:events';
import type { CallSession } from '@sim-gateway/shared';
import { ModemEvent, ModemId, ModemNotFoundError, ModemRegistrationError, ModemStatusSnapshot, ModemUnit } from './types.js';

interface Binding {
  unit: ModemUnit;
  detach: () => void;
}

/**
 * The set of modems the gateway manages. It owns no hardware: each unit brings its own driver, call manager and audio.
 * Lookups are always by modemId (or by callId, which resolves to exactly one modem); there is no "active modem".
 */
export class ModemRegistry extends EventEmitter {
  private readonly units = new Map<ModemId, Binding>();
  private defaultId: ModemId | null = null;

  /** Add a unit. Rejects a duplicate id and any serial port or audio device already claimed by another modem. */
  register(unit: ModemUnit, options: { isDefault?: boolean } = {}): void {
    const { modemId } = unit.descriptor;
    if (!modemId.trim()) throw new ModemRegistrationError('A modem needs a modemId');
    if (this.units.has(modemId)) throw new ModemRegistrationError(`Modem '${modemId}' is already registered`);
    for (const other of this.list()) {
      const clash = this.portClash(unit, other);
      if (clash) throw new ModemRegistrationError(`Modem '${modemId}' cannot use ${clash}: it belongs to '${other.descriptor.modemId}'`);
    }
    this.units.set(modemId, { unit, detach: this.bind(unit) });
    if (options.isDefault || this.defaultId === null) this.defaultId = modemId;
    this.publish({ type: 'modem.status', modemId, status: this.status(modemId), timestamp: now() });
  }

  /** Remove a unit and stop listening to it. Other modems are untouched. */
  unregister(modemId: ModemId): void {
    const binding = this.units.get(modemId);
    if (!binding) throw new ModemNotFoundError(modemId);
    binding.detach();
    this.units.delete(modemId);
    if (this.defaultId === modemId) this.defaultId = this.units.keys().next().value ?? null;
  }

  get(modemId: ModemId): ModemUnit {
    const binding = this.units.get(modemId);
    if (!binding) throw new ModemNotFoundError(modemId);
    return binding.unit;
  }

  has(modemId: ModemId): boolean {
    return this.units.has(modemId);
  }

  list(): ModemUnit[] {
    return [...this.units.values()].map((b) => b.unit);
  }

  /** The modem the legacy, unscoped API routes act on (the first one registered unless another was marked default). */
  get defaultModemId(): ModemId | null {
    return this.defaultId;
  }

  getDefault(): ModemUnit {
    if (!this.defaultId) throw new ModemNotFoundError('(default)');
    return this.get(this.defaultId);
  }

  /** The call a modem is handling, or null. */
  getCall(modemId: ModemId): CallSession | null {
    return this.get(modemId).callManager.getCurrentCall();
  }

  /** Which modem is carrying this call. A callId belongs to exactly one modem. */
  findByCallId(callId: string): ModemUnit | null {
    for (const unit of this.list()) if (unit.callManager.getCurrentCall()?.id === callId) return unit;
    return null;
  }

  status(modemId: ModemId): ModemStatusSnapshot {
    const unit = this.get(modemId);
    return {
      modemId,
      name: unit.descriptor.name,
      model: unit.descriptor.model,
      connection: unit.modem.getConnectionState(),
      audio: unit.audioStatus(),
      aiEnabled: unit.aiEnabled,
      call: unit.callManager.getCurrentCall(),
      timestamp: now(),
    };
  }

  setAiEnabled(modemId: ModemId, enabled: boolean): void {
    this.get(modemId).aiEnabled = enabled;
    this.publish({ type: 'modem.status', modemId, status: this.status(modemId), timestamp: now() });
  }

  onModemEvent(listener: (event: ModemEvent) => void): () => void {
    this.on('modem-event', listener);
    return () => this.off('modem-event', listener);
  }

  private publish(event: ModemEvent): void {
    this.emit('modem-event', event);
  }

  /** Translate one unit's own events into modem-scoped events. The closures capture this unit's modemId and nothing else. */
  private bind(unit: ModemUnit): () => void {
    const { modemId } = unit.descriptor;
    const cm = unit.callManager;
    // The call manager can report INBOUND_RINGING again on each RING / CLIP line; announce a call once.
    let ringingAnnounced: string | null = null;
    const onState = (e: { callId: string; currentState: string; session: CallSession }) => {
      if (e.currentState === 'INBOUND_RINGING') {
        if (ringingAnnounced === e.callId) return;
        ringingAnnounced = e.callId;
        this.publish({ type: 'modem.call.ringing', modemId, callId: e.callId, remoteNumber: e.session.remoteNumber, timestamp: now() });
      } else if (e.currentState === 'ACTIVE') {
        this.publish({ type: 'modem.call.answered', modemId, callId: e.callId, timestamp: now() });
      }
      this.publish({ type: 'modem.status', modemId, status: this.status(modemId), timestamp: now() });
    };
    const onEnded = (s: CallSession) => {
      this.publish({ type: 'modem.call.ended', modemId, callId: s.id, outcome: s.outcome, durationSeconds: s.durationSeconds, timestamp: now() });
      this.publish({ type: 'modem.status', modemId, status: this.status(modemId), timestamp: now() });
    };
    const onConnection = () => this.publish({ type: 'modem.status', modemId, status: this.status(modemId), timestamp: now() });
    const onError = (error: Error) => this.publish({ type: 'modem.error', modemId, message: error.message, timestamp: now() });

    cm.on('call:state_changed', onState);
    cm.on('call:ended', onEnded);
    cm.on('error', onError); // an unhandled 'error' on one manager must never throw into another modem's path
    unit.modem.on('connection_state', onConnection);
    unit.modem.on('error', onError);
    unit.audio?.on('error', (error) => this.publish({ type: 'modem.error', modemId, message: `audio: ${error.message}`, timestamp: now() }));
    return () => {
      cm.off('call:state_changed', onState);
      cm.off('call:ended', onEnded);
      cm.off('error', onError);
      unit.modem.off('connection_state', onConnection);
      unit.modem.off('error', onError);
    };
  }

  private portClash(a: ModemUnit, b: ModemUnit): string | null {
    const ports = (u: ModemUnit): string[] =>
      [u.descriptor.atPort, u.descriptor.diagPort, u.descriptor.audio.kind === 'usb-pcm' ? u.descriptor.audio.port : undefined]
        .filter((p): p is string => !!p)
        .map((p) => p.toUpperCase());
    const mine = new Set(ports(a));
    const shared = ports(b).find((p) => mine.has(p));
    if (shared) return `port ${shared}`;
    const device = (u: ModemUnit): string[] =>
      u.descriptor.audio.kind === 'analog' ? [u.descriptor.audio.captureDevice, u.descriptor.audio.playbackDevice].filter((d): d is string => !!d) : [];
    const mineDevices = new Set(device(a));
    const sharedDevice = device(b).find((d) => mineDevices.has(d));
    return sharedDevice ? `audio device '${sharedDevice}'` : null;
  }
}

function now(): string {
  return new Date().toISOString();
}
