'use client';

import React from 'react';
import { afterRestore, effectivePrompt, hasCustomPrompt, PromptInputs, PromptSource, restoreTarget, SOURCE_LABEL } from '../../lib/agent-prompts';
import { Badge, Button, Card, Field, TextArea, TextInput } from './ui';

export interface PromptCardProps extends PromptInputs {
  title: string;
  subtitle: string;
  direction: 'inbound' | 'outbound';
  editing: boolean;
  confirmingRestore: boolean;
  /** The values being edited (only meaningful while editing). */
  draftInstructions: string;
  draftGreeting: string;
  busy: boolean;
  problems: string[];
  note?: React.ReactNode;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onAskRestore: () => void;
  onRestore: () => void;
  onKeep: () => void;
  onInstructions: (v: string) => void;
  onGreeting: (v: string) => void;
}

const TONE: Record<PromptSource, 'good' | 'neutral'> = { custom: 'good', shared: 'neutral', default: 'neutral', none: 'neutral' };

/**
 * One direction's prompt, with where it comes from. Reading it, editing it, saving it and restoring the default are four separate states,
 * so a customer can always see what a call will actually say before changing anything. It has no state of its own: the parent decides.
 */
export function PromptCard(p: PromptCardProps) {
  const view = effectivePrompt(p);
  const label = p.direction === 'inbound' ? 'Inbound' : 'Outbound';
  const known = view.instructions !== '' || view.source.instructions !== 'default';
  // What removing the customer's own text leads to: the shared instructions if there are any, otherwise the built-in default.
  const target = restoreTarget(p);
  const next = afterRestore(p);
  const nextWords = `${next.source.instructions === 'shared' ? 'the shared instructions' : next.source.instructions === 'default' ? 'the built-in default prompt' : 'no instructions'} and ${next.source.greeting === 'none' ? 'no greeting (the assistant waits for the other person to speak)' : next.source.greeting === 'shared' ? 'the shared greeting' : 'the built-in greeting'}`;
  const restoreLabel = target === 'shared' ? 'Use shared instructions' : 'Restore default';
  return (
    <Card
      title={p.title}
      subtitle={p.subtitle}
      actions={
        <Badge tone={TONE[view.source.instructions]}>
          <span data-testid={`${p.direction}-source`}>{SOURCE_LABEL[view.source.instructions]}</span>
        </Badge>
      }
    >
      {!p.editing && (
        <div className="space-y-3" data-testid={`${p.direction}-reading`}>
          <div>
            <p className="text-[10px] uppercase tracking-wide font-medium text-slate-500 mb-1">{label} instructions</p>
            {known ? (
              <pre className="whitespace-pre-wrap break-words text-xs text-slate-200 bg-slate-950/60 border border-slate-800 rounded-lg p-3 font-sans" data-testid={`${p.direction}-instructions`}>
                {view.instructions}
              </pre>
            ) : (
              <p className="text-xs text-slate-400" data-testid={`${p.direction}-unknown`}>
                No prompt is saved for {p.direction} calls. A built-in default prompt is added by a newer version of the gateway, and its text is shown here once the gateway has it.
              </p>
            )}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide font-medium text-slate-500 mb-1">{label} greeting</p>
            <p className="text-xs text-slate-200 bg-slate-950/60 border border-slate-800 rounded-lg p-3" data-testid={`${p.direction}-greeting`}>
              {view.greeting || (view.source.greeting === 'none' ? 'None: the assistant waits for the other person to speak first.' : '—')}
            </p>
          </div>
          {view.source.instructions === 'default' && <p className="text-[11px] text-slate-500">This is the built-in default. It already says the assistant is an AI, so you can make a test call without changing anything.</p>}
          {view.source.instructions === 'shared' && <p className="text-[11px] text-slate-500">These are the shared instructions (Agent profile above). Editing here makes a separate prompt for {p.direction} calls.</p>}
          {target === 'shared' && view.source.instructions === 'custom' && <p className="text-[11px] text-slate-500">Shared instructions exist, so removing your own text leads back to them. To use the built-in default instead, clear the shared instructions in the Agent profile above.</p>}
          {p.confirmingRestore ? (
            <div className="space-y-2 text-xs text-slate-300" role="alert">
              <p data-testid={`${p.direction}-confirm`}>
                {target === 'shared' ? 'Use the shared instructions instead? ' : 'Restore the built-in default? '}Your own {p.direction} text will be removed.
                {target === 'shared' ? ' The shared instructions themselves are not changed.' : ''}
              </p>
              <p className="text-slate-400">
                {p.direction === 'inbound' ? 'Inbound' : 'Outbound'} calls will then use {nextWords}.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" onClick={p.onRestore} busy={p.busy}>
                  {target === 'shared' ? 'Yes, use shared instructions' : 'Yes, restore default'}
                </Button>
                <Button onClick={p.onKeep}>Keep mine</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={p.onEdit}>Edit</Button>
              {hasCustomPrompt(p) && <Button onClick={p.onAskRestore}>{restoreLabel}</Button>}
            </div>
          )}
        </div>
      )}

      {p.editing && (
        <div className="space-y-3" data-testid={`${p.direction}-editing`}>
          <Field label={`${label} instructions (${p.draftInstructions.length}/8000)`} hint="Say who the assistant is and how it should behave. Saving text identical to the built-in default keeps following the built-in one.">
            <TextArea value={p.draftInstructions} maxLength={8000} onChange={(e) => p.onInstructions(e.target.value)} className="min-h-[180px]" aria-label={`${label} instructions`} />
          </Field>
          <Field label={`${label} greeting`} hint="Spoken first. Leave empty to have the assistant wait for the other person to speak.">
            <TextInput value={p.draftGreeting} maxLength={500} onChange={(e) => p.onGreeting(e.target.value)} aria-label={`${label} greeting`} />
          </Field>
          {p.problems.length > 0 && (
            <ul role="alert" className="text-xs text-rose-300 list-disc ml-4">
              {p.problems.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={p.onSave} busy={p.busy} disabled={p.problems.length > 0}>
              Save
            </Button>
            <Button onClick={p.onCancel}>Cancel</Button>
          </div>
        </div>
      )}
      {p.note}
    </Card>
  );
}
