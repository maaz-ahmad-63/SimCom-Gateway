'use client';

import React, { useState } from 'react';
import type { AiAgentProfile } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { AgentWithDefaults, directionPatch, effectivePrompt, PromptInputs, restoreTarget, textToEdit, textToSave } from '../../lib/agent-prompts';
import { useAi } from '../../lib/context/AiContext';
import { PromptCard } from './PromptCard';
import { ActionNote, useAction } from './ui';

type AgentSettings = AiAgentProfile &
  AgentWithDefaults & {
    inboundInstructions?: string;
    inboundGreeting?: string;
    outboundInstructions?: string;
    outboundGreeting?: string;
  };

const TEXT = {
  inbound: { title: 'Inbound calls', subtitle: 'Used when someone rings in. The text below is exactly what the assistant is told for these calls, before the built-in phone-call rules.' },
  outbound: { title: 'Outbound calls', subtitle: 'Used when the assistant calls someone outside a campaign. A campaign adds its own prompt on top of its own calls and does not use this one.' },
} as const;

/**
 * One direction's prompt, wired to the backend. It reads what the gateway has SAVED (not the page's other unsaved edits) and saves only
 * its own two fields through the same endpoint the rest of the tab uses, so saving a prompt can never carry someone's half-finished edits
 * elsewhere with it. "Restore default" saves empty values, which the gateway reads as "not set".
 */
export function DirectionPrompt({ direction }: { direction: 'inbound' | 'outbound' }) {
  const { state, refresh } = useAi();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [greeting, setGreeting] = useState('');
  const [action, run, reset] = useAction();
  if (!state) return null;

  const agent = state.settings.agent as AgentSettings;
  const inputs: PromptInputs = {
    customInstructions: (direction === 'inbound' ? agent.inboundInstructions : agent.outboundInstructions) ?? '',
    customGreeting: (direction === 'inbound' ? agent.inboundGreeting : agent.outboundGreeting) ?? '',
    sharedInstructions: agent.instructions ?? '',
    sharedGreeting: agent.greeting ?? '',
    defaults: agent.defaultPrompts?.[direction],
  };
  const view = effectivePrompt(inputs);

  const persist = async (nextInstructions: string, nextGreeting: string, message: string) => {
    const saved = await run(() => apiClient.saveAiSettings(directionPatch(direction, nextInstructions, nextGreeting)), message);
    if (saved) {
      setEditing(false);
      setConfirming(false);
      await refresh();
    }
  };

  const problems: string[] = [];
  if (instructions.length > 8000) problems.push('Instructions are limited to 8000 characters');
  if (greeting.length > 500) problems.push('The greeting is limited to 500 characters');

  return (
    <PromptCard
      {...inputs}
      {...TEXT[direction]}
      direction={direction}
      editing={editing}
      confirmingRestore={confirming}
      draftInstructions={instructions}
      draftGreeting={greeting}
      busy={action.status === 'running'}
      problems={problems}
      note={<ActionNote state={action} />}
      onEdit={() => {
        reset();
        setInstructions(textToEdit(inputs.customInstructions, view.instructions));
        setGreeting(textToEdit(inputs.customGreeting, view.greeting));
        setEditing(true);
      }}
      onCancel={() => {
        reset();
        setEditing(false);
      }}
      onSave={() => void persist(textToSave(instructions, inputs.defaults?.instructions), textToSave(greeting, inputs.defaults?.greeting), 'Saved. It applies from the next call; a call in progress keeps the prompt it started with.')}
      onAskRestore={() => setConfirming(true)}
      onRestore={() => void persist('', '', restoreTarget(inputs) === 'shared' ? 'Your own text was removed; the shared instructions now apply. It applies from the next call.' : 'Default restored. It applies from the next call.')}
      onKeep={() => setConfirming(false)}
      onInstructions={setInstructions}
      onGreeting={setGreeting}
    />
  );
}
