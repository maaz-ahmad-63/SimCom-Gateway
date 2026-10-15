import { describe, expect, it } from 'vitest';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import { GatewayBusyError, InvalidStateTransitionError } from '../src/core/errors.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';

describe('CallSessionManager', () => {
  const createHarness = (modemOptions = {}) => {
    const modem = new MockModemAdapter({
      autoAnswerDelayMs: 0, // Manual control for tests
      ringIntervalMs: 100,
      ...modemOptions,
    });
    const audio = new MockAudioAdapter();
    const eventBus = new GatewayEventBus();
    const manager = new CallSessionManager({ modem, audio, eventBus });
    return { modem, audio, eventBus, manager };
  };

  it('manages complete outbound call lifecycle', async () => {
    const { modem, audio, manager } = createHarness();
    await modem.initialize();

    expect(manager.getCurrentCall()).toBeNull();

    // 1. Dial
    const session = await manager.dial({ phoneNumber: '+919876543210' });
    expect(session.state).toBe('DIALING');
    expect(manager.getCurrentCall()?.state).toBe('DIALING');

    // 2. Alerting
    modem.emit('urc', {
      raw: 'ALERTING',
      type: 'CUSTOM',
      payload: { status: 'alerting' },
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    expect(manager.getCurrentCall()?.state).toBe('OUTBOUND_RINGING');

    // 3. Remote Answer
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(audio.getStats().isStreaming).toBe(true);

    // 4. Hangup
    await manager.hangup('Call completed');
    expect(manager.getCurrentCall()).toBeNull();
    expect(audio.getStats().isStreaming).toBe(false);

    await modem.close();
  });

  it('manages complete inbound call lifecycle', async () => {
    const { modem, audio, manager } = createHarness();
    await modem.initialize();

    // 1. Inbound Ring
    modem.emit('urc', {
      raw: 'RING\r\n+CLIP: "+919123456789",145',
      type: 'CLIP',
      phoneNumber: '+919123456789',
      typeOfAddress: 145,
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    const activeCall = manager.getCurrentCall();
    expect(activeCall).toBeDefined();
    expect(activeCall?.direction).toBe('inbound');
    expect(activeCall?.remoteNumber).toBe('+919123456789');
    expect(activeCall?.state).toBe('INBOUND_RINGING');

    // 2. Answer
    await manager.answer();
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(audio.getStats().isStreaming).toBe(true);

    // 3. Hangup
    await manager.hangup();
    expect(manager.getCurrentCall()).toBeNull();

    await modem.close();
  });

  it('strictly enforces single concurrency lock on outbound calls', async () => {
    const { modem, manager } = createHarness();
    await modem.initialize();

    await manager.dial({ phoneNumber: '+919876543210' });
    expect(manager.getCurrentCall()?.state).toBe('DIALING');

    // Attempting a second outbound call while active must throw GatewayBusyError
    await expect(
      manager.dial({ phoneNumber: '+919999999999' })
    ).rejects.toThrow(GatewayBusyError);

    await manager.hangup();
    await modem.close();
  });

  it('strictly rejects second incoming call while already in an active call', async () => {
    const { modem, eventBus, manager } = createHarness();
    await modem.initialize();

    // Start first call and advance to ACTIVE
    await manager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');
    const firstCallId = manager.getCurrentCall()?.id;

    // Second incoming call arrives
    const endedEvents: any[] = [];
    eventBus.on('call:ended', (c) => endedEvents.push(c));

    modem.emit('urc', {
      raw: 'RING\r\n+CLIP: "+919999999999",145',
      type: 'CLIP',
      phoneNumber: '+919999999999',
      typeOfAddress: 145,
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    // Verify first call is STILL active and untouched
    expect(manager.getCurrentCall()?.id).toBe(firstCallId);
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');

    // Verify second call was rejected with busy_rejected
    const rejected = endedEvents.find((e) => e.remoteNumber === '+919999999999');
    expect(rejected).toBeDefined();
    expect(rejected.outcome).toBe('busy_rejected');
    expect(rejected.isSimulated).toBe(true);

    await manager.hangup();
    await modem.close();
  });

  it('permits DTMF transmission only when ACTIVE', async () => {
    const { modem, manager } = createHarness();
    await modem.initialize();

    // DTMF when IDLE must fail
    await expect(manager.sendDtmf({ digit: '5' })).rejects.toThrow(
      InvalidStateTransitionError
    );

    // Dial and advance to ACTIVE
    await manager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    // DTMF when ACTIVE succeeds
    await expect(manager.sendDtmf({ digit: '9' })).resolves.not.toThrow();

    await manager.hangup();
    await modem.close();
  });
});
