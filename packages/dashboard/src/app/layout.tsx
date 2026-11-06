import type { Metadata } from 'next';
import './globals.css';
import { GatewayProvider } from '../lib/context/GatewayContext';
import { AppShell } from '../components/layout/AppShell';
import { THEME_BOOT_SCRIPT } from '../lib/theme';

export const metadata: Metadata = {
  title: 'SIZH IT Solution',
  description: 'Call handling, AI assistant and SMS from one place.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme class is set before the first paint by the boot script (the saved choice, or the system theme); 'dark' until then.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="h-screen bg-background text-slate-100 antialiased flex flex-col overflow-hidden">
        <GatewayProvider>
          <AppShell>{children}</AppShell>
        </GatewayProvider>
      </body>
    </html>
  );
}
