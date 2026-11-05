import { EventEmitter } from 'node:events';
import {
  AtCommandError,
  AtCommandTimeoutError,
  AtCommunicationStatus,
  SerialPortDisconnectedError,
  UrcEvent,
} from '@sim-gateway/shared';
import { describeClose, ISerialTransport, SerialCloseInfo } from './serial-transport.js';
import { AtParser, isDtmfUrc } from './at-parser.js';
import { createLogger, Logger, redactDiagnosticText } from '../../core/logger.js';

/** Most distinct line shapes the unrecognized-line diagnostic remembers (and so can announce). */
const MAX_UNRECOGNIZED_SHAPES = 64;
/** After its first announcement a shape is announced again every this many occurrences. */
const UNRECOGNIZED_REPEAT_EVERY = 50;

export interface UnrecognizedLineStat {
  /** The line with digits and quoted text masked: what it looks like, never what it said. */
  shape: string;
  count: number;
  /** 'idle': nothing was in flight and the line was dropped. 'during-command': it was dropped as a mismatched response prefix. */
  where: 'idle' | 'during-command';
}

interface QueuedCommand {
  command: string;
  timeoutMs: number;
  /**
   * AT+CMGS style command: the modem answers the command line with a '>' prompt (no newline), the body is then sent
   * followed by Ctrl+Z, and only then does the final result (+CMGS: n / OK, or +CMS ERROR) arrive.
   */
  prompt?: { body: string; promptTimeoutMs: number };
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

export interface AtCommandQueueOptions {
  defaultTimeoutMs?: number;
}

/**
 * A prompted command (AT+CMGS) timed out. `phase` says where: 'prompt' means the '>' never came (nothing was sent, and
 * Escape was written so the modem leaves text entry); 'completion' means the body and Ctrl+Z WERE sent and no final
 * result arrived, so the outcome is unknown (the message may have gone out) and the command must not be retried blindly.
 */
export class AtPromptTimeoutError extends AtCommandTimeoutError {
  readonly phase: 'prompt' | 'completion';

  constructor(command: string, timeoutMs: number, phase: 'prompt' | 'completion') {
    super(command, timeoutMs);
    this.name = 'AtPromptTimeoutError';
    this.phase = phase;
  }
}

const CTRL_Z = '\x1a';
const ESCAPE = '\x1b';

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
  private transportFailureHandled = false;
  /** A prompted command has been written and the '>' has not arrived yet. */
  private awaitingPrompt = false;
  /** The body and Ctrl+Z of the prompted command have been written. */
  private promptBodySent = false;
  /**
   * While AT+CMGL / AT+CMGR output is being read: 'header' = a +CMGL:/+CMGR: line was just seen, so the next line is the
   * message body whatever it says; 'body' = inside a body (more lines belong to it until the final result).
   */
  private smsReadState: 'idle' | 'header' | 'body' = 'idle';
  /** Diagnostics only: lines the queue dropped as unrecognized, by shape. Bounded; never read by any decision. */
  private readonly unrecognized = new Map<string, UnrecognizedLineStat>();
  private unrecognizedOverflowAnnounced = false;

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

