import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { dialRequestSchema } from '@sim-gateway/shared';
import { GatewayBusyError } from '../../core/errors.js';
import { ModemRegistry } from '../../modems/registry.js';
import { ModemUnit } from '../../modems/types.js';

export interface ModemsRouteDependencies {
  registry: ModemRegistry;
}

/** Optional on every action: when given, the action only runs if it is still this modem's current call. */
const callTarget = z.object({ callId: z.string().min(1).optional() }).default({});

const refreshTimeoutMs = 5000;

/**
 * Modem-scoped control. Every route names its modem in the path (/api/modems/:modemId/...); nothing here falls back to a
 * default or "active" modem. The legacy /api/gateway and /api/calls routes are unchanged and keep acting on the default modem.
 */
export function createModemsRouter(deps: ModemsRouteDependencies): Router {
  const router = Router();
  const { registry } = deps;

  const unitOf = (req: Request): ModemUnit => registry.get(req.params.modemId);

  /** The call the request targets. A callId from a stale card must never act on a newer call. */
  const targetCall = (unit: ModemUnit, callId: string | undefined) => {
    const call = unit.callManager.getCurrentCall();
    if (callId && call?.id !== callId) {
      throw new GatewayBusyError(`Call ${callId} is no longer the current call on ${unit.descriptor.modemId}`);
    }
    return call;
  };

  const guard =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
    };

  router.get('/', (_req, res) => {
    res.json({ success: true, defaultModemId: registry.defaultModemId, modems: registry.list().map((u) => registry.status(u.descriptor.modemId)) });
  });

  router.get('/:modemId', guard((req, res) => {
    const unit = unitOf(req);
    res.json({ success: true, modem: registry.status(unit.descriptor.modemId), descriptor: unit.descriptor });
  }));

  router.post('/:modemId/answer', guard(async (req, res) => {
    const unit = unitOf(req);
    const { callId } = callTarget.parse(req.body);
    targetCall(unit, callId);
    const call = await unit.callManager.answer();
    res.json({ success: true, modemId: unit.descriptor.modemId, callId: call.id, call });
  }));

  // Reject and hang-up are the same command on the modem (AT+CHUP / ATH); reject is only meaningful while ringing.
  router.post('/:modemId/reject', guard(async (req, res) => {
    const unit = unitOf(req);
    const { callId } = callTarget.parse(req.body);
    const call = targetCall(unit, callId);
    if (call?.state !== 'INBOUND_RINGING') throw new GatewayBusyError(`${unit.descriptor.modemId} has no incoming call to reject`);
    await unit.callManager.hangup('rejected via modem api');
    res.json({ success: true, modemId: unit.descriptor.modemId, callId: call.id });
  }));

  router.post('/:modemId/hangup', guard(async (req, res) => {
    const unit = unitOf(req);
    const { callId } = callTarget.parse(req.body);
    const call = targetCall(unit, callId);
    await unit.callManager.hangup('hangup via modem api');
    res.json({ success: true, modemId: unit.descriptor.modemId, callId: call?.id ?? null });
  }));

  router.post('/:modemId/dial', guard(async (req, res) => {
    const unit = unitOf(req);
    const call = await unit.callManager.dial(dialRequestSchema.parse(req.body));
    res.status(201).json({ success: true, modemId: unit.descriptor.modemId, callId: call.id, call });
  }));

  // Refresh asks this modem (and only this one) for its SIM, signal and network state: it does send AT commands to it.
  router.post('/:modemId/refresh', guard(async (req, res) => {
    const unit = unitOf(req);
    const { modem } = unit;
    const settle = async <T>(p: Promise<T> | undefined): Promise<T | null> => {
      if (!p) return null;
      try {
        return await Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), refreshTimeoutMs).unref())]);
      } catch {
        return null;
      }
    };
    const connected = modem.getConnectionState() === 'READY';
    const [signal, network, sim] = connected
      ? await Promise.all([settle(modem.getSignalQuality()), settle(modem.getNetworkStatus()), settle(modem.getSimStatus?.())])
      : [null, null, null];
    res.json({ success: true, modemId: unit.descriptor.modemId, status: registry.status(unit.descriptor.modemId), signal, network, sim });
  }));

  router.put('/:modemId/ai', guard((req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    registry.setAiEnabled(req.params.modemId, enabled);
    res.json({ success: true, modem: registry.status(req.params.modemId) });
  }));

  return router;
}
