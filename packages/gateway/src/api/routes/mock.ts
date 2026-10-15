import { Router, Request, Response, NextFunction } from 'express';
import { triggerMockInboundSchema, IModemAdapter } from '@sim-gateway/shared';
import { MockModemAdapter } from '../../adapters/modem/mock-modem.js';

export interface MockRouteDependencies {
  modem: IModemAdapter;
}

export function createMockRouter(deps: MockRouteDependencies): Router {
  const router = Router();

  // POST /api/mock/trigger-inbound
  router.post('/trigger-inbound', (req: Request, res: Response, next: NextFunction) => {
    try {
      // Security guard: Ensure mock endpoints can never control or trigger a real hardware modem
      if (deps.modem.driverType !== 'mock') {
        res.status(403).json({
          success: false,
          error: 'Mock endpoints are disabled when running with physical hardware',
          code: 'MOCK_DISABLED',
        });
        return;
      }

      const input = triggerMockInboundSchema.parse(req.body);
      const mockModem = deps.modem as MockModemAdapter;

      mockModem.simulateInboundCall(input.phoneNumber, input.ringCount);

      res.json({
        success: true,
        message: 'Simulated inbound call triggered',
        phoneNumber: input.phoneNumber,
        ringCount: input.ringCount,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
