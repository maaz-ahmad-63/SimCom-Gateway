import { describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CallSessionManager } from '../../src/core/call-session-manager.js';
import { GatewayEventBus } from '../../src/core/event-bus.js';
import { ModemRegistry } from '../../src/modems/registry.js';
import { ModemEvent, ModemNotFoundError, ModemRegistrationError } from '../../src/modems/types.js';
import { createModemUnit } from '../../src/modems/unit.js';

// These are mock-adapter tests: they prove routing and isolation in the gateway, not physical modem or audio behavior.

function unit(id: string, atPort: string, over: { audioPort?: string; diagPort?: string } = {}) {
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
  const audio = new MockAudioAdapter();
  const eventBus = new GatewayEventBus();
  eventBus.on('error', () => {}); // server.ts registers the same listener; without one EventEmitter throws on 'error'
  const callManager = new CallSessionManager({ modem, audio, eventBus });
  return createModemUnit({
    descriptor: { modemId: id, name: id, model: 'MOCK', atPort, diagPort: over.diagPort, audio: { kind: 'usb-pcm', port: over.audioPort ?? `${atPort}-audio` } },
    modem,
    audio,
    callManager,
  });
}

describe('ModemRegistry', () => {
  it('registers two modems independently, each with its own driver, audio and call manager', () => {
    const registry = new ModemRegistry();
    const a = unit('modem-a', 'COM14', { audioPort: 'COM13' });
    const b = unit('modem-b', 'COM27', { diagPort: 'COM29' });
    registry.register(a);
    registry.register(b);
    expect(registry.list().map((u) => u.descriptor.modemId)).toEqual(['modem-a', 'modem-b']);
    expect(registry.get('modem-a').modem).not.toBe(registry.get('modem-b').modem);
    expect(registry.get('modem-a').callManager).not.toBe(registry.get('modem-b').callManager);
    expect(registry.get('modem-a').audio).not.toBe(registry.get('modem-b').audio);
    expect(registry.defaultModemId).toBe('modem-a');
  });

  it('rejects a duplicate id, a shared serial port and an unknown modem', () => {
    const registry = new ModemRegistry();
    registry.register(unit('modem-a', 'COM14', { audioPort: 'COM13' }));
    expect(() => registry.register(unit('modem-a', 'COM30'))).toThrow(ModemRegistrationError);
    expect(() => registry.register(unit('modem-c', 'com14'))).toThrow(/COM14/);
    expect(() => registry.register(unit('modem-d', 'COM30', { diagPort: 'COM13' }))).toThrow(/COM13/);
    expect(() => registry.get('nope')).toThrow(ModemNotFoundError);
  });

  it('a simultaneous inbound call on each modem produces two separate calls and modem-scoped events', async () => {
    const registry = new ModemRegistry();
    const events: ModemEvent[] = [];
    registry.onModemEvent((e) => events.push(e));
    const a = unit('modem-a', 'COM14', { audioPort: 'COM13' });
    const b = unit('modem-b', 'COM27', { diagPort: 'COM29' });
    registry.register(a);
    registry.register(b);
    await a.modem.initialize();
    await b.modem.initialize();

    (a.modem as MockModemAdapter).simulateInboundCall('+911111111111');
    (b.modem as MockModemAdapter).simulateInboundCall('+922222222222');
    await new Promise((r) => setTimeout(r, 20));

    const callA = registry.getCall('modem-a');
    const callB = registry.getCall('modem-b');
    expect(callA?.remoteNumber).toBe('+911111111111');
    expect(callB?.remoteNumber).toBe('+922222222222');
    expect(callA?.id).not.toBe(callB?.id);
    expect(registry.findByCallId(callA!.id)?.descriptor.modemId).toBe('modem-a');
    expect(registry.findByCallId(callB!.id)?.descriptor.modemId).toBe('modem-b');

    const ringing = events.filter((e) => e.type === 'modem.call.ringing');
    expect(ringing.map((e) => [e.modemId, (e as { callId: string }).callId])).toEqual(
      expect.arrayContaining([['modem-a', callA!.id], ['modem-b', callB!.id]])
    );

    // Answering A does not touch B.
    await a.callManager.answer();
    expect(registry.getCall('modem-a')?.state).toBe('ACTIVE');
    expect(registry.getCall('modem-b')?.state).toBe('INBOUND_RINGING');
    expect(events.some((e) => e.type === 'modem.call.answered' && e.modemId === 'modem-a')).toBe(true);
    expect(events.some((e) => e.type === 'modem.call.answered' && e.modemId === 'modem-b')).toBe(false);

    // Hanging up A leaves B ringing.
    await a.callManager.hangup('test');
    expect(registry.getCall('modem-a')).toBeNull();
    expect(registry.getCall('modem-b')?.state).toBe('INBOUND_RINGING');
    expect(events.some((e) => e.type === 'modem.call.ended' && e.modemId === 'modem-a')).toBe(true);
    expect(events.some((e) => e.type === 'modem.call.ended' && e.modemId === 'modem-b')).toBe(false);
    await b.callManager.hangup('test');
  });

  it('losing one modem does not change the other, and unregistering stops its events', async () => {
    const registry = new ModemRegistry();
    const events: ModemEvent[] = [];
    registry.onModemEvent((e) => events.push(e));
    const a = unit('modem-a', 'COM14', { audioPort: 'COM13' });
    const b = unit('modem-b', 'COM27');
    registry.register(a);
    registry.register(b);
    await a.modem.initialize();
    await b.modem.initialize();
    (a.modem as MockModemAdapter).simulatePortDisconnect();
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.status('modem-a').connection).not.toBe('READY');
    expect(registry.status('modem-b').connection).toBe('READY');
    registry.unregister('modem-a');
    expect(registry.defaultModemId).toBe('modem-b');
    const before = events.length;
    (b.modem as MockModemAdapter).simulateInboundCall('+933333333333');
    await new Promise((r) => setTimeout(r, 20));
    expect(events.slice(before).every((e) => e.modemId === 'modem-b')).toBe(true);
    await b.callManager.hangup('test');
  });

  it('AI can be switched off for one modem only', () => {
    const registry = new ModemRegistry();
    registry.register(unit('modem-a', 'COM14', { audioPort: 'COM13' }));
    registry.register(unit('modem-b', 'COM27'));
    registry.setAiEnabled('modem-b', false);
    expect(registry.status('modem-a').aiEnabled).toBe(true);
    expect(registry.status('modem-b').aiEnabled).toBe(false);
  });
});
