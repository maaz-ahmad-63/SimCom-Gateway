import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPTS, selectPrompt } from '../../gateway/src/ai/default-prompts';
import { PromptCard, PromptCardProps } from '../src/components/ai/PromptCard';
import { afterRestore, directionPatch, effectivePrompt, hasCustomPrompt, restoreTarget, textToEdit, textToSave } from '../src/lib/agent-prompts';

const defaults = DEFAULT_PROMPTS.inbound;
const inputs = (over: Record<string, unknown> = {}) => ({ customInstructions: '', customGreeting: '', sharedInstructions: '', sharedGreeting: '', defaults, ...over }) as Parameters<typeof effectivePrompt>[0];

describe('which prompt is in use', () => {
  it('is the built-in default when nothing is set, and the greeting is the built-in one too', () => {
    expect(effectivePrompt(inputs())).toEqual({ instructions: defaults.instructions, greeting: defaults.greeting, source: { instructions: 'default', greeting: 'default' } });
  });

  it('prefers the customer\'s own text, then the shared text, then the default', () => {
    expect(effectivePrompt(inputs({ customInstructions: 'OWN', sharedInstructions: 'SHARED' })).source.instructions).toBe('custom');
    expect(effectivePrompt(inputs({ sharedInstructions: 'SHARED' }))).toMatchObject({ instructions: 'SHARED', source: { instructions: 'shared' } });
    expect(effectivePrompt(inputs({ customInstructions: '   ', sharedInstructions: '' })).source.instructions).toBe('default'); // blank is "not set"
  });

  it('keeps a call that waits for the caller when the customer wrote instructions but no greeting (their existing behaviour)', () => {
    expect(effectivePrompt(inputs({ customInstructions: 'OWN' }))).toMatchObject({ greeting: '', source: { instructions: 'custom', greeting: 'none' } });
    expect(effectivePrompt(inputs({ sharedInstructions: 'SHARED' })).source.greeting).toBe('none');
    expect(effectivePrompt(inputs({ customGreeting: 'Hi' }))).toMatchObject({ greeting: 'Hi', source: { instructions: 'default', greeting: 'custom' } });
  });

  it('does not invent text when the gateway has not sent the built-in prompts', () => {
    expect(effectivePrompt(inputs({ defaults: undefined }))).toMatchObject({ instructions: '', greeting: '', source: { instructions: 'default' } });
  });

  it('gives the same answer as the gateway for every combination (the dashboard cannot drift from the real rule)', () => {
    const values = ['', '   ', 'text'];
    for (const own of values) for (const sharedI of values) for (const sharedG of values) for (const ownG of values) {
      for (const direction of ['inbound', 'outbound'] as const) {
        const d = DEFAULT_PROMPTS[direction];
        const ui = effectivePrompt({ customInstructions: own, customGreeting: ownG, sharedInstructions: sharedI, sharedGreeting: sharedG, defaults: d });
        const config = { sharedInstructions: sharedI.trim() || null, greeting: sharedG.trim() || null, promptBody: 'BODY', directions: { inbound: { instructions: null, greeting: null }, outbound: { instructions: null, greeting: null } } };
        config.directions[direction] = { instructions: own.trim() || null, greeting: ownG.trim() || null };
        const gateway = selectPrompt(config, direction);
        const label = JSON.stringify({ own, ownG, sharedI, sharedG, direction });
        expect(gateway.systemPrompt.startsWith(`${ui.instructions}\n\nBODY`), label).toBe(true);
        expect(ui.greeting, label).toBe(gateway.greeting ?? '');
        const map = { direction: 'custom', shared: 'shared', default: 'default', none: 'none' } as const;
        expect(ui.source, label).toEqual({ instructions: map[gateway.source.instructions], greeting: map[gateway.source.greeting] });
      }
    }
  });
});

describe('editing and saving', () => {
  it('starts an edit from what is in use, never a blank page', () => {
    expect(textToEdit('', defaults.instructions)).toBe(defaults.instructions);
    expect(textToEdit('mine', defaults.instructions)).toBe('mine');
    expect(textToEdit('  ', 'shared text')).toBe('shared text');
  });

  it('saves nothing for text identical to the built-in default, so it keeps following the built-in one through updates', () => {
    expect(textToSave(defaults.instructions, defaults.instructions)).toBe('');
    expect(textToSave(`  ${defaults.instructions}\n`, defaults.instructions)).toBe('');
    expect(textToSave('', defaults.instructions)).toBe('');
    expect(textToSave('   ', defaults.instructions)).toBe('');
  });

  it('saves a real change exactly as typed, and without a known default saves what was typed', () => {
    expect(textToSave('You are the receptionist for the dental clinic.', defaults.instructions)).toBe('You are the receptionist for the dental clinic.');
    expect(textToSave('anything', undefined)).toBe('anything');
  });

  it('knows when there is something of the customer\'s own to restore', () => {
    expect(hasCustomPrompt({ customInstructions: '', customGreeting: '' })).toBe(false);
    expect(hasCustomPrompt({ customInstructions: ' ', customGreeting: '' })).toBe(false);
    expect(hasCustomPrompt({ customInstructions: 'x', customGreeting: '' })).toBe(true);
    expect(hasCustomPrompt({ customInstructions: '', customGreeting: 'Hi' })).toBe(true);
  });
});

