import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createGatewayServer } from '../../src/server.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';

describe('Integration: SQLite Persistence Across Application Restarts', () => {
  const testDbPath = path.resolve('./data/test-restart-persistence.sqlite');
  const apiKey = 'test-key-persistence-12345';

  afterAll(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  });

  it('persists call records, outcomes, durations, and timelines across full server restart', async () => {
    // -------------------------------------------------------------
    // INSTANCE 1: Start server, execute call, close server
    // -------------------------------------------------------------
    const modem1 = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const server1 = createGatewayServer({
      config: {
        sqliteDbPath: testDbPath,
        gatewayApiKey: apiKey,
      },
      modem: modem1,
    });
    await modem1.initialize();

    // Persist a gateway setting
    server1.repository.setSetting('auto_recording_enabled', 'true');
    server1.repository.setSetting('default_carrier', 'Vi India');

    // Initiate outbound call
    const session = await server1.callManager.dial({ phoneNumber: '+919876543210' });
    const callId = session.id;

    // Advance to ACTIVE
    modem1.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    // Wait 1.1s so duration is calculated as >= 1s
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Hangup
    await server1.callManager.hangup('Call ended normally');

    // Shutdown instance 1 completely
    await server1.close();

    // -------------------------------------------------------------
    // INSTANCE 2: Start new server on the same database file
    // -------------------------------------------------------------
    const modem2 = new MockModemAdapter();
    const server2 = createGatewayServer({
      config: {
        sqliteDbPath: testDbPath,
        gatewayApiKey: apiKey,
      },
      modem: modem2,
    });
    await modem2.initialize();

    // 1. Verify settings survived restart
    expect(server2.repository.getSetting('auto_recording_enabled')).toBe('true');
    expect(server2.repository.getSetting('default_carrier')).toBe('Vi India');

    // 2. Verify call record survived restart
    const callDetails = server2.repository.getCallById(callId);
    expect(callDetails).not.toBeNull();

    const restoredSession = callDetails!.session;
    expect(restoredSession.id).toBe(callId);
    expect(restoredSession.remoteNumber).toBe('+919876543210');
    expect(restoredSession.direction).toBe('outbound');
    expect(restoredSession.outcome).toBe('completed');
    expect(restoredSession.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(restoredSession.isSimulated).toBe(true);
    expect(restoredSession.startedAt).toBeDefined();
    expect(restoredSession.answeredAt).toBeDefined();
    expect(restoredSession.endedAt).toBeDefined();

    // 3. Verify event timeline survived restart
    const events = callDetails!.events;
    expect(events.length).toBeGreaterThanOrEqual(3);

    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('CALL_STARTED');
    expect(eventTypes).toContain('STATE_CHANGED');
    expect(eventTypes).toContain('CALL_ENDED');

    await server2.close();
  });
});
