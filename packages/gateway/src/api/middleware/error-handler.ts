import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { GatewayBusyError, InvalidStateTransitionError, ModemCommandError, CallNotFoundError } from '../../core/errors.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const errorObj = err as any;

  if (err instanceof ZodError || errorObj?.name === 'ZodError') {
    res.status(400).json({
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errorObj.errors?.map((e: any) => ({
        path: Array.isArray(e.path) ? e.path.join('.') : e.path,
        message: e.message,
      })),
    });
    return;
  }

  if (err instanceof GatewayBusyError || errorObj?.name === 'GatewayBusyError') {
    res.status(409).json({
      success: false,
      error: errorObj.message,
      code: 'GATEWAY_BUSY',
    });
    return;
  }

  if (err instanceof InvalidStateTransitionError || errorObj?.name === 'InvalidStateTransitionError') {
    res.status(400).json({
      success: false,
      error: errorObj.message,
      code: 'INVALID_STATE_TRANSITION',
    });
    return;
  }

  if (err instanceof CallNotFoundError || errorObj?.name === 'CallNotFoundError') {
    res.status(404).json({
      success: false,
      error: errorObj.message,
      code: 'NOT_FOUND',
    });
    return;
  }

  if (err instanceof ModemCommandError || errorObj?.name === 'ModemCommandError') {
    res.status(502).json({
      success: false,
      error: errorObj.message,
      code: 'MODEM_ERROR',
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'An unexpected error occurred';
  res.status(500).json({
    success: false,
    error: message,
    code: 'INTERNAL_SERVER_ERROR',
  });
}