describe('the prompt card', () => {
  const noop = () => undefined;
  const card = (over: Partial<PromptCardProps> = {}) =>
    renderToStaticMarkup(
      React.createElement(PromptCard, {
        ...inputs(),
        title: 'Inbound calls',
        subtitle: 's',
        direction: 'inbound',
        editing: false,
        confirmingRestore: false,
        draftInstructions: '',
        draftGreeting: '',
        busy: false,
        problems: [],
        onEdit: noop,
        onCancel: noop,
        onSave: noop,
        onAskRestore: noop,
        onRestore: noop,
        onKeep: noop,
        onInstructions: noop,
        onGreeting: noop,
        ...over,
      } as PromptCardProps)
    );

  it('shows the default prompt with a Default indicator and an Edit button, but nothing to restore', () => {
    const html = card();
    expect(html).toContain('>Default<');
    expect(html).toContain('AI assistant');
    expect(html).toContain('>Edit<');
    expect(html).not.toContain('Restore default');
    expect(html).toContain('already says the assistant is an AI');
  });

  it('shows a custom prompt with a Custom indicator, Edit and Restore default', () => {
    const html = card({ customInstructions: 'You are the receptionist.', customGreeting: 'Hello, clinic.' });
    expect(html).toContain('>Custom<');
    expect(html).toContain('You are the receptionist.');
    expect(html).toContain('Hello, clinic.');
    expect(html).toContain('>Edit<');
    expect(html).toContain('>Restore default<');
  });

  it('says where shared instructions come from, and that a call with no greeting waits for the caller', () => {
    const html = card({ sharedInstructions: 'Shared rules.' });
    expect(html).toContain('>Shared<');
    expect(html).toContain('Shared rules.');
    expect(html).toContain('waits for the other person to speak first');
    expect(html).not.toContain('Restore default');
  });

  it('asks before restoring, naming what will be removed', () => {
    const html = card({ customInstructions: 'x', confirmingRestore: true });
    expect(html).toContain('Restore the built-in default? Your own inbound text will be removed.');
    expect(html).toContain('Yes, restore default');
    expect(html).toContain('Keep mine');
    expect(html).not.toContain('>Edit<');
  });

  it('shows the editor with counters, Save and Cancel while editing, and the problems that block saving', () => {
    const html = card({ editing: true, draftInstructions: 'Hello there', draftGreeting: 'Hi' });
    expect(html).toContain('Inbound instructions (11/8000)');
    expect(html).toContain('>Save<');
    expect(html).toContain('>Cancel<');
    expect(html).not.toContain('data-testid="inbound-reading"');
    const blocked = card({ editing: true, problems: ['Instructions are limited to 8000 characters'] });
    expect(blocked).toContain('role="alert"');
    expect(blocked).toMatch(/<button[^>]*disabled[^>]*>Save/);
  });

  it('says plainly when this page does not know the built-in text yet (an older gateway), without inventing one', () => {
    const html = card({ defaults: undefined });
    expect(html).toContain('No prompt is saved');
    expect(html).toContain('once the gateway has it');
    expect(html).toContain('>Default<');
  });

  it('labels the outbound card for outbound calls', () => {
    const html = card({ direction: 'outbound', defaults: DEFAULT_PROMPTS.outbound, title: 'Outbound calls' });
    expect(html).toContain('Outbound instructions');
    expect(html).toContain('making a phone call');
    expect(html).toContain('good time');
  });
});

