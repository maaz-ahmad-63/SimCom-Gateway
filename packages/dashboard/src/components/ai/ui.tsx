'use client';

import React, { useCallback, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { GatewayApiError } from '../../lib/api-client';
import type { Tone } from '../../lib/ai-secrets';

const TONES: Record<Tone, string> = {
  good: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60',
  warn: 'bg-amber-950/40 text-amber-300 border-amber-800/60',
  bad: 'bg-rose-950/40 text-rose-300 border-rose-800/60',
  neutral: 'bg-slate-800/50 text-slate-300 border-slate-700/60',
};

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-surface border border-slate-800 rounded-lg p-5 space-y-4">
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-white leading-6">{title}</h2>}
            {subtitle && <p className="text-[13px] text-slate-400 mt-0.5 leading-relaxed max-w-3xl">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${TONES[tone]}`}>{children}</span>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs font-medium text-slate-300 mb-1.5">{children}</span>;
}

export function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-950/60 rounded-md p-3 border border-slate-800">
      <span className="block text-[11px] text-slate-500 mb-1">{label}</span>
      <div className="text-sm text-slate-100 font-medium break-words tabular-nums">{children}</div>
    </div>
  );
}

const inputClass =
  'w-full bg-slate-950 border border-slate-700/70 rounded-md px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:opacity-50';

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput(props, ref) {
  return <input ref={ref} {...props} className={`${inputClass} ${props.className ?? ''}`} />;
});

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} min-h-[110px] ${props.className ?? ''}`} />;
}

export function Select({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select {...props} className={`${inputClass} ${props.className ?? ''}`}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <Label>{label}</Label>
      {children}
      {hint && <span className="block text-xs text-slate-500 mt-1.5 leading-relaxed">{hint}</span>}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-cyan-600"
      />
      <span>
        <span className="block text-[13px] text-slate-100 font-medium">{label}</span>
        {hint && <span className="block text-xs text-slate-400 mt-0.5 leading-relaxed">{hint}</span>}
      </span>
    </label>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';
// Primary uses the semantic primary token (a solid brand blue in both themes); the others follow the palette tokens.
const BUTTONS: Record<ButtonVariant, string> = {
  primary: 'bg-primary hover:bg-primary-hover text-primary-foreground border-transparent',
  secondary: 'bg-surface hover:bg-slate-800/60 text-slate-200 border-slate-700/80',
  danger: 'bg-surface hover:bg-rose-950/50 text-rose-300 border-rose-800/70',
};

export function Button({
  variant = 'secondary',
  busy,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border text-[13px] font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${BUTTONS[variant]} ${props.className ?? ''}`}
    >
      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

// ---- async actions with visible loading / success / failure ---------------------------------------

export interface ActionState {
  status: 'idle' | 'running' | 'success' | 'error';
  message?: string;
  reasons?: string[];
}

/** Run an API call and keep its outcome on screen: nothing fails silently and nothing claims success early. */
export function useAction(): [ActionState, <T>(fn: () => Promise<T>, successMessage: string) => Promise<T | undefined>, () => void] {
  const [state, setState] = useState<ActionState>({ status: 'idle' });
  const alive = useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(fn: () => Promise<T>, successMessage: string): Promise<T | undefined> => {
    setState({ status: 'running' });
    try {
      const result = await fn();
      if (alive.current) setState({ status: 'success', message: successMessage });
      return result;
    } catch (err) {
      if (alive.current) {
        setState({
          status: 'error',
          message: (err as Error).message,
          reasons: err instanceof GatewayApiError ? err.reasons : undefined,
        });
      }
      return undefined;
    }
  }, []);
  const reset = useCallback(() => setState({ status: 'idle' }), []);
  return [state, run, reset];
}

export function ActionNote({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-slate-400" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Working…
      </p>
    );
  }
  const ok = state.status === 'success';
  return (
    <div
      role={ok ? 'status' : 'alert'}
      className={`text-xs rounded-md border px-3 py-2 flex items-start gap-2 ${ok ? TONES.good : TONES.bad}`}
    >
      {ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
      <div className="space-y-1">
        <p>{state.message}</p>
        {state.reasons && state.reasons.length > 0 && (
          <ul className="list-disc pl-4 font-mono text-[11px] space-y-0.5">
            {state.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Save / Cancel bar for a form that edits server-side settings. */
export function SaveBar({
  dirty,
  problems,
  action,
  onSave,
  onCancel,
}: {
  dirty: boolean;
  problems: string[];
  action: ActionState;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 border-t border-slate-800 pt-4">
      {problems.length > 0 && (
        <ul className="text-xs text-amber-300 list-disc pl-4 space-y-0.5" aria-label="Problems to fix before saving">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={onSave} disabled={!dirty || problems.length > 0} busy={action.status === 'running'}>
          Save changes
        </Button>
        <Button onClick={onCancel} disabled={!dirty || action.status === 'running'}>
          Cancel
        </Button>
        {dirty && action.status !== 'running' && <span className="text-[11px] text-slate-500">Unsaved changes</span>}
      </div>
      <ActionNote state={action} />
    </div>
  );
}
