import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, createLogger } from '../src/core/logger.js';

describe('Structured Logger & Sensitive Data Redaction', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats log messages with timestamp, uppercase level, and module tag', () => {
    const logger = createLogger('TestModule');
    logger.info('System initialized successfully');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+\[INFO\s*\]\s+\[TestModule\]\s+System initialized successfully/);
  });

  it('redacts sensitive API keys and authorization tokens in object metadata', () => {
    const logger = createLogger('AuthModule');
    logger.info('User authenticated', {
      username: 'admin',
      gatewayApiKey: 'super-secret-token-12345',
      token: 'jwt-access-token-abc',
      password: 'mypassword',
      safeField: 'visible-metadata',
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('"gatewayApiKey":"[REDACTED]"');
    expect(output).toContain('"token":"[REDACTED]"');
    expect(output).toContain('"password":"[REDACTED]"');
    expect(output).toContain('"safeField":"visible-metadata"');
    expect(output).not.toContain('super-secret-token-12345');
  });

  it('redacts Bearer tokens embedded directly in string messages', () => {
    const logger = createLogger('HttpServer');
    logger.warn('Failed attempt with authorization: Bearer secret-bearer-token-abc123');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const output = warnSpy.mock.calls[0][0] as string;
    expect(output).toContain('Bearer [REDACTED]');
    expect(output).not.toContain('secret-bearer-token-abc123');
  });

  it('respects LOG_LEVEL configuration and filters lower priority logs', () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = createLogger('FilteredModule');

    logger.debug('Debug log message');
    logger.info('Info log message');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    logger.warn('Warning log message');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    logger.error('Error log message');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('supports child loggers with nested module namespaces', () => {
    const parent = new Logger('Parent');
    const child = parent.child('Child');

    expect(child.module).toBe('Parent:Child');
    child.info('Child event occurred');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[Parent:Child]');
  });
});
