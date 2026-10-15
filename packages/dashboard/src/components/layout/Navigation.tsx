'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  History,
  LayoutDashboard,
  PhoneCall,
  Sliders,
  Cpu,
  Volume2,
} from 'lucide-react';
import { useGateway } from '../../lib/context/GatewayContext';

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/dialer', label: 'Dialer & Live', icon: PhoneCall, showActivePill: true },
  { href: '/calls', label: 'Call History', icon: History },
  { href: '/settings', label: 'Settings', icon: Sliders },
];

export function Navigation() {
  const pathname = usePathname();
  const { activeCall, health } = useGateway();

  const isCallActive = activeCall && activeCall.state !== 'IDLE';

  return (
    <aside className="w-56 border-r border-slate-800 bg-[#090d16] flex flex-col justify-between shrink-0 hidden md:flex">
      <div className="p-3 space-y-1">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 font-mono">
          Gateway Control
        </div>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition ${
                  isActive
                    ? 'bg-slate-800 text-white font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/80'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon
                    className={`w-4 h-4 ${
                      isActive ? 'text-cyan-400' : 'text-slate-500'
                    }`}
                  />
                  <span>{item.label}</span>
                </div>

                {item.showActivePill && isCallActive && (
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Footer System Info */}
      <div className="p-3 border-t border-slate-800/80 space-y-2">
        <div className="px-3 py-1.5 rounded bg-slate-900/60 border border-slate-800/80 space-y-1">
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span className="flex items-center gap-1.5">
              <Cpu className="w-3 h-3 text-slate-500" /> AT Port
            </span>
            <span className="text-slate-300 font-semibold">
              {health?.modem.atPort || 'COM20'}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span className="flex items-center gap-1.5">
              <Volume2 className="w-3 h-3 text-slate-500" /> Audio Port
            </span>
            <span className="text-slate-300 font-semibold">
              {health?.modem.audioPort || 'COM19'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
