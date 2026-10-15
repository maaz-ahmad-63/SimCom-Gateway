export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Patterns and key names that must be redacted from logs
const SENSITIVE_KEY_PATTERNS = [
  /api[-_]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth/i,
];

function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof key === 'string' && SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    // Redact Bearer tokens: Bearer <token>
    return value
      .replace(/Bearer\s+[A-Za-z0-9\-_.]{8,}/gi, 'Bearer [REDACTED]')
      .replace(/(?:key|token|secret|password)=([^\s&]+)/gi, '$1=[REDACTED]');
  }

  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(key, item));
    }
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitizedObj[k] = sanitizeValue(k, v);
    }
    return sanitizedObj;
  }

  return value;
}

export class Logger {
  readonly module: string;

  constructor(module = 'Gateway') {
    this.module = module;
  }

  private getEffectiveLevel(): LogLevel {
    const envLevel = process.env.LOG_LEVEL?.toLowerCase();
    if (envLevel && envLevel in LEVEL_PRIORITY) {
      return envLevel as LogLevel;
    }
    return 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    const currentPriority = LEVEL_PRIORITY[this.getEffectiveLevel()];
    const targetPriority = LEVEL_PRIORITY[level];
    return targetPriority >= currentPriority;
  }

  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    const cleanMessage = typeof message === 'string' ? sanitizeValue('', message) : message;
    let output = `${timestamp} [${tag}] [${this.module}] ${cleanMessage}`;

    if (meta !== undefined) {
      if (meta instanceof Error) {
        output += ` | Error: ${meta.message}${meta.stack ? `\n${meta.stack}` : ''}`;
      } else {
        const cleanMeta = sanitizeValue('', meta);
        output += ` | ${JSON.stringify(cleanMeta)}`;
      }
    }

    return output;
  }

  debug(message: string, meta?: unknown): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, meta));
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message: string, meta?: unknown): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, meta));
    }
  }

  child(subModule: string): Logger {
    return new Logger(`${this.module}:${subModule}`);
  }
}

export const rootLogger = new Logger('Gateway');

export function createLogger(moduleName: string): Logger {
  return new Logger(moduleName);
}
