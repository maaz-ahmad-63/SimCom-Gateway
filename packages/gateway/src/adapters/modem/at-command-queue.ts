import { EventEmitter } from 'node:events';
import {
  AtCommandError,
  AtCommandTimeoutError,
  AtCommunicationStatus,
  SerialPortDisconnectedError,
  UrcEvent,
} from '@sim-gateway/shared';
import { ISerialTransport } from './serial-transport.js';
import { AtParser } from './at-parser.js';
import { createLogger, Logger } from '../../core/logger.js';

interface QueuedCommand {
  command: string;
  timeoutMs: number;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

export interface AtCommandQueueOptions {
  defaultTimeoutMs?: number;
}

export class AtCommandQueue extends EventEmitter {
  private readonly transport: ISerialTransport;
  private readonly defaultTimeoutMs: number;
  private readonly logger: Logger;
  private queue: QueuedCommand[] = [];
  private activeCommand: QueuedCommand | null = null;
  private responseBuffer: string[] = [];
  private lineAccumulator = '';
  private timeoutTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private lastCommunicationTime: string | null = null;
  private lastAtStatus: AtCommunicationStatus = 'UNKNOWN';

  constructor(transport: ISerialTransport, options: AtCommandQueueOptions = {}) {
    super();
    this.transport = transport;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.logger = createLogger(`ATQueue:${transport.path}`);

    this.transport.on('data', (chunk: Buffer) => {
      this.handleIncomingChunk(chunk);
    });

    this.transport.on('error', (err: Error) => {
      this.handleTransportFailure(
        new SerialPortDisconnectedError(this.transport.path, err.message)
      );
    });

    this.transport.on('close', () => {
      this.handleTransportFailure(
        new SerialPortDisconnectedError(
          this.transport.path,
          `Serial transport '${this.transport.path}' closed`
        )
      );
    });
  }

  getLastCommunicationTime(): string | null {
    return this.lastCommunicationTime;
  }

  getAtCommunicationStatus(): AtCommunicationStatus {
    return this.lastAtStatus;
  }

  /**
   * Execute an AT command. Queues the command if another command is currently in flight.
   */
  async execute(command: string, timeoutMs?: number): Promise<string> {
    if (!this.transport.isOpen()) {
      this.lastAtStatus = 'DISCONNECTED';
      throw new SerialPortDisconnectedError(
        this.transport.path,
        `Cannot execute '${command}': Serial port '${this.transport.path}' is not open`
      );
    }

    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<string>((resolve, reject) => {
      this.queue.push({
        command: command.trim(),
        timeoutMs: timeout,
        resolve,
        reject,
      });

      this.processNext();
    });
  }

