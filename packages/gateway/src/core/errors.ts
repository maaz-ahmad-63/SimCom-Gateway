/**
 * Gateway domain error classes.
 */

export class GatewayBusyError extends Error {
  constructor(message = 'Gateway is currently busy handling another call') {
    super(message);
    this.name = 'GatewayBusyError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(fromState: string, toState: string, reason?: string) {
    const detail = reason ? ` (${reason})` : '';
    super(`Cannot transition call state from ${fromState} to ${toState}${detail}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class ModemCommandError extends Error {
  constructor(public readonly command: string, message: string) {
    super(`Modem command "${command}" failed: ${message}`);
    this.name = 'ModemCommandError';
  }
}

export class CallNotFoundError extends Error {
  constructor(callId: string) {
    super(`Call session with ID ${callId} was not found`);
    this.name = 'CallNotFoundError';
  }
}
