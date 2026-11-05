'use client';

import React from 'react';
import { CheckCircle2, CircleDashed, CircleSlash, XCircle } from 'lucide-react';
import type { SetupStep } from '../../lib/setup';

const ICON = { done: CheckCircle2, todo: XCircle, waiting: CircleDashed, skipped: CircleSlash } as const;
const COLOR = { done: 'text-emerald-400', todo: 'text-rose-400', waiting: 'text-slate-400', skipped: 'text-slate-600' } as const;

/** The first-run checklist, one row per step, with what to do for any step that is not done. */
export function SetupList({ steps }: { steps: SetupStep[] }) {
  return (
    <ol className="space-y-2" data-testid="setup-steps">
      {steps.map((s, i) => {
        const Icon = ICON[s.state];
        return (
          <li key={s.id} className="flex gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs" data-state={s.state}>
            <Icon className={`w-5 h-5 shrink-0 ${COLOR[s.state]}`} aria-label={s.state} />
            <div className="min-w-0 space-y-1">
              <p className="font-semibold text-white">
                {i + 1}. {s.title}
              </p>
              <p className="text-slate-300">{s.detail}</p>
              {s.action && <p className="text-amber-200">What to do: {s.action}</p>}
              {s.href && s.state !== 'skipped' && (
                <a href={s.href} className="text-cyan-400 hover:underline">
                  Open
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