  /**
   * Process the next command in the queue if none is active.
   */
  private async processNext(): Promise<void> {
    if (this.isProcessing || this.activeCommand !== null || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift()!;
    this.activeCommand = item;
    this.responseBuffer = [];

    this.logger.debug(`Dispatching AT command: ${item.command} (timeout: ${item.timeoutMs}ms)`);

    // Set command timeout
    this.timeoutTimer = setTimeout(() => {
      this.handleTimeout();
    }, item.timeoutMs);

    try {
      // Send command terminated by \r\n
      const payload = item.command.endsWith('\r') ? item.command : `${item.command}\r\n`;
      await this.transport.write(payload);
    } catch (writeErr) {
      this.clearActiveTimer();
      this.activeCommand = null;
      this.isProcessing = false;
      this.lastAtStatus = 'ERROR';
      this.logger.error(`Failed to write command '${item.command}': ${(writeErr as Error).message}`);
      item.reject(writeErr as Error);
      this.processNext();
      return;
    }

    this.isProcessing = false;
  }

  /**
   * Chunks incoming data and buffers lines on \n or \r boundaries.
   */
  private handleIncomingChunk(chunk: Buffer): void {
    this.lastCommunicationTime = new Date().toISOString();
    this.lineAccumulator += chunk.toString('utf-8');

    let newlineIndex: number;
    while ((newlineIndex = this.lineAccumulator.indexOf('\n')) !== -1) {
      const line = this.lineAccumulator.substring(0, newlineIndex);
      this.lineAccumulator = this.lineAccumulator.substring(newlineIndex + 1);
      this.processLine(line.trim());
    }
  }

  private staleCommandsToClean: Array<{ command: string; prefix: string | null; awaitTerminal: boolean }> = [];

  private getExpectedResponsePrefix(command: string): string | null {
    const trimmed = command.trim();
    if (trimmed.startsWith('AT+CSQ')) return '+CSQ:';
    if (trimmed.startsWith('AT+CPIN')) return '+CPIN:';
    if (trimmed.startsWith('AT+CEREG')) return '+CEREG:';
    if (trimmed.startsWith('AT+CREG')) return '+CREG:';
    if (trimmed.startsWith('AT+CGREG')) return '+CGREG:';
    if (trimmed.startsWith('AT+COPS')) return '+COPS:';
    if (trimmed.startsWith('AT+CLCC')) return '+CLCC:';
    if (trimmed.startsWith('AT+CCLK')) return '+CCLK:';
    return null;
  }

  /**
   * Route an incoming raw line: echo filter -> URC check -> command terminal check -> buffer line.
   */
  private processLine(line: string): void {
    if (!line) return; // Ignore blank lines

    // 1. Echo filter: if modem echoes the sent command back, ignore it
    if (this.activeCommand && line === this.activeCommand.command) {
      return;
    }

    // 2. Stale Timed-Out Command Filtering
    // If this line belongs to a command that previously timed out, discard it to prevent corrupting active/subsequent commands.
    if (this.staleCommandsToClean.length > 0) {
      const staleMatchIndex = this.staleCommandsToClean.findIndex(
        (sc) => sc.prefix && line.startsWith(sc.prefix)
      );

      if (staleMatchIndex !== -1) {
        // Discard data line belonging to timed-out command
        return;
      }

      // Check if terminal response (OK / ERROR) closes out a pending stale command
      const termCheck = AtParser.isTerminalResponse(line);
      if (termCheck.isTerminal) {
        const activeNeedsTerminal = this.activeCommand !== null;
        const activePrefix = this.activeCommand ? this.getExpectedResponsePrefix(this.activeCommand.command) : null;
        const activeHasReceivedData = this.responseBuffer.length > 0;

        // If active command expects data first (like +CSQ or +CPIN) and hasn't received any, this OK belongs to the stale command
        if (activePrefix && !activeHasReceivedData) {
          this.staleCommandsToClean.shift();
          return;
        }

        // If no active command, consume stale terminal
        if (!activeNeedsTerminal) {
          this.staleCommandsToClean.shift();
          return;
        }
      }
    }

    // 3. URC Check
    // If line matches a URC, dispatch it immediately.
    // Note: If active command is ATD or ATA and returns BUSY or NO CARRIER, that is the command's terminal status!
    const isDialOrAnswerInFlight =
      this.activeCommand &&
      (this.activeCommand.command.startsWith('ATD') || this.activeCommand.command === 'ATA');

    const isCallProgressTerminal =
      isDialOrAnswerInFlight && (line === 'BUSY' || line === 'NO CARRIER' || line === 'NO ANSWER');

    // Distinguish command responses from unsolicited URCs
    const isExpectedCommandResponse =
      this.activeCommand &&
      ((this.activeCommand.command.includes('CEREG') && line.startsWith('+CEREG:')) ||
        (this.activeCommand.command.includes('CREG') && line.startsWith('+CREG:')) ||
        (this.activeCommand.command.includes('CSQ') && line.startsWith('+CSQ:')) ||
        (this.activeCommand.command.includes('CPIN') && line.startsWith('+CPIN:')) ||
        (this.activeCommand.command.includes('COPS') && line.startsWith('+COPS:')));

    if (!isCallProgressTerminal && !isExpectedCommandResponse && AtParser.isUrc(line)) {
      const urc = AtParser.parseUrc(line);
      if (urc) {
        this.logger.info(`URC received [${urc.type}]: ${line}`);
        this.emit('urc', urc);
        return;
      }
    }

    // 4. Command Terminal Check (command-aware)
    if (this.activeCommand) {
      const term = AtParser.isTerminalResponse(line, this.activeCommand.command);
      if (term.isTerminal) {
        this.finishActiveCommand(term.isSuccess, term.errorMessage);
        return;
      }

      // 5. Response-to-command prefix sanity check
      // If the line has an AT response prefix from a different command (e.g. +CSQ: while executing AT+COPS?), reject as orphan
      const linePrefixMatch = line.match(/^(\+[A-Z]+:)/);
      if (linePrefixMatch) {
        const foundPrefix = linePrefixMatch[1];
        const expectedPrefix = this.getExpectedResponsePrefix(this.activeCommand.command);
        if (expectedPrefix && foundPrefix !== expectedPrefix) {
          this.logger.debug(`Discarding mismatched AT prefix '${foundPrefix}' while executing '${this.activeCommand.command}'`);
          return;
        }
      }

      // 6. Intermediate response line (e.g. "+CSQ: 24,99")
      this.responseBuffer.push(line);
    } else {
      // Line received with no command in-flight and not caught as URC
      const urc = AtParser.parseUrc(line);
      if (urc) {
        this.logger.info(`URC received (unsolicited) [${urc.type}]: ${line}`);
        this.emit('urc', urc);
      }
    }
  }

  /**
   * Finishes the active command, resolving or rejecting its promise.
   */
  private finishActiveCommand(isSuccess: boolean, errorMessage?: string): void {
    if (!this.activeCommand) return;

    this.clearActiveTimer();
    const current = this.activeCommand;
    this.activeCommand = null;

    const fullResponse = this.responseBuffer.join('\n');

    if (isSuccess) {
      this.lastAtStatus = 'OK';
      this.lastCommunicationTime = new Date().toISOString();
      this.logger.debug(`AT command '${current.command}' completed successfully -> ${fullResponse || 'OK'}`);
      current.resolve(fullResponse ? `${fullResponse}\nOK` : 'OK');
    } else {
      this.lastAtStatus = 'ERROR';
      this.logger.warn(`AT command '${current.command}' failed: ${errorMessage ?? fullResponse ?? 'ERROR'}`);
      current.reject(
        new AtCommandError(
          current.command,
          fullResponse,
          errorMessage ?? `Command ${current.command} failed`
        )
      );
    }

    // Process next queued command
    setImmediate(() => this.processNext());
  }

  /**
   * Handles timeout of the currently active command.
   */
  private handleTimeout(): void {
    if (!this.activeCommand) return;

    this.clearActiveTimer();
    const current = this.activeCommand;
    this.activeCommand = null;

    this.lastAtStatus = 'TIMEOUT';
    this.logger.warn(`AT command '${current.command}' timed out after ${current.timeoutMs}ms`);

    // Record stale command to discard delayed responses that arrive late
    const prefix = this.getExpectedResponsePrefix(current.command);
    this.staleCommandsToClean.push({
      command: current.command,
      prefix,
      awaitTerminal: true,
    });

    current.reject(new AtCommandTimeoutError(current.command, current.timeoutMs));

    // Allow next command to proceed
    setImmediate(() => this.processNext());
  }

  /**
   * Handles serial transport disconnects or fatal hardware errors.
   */
  private handleTransportFailure(error: Error): void {
    this.clearActiveTimer();
    this.lastAtStatus = 'DISCONNECTED';
    this.logger.error(`Serial transport failure: ${error.message}`);

    // Reject active command
    if (this.activeCommand) {
      this.activeCommand.reject(error);
      this.activeCommand = null;
    }

    // Reject all queued commands
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(error);
    }

    this.responseBuffer = [];
    this.lineAccumulator = '';
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  private clearActiveTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * Clear state and pending commands (for manual reset or disconnect cleanup).
   */
  reset(): void {
    this.clearActiveTimer();
    const err = new SerialPortDisconnectedError(this.transport.path, 'Command queue manually reset');
    if (this.activeCommand) {
      this.activeCommand.reject(err);
      this.activeCommand = null;
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(err);
    }
    this.responseBuffer = [];
    this.lineAccumulator = '';
  }
}
