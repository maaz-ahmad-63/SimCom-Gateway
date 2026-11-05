'use client';

import React, { useEffect, useState } from 'react';
import { fetchSupervisorSecrets, StorageNotice as Notice, storageNotice, SupervisorSecrets } from '../../lib/secret-storage';

/** The notice itself, with no state, so every case can be drawn and tested. */
export function StorageNoticeView({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const tone = notice.tone === 'bad' ? 'border-rose-800/70 bg-rose-950/40 text-rose-100' : 'border-amber-800/70 bg-amber-950/50 text-amber-200';
  return (
    <div role="alert" className={`text-xs rounded-md border px-3 py-2 space-y-1 ${tone}`} data-testid="storage-notice" data-tone={notice.tone}>
      <p>
        <strong>{notice.title}.</strong> {notice.message}
      </p>
      {notice.action && <p>What to do: {notice.action}</p>}
    </div>
  );
}

/** Asks the supervisor (when there is one) whether the encryption key is in order, and explains it if not. */
export function StorageNotice({ storageAvailable }: { storageAvailable: boolean }) {
  const [supervisor, setSupervisor] = useState<SupervisorSecrets | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchSupervisorSecrets(typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname).then((s) => alive && setSupervisor(s));
    return () => {
      alive = false;
    };
  }, [storageAvailable]);
  return <StorageNoticeView notice={storageNotice({ storageAvailable, supervisor })} />;
}
