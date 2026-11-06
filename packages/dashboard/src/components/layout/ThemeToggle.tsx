'use client';

import React, { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { applyTheme, readThemeChoice, resolveTheme, saveThemeChoice, ThemeChoice } from '../../lib/theme';

const OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Light / Dark / System, remembered in this browser. On the brand bar, so it is styled for the navy bar in both themes. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    setChoice(readThemeChoice(storage()));
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => applyTheme(document.documentElement, resolveTheme(choice, media.matches));
    update();
    if (choice !== 'system') return;
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [choice]);

  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex items-center rounded-md border border-brand-fg/15 p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={choice === value}
          title={`${label} theme`}
          onClick={() => {
            setChoice(value);
            saveThemeChoice(storage(), value);
          }}
          className={`p-1.5 rounded transition ${choice === value ? 'bg-brand-fg/15 text-brand-fg' : 'text-brand-fg/60 hover:text-brand-fg'}`}
        >
          <Icon className="w-3.5 h-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
