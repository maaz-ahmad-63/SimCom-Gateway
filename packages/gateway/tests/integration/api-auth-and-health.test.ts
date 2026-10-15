import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';

describe('Integration: API Auth & Gateway Health', () => {
  let serverInstance: GatewayServerInstance;
  const testApiKey = 'test-secret-key-12345';
  const testDbPath = path.resolve('./data/test-auth-health.sqlite');

  beforeAll(async () => {
    const modem = new MockModemAdapter({
      carrierName: 'Vi India',
      firmwareRevision: 'SIM7600M21-A_V1.1',
    });

    serverInstance = createGatewayServer({
      config: {
        gatewayApiKey: testApiKey,
        sqliteDbPath: testDbPath,
      },
      modem,
    });

    await modem.initialize();
  });

  afterAll(async () => {
    await serverInstance.close();
    // Cleanup test sqlite db
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  });

  it('rejects requests with missing API key (401)', async () => {
    const res = await request(serverInstance.app).get('/api/gateway/health');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with invalid API key (401)', async () => {
    const res = await request(serverInstance.app)
      .get('/api/gateway/health')
      .set('x-api-key', 'wrong-key-value');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('accepts requests with valid API key via x-api-key header', async () => {
    const res = await request(serverInstance.app)
      .get('/api/gateway/health')
      .set('x-api-key', testApiKey);
    expect(res.status).toBe(200);
    expect(res.body.gatewayVersion).toBe('0.1.0');
  });

  it('accepts requests with valid API key via Authorization: Bearer header', async () => {
    const res = await request(serverInstance.app)
      .get('/api/gateway/health')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.gatewayVersion).toBe('0.1.0');
  });

  it('returns comprehensive health and explicitly marks simulation mode without leaking secrets', async () => {
    const res = await request(serverInstance.app)
      .get('/api/gateway/health')
      .set('x-api-key', testApiKey);

    expect(res.status).toBe(200);
    const body = res.body;

    // Simulation verification
    expect(body.isSimulated).toBe(true);
    expect(body.driverType).toBe('mock');

    // Modem specs
    expect(body.modem.connectionState).toBe('READY');
    expect(body.modem.info.model).toBe('SIMCOM_SIM7600EI');
    expect(body.modem.info.firmwareRevision).toBe('SIM7600M21-A_V1.1');
    expect(body.modem.network.operatorName).toBe('Vi India');
    expect(body.modem.signal.bars).toBeGreaterThanOrEqual(1);

    // Ports & Diagnostic Telemetry
    expect(body.modem.atPort).toBe('COM20');
    expect(body.modem.audioPort).toBe('COM19');
    expect(body.modem.simStatus).toBe('READY');
    expect(body.modem.atStatus).toBe('OK');
    expect(body.modem.lastCommunicationTime).toBeDefined();

    // System metrics
    expect(body.system.platform).toBeDefined();
    expect(body.system.nodeVersion).toBe(process.version);
    expect(body.system.memoryUsageMb).toBeGreaterThan(0);

    // Zero secret leakage
    expect(body.gatewayApiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(testApiKey);
  });
});
