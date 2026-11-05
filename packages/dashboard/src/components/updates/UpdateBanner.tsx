'use client';

import React from 'react';
import Link from 'next/link';
import { lastResultNotice } from '../../lib/updates';
import { useUpdates } from './useUpdates';

/** A thin notice across the top: a new version is ready, or the last update was undone. It links to Settings, where the buttons are. */
export function UpdateBanner() {
  const { update, unavailable } = useUpdates();
  if (unavailable || !update) return null;
  const last = lastResultNotice(update.lastResult, update.currentVersion);
  const rolledBack = update.lastResult?.outcome === 'rolled_back' || update.lastResult?.outcome === 'failed';
  if (!update.available && !(rolledBack && last)) return null;
  return (
    <div role="status" className="px-4 md:px-6 py-2 text-xs border-b border-cyan-900/60 bg-cyan-950/40 text-cyan-200 flex flex-wrap items-center gap-2" data-testid="update-banner">
      {update.available ? <span>Version {update.available.version} is available.</span> : <span>{last?.title}.</span>}
      <Link href="/settings" className="underline underline-offset-2 hover:text-white">
        {update.available ? 'Review and update' : 'Details'}
      </Link>
    </div>
  );
}
