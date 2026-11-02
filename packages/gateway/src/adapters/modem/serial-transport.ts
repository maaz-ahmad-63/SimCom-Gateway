import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { SerialPortDisconnectedError } from '@sim-gateway/shared';
import { createLogger, Logger } from '../../core/logger.js';

export interface SerialTransportOptions {
  path: string;
  baudRate: number;
  lock?: boolean;
  autoOpen?: boolean;
  /**
   * Wait for the device to drain each write before it resolves (default true, and what every port uses today). The wait is
   * also the audio port's backpressure: it bounds how much stale audio can be queued behind a barge-in. Turning it off for
   * audio would remove that bound, so it is only a switch for a hardware experiment, never on by default.
   */
  drainAfterWrite?: boolean;
}

/** The two port operations a write uses (a test seam; the real one is serialport's SerialPort). */
export interface WritablePort {
  write(data: string | Buffer, callback: (err: Error | null | undefined) => void): unknown;
  drain(callback: (err: Error | null | undefined) => void): unknown;
}

/** One write: resolved once the OS accepted the data, and, when asked, once the device has drained it. */
export function writeToPort(port: WritablePort, data: string | Buffer, drain: boolean, fail: (err: Error, what: string) => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(data, (err) => {
      if (err) return reject(fail(err, 'write'));
      if (!drain) return resolve();
      port.drain((drainErr) => (drainErr ? reject(fail(drainErr, 'drain')) : resolve()));
    });
  });
}

/**
 * Why a port closed. serialport reports a device removal as a `close` carrying a Disconnect error
 * (`err.disconnected === true`) and a host-initiated close as a plain `close`; without this the two
 * look identical, so "who closed COM22?" could not be answered from the logs.
 */
export interface SerialCloseInfo {
  /** The device vanished (USB removal, driver failure) rather than the host closing the port. */
  disconnected: boolean;
  /** This process asked for the close (close() was called). */
  requestedByHost: boolean;
  detail?: string;
}

export function describeClose(info?: SerialCloseInfo): string {
  if (!info) return 'closed';
  if (info.disconnected) return `closed: device disconnected${info.detail ? ` (${info.detail})` : ''}`;
  return info.requestedByHost ? 'closed by the gateway' : 'closed without a disconnect error';
}

export interface ISerialTransport extends EventEmitter {
  readonly path: string;
  readonly baudRate: number;
  open(options?: Partial<SerialTransportOptions>): Promise<void>;
  close(): Promise<void>;
  write(data: string | Buffer): Promise<void>;
  isOpen(): boolean;

  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: (info?: SerialCloseInfo) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Errors that mean the device behind the handle is gone or has stopped responding, so the handle cannot be
 * used again. Windows reports a USB serial port that re-enumerates or hangs as "Unknown error code 31"
 * (ERROR_GEN_FAILURE); 55 (ERROR_DEV_NOT_EXIST) and 1167 (ERROR_DEVICE_NOT_CONNECTED) are the same family.
 * The codes are general Windows knowledge, not something this repository documents.
 */
export function isFatalSerialError(error: Error): boolean {
  return /error code (31|55|1167)\b|ERROR_GEN_FAILURE|not functioning|device is not connected|handle is invalid|\bEIO\b|\bENXIO\b|\bENODEV\b/i.test(
    error.message
  );
}

/** How long a replaced or dead handle gets to release the port before the next open goes ahead anyway. */
const RELEASE_TIMEOUT_MS = 1500;

/**
 * Real Node.js SerialPort transport targeting Windows COM ports (e.g. COM20).
 * Configured with exclusive port locking on Windows.
 *
 * Lifecycle rules (each one exists because the failure it prevents was possible):
 * - open() and close() run one at a time, in order. A reopen can never start while the previous handle is
 *   still being released, which on Windows (exclusive lock) would fail with "Access denied".
 * - Every event is tied to the SerialPort instance that produced it. Events from a replaced instance are
 *   dropped, so a late `close` of an old handle cannot mark the new connection as failed.
 * - A handle that fails fatally (a port `error` event, or a write failing with a device-gone error such as
 *   Windows error 31) is dead even if serialport still says isOpen. isOpen() then reports false, the failure
 *   is announced once as a disconnect, and the next open() destroys the dead handle before creating a new one.
 */
export class NodeSerialTransport extends EventEmitter implements ISerialTransport {
  readonly path: string;
  readonly baudRate: number;
  private readonly lock: boolean;
  private readonly drainAfterWrite: boolean;
  private readonly logger: Logger;
  private port: SerialPort | null = null;
  private readonly hostClosing = new WeakSet<SerialPort>();
  private readonly dead = new WeakSet<SerialPort>();
  private closing = false;
  /** Open/close requests queue here so they never overlap. It never rejects. */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(options: SerialTransportOptions) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    this.lock = options.lock ?? true;
    this.drainAfterWrite = options.drainAfterWrite ?? true;
    this.logger = createLogger(`Serial:${this.path}`);
  }

