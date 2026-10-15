import { describe, expect, it, vi } from 'vitest';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import { GatewayBusyError, InvalidStateTransitionError } from '../src/core/errors.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { CallSession } from '@sim-gateway/shared';

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

  it('does not throw when a modem error has no external session-manager listener', () => {
    const modem = new MockModemAdapter();
    const manager = new CallSessionManager({ modem });

    expect(() => modem.emit('error', new Error('serial transport failed'))).not.toThrow();
    expect(manager.listenerCount('error')).toBe(0);
  });

  it('forwards modem errors to an external session-manager listener', () => {
    const modem = new MockModemAdapter();
    const manager = new CallSessionManager({ modem });
    const error = new Error('serial transport failed');
    const errors: Error[] = [];
    manager.on('error', (received) => errors.push(received));

    modem.emit('error', error);

    expect(errors).toEqual([error]);
  });

  it('maps a pre-answer NO CARRIER to call ended before answer', async () => {
    const { modem, manager } = createHarness();
    await modem.initialize();
    await manager.dial({ phoneNumber: '+919876543210' });

    modem.emit('urc', {
      raw: 'NO CARRIER',
      type: 'NO_CARRIER',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    expect(manager.getCurrentCall()).toBeNull();
  });

  it('maps a post-answer call end to remote party disconnected', async () => {
    const { modem, eventBus, manager } = createHarness();
    const ended: CallSession[] = [];
    eventBus.on('call:ended', (session) => ended.push(session));
    await modem.initialize();
    await manager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    modem.emit('urc', {
      raw: 'VOICE CALL: END: 4',
      type: 'VOICE_CALL_END',
      durationSeconds: 4,
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    expect(ended[0]?.terminationReason).toBe('Remote party disconnected');
  });

  it('treats SIM7600 CONNECT as answered and cancels the dial timeout', async () => {
    const { modem, eventBus, manager } = createHarness();
    const ended: CallSession[] = [];
    eventBus.on('call:ended', (session) => ended.push(session));
    const originalDial = modem.dial.bind(modem);
    modem.dial = async (phoneNumber) => {
      await originalDial(phoneNumber);
      modem.emit('urc', {
        raw: 'CONNECT',
        type: 'VOICE_CALL_BEGIN',
        timestamp: new Date().toISOString(),
        isSimulated: false,
      });
    };

    await modem.initialize();
    const session = await manager.dial({ phoneNumber: '+919876543210', timeoutSeconds: 5 });
    expect(session.state).toBe('ACTIVE');
    expect(session.answeredAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ended).toHaveLength(0);

    await manager.hangup('Test hangup');
  });

  it('activates and deactivates USB audio only through the explicit diagnostic methods', async () => {
    const { modem, manager } = createHarness();
    await modem.initialize();
    await manager.dial({ phoneNumber: '+919876543210' });

    await expect(manager.activateUsbAudioDiagnostic?.()).rejects.toThrow(
      'USB audio diagnostic is disabled'
    );

    const enabledManager = new CallSessionManager({
      modem,
      audio: new MockAudioAdapter(),
      enableUsbAudioDiagnostic: true,
    });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    await expect(enabledManager.activateUsbAudioDiagnostic?.()).rejects.toThrow(
      'requires an active call'
    );
    await manager.hangup('cleanup');
  });

  it('issues CPCMREG activation and idempotent deactivation for an active call', async () => {
    const { modem } = createHarness();
    const commands: string[] = [];
    const originalExecute = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return originalExecute(command, timeoutMs);
    };
    const enabledManager = new CallSessionManager({
      modem,
      audio: new MockAudioAdapter(),
      enableUsbAudioDiagnostic: true,
    });
    await modem.initialize();
    await enabledManager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    await expect(enabledManager.activateUsbAudioDiagnostic?.()).resolves.toMatchObject({
      command: 'AT+CPCMREG=1',
    });
    await expect(enabledManager.activateUsbAudioDiagnostic?.()).rejects.toThrow('already active');
    await expect(enabledManager.deactivateUsbAudioDiagnostic?.()).resolves.toMatchObject({
      command: 'AT+CPCMREG=0',
    });
    await expect(enabledManager.deactivateUsbAudioDiagnostic?.()).resolves.toBeNull();
    expect(commands).toEqual(expect.arrayContaining(['AT+CPCMREG=1', 'AT+CPCMREG=0']));
    await enabledManager.hangup('cleanup');
  });

  it('does not mark USB audio active when activation command fails', async () => {
    const { modem } = createHarness();
    const enabledManager = new CallSessionManager({
      modem,
      audio: new MockAudioAdapter(),
      enableUsbAudioDiagnostic: true,
    });
    await modem.initialize();
    await enabledManager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    modem.executeCommand = async () => 'ERROR';
    await expect(enabledManager.activateUsbAudioDiagnostic?.()).rejects.toThrow('activation rejected');
    await expect(enabledManager.deactivateUsbAudioDiagnostic?.()).resolves.toBeNull();
    await enabledManager.hangup('cleanup');
  });

  it('deactivates USB audio before finalizing a modem hangup', async () => {
    const { modem } = createHarness();
    const commands: string[] = [];
    const originalExecute = modem.executeCommand.bind(modem);
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      return originalExecute(command, timeoutMs);
    };
    const enabledManager = new CallSessionManager({
      modem,
      audio: new MockAudioAdapter(),
      enableUsbAudioDiagnostic: true,
    });
    await modem.initialize();
    await enabledManager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
    await enabledManager.activateUsbAudioDiagnostic?.();
    await enabledManager.hangup('manual cleanup');
    expect(commands.indexOf('AT+CPCMREG=0')).toBeGreaterThan(-1);
  });

  it('ends an unanswered dialing call when the dial timeout expires', async () => {
    const { modem, eventBus, manager } = createHarness();
    const ended: CallSession[] = [];
    eventBus.on('call:ended', (session) => ended.push(session));
    modem.dial = async () => new Promise<void>(() => {});
    await modem.initialize();
    vi.useFakeTimers();
    void manager.dial({ phoneNumber: '+919876543210', timeoutSeconds: 5 });

    await vi.advanceTimersByTimeAsync(5040);

    try {
      expect(ended[0]?.outcome).toBe('no_answer');
      expect(ended[0]?.terminationReason).toBe('Dial timeout exceeded');
    } finally {
      vi.useRealTimers();
    }
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
