import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { SerialPortDisconnectedError } from '@sim-gateway/shared';

export interface SerialTransportOptions {
  path: string;
  baudRate: number;
  lock?: boolean;
  autoOpen?: boolean;
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
  on(event: 'close', listener: () => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Real Node.js SerialPort transport targeting Windows COM ports (e.g. COM14).
 * Configured with exclusive port locking on Windows.
 */
export class NodeSerialTransport extends EventEmitter implements ISerialTransport {
  readonly path: string;
  readonly baudRate: number;
  private readonly lock: boolean;
  private port: SerialPort | null = null;

  constructor(options: SerialTransportOptions) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    this.lock = options.lock ?? true;
  }

  isOpen(): boolean {
    return this.port !== null && this.port.isOpen;
  }

  async open(overrides?: Partial<SerialTransportOptions>): Promise<void> {
    if (this.isOpen()) {
      return;
    }

    const targetPath = overrides?.path ?? this.path;
    const targetBaud = overrides?.baudRate ?? this.baudRate;

    return new Promise((resolve, reject) => {
      try {
        this.port = new SerialPort(
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
              this.port = null;
              reject(err);
            }
          }
        );

        this.port.on('data', (chunk: Buffer) => {
          this.emit('data', chunk);
        });

        this.port.on('error', (err: Error) => {
          this.emit('error', err);
        });

        this.port.on('close', () => {
          this.emit('close');
        });

        this.port.open((openErr) => {
          if (openErr) {
            this.port = null;
            reject(
              new SerialPortDisconnectedError(
                targetPath,
                `Failed to open serial port '${targetPath}': ${openErr.message}`
              )
            );
          } else {
            resolve();
          }
        });
      } catch (constructionErr) {
        this.port = null;
        reject(constructionErr);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      this.port = null;
      return;
    }

    return new Promise((resolve) => {
      const port = this.port;
      this.port = null;
      if (port) {
        port.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async write(data: string | Buffer): Promise<void> {
    if (!this.isOpen() || !this.port) {
      throw new SerialPortDisconnectedError(
        this.path,
        `Cannot write to serial port '${this.path}': port is not open`
      );
    }

    return new Promise((resolve, reject) => {
      this.port!.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          this.port!.drain((drainErr) => {
            if (drainErr) {
              reject(drainErr);
            } else {
              resolve();
            }
          });
        }
      });
    });
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
      this.emit('close');
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
    this.emit('close');
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