  isOpen(): boolean {
    return this.port !== null && !this.closing && !this.dead.has(this.port) && this.port.isOpen;
  }

  open(overrides?: Partial<SerialTransportOptions>): Promise<void> {
    return this.exclusive(() => this.doOpen(overrides));
  }

  close(): Promise<void> {
    return this.exclusive(() => this.doClose());
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(work);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  /** Destroy a handle and wait (bounded) until it has really released the port. */
  private destroyAndWait(port: SerialPort): Promise<void> {
    this.hostClosing.add(port);
    if (!port.isOpen) {
      try {
        port.destroy();
      } catch {
        // nothing left to release
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        port.off('close', done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.logger.warn(`Serial port '${this.path}' did not release within ${RELEASE_TIMEOUT_MS} ms; continuing`);
        done();
      }, RELEASE_TIMEOUT_MS);
      port.once('close', done);
      try {
        port.destroy();
      } catch {
        done();
      }
    });
  }

  /** A previous handle (dead, half-closed or simply left over) is gone before a new one is created. */
  private async releaseCurrent(): Promise<void> {
    const stale = this.port;
    if (!stale) return;
    this.closing = true;
    try {
      await this.destroyAndWait(stale);
    } finally {
      this.port = null;
      this.closing = false;
    }
  }

  /**
   * The handle failed in a way it cannot come back from. Announce it once, as a disconnect, and let go of it.
   * The real `close` event that follows is swallowed: the failure has already been reported.
   */
  private markDead(port: SerialPort, reason: string): void {
    if (this.dead.has(port) || this.port !== port) return;
    this.dead.add(port);
    this.logger.error(`Serial port '${this.path}' handle is dead (${reason}); it will be released before any reopen`);
    this.emit('close', { disconnected: true, requestedByHost: false, detail: reason } satisfies SerialCloseInfo);
    try {
      port.destroy();
    } catch {
      // released by the next open() if this did not work
    }
  }

  private async doOpen(overrides?: Partial<SerialTransportOptions>): Promise<void> {
    if (this.isOpen()) {
      return;
    }
    await this.releaseCurrent();

    const targetPath = overrides?.path ?? this.path;
    const targetBaud = overrides?.baudRate ?? this.baudRate;

    this.logger.info(`Opening serial port '${targetPath}' at ${targetBaud} baud (lock: ${this.lock})`);

    return new Promise((resolve, reject) => {
      try {
        const opened = new SerialPort(
          {
            path: targetPath,
            baudRate: targetBaud,
            lock: this.lock,
            autoOpen: false,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            rtscts: false,
          },
          (err) => {
            if (err) {
              this.logger.error(`SerialPort construction error on '${targetPath}': ${err.message}`);
              if (this.port === opened) this.port = null;
              reject(err);
            }
          }
        );
        this.port = opened;
        const isCurrent = (): boolean => this.port === opened;

        opened.on('data', (chunk: Buffer) => {
          if (!isCurrent() || this.dead.has(opened)) return;
          this.emit('data', chunk);
        });

        opened.on('error', (err: Error) => {
          if (!isCurrent()) {
            this.logger.debug(`Ignoring error from a replaced handle of '${targetPath}': ${err.message}`);
            return;
          }
          this.logger.error(`Serial port '${targetPath}' error: ${err.message}`);
          this.emit('error', err);
          // Nothing reads or writes a port after one of these; treat the handle as gone.
          this.markDead(opened, err.message);
        });

        opened.on('close', (closeError?: Error & { disconnected?: boolean }) => {
          if (!isCurrent()) {
            this.logger.debug(`Ignoring close of a replaced handle of '${targetPath}'`);
            return;
          }
          if (this.dead.has(opened)) return; // already announced when it died
          const info: SerialCloseInfo = {
            disconnected: closeError?.disconnected === true,
            requestedByHost: this.hostClosing.has(opened),
            detail: closeError?.message,
          };
          this.logger.warn(`Serial port '${targetPath}' ${describeClose(info)}`);
          this.emit('close', info);
        });

        opened.open((openErr) => {
          if (openErr) {
            this.logger.error(`Failed to open serial port '${targetPath}': ${openErr.message}`);
            if (this.port === opened) this.port = null;
            reject(
              new SerialPortDisconnectedError(
                targetPath,
                `Failed to open serial port '${targetPath}': ${openErr.message}`
              )
            );
          } else {
            this.logger.info(`Serial port '${targetPath}' opened successfully`);
            resolve();
          }
        });
      } catch (constructionErr) {
        this.logger.error(`Serial port '${targetPath}' unexpected error: ${(constructionErr as Error).message}`);
        this.port = null;
        reject(constructionErr);
      }
    });
  }

