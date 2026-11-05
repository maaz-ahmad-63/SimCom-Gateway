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

export interface RecentLogEntry {
  at: string;
  level: LogLevel;
  module: string;
  /** The full formatted line, already redacted. */
  line: string;
}

const RECENT_LOG_LIMIT = 500;
const recentLogs: RecentLogEntry[] = [];

function keepRecent(level: LogLevel, module: string, line: string): void {
  recentLogs.push({ at: line.slice(0, 24), level, module, line });
  if (recentLogs.length > RECENT_LOG_LIMIT) recentLogs.splice(0, recentLogs.length - RECENT_LOG_LIMIT);
}

/** The newest log lines at or above a level (info by default), oldest first. Nothing persists beyond the process. */
export function getRecentLogs(limit = 100, minLevel: LogLevel = 'info'): RecentLogEntry[] {
  const floor = LEVEL_PRIORITY[minLevel];
  return recentLogs.filter((e) => LEVEL_PRIORITY[e.level] >= floor).slice(-limit);
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/(ATD)\s*([+0-9][0-9\s-]{5,})(;?)/gi, '$1[REDACTED]$3')
    .replace(/(\+CLIP:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/(\+RXDTMF:\s*)\S+/gi, '$1[REDACTED]') // a key the caller pressed may be a PIN or a card digit
    .replace(/\b(?:sk|gsk|pk|xox[bp])[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .replace(/\b(api[-_]?key|token|secret)=\S+/gi, '$1=[REDACTED]')
    .replace(/\b\d{7,}\b/g, '[REDACTED]');
}

export interface LogSinkRecord {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  callId?: string;
  data?: unknown;
}

let sink: ((record: LogSinkRecord) => void) | null = null;

/** Where structured (JSON) records go, in addition to the console. The gateway points this at a rotating file. */
export function setLogSink(fn: ((record: LogSinkRecord) => void) | null): void {
  sink = fn;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

function toSink(level: LogLevel, module: string, message: string, meta?: unknown): void {
  if (!sink) return;
  try {
    const msg = typeof message === 'string' ? redactDiagnosticText(sanitizeValue('', message) as string) : String(message);
    const record: LogSinkRecord = { ts: new Date().toISOString(), level, component: module, msg };
    if (meta instanceof Error) record.data = { error: redactDiagnosticText(meta.message), stack: meta.stack ? redactDiagnosticText(meta.stack).slice(0, 1500) : undefined };
    else if (meta !== undefined) {
      record.data = redactDeep(sanitizeValue('', meta));
      const id = (meta as { callId?: unknown } | null)?.callId;
      if (typeof id === 'string') record.callId = id.slice(0, 100);
    }
    sink(record);
  } catch {
    /* logging must never throw */
  }
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
    const cleanMessage =
      typeof message === 'string' ? redactDiagnosticText(sanitizeValue('', message) as string) : message;
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
      toSink('debug', this.module, message, meta);
    }
  }

  info(message: string, meta?: unknown): void {
    if (this.shouldLog('info')) {
      const line = this.formatMessage('info', message, meta);
      keepRecent('info', this.module, line);
      console.log(line);
      toSink('info', this.module, message, meta);
    }
  }

  warn(message: string, meta?: unknown): void {
    if (this.shouldLog('warn')) {
      const line = this.formatMessage('warn', message, meta);
      keepRecent('warn', this.module, line);
      console.warn(line);
      toSink('warn', this.module, message, meta);
    }
  }

  error(message: string, meta?: unknown): void {
    if (this.shouldLog('error')) {
      const line = this.formatMessage('error', message, meta);
      keepRecent('error', this.module, line);
      console.error(line);
      toSink('error', this.module, message, meta);
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