describe('Restore when shared instructions exist (the review point)', () => {
  const noop = () => undefined;
  const card = (over: Partial<PromptCardProps> = {}) =>
    renderToStaticMarkup(
      React.createElement(PromptCard, {
        ...inputs({ sharedInstructions: 'SHARED RULES' }),
        title: 'Inbound calls',
        subtitle: 's',
        direction: 'inbound',
        editing: false,
        confirmingRestore: false,
        draftInstructions: '',
        draftGreeting: '',
        busy: false,
        problems: [],
        onEdit: noop,
        onCancel: noop,
        onSave: noop,
        onAskRestore: noop,
        onRestore: noop,
        onKeep: noop,
        onInstructions: noop,
        onGreeting: noop,
        ...over,
      } as PromptCardProps)
    );

  it('names what removing the customer\'s own text really does: it leads to the shared instructions, not the built-in default', () => {
    expect(restoreTarget({ sharedInstructions: 'SHARED RULES' })).toBe('shared');
    expect(restoreTarget({ sharedInstructions: '   ' })).toBe('default');
    expect(restoreTarget({ sharedInstructions: '' })).toBe('default');
    const html = card({ customInstructions: 'MY INBOUND', customGreeting: 'MY HELLO' });
    expect(html).toContain('>Use shared instructions<');
    expect(html).not.toContain('Restore default');
    expect(html).toContain('To use the built-in default instead, clear the shared instructions');
  });

  it('asks in accurate words, says shared instructions are not changed, and previews exactly what calls will use afterwards', () => {
    const html = card({ customInstructions: 'MY INBOUND', customGreeting: 'MY HELLO', confirmingRestore: true });
    expect(html).toContain('Use the shared instructions instead?');
    expect(html).toContain('The shared instructions themselves are not changed.');
    expect(html).toContain('Inbound calls will then use the shared instructions and no greeting (the assistant waits for the other person to speak)');
    expect(html).toContain('Yes, use shared instructions');
    expect(html).not.toContain('built-in default?');
  });

  it('previews the shared greeting when there is one, and the built-in default when there are no shared instructions', () => {
    expect(card({ customInstructions: 'x', sharedGreeting: 'SHARED HELLO', confirmingRestore: true })).toContain('the shared instructions and the shared greeting');
    const alone = renderToStaticMarkup(
      React.createElement(PromptCard, { ...inputs(), title: 'Inbound calls', subtitle: 's', direction: 'inbound', editing: false, confirmingRestore: true, customInstructions: 'x', draftInstructions: '', draftGreeting: '', busy: false, problems: [], onEdit: noop, onCancel: noop, onSave: noop, onAskRestore: noop, onRestore: noop, onKeep: noop, onInstructions: noop, onGreeting: noop } as PromptCardProps)
    );
    expect(alone).toContain('Restore the built-in default? Your own inbound text will be removed.');
    expect(alone).toContain('the built-in default prompt and the built-in greeting');
    expect(alone).toContain('Yes, restore default');
  });

  it('shows the prompt a call will use: after the restore it is the shared text, by the same rule the gateway applies', () => {
    const i = inputs({ customInstructions: 'MY INBOUND', customGreeting: 'MY HELLO', sharedInstructions: 'SHARED RULES' });
    expect(effectivePrompt(i)).toMatchObject({ instructions: 'MY INBOUND', source: { instructions: 'custom' } });
    expect(afterRestore(i)).toMatchObject({ instructions: 'SHARED RULES', greeting: '', source: { instructions: 'shared', greeting: 'none' } });
    expect(card({ customInstructions: '', customGreeting: '' })).toContain('SHARED RULES'); // what the card shows once saved
    expect(card({ customInstructions: '', customGreeting: '' })).toContain('>Shared<');
  });

  it('never carries the shared instructions or greeting in what it saves, so they cannot be deleted by accident', () => {
    for (const direction of ['inbound', 'outbound'] as const) {
      const patch = directionPatch(direction, '', '');
      const keys = Object.keys(patch.agent).sort();
      expect(keys).toEqual([`${direction}Greeting`, `${direction}Instructions`]);
      expect(keys).not.toContain('instructions');
      expect(keys).not.toContain('greeting');
      expect(Object.keys(patch)).toEqual(['agent']);
    }
    expect(directionPatch('inbound', 'a', 'b')).toEqual({ agent: { inboundInstructions: 'a', inboundGreeting: 'b' } });
  });

  it('does not claim a built-in default exists when the gateway has not sent one', () => {
    const html = renderToStaticMarkup(
      React.createElement(PromptCard, { ...inputs({ defaults: undefined }), title: 'Inbound calls', subtitle: 's', direction: 'inbound', editing: false, confirmingRestore: false, draftInstructions: '', draftGreeting: '', busy: false, problems: [], onEdit: noop, onCancel: noop, onSave: noop, onAskRestore: noop, onRestore: noop, onKeep: noop, onInstructions: noop, onGreeting: noop } as PromptCardProps)
    );
    expect(html).toContain('No prompt is saved for inbound calls');
    expect(html).not.toContain('built-in default prompt is used');
  });
});
