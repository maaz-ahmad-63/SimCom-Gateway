import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { IModemAdapter, ModemConnectionState, ModemDeviceInfo, ModemNetworkStatus, ModemSignalQuality } from '@sim-gateway/shared';
import { EventEmitter } from 'node:events';

describe('Integration: Mock Inbound Call & Hardware Safety Guard', () => {
  let serverInstance: GatewayServerInstance;
  let mockModem: MockModemAdapter;
  const testApiKey = 'test-secret-mock-inbound-12345';
  const testDbPath = path.resolve('./data/test-inbound.sqlite');

  beforeAll(async () => {
    mockModem = new MockModemAdapter({ ringIntervalMs: 500 });

    serverInstance = createGatewayServer({
      config: {
        gatewayApiKey: testApiKey,
        sqliteDbPath: testDbPath,
      },
      modem: mockModem,
    });

    await mockModem.initialize();
  });

  afterAll(async () => {
    await serverInstance.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  });

  it('triggers simulated inbound call and answers it via API', async () => {
    // 1. Trigger inbound call
    const triggerRes = await request(serverInstance.app)
      .post('/api/mock/trigger-inbound')
      .set('x-api-key', testApiKey)
      .send({ phoneNumber: '+919123456789', ringCount: 8 });

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.success).toBe(true);

    // Give ring event a short tick
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 2. Verify health reports active ringing call
    const healthRes = await request(serverInstance.app)
      .get('/api/gateway/health')
      .set('x-api-key', testApiKey);

    expect(healthRes.body.activeCall).toBeDefined();
    expect(healthRes.body.activeCall.remoteNumber).toBe('+919123456789');
    expect(healthRes.body.activeCall.state).toBe('INBOUND_RINGING');

    // 3. Answer the incoming call
    const answerRes = await request(serverInstance.app)
      .post('/api/calls/answer')
      .set('x-api-key', testApiKey);

    expect(answerRes.status).toBe(200);
    expect(answerRes.body.call.state).toBe('ACTIVE');

    // 4. Hang up
    const hangupRes = await request(serverInstance.app)
      .post('/api/calls/hangup')
      .set('x-api-key', testApiKey);

    expect(hangupRes.status).toBe(200);
  });

  it('strictly blocks mock endpoint when running with physical hardware driver (403)', async () => {
    // Construct a fake hardware adapter
    class FakeHardwareAdapter extends EventEmitter implements IModemAdapter {
      readonly driverType = 'hardware' as const;
      readonly isSimulated = false;
      getConnectionState(): ModemConnectionState { return 'READY'; }
      async initialize(): Promise<void> {}
      async close(): Promise<void> {}
      async executeCommand(): Promise<string> { return 'OK'; }
      async dial(): Promise<void> {}
      async answer(): Promise<void> {}
      async hangup(): Promise<void> {}
      async sendDtmf(): Promise<void> {}
      async getSignalQuality(): Promise<ModemSignalQuality> {
        return { rssi: 20, ber: 99, dBm: -73, bars: 4, timestamp: new Date().toISOString() };
      }
      async getNetworkStatus(): Promise<ModemNetworkStatus> {
        return { registration: 'REGISTERED_HOME', operatorName: 'Vi India', accessTechnology: 'LTE', timestamp: new Date().toISOString() };
      }
      async getDeviceInfo(): Promise<ModemDeviceInfo> {
        return { manufacturer: 'SIMCOM', model: 'SIMCOM_SIM7600EI', firmwareRevision: 'SIM7600M21-A_V1.1', isSimulated: false };
      }
    }

    const fakeHardwareModem = new FakeHardwareAdapter();
    const hwServer = createGatewayServer({
      config: {
        gatewayApiKey: testApiKey,
        sqliteDbPath: path.resolve('./data/test-hw.sqlite'),
      },
      modem: fakeHardwareModem,
    });

    const res = await request(hwServer.app)
      .post('/api/mock/trigger-inbound')
      .set('x-api-key', testApiKey)
      .send({ phoneNumber: '+919999999999' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('MOCK_DISABLED');

    await hwServer.close();
    const hwDb = path.resolve('./data/test-hw.sqlite');
    if (fs.existsSync(hwDb)) fs.unlinkSync(hwDb);
    if (fs.existsSync(`${hwDb}-wal`)) fs.unlinkSync(`${hwDb}-wal`);
    if (fs.existsSync(`${hwDb}-shm`)) fs.unlinkSync(`${hwDb}-shm`);
  });
});
