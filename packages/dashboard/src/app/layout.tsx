import type { Metadata } from 'next';
import './globals.css';
import { GatewayProvider } from '../lib/context/GatewayContext';
import { Header } from '../components/layout/Header';
import { Navigation } from '../components/layout/Navigation';
import { IncomingCallBanner } from '../components/layout/IncomingCallBanner';
import { AlertCenter } from '../components/ops/AlertCenter';
import { UpdateBanner } from '../components/updates/UpdateBanner';

export const metadata: Metadata = {
  title: 'SIZH IT Solution',
  description: 'Call handling, AI assistant and SMS from one place.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#090d16] text-slate-100 antialiased flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
        <GatewayProvider>
          {/* Top Sticky Header */}
          <Header />

          {/* Global Incoming Call Banner (shown when INBOUND_RINGING) */}
          <IncomingCallBanner />

          {/* Connection loss, critical alerts and the alert bell (health and alerts come from the gateway) */}
          <AlertCenter />

          {/* A new version is ready, or the last update was undone */}
          <UpdateBanner />

          {/* Main App Body with Sidebar & Content */}
          <div className="flex-1 flex overflow-hidden">
            <Navigation />

            <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 max-w-7xl mx-auto w-full">
              {children}
            </main>
          </div>
        </GatewayProvider>
      </body>
    </html>
  );
}
