import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';

describe('Integration: Calls REST API & Concurrency', () => {
  let serverInstance: GatewayServerInstance;
  let modem: MockModemAdapter;
  const testApiKey = 'test-secret-calls-api-12345';
  const testDbPath = path.resolve('./data/test-calls.sqlite');

  beforeAll(async () => {
    modem = new MockModemAdapter({
      autoAnswerDelayMs: 0,
      ringIntervalMs: 50,
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
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  });

  it('rejects invalid phone numbers with 400 VALIDATION_ERROR', async () => {
    const invalidNumbers = [
      '123',
      '+91abc1234',
      '+919876543210;\r\nAT+CFUN=0',
      'invalid-phone',
      '',
    ];

    for (const num of invalidNumbers) {
      const res = await request(serverInstance.app)
        .post('/api/calls/dial')
        .set('x-api-key', testApiKey)
        .send({ phoneNumber: num });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('initiates outbound call with 201 Created and persists initial state', async () => {
    const res = await request(serverInstance.app)
      .post('/api/calls/dial')
      .set('x-api-key', testApiKey)
      .send({ phoneNumber: '+919876543210' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.call.remoteNumber).toBe('+919876543210');
    expect(res.body.call.direction).toBe('outbound');
    expect(res.body.call.state).toBe('DIALING');
    expect(res.body.call.isSimulated).toBe(true);

    const callId = res.body.call.id;

    // Verify call can be fetched from DB
    const getRes = await request(serverInstance.app)
      .get(`/api/calls/${callId}`)
      .set('x-api-key', testApiKey);

    expect(getRes.status).toBe(200);
    expect(getRes.body.call.id).toBe(callId);
    expect(getRes.body.events.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects concurrent outbound call with 409 GATEWAY_BUSY', async () => {
    // Current call is still active/dialing
    const res = await request(serverInstance.app)
      .post('/api/calls/dial')
      .set('x-api-key', testApiKey)
      .send({ phoneNumber: '+919999999999' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('GATEWAY_BUSY');
    expect(res.body.error).toContain('already active');
  });

  it('rejects answering an outbound dialing call with 400 INVALID_STATE_TRANSITION', async () => {
    const res = await request(serverInstance.app)
      .post('/api/calls/answer')
      .set('x-api-key', testApiKey);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('advances call to ACTIVE and supports DTMF transmission', async () => {
    // Simulate remote answering
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    const dtmfRes = await request(serverInstance.app)
      .post('/api/calls/dtmf')
      .set('x-api-key', testApiKey)
      .send({ digit: '7' });

    expect(dtmfRes.status).toBe(200);
    expect(dtmfRes.body.success).toBe(true);
    expect(dtmfRes.body.digit).toBe('7');
  });

  it('terminates active call with 200 OK and records completed outcome in database', async () => {
    const hangupRes = await request(serverInstance.app)
      .post('/api/calls/hangup')
      .set('x-api-key', testApiKey)
      .send({ reason: 'Completed customer interaction' });

    expect(hangupRes.status).toBe(200);
    expect(hangupRes.body.success).toBe(true);

    // Verify call is ended and listed in /api/calls
    const listRes = await request(serverInstance.app)
      .get('/api/calls')
      .set('x-api-key', testApiKey);

    expect(listRes.status).toBe(200);
    expect(listRes.body.calls.length).toBeGreaterThanOrEqual(1);

    const endedCall = listRes.body.calls[0];
    expect(endedCall.state).toBe('IDLE');
    expect(endedCall.outcome).toBe('completed');
    expect(endedCall.endedAt).toBeDefined();
  });

  it('returns 404 NOT_FOUND for non-existent call ID', async () => {
    const res = await request(serverInstance.app)
      .get('/api/calls/non-existent-uuid-1234')
      .set('x-api-key', testApiKey);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