    this.transport.on('close', (info?: SerialCloseInfo) => {
      this.handleTransportFailure(
        new SerialPortDisconnectedError(
          this.transport.path,
          `Serial transport '${this.transport.path}' ${describeClose(info)}`
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

  markTransportReady(): void {
    this.transportFailureHandled = false;
  }

  markTransportClosing(): void {
    this.transportFailureHandled = true;
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
   * Execute a command that is answered with a '>' prompt (AT+CMGS). It takes the same single slot as every other
   * command, so nothing else is written to the port between the command, its body and its result.
   *
   * 1. `command` is written terminated by CR alone (a trailing LF would arrive after the prompt and become the first
   *    character of the message).
   * 2. When the '>' prompt arrives, `body` is written followed by Ctrl+Z.
   * 3. The command ends with the modem's final result: OK (resolves) or ERROR / +CMS ERROR / +CME ERROR (rejects).
   *
   * If no prompt arrives within `promptTimeoutMs`, Escape is written so the modem leaves text entry (otherwise it would
   * swallow the next AT command as message text) and an AtPromptTimeoutError with phase 'prompt' is thrown. If the
   * final result does not arrive within `timeoutMs` of the body being sent, the error has phase 'completion': the
   * message may or may not have been sent.
   */
  async executeWithPrompt(command: string, body: string, options: { promptTimeoutMs?: number; timeoutMs?: number } = {}): Promise<string> {
    if (!this.transport.isOpen()) {
      this.lastAtStatus = 'DISCONNECTED';
      throw new SerialPortDisconnectedError(
        this.transport.path,
        `Cannot execute '${command}': Serial port '${this.transport.path}' is not open`
      );
    }
    if (body.includes(CTRL_Z) || body.includes(ESCAPE)) {
      throw new Error('The message body must not contain Ctrl+Z or Escape');
    }
    return new Promise<string>((resolve, reject) => {
      this.queue.push({
        command: command.trim(),
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        prompt: { body, promptTimeoutMs: options.promptTimeoutMs ?? 5000 },
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
    // A command that timed out and is now being asked again: its leftover marker must not swallow this
    // attempt's genuine answer (otherwise one unanswered query makes every later identical query fail too,
    // each timeout leaving a new marker). A late answer to the old attempt is the same query's answer.
    this.staleCommandsToClean = this.staleCommandsToClean.filter((stale) => stale.command !== item.command);
    this.activeCommand = item;
    this.responseBuffer = [];
    this.awaitingPrompt = Boolean(item.prompt);
    this.promptBodySent = false;
    this.smsReadState = 'idle';

    this.logger.debug(`Dispatching AT command: ${item.command} (timeout: ${item.prompt ? item.prompt.promptTimeoutMs : item.timeoutMs}ms${item.prompt ? ' to the prompt' : ''})`);

    // Set command timeout (a prompted command first waits only for its prompt)
    this.timeoutTimer = setTimeout(() => {
      this.handleTimeout();
    }, item.prompt ? item.prompt.promptTimeoutMs : item.timeoutMs);

    try {
      // Send command terminated by \r\n (a prompted command by \r alone, see executeWithPrompt)
      const payload = item.prompt ? `${item.command}\r` : item.command.endsWith('\r') ? item.command : `${item.command}\r\n`;
      await this.transport.write(payload);
    } catch (writeErr) {
      this.clearActiveTimer();
      this.activeCommand = null;
      this.awaitingPrompt = false;
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

    // The '>' prompt of a prompted command ends with a space, not a newline, so it is still in the accumulator.
    if (this.awaitingPrompt && /^\s*>\s?$/.test(this.lineAccumulator)) {
      this.lineAccumulator = '';
      this.onPrompt();
    }
  }

  /** The modem asked for the message body: send it, then Ctrl+Z, and wait for the final result. */
  private onPrompt(): void {
    const active = this.activeCommand;
    if (!active?.prompt || !this.awaitingPrompt) return;
    this.awaitingPrompt = false;
    this.promptBodySent = true;
    this.clearActiveTimer();
    this.timeoutTimer = setTimeout(() => this.handleTimeout(), active.timeoutMs);
    this.logger.debug(`Prompt received for '${active.command}': sending ${active.prompt.body.length} characters and Ctrl+Z`);
    this.transport.write(`${active.prompt.body}${CTRL_Z}`).catch((error: Error) => {
      if (this.activeCommand !== active) return;
      this.lastAtStatus = 'ERROR';
      this.clearActiveTimer();
      this.activeCommand = null;
      this.awaitingPrompt = false;
      this.promptBodySent = false;
      active.reject(error);
      setImmediate(() => this.processNext());
    });
  }

  /**
   * AT+CMGL / AT+CMGR output in text mode: a header line, then the message body on the following line(s). A body is
   * arbitrary text, so a body line of "RING", "BUSY", "NO CARRIER" or "OK" must not be taken for a call event or the end
   * of the command. The line right after a header is always body; later lines are body until a final result.
   * Returns true when the line was consumed here.
   */
  private processSmsReadLine(line: string): boolean {
    // A new-message indication that arrives in the middle of a listing is a modem event, not message text: only a line
    // that is exactly `+CMTI: "XX",n` is treated so, and it must not be lost (it triggers the next read).
    // The same goes for a key the caller pressed (`+RXDTMF: 5`, exactly): it is an event, never message text.
    if (AtParser.parseCmti(line) || AtParser.parseDtmf(line) !== null) return false;
    if (line.startsWith('+CMGL:') || line.startsWith('+CMGR:')) {
      this.responseBuffer.push(line);
      this.smsReadState = 'header';
      return true;
    }
    if (this.smsReadState === 'header') {
      this.responseBuffer.push(line);
      this.smsReadState = 'body';
      return true;
    }
    if (this.smsReadState === 'body') {
      if (AtParser.isTerminalResponse(line, this.activeCommand?.command).isTerminal) return false;
      this.responseBuffer.push(line);
      return true;
    }
    return false;
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
    if (trimmed.startsWith('AT+CEER')) return '+CEER:';
    // A late "+CMGS: n" from a send that timed out must not become the answer to a later command.
    if (trimmed.startsWith('AT+CMGS')) return '+CMGS:';
    return null;
  }

  /**
   * Route an incoming raw line: echo filter -> URC check -> command terminal check -> buffer line.
   */
  private processLine(line: string): void {
    if (!line) {
      // Ignore blank lines, except right after an SMS header, where one is an empty message body.
      if (this.smsReadState === 'header' && this.activeCommand) {
        this.responseBuffer.push('');
        this.smsReadState = 'body';
      }
      return;
    }

    // 0. Reading stored SMS: message text is private and arbitrary, so it is neither logged nor interpreted.
    if (this.activeCommand && /^AT\+CMG[LR]\b/i.test(this.activeCommand.command) && line !== this.activeCommand.command) {
      if (this.processSmsReadLine(line)) {
        this.logger.debug(`Modem SMS line (${line.length} chars)`);
        return;
      }
    }

    this.logger.debug(`Modem response line: ${redactDiagnosticText(line)}`);

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

    if (isDialOrAnswerInFlight && line === 'CONNECT') {
      this.finishActiveCommand(true);
      const connected = AtParser.parseUrc(line);
      if (connected) {
        this.logger.info(`Call connected: ${line}`);
        this.emit('urc', connected);
      }
      return;
    }

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
        // A pressed key is never written to a log; every other URC is logged exactly as before.
        this.logger.info(`URC received [${urc.type}]: ${isDtmfUrc(urc) ? urc.raw : line}`);
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
          this.noteUnrecognized(line, 'during-command');
          return;
        }
      }

      // 6. Intermediate response line (e.g. "+CSQ: 24,99")
      this.responseBuffer.push(line);
    } else {
      // Line received with no command in-flight and not caught as URC
      const urc = AtParser.parseUrc(line);
      if (urc) {
        this.logger.info(`URC received (unsolicited) [${urc.type}]: ${isDtmfUrc(urc) ? urc.raw : line}`);
        this.emit('urc', urc);
      } else {
        this.noteUnrecognized(line, 'idle');
      }
    }
  }

  /** What the queue has dropped as unrecognized, by shape and count. Read-only; sends nothing to the modem. */
  getUnrecognizedLineStats(): UnrecognizedLineStat[] {
    return [...this.unrecognized.values()].map((s) => ({ ...s }));
  }

  /**
   * Diagnostics only. A line the queue cannot place used to vanish without a trace, which is how an unexpected modem event (for
   * example a key pressed by the caller in a format nobody had seen) could be lost with nothing to show for it. Each distinct
   * SHAPE is announced once at info level, then every 50th time; the rest are counted. A shape is the line with its digits and
   * quoted text masked and its length capped, so a phone number, a pressed key or a message fragment is never written out, and at
   * most 64 shapes are kept.
   */
  private noteUnrecognized(line: string, where: UnrecognizedLineStat['where']): void {
    const shape = redactDiagnosticText(line)
      .replace(/"[^"]*"/g, '"…"')
      .replace(/\d+/g, '#')
      .trim()
      .slice(0, 80);
    if (!shape) return;
    const key = `${where}|${shape}`;
    const known = this.unrecognized.get(key);
    if (known) {
      known.count++;
      if (known.count % UNRECOGNIZED_REPEAT_EVERY === 0) {
        this.logger.info(`Unrecognized modem line (${where}) seen ${known.count} times: "${shape}"`);
      }
      return;
    }
    if (this.unrecognized.size >= MAX_UNRECOGNIZED_SHAPES) {
      if (!this.unrecognizedOverflowAnnounced) {
        this.unrecognizedOverflowAnnounced = true;
        this.logger.info(`Unrecognized modem lines: more than ${MAX_UNRECOGNIZED_SHAPES} different shapes seen; further new shapes are not recorded`);
      }
      return;
    }
    this.unrecognized.set(key, { shape, count: 1, where });
    this.logger.info(`Unrecognized modem line (${where}, ${line.length} chars): "${shape}"`);
  }

  /**
   * Finishes the active command, resolving or rejecting its promise.
   */
  private finishActiveCommand(isSuccess: boolean, errorMessage?: string): void {
    if (!this.activeCommand) return;

    this.clearActiveTimer();
    const current = this.activeCommand;
    this.activeCommand = null;
    this.awaitingPrompt = false;
    this.promptBodySent = false;
    this.smsReadState = 'idle';

    const fullResponse = this.responseBuffer.join('\n');

    if (isSuccess) {
      this.lastAtStatus = 'OK';
      this.lastCommunicationTime = new Date().toISOString();
      // Stored messages are private: their text is never written to the log.
      const shown = /^AT\+CMG[LR]\b/i.test(current.command) ? `${this.responseBuffer.length} line(s)` : fullResponse || 'OK';
      this.logger.debug(`AT command '${current.command}' completed successfully -> ${shown}`);
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
    const waitedForPrompt = this.awaitingPrompt;
    const bodySent = this.promptBodySent;
    this.awaitingPrompt = false;
    this.promptBodySent = false;
    this.smsReadState = 'idle';

    this.lastAtStatus = 'TIMEOUT';
    const timedOutAfter = current.prompt && waitedForPrompt ? current.prompt.promptTimeoutMs : current.timeoutMs;
    this.logger.warn(`AT command '${current.command}' timed out after ${timedOutAfter}ms${current.prompt ? (waitedForPrompt ? ' waiting for the prompt' : ' waiting for the result after the body was sent') : ''}`);

    if (current.prompt && waitedForPrompt) {
      // The modem never asked for the body. Escape makes it leave text entry in case the prompt is merely late;
      // otherwise the next AT command would be swallowed as message text.
      this.transport.write(ESCAPE).catch(() => {});
    }

    // Record stale command to discard delayed responses that arrive late
    const prefix = this.getExpectedResponsePrefix(current.command);
    this.staleCommandsToClean.push({
      command: current.command,
      prefix,
      awaitTerminal: true,
    });

    if (current.prompt) {
      current.reject(new AtPromptTimeoutError(current.command, timedOutAfter, bodySent ? 'completion' : 'prompt'));
    } else {
      current.reject(new AtCommandTimeoutError(current.command, current.timeoutMs));
    }

    // Allow next command to proceed
    setImmediate(() => this.processNext());
  }

  /**
   * Handles serial transport disconnects or fatal hardware errors.
   */
  private handleTransportFailure(error: Error): void {
    if (this.transportFailureHandled) return;

    this.transportFailureHandled = true;
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
    this.awaitingPrompt = false;
    this.promptBodySent = false;
    this.smsReadState = 'idle';
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
    this.transportFailureHandled = false;
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
    this.awaitingPrompt = false;
    this.promptBodySent = false;
    this.smsReadState = 'idle';
  }
}
