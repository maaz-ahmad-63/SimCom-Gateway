'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AiCatalogResponse, AiInspectorEvent } from '@sim-gateway/shared';
import { AiStateResponse, apiClient } from '../api-client';
import { applyInspectorEvent, emptyInspector, InspectorState, mergeInspectorEvents } from '../ai-inspector';
import { catalogChanged } from '../catalog-sync';
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
  /** Fetch the model catalog again (after the registry changed). The page also does this by itself when the gateway reports a new revision. */
  refreshCatalog: () => Promise<void>;
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
  const catalogRevision = useRef<number | null>(null);

  const refreshCatalog = useCallback(async () => {
    try {
      const next = await apiClient.getAiCatalog();
      if (mounted.current) setCatalog(next);
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.getAiState();
      if (!mounted.current) return;
      setState(next);
      setError(null);
      // The model registry changed since the catalog was fetched (a model added, switched off or removed): fetch it again.
      const check = catalogChanged(catalogRevision.current, next);
      catalogRevision.current = check.revision;
      if (check.reload && catalogRevision.current !== null) void refreshCatalog();
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [refreshCatalog]);

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
    void refreshCatalog();
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
  }, [refresh, refreshCatalog, catchUp]);

  const value = useMemo<AiContextValue>(
    () => ({ state, catalog, inspector, error, loading, refresh, refreshCatalog, clearInspector: () => dispatch({ type: 'reset' }) }),
    [state, catalog, inspector, error, loading, refresh, refreshCatalog]
  );
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

export function useAi(): AiContextValue {
  const ctx = useContext(AiContext);
  if (!ctx) throw new Error('useAi must be used inside <AiProvider>');
  return ctx;
}
