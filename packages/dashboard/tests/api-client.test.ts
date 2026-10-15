import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient, GatewayApiError } from '../src/lib/api-client';

describe('GatewayApiClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('injects x-api-key header and normalizes endpoint URL', async () => {
    const mockHealth = {
      gatewayVersion: '0.1.0',
      isSimulated: true,
      driverType: 'mock',
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockHealth,
    });

    const client = new GatewayApiClient({
      gatewayUrl: 'http://127.0.0.1:4000///',
      apiKey: 'my-test-key-12345',
    });

    const result = await client.getHealth();

    expect(result).toEqual(mockHealth);
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:4000/api/gateway/health', {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'my-test-key-12345',
      },
    });
  });

  it('handles 409 Gateway Busy conflict and parses structured error', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        success: false,
        error: 'Cannot initiate call: A call is already active',
        code: 'GATEWAY_BUSY',
      }),
    });

    const client = new GatewayApiClient({
      gatewayUrl: 'http://127.0.0.1:4000',
      apiKey: 'test-key',
    });

    try {
      await client.dial({ phoneNumber: '+919876543210' });
      expect.fail('Should have thrown GatewayApiError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(GatewayApiError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('GATEWAY_BUSY');
      expect(err.message).toContain('already active');
    }
  });

  it('handles network failure and returns friendly GatewayApiError', async () => {
    (global.fetch as any).mockRejectedValue(new TypeError('Failed to fetch'));

    const client = new GatewayApiClient({
      gatewayUrl: 'http://127.0.0.1:4000',
      apiKey: 'test-key',
    });

    try {
      await client.getHealth();
      expect.fail('Should have thrown GatewayApiError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(GatewayApiError);
      expect(err.statusCode).toBe(0);
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.message).toContain('Failed to connect to Gateway');
    }
  });
});
