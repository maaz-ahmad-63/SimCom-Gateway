'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AiCatalogResponse, AiInspectorEvent } from '@sim-gateway/shared';
import { AiStateResponse, apiClient } from '../api-client';
import { applyInspectorEvent, emptyInspector, InspectorState, mergeInspectorEvents } from '../ai-inspector';
import { socketService } from '../socket-service';

type InspectorAction =
  | { type: 'event'; event: AiInspectorEvent }
  | { type: 'merge'; events: AiInspectorEvent[] }
  | { type: 'reset' };

function inspectorReducer(state: InspectorState, action: InspectorAction): InspectorState {
  switch (action.type) {
    case 'event':
      return applyInspectorEvent(state, action.event);
    case 'merge':
      return mergeInspectorEvents(state, action.events);
    case 'reset':
      return emptyInspector();
  }
}

interface AiContextValue {
  state: AiStateResponse | null;
  catalog: AiCatalogResponse | null;
  inspector: InspectorState;
  /** Last failure talking to the gateway's AI API, shown as-is. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  clearInspector: () => void;
}

const AiContext = createContext<AiContextValue | null>(null);

const POLL_MS = 2500;

export function AiProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AiStateResponse | null>(null);
  const [catalog, setCatalog] = useState<AiCatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspector, dispatch] = useReducer(inspectorReducer, undefined, emptyInspector);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.getAiState();
      if (!mounted.current) return;
      setState(next);
      setError(null);
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const catchUp = useCallback(async () => {
    try {
      const { events } = await apiClient.getAiEvents();
      if (mounted.current) dispatch({ type: 'merge', events });
    } catch {
      // The live stream still works; the next reconnect tries again.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    apiClient
      .getAiCatalog()
      .then((c) => mounted.current && setCatalog(c))
      .catch((err) => mounted.current && setError((err as Error).message));
    const timer = setInterval(() => void refresh(), POLL_MS);

    const offEvent = socketService.on('ai:event', (event) => dispatch({ type: 'event', event }));
    // Events can be missed while disconnected; fetch the gateway's buffer on every (re)connect, duplicates are ignored.
    const offState = socketService.onStateChange((s) => {
      if (s === 'connected') void catchUp();
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
      offEvent();
      offState();
    };
  }, [refresh, catchUp]);

  const value = useMemo<AiContextValue>(
    () => ({ state, catalog, inspector, error, loading, refresh, clearInspector: () => dispatch({ type: 'reset' }) }),
    [state, catalog, inspector, error, loading, refresh]
  );
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

export function useAi(): AiContextValue {
  const ctx = useContext(AiContext);
  if (!ctx) throw new Error('useAi must be used inside <AiProvider>');
  return ctx;
}
