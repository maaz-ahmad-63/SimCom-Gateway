'use client';

import React, { useState } from 'react';
import { Header } from './Header';
import { Navigation } from './Navigation';
import { IncomingCallBanner } from './IncomingCallBanner';
import { AlertCenter } from '../ops/AlertCenter';
import { UpdateBanner } from '../updates/UpdateBanner';

/** The application frame: brand bar, banners, navigation and the page. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <Header onOpenMenu={() => setMenuOpen(true)} />
      {/* Incoming call (INBOUND_RINGING), connection loss / critical alerts with the alert bell, and update notices */}
      <IncomingCallBanner />
      <AlertCenter />
      <UpdateBanner />
      <div className="flex-1 flex min-h-0">
        <Navigation mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-7xl mx-auto w-full px-4 py-5 md:px-6 md:py-6 lg:px-8">{children}</div>
        </main>
      </div>
    </>
  );
}
