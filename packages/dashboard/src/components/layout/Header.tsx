'use client';

import React from 'react';
import Link from 'next/link';
import { useGateway } from '../../lib/context/GatewayContext';
import { BRAND_NAME } from '../../lib/brand';
import { Menu, Radio, RefreshCw, Settings, WifiOff } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

/**
 * The brand bar: the supplied SIZH IT Solutions logo (shown as supplied, never recoloured) on its own navy, in both themes. The bar is a
 * `theme-dark` area, so everything on it keeps the dark colours that suit the navy whatever the page theme.
 */
export function Header({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const { connectionState, health, telemetry, hardware, linkIssue, refreshHealth, isLoading } = useGateway();

  const signalBars = telemetry.signal?.bars ?? 0;
  const dBm = telemetry.signal?.dBm ?? null;
  const carrier = telemetry.network?.operatorName ?? health?.modem?.network?.operatorName ?? '—';

  const chip = 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-white/10 bg-white/5 text-[11px] font-medium';

  return (
    <header className="theme-dark h-14 bg-brand-bar border-b border-white/10 sticky top-0 z-40 px-3 md:px-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <button type="button" onClick={onOpenMenu} className="md:hidden p-1.5 rounded text-slate-300 hover:text-white hover:bg-white/10" aria-label="Open navigation">
          <Menu className="w-5 h-5" />
        </button>
        <Link href="/" className="flex items-center shrink-0" aria-label={`${BRAND_NAME} home`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a static brand asset, shown at its own proportions */}
          <img src="/brand/sizh-logo.png" alt={BRAND_NAME} width={95} height={35} className="h-[35px] w-auto" />
        </Link>
        <span className="hidden lg:block h-6 w-px bg-white/15" aria-hidden />

        {/* What the gateway itself reports. Before it has answered, the mode is unknown, not a simulation. */}
        {hardware.mode === 'mock' ? (
          <span className={`${chip} text-cyan-300 hidden sm:inline-flex`}>MOCK SIMULATION</span>
        ) : hardware.mode === 'hardware' ? (
          <span className={`${chip} text-emerald-300 hidden sm:inline-flex`}>PHYSICAL HARDWARE</span>
        ) : (
          <span title="The gateway has not answered yet, so whether it uses a real modem or a simulation is not known." className={`${chip} text-slate-300 hidden sm:inline-flex`}>
            HARDWARE UNKNOWN
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <div className={`${chip} hidden md:inline-flex text-slate-200`}>
          <Radio className="w-3.5 h-3.5 text-slate-400" aria-hidden />
          <span>{carrier}</span>
          <span className="flex items-end gap-0.5 h-3 ml-1" aria-label={`Signal ${signalBars} of 5`}>
            {[1, 2, 3, 4, 5].map((bar) => (
              <span
                key={bar}
                className={`w-1 rounded-sm ${bar <= signalBars ? (signalBars >= 3 ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-white/20'}`}
                style={{ height: `${bar * 20}%` }}
              />
            ))}
          </span>
          {dBm !== null && <span className="text-slate-400">{dBm} dBm</span>}
        </div>

        <div className={chip}>
          {connectionState === 'connected' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
              <span className="text-emerald-300">ONLINE</span>
            </>
          ) : connectionState === 'connecting' ? (
            <>
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" aria-hidden />
              <span className="text-amber-300">CONNECTING</span>
            </>
          ) : linkIssue ? (
            <Link href="/settings" title={linkIssue.message} className="flex items-center gap-1.5">
              <WifiOff className="w-3 h-3 text-amber-300" aria-hidden />
              <span className="text-amber-300">{linkIssue.label}</span>
            </Link>
          ) : (
            <>
              <WifiOff className="w-3 h-3 text-rose-300" aria-hidden />
              <span className="text-rose-300">OFFLINE</span>
            </>
          )}
        </div>

        <div className="hidden sm:block">
          <ThemeToggle />
        </div>

        <button
          onClick={() => refreshHealth()}
          disabled={isLoading}
          title="Refresh gateway health"
          aria-label="Refresh gateway health"
          className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-white/10 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
        <Link href="/settings" title="Settings" aria-label="Settings" className="hidden sm:block p-1.5 rounded text-slate-300 hover:text-white hover:bg-white/10 transition">
          <Settings className="w-4 h-4" />
        </Link>
      </div>
    </header>
  );
}
