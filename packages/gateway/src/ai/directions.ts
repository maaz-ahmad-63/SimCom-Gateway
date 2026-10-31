import type { CallDirection } from '@sim-gateway/shared';
import type { AiConfig } from './config.js';

/**
 * The prompt and greeting for a call, chosen by its direction. Only the operator's instructions and the greeting differ: the
 * built-in call rules, the providers, the audio path and the call lifecycle are the same for every call, so there is one voice
 * engine and two configurations. A direction with nothing of its own uses the shared instructions and greeting, so a gateway
 * that has not set these behaves exactly as it did before.
 */
export function agentFor(config: AiConfig, direction: CallDirection): { systemPrompt: string; greeting: string | null; source: { instructions: 'direction' | 'shared' | 'none'; greeting: 'direction' | 'shared' | 'none' } } {
  const own = config.directions[direction === 'outbound' ? 'outbound' : 'inbound'];
  const instructions = own.instructions ?? config.sharedInstructions;
  const greeting = own.greeting ?? config.greeting;
  return {
    systemPrompt: instructions ? `${instructions}\n\n${config.promptBody}` : config.promptBody,
    greeting,
    source: {
      instructions: own.instructions ? 'direction' : config.sharedInstructions ? 'shared' : 'none',
      greeting: own.greeting ? 'direction' : config.greeting ? 'shared' : 'none',
    },
  };
}
