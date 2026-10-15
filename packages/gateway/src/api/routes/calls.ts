import { Router, Request, Response, NextFunction } from 'express';
import {
  dialRequestSchema,
  dtmfRequestSchema,
  ICallSessionManager,
} from '@sim-gateway/shared';
import { GatewayRepository } from '../../db/repository.js';
import { CallNotFoundError } from '../../core/errors.js';

export interface CallsRouteDependencies {
  callManager: ICallSessionManager;
  repository: GatewayRepository;
}

export function createCallsRouter(deps: CallsRouteDependencies): Router {
  const router = Router();

  // GET /api/calls - List paginated call history
  router.get('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const result = deps.repository.listCalls({ limit, offset });
      res.json({
        success: true,
        calls: result.calls,
        total: result.total,
        limit,
        offset,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/calls/:id - Get call details and event timeline
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = deps.repository.getCallById(req.params.id);
      if (!result) {
        throw new CallNotFoundError(req.params.id);
      }

      res.json({
        success: true,
        call: result.session,
        events: result.events,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/calls/dial - Initiate outbound call
  router.post('/dial', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedInput = dialRequestSchema.parse(req.body);
      const session = await deps.callManager.dial(validatedInput);

      res.status(201).json({
        success: true,
        call: session,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/calls/answer - Answer ringing inbound call
  router.post('/answer', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await deps.callManager.answer();
      res.json({
        success: true,
        call: session,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/calls/hangup - Terminate active or ringing call
  router.post('/hangup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reason = typeof req.body.reason === 'string' ? req.body.reason : 'User requested hangup';
      await deps.callManager.hangup(reason);

      res.json({
        success: true,
        message: 'Call terminated',
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/calls/dtmf - Send DTMF tone on active call
  router.post('/dtmf', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validatedInput = dtmfRequestSchema.parse(req.body);
      await deps.callManager.sendDtmf(validatedInput);

      res.json({
        success: true,
        digit: validatedInput.digit,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
