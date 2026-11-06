'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bot,
  Megaphone,
  History,
  LayoutDashboard,
  MessageSquare,
  PhoneCall,
  PhoneForwarded,
  Sliders,
  Cpu,
  Wrench,
  Volume2,
  HeartPulse,
  ListChecks,
  X,
} from 'lucide-react';
import { useGateway } from '../../lib/context/GatewayContext';
import { portText } from '../../lib/hardware-mode';
import { ThemeToggle } from './ThemeToggle';

export const NAV_SECTIONS = [
  {
    title: 'Operations',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/dialer', label: 'Dialer & Live', icon: PhoneCall, showActivePill: true },
      { href: '/calls', label: 'Call History', icon: History },
      { href: '/observability', label: 'Call Logs', icon: Activity },
      { href: '/campaigns', label: 'Campaigns', icon: Megaphone },
      { href: '/sms', label: 'SMS', icon: MessageSquare },
    ],
  },
  {
    title: 'Automation',
    items: [
      { href: '/ai', label: 'AI Agent', icon: Bot },
      { href: '/ivr', label: 'IVR Menu', icon: PhoneForwarded },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/setup', label: 'Setup', icon: ListChecks },
      { href: '/health', label: 'System health', icon: HeartPulse },
      { href: '/hardware', label: 'Hardware', icon: Wrench },
      { href: '/settings', label: 'Settings', icon: Sliders },
    ],
  },
] as const;

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { activeCall, hardware } = useGateway();
  const isCallActive = activeCall && activeCall.state !== 'IDLE';

  return (
    <div className="flex flex-col justify-between h-full">
      <nav className="p-3 space-y-5" aria-label="Main">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{section.title}</p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={isActive ? 'page' : undefined}
                      className={`relative flex items-center justify-between px-3 py-2 rounded-md text-[13px] transition ${
                        isActive ? 'bg-slate-800/70 text-white font-medium' : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                      }`}
                    >
                      {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-cyan-500" aria-hidden />}
                      <span className="flex items-center gap-2.5">
                        <Icon className={`w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-slate-500'}`} aria-hidden />
                        {item.label}
                      </span>
                      {'showActivePill' in item && item.showActivePill && isCallActive && (
                        <span className="h-2 w-2 rounded-full bg-emerald-500" title="A call is in progress" aria-label="A call is in progress" />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-800">
        <dl className="px-3 py-2 rounded-md bg-slate-950/50 border border-slate-800 space-y-1 text-[11px]">
          <div className="flex items-center justify-between gap-2 text-slate-400">
            <dt className="flex items-center gap-1.5">
              <Cpu className="w-3 h-3 text-slate-500" aria-hidden /> AT Port
            </dt>
            <dd className="font-mono text-slate-300 text-right">{portText(hardware, 'at')}</dd>
          </div>
          <div className="flex items-center justify-between gap-2 text-slate-400">
            <dt className="flex items-center gap-1.5">
              <Volume2 className="w-3 h-3 text-slate-500" aria-hidden /> Audio Port
            </dt>
            <dd className="font-mono text-slate-300 text-right">{portText(hardware, 'audio')}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/** The sidebar on wide screens; on small screens the same list slides in from the left when the header's menu button is pressed. */
export function Navigation({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onClose]);

  return (
    <>
      <aside className="w-60 border-r border-slate-800 bg-surface shrink-0 hidden md:block overflow-y-auto">
        <NavList />
      </aside>
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface border-r border-slate-800 overflow-y-auto">
            <div className="theme-dark bg-brand-bar flex items-center justify-between p-2">
              {/* On a phone the theme switcher lives here (the brand bar has no room for it). */}
              <ThemeToggle />
              <button type="button" onClick={onClose} className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800/50" aria-label="Close navigation">
                <X className="w-5 h-5" />
              </button>
            </div>
            <NavList onNavigate={onClose} />
          </aside>
        </div>
      )}
    </>
  );
}
