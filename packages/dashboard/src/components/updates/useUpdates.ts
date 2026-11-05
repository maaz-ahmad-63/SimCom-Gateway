'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { updateApi, UpdateView } from '../../lib/updates';

export interface UpdatesState {
  update: UpdateView | null;
  /** The update service is not part of this run of the dashboard (development), or cannot be reached. */
  unavailable: boolean;
  /** An install was started and the program is restarting; the page is waiting for the new version. */
  restarting: boolean;
  message: string | null;
  busy: 'check' | 'apply' | null;
  check: () => Promise<void>;
  apply: () => Promise<void>;
}

const api = updateApi();

/** The update state for the page: read on load and now and then, refreshed after each request, and followed through a restart. */
export function useUpdates(pollMs = 10 * 60_000): UpdatesState {
  const [update, setUpdate] = useState<UpdateView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const fromVersion = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api.status();
    if (r.ok) {
      setUnavailable(false);
      setUpdate(r.update);
      if (fromVersion.current && r.update.currentVersion !== fromVersion.current) {
        fromVersion.current = null;
        setRestarting(false);
        setMessage(null);
      }
    } else if (r.ok === false && r.code === 'NOT_AVAILABLE') setUnavailable(true);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), restarting ? 3000 : pollMs);
    return () => clearInterval(t);
  }, [refresh, restarting, pollMs]);

  const check = useCallback(async () => {
    setBusy('check');
    setMessage(null);
    const r = await api.check();
    if (r.ok) setUpdate(r.update);
    else if (r.ok === false) {
      if (r.update) setUpdate(r.update);
      setMessage(r.message);
    }
    setBusy(null);
  }, []);

  const apply = useCallback(async () => {
    setBusy('apply');
    setMessage(null);
    const started = update?.currentVersion ?? null;
    const r = await api.apply();
    if (r.ok) {
      fromVersion.current = started;
      setRestarting(true);
      setUpdate(r.update);
    } else if (r.ok === false) {
      if (r.update) setUpdate(r.update);
      setMessage(r.message);
    }
    setBusy(null);
  }, [update]);

  return { update, unavailable, restarting, message, busy, check, apply };
}
