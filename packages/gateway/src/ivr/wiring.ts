import type { IAudioAdapter, ICallSessionManager, IModemAdapter } from '@sim-gateway/shared';
import { isDtmfUrc } from '../adapters/modem/at-parser.js';
import { GatewayAudioSink } from '../ai/gateway-adapters.js';
import type { AiRuntime } from '../ai/runtime.js';
import type { GatewayEventBus } from '../core/event-bus.js';
import { IvrController, IvrControllerDeps } from './controller.js';

export interface IvrControllerWiring {
  modem: IModemAdapter;
  audio: IAudioAdapter;
  manager: ICallSessionManager;
  eventBus: GatewayEventBus;
  /** The AI runtime, for the audio configuration and the readiness checks (read at call time: the runtime is built after this). */
  runtime: () => AiRuntime | undefined;
  /** Test seams. Production leaves these unset. */
  options?: Pick<IvrControllerDeps, 'handoffSettleMs' | 'debounceMs' | 'now'>;
}

/**
 * Connects the IVR controller to the gateway's real parts, adding nothing to them:
 *  - audio goes out through the same `GatewayAudioSink` the AI uses (a separate instance per call, with the AI's own pacing settings);
 *  - keys come from the modem adapter's own `urc` events (the digit never goes through the shared event bus);
 *  - the IVR may only play when the AI runtime's readiness says the outbound audio path is confirmed and the audio is flowing,
 *    which is the same audio verification the AI needs: it is never bypassed.
 */
export function createIvrController(wiring: IvrControllerWiring): IvrController {
  const { modem, audio, manager, eventBus, runtime } = wiring;
  return new IvrController({
    manager,
    eventBus,
    onDtmf: (listener) => {
      const handler = (urc: Parameters<typeof isDtmfUrc>[0]) => {
        if (isDtmfUrc(urc)) listener(urc.payload.digit);
      };
      modem.on('urc', handler);
      return () => void modem.off('urc', handler);
    },
    createSink: (call) => {
      const config = runtime()?.config.config;
      const format = config?.audio.format;
      if (!config || !format) return null;
      const isLive = () => {
        const current = manager.getCurrentCall();
        return current?.id === call.id && current.state === 'ACTIVE';
      };
      return new GatewayAudioSink(audio, format, config.audio.outboundVerified, isLive, {
        leadFrames: config.playback.leadFrames,
        prerollMs: config.playback.prerollMs,
      });
    },
    audioProblem: (snapshot) => {
      const rt = runtime();
      if (!rt) return 'the AI runtime that holds the audio configuration is not running';
      const format = rt.config.config.audio.format;
      if (!format) return 'the gateway audio sample rate is not set';
      if (format.sampleRate !== snapshot.sampleRate) return `the announcements are ${snapshot.sampleRate} Hz but the gateway now uses ${format.sampleRate} Hz`;
      const checks = rt.readiness().checks;
      for (const name of ['inbound-wire', 'outbound-audio']) {
        const check = checks.find((c) => c.name === name);
        if (check && check.status !== 'pass') return `${name}: ${check.detail}`;
      }
      return null;
    },
    mark: (callId, event) => void runtime()?.hub.publish(callId, event),
    ...wiring.options,
  });
}