  private async doClose(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    try {
      if (this.dead.has(port) || !port.isOpen) {
        await this.destroyAndWait(port);
      } else {
        this.hostClosing.add(port);
        await new Promise<void>((resolve) => {
          port.close(() => {
            this.logger.info(`Serial port '${this.path}' closed cleanly`);
            resolve();
          });
        });
      }
    } finally {
      this.port = null;
      this.closing = false;
    }
  }

  async write(data: string | Buffer): Promise<void> {
    const port = this.port;
    if (!port || !this.isOpen()) {
      throw new SerialPortDisconnectedError(
        this.path,
        `Cannot write to serial port '${this.path}': port is not open`
      );
    }

    this.logger.debug(`Writing to '${this.path}': ${typeof data === 'string' ? data.trim() : `${data.length} bytes`}`);

    const fail = (err: Error, what: string): Error => {
      this.logger.error(`Serial ${what} error on '${this.path}': ${err.message}`);
      if (isFatalSerialError(err)) this.markDead(port, err.message);
      return err;
    };

    return writeToPort(port, data, this.drainAfterWrite, fail);
  }
}

/**
 * In-memory FakeSerialTransport for comprehensive unit testing without COM hardware.
 * Simulates UART data flow, write interception, command latency, and disconnect errors.
 */
export class FakeSerialTransport extends EventEmitter implements ISerialTransport {
  readonly path: string;
  readonly baudRate: number;
  private _isOpen = false;
  private writtenChunks: string[] = [];
  private writeInterceptor?: (data: string) => void;

  constructor(path = 'COM14', baudRate = 115200) {
    super();
    this.path = path;
    this.baudRate = baudRate;
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  async open(): Promise<void> {
    this._isOpen = true;
  }

  async close(): Promise<void> {
    if (this._isOpen) {
      this._isOpen = false;
      this.emit('close', { disconnected: false, requestedByHost: true } satisfies SerialCloseInfo);
    }
  }

  async write(data: string | Buffer): Promise<void> {
    if (!this._isOpen) {
      throw new SerialPortDisconnectedError(
        this.path,
        `Cannot write to '${this.path}': port is closed`
      );
    }

    const str = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
    this.writtenChunks.push(str);

    if (this.writeInterceptor) {
      this.writeInterceptor(str);
    }
  }

  /** Test helper: simulate modem sending data to gateway */
  feedIncomingData(data: string | Buffer): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    this.emit('data', chunk);
  }

  /** Test helper: simulate sudden USB unplug / error */
  simulateDisconnect(error?: Error): void {
    this._isOpen = false;
    if (error) {
      this.emit('error', error);
    }
    this.emit('close', { disconnected: true, requestedByHost: false, detail: 'simulated' } satisfies SerialCloseInfo);
  }

  /**
   * Test helper: a driver error that does NOT close the port, so isOpen() stays true: the dead-handle case
   * (for example Windows error 31) that a reconnect must not mistake for a healthy connection.
   */
  simulateErrorWithoutClose(error: Error): void {
    this.emit('error', error);
  }

  /** Test helper: intercept commands written by the gateway */
  onWrite(callback: (data: string) => void): void {
    this.writeInterceptor = callback;
  }

  getWrittenHistory(): string[] {
    return [...this.writtenChunks];
  }

  clearWrittenHistory(): void {
    this.writtenChunks = [];
  }
}
