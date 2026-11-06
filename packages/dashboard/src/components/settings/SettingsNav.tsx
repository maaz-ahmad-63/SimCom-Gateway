'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React from 'react';

export const SETTINGS_SECTIONS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/api-keys', label: 'API Keys' },
  { href: '/settings/recording', label: 'Call Recording' },
] as const;

/** The sections of Settings, as tabs. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="flex gap-1 border-b border-slate-800">
      {SETTINGS_SECTIONS.map((s) => {
        const active = pathname === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? 'page' : undefined}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition ${active ? 'border-cyan-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
