'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  CallSession,
  CallStateChangeEvent,
  GatewayHealthStatus,
  ModemNetworkStatus,
  ModemSignalQuality,
  DialRequestInput,
  DtmfRequestInput,
  TriggerMockInboundInput,
} from '@sim-gateway/shared';
import { apiClient, GatewayApiError } from '../api-client';
import { HardwareView, HealthError, hardwareView, LinkIssue, linkIssue, RelayStatusResponse } from '../hardware-mode';
import { fetchRelayStatus } from '../gateway-status';
import { socketService, SocketConnectionState } from '../socket-service';
import { reconcileCall } from '../call-sync';

export interface AudioLevelData {
  inboundRms: number;
  outboundRms: number;
  timestamp: number;
}

export interface GatewayAlert {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

export interface GatewayContextValue {
  connectionState: SocketConnectionState;
  health: GatewayHealthStatus | null;
  activeCall: CallSession | null;
  audioLevel: AudioLevelData;
  telemetry: {
    signal: ModemSignalQuality | null;
    network: ModemNetworkStatus | null;
  };
  recentAlerts: GatewayAlert[];
  /** True only when the gateway itself said it is simulated. Unknown is not simulated. */
  isSimulated: boolean;
  /** 'unknown' until the gateway has answered, directly or through the dashboard server. */
  driverType: 'hardware' | 'mock' | 'unknown';
  hardware: HardwareView;
  /** Why this browser has no live connection, or null. */
  linkIssue: LinkIssue | null;
  lastCallEnded: CallSession | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  refreshHealth: () => Promise<void>;
  dial: (request: DialRequestInput) => Promise<CallSession>;
  answer: () => Promise<CallSession>;
  hangup: (reason?: string) => Promise<void>;
  sendDtmf: (request: DtmfRequestInput) => Promise<void>;
  triggerMockInbound: (request: TriggerMockInboundInput) => Promise<void>;
  clearAlerts: () => void;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

export function GatewayProvider({ children }: { children: React.ReactNode }) {
  const [connectionState, setConnectionState] = useState<SocketConnectionState>('disconnected');
  const [health, setHealth] = useState<GatewayHealthStatus | null>(null);
  const [activeCall, setActiveCall] = useState<CallSession | null>(null);
  const activeCallRef = useRef<CallSession | null>(null);
  activeCallRef.current = activeCall;
  const [audioLevel, setAudioLevel] = useState<AudioLevelData>({
    inboundRms: 0,
    outboundRms: 0,
    timestamp: 0,
  });
  const [telemetry, setTelemetry] = useState<{
    signal: ModemSignalQuality | null;
    network: ModemNetworkStatus | null;
  }>({ signal: null, network: null });
  const [recentAlerts, setRecentAlerts] = useState<GatewayAlert[]>([]);
  const [lastCallEnded, setLastCallEnded] = useState<CallSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<HealthError | null>(null);
  const [relay, setRelay] = useState<RelayStatusResponse | null>(null);
  const lastRelayAt = useRef(0);

  /** What the dashboard server can see of the gateway (its AT-free status). Asked only while this browser has no health. */
  const refreshRelay = useCallback(async () => {
    lastRelayAt.current = Date.now();
    setRelay(await fetchRelayStatus());
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setError(null);
      const data = await apiClient.getHealth();
      setHealth(data);
      setHealthError(null);
      if (data.activeCall) {
        setActiveCall(data.activeCall);
      } else {
        setActiveCall(null);
      }
      setTelemetry({
        signal: data.modem.signal,
        network: data.modem.network,
      });
    } catch (err) {
      setError((err as Error).message);
      const api = err instanceof GatewayApiError ? err : null;
      setHealthError({ status: api?.statusCode, code: api?.code, message: (err as Error).message });
      void refreshRelay();
    } finally {
      setIsLoading(false);
    }
  }, [refreshRelay]);

  useEffect(() => {
    // 1. Initial snapshot fetch
    refreshHealth();

    // 2. Track Socket.IO connection state
    const unsubscribeState = socketService.onStateChange((state) => {
      setConnectionState(state);
      if (state === 'connected') {
        refreshHealth();
      }
    });

    // 3. Connect real-time socket
    socketService.connect();

    // 4. Register typed real-time listeners
    const unsubs = [
      socketService.on('gateway:health', (incomingHealth) => {
        setHealth(incomingHealth);
        if (incomingHealth.activeCall) {
          setActiveCall(incomingHealth.activeCall);
        } else if (incomingHealth.activeCall === null) {
          setActiveCall(null);
        }
        if (incomingHealth.modem.signal && incomingHealth.modem.network) {
          setTelemetry({
            signal: incomingHealth.modem.signal,
            network: incomingHealth.modem.network,
          });
        }
      }),

      socketService.on('call:started', (session) => {
        setActiveCall(session);
      }),

      socketService.on('call:state_changed', (evt: CallStateChangeEvent) => {
        if (evt.currentState === 'IDLE') {
          setActiveCall(null);
        } else {
          setActiveCall(evt.session);
        }
      }),

      socketService.on('call:ended', (session) => {
        setActiveCall(null);
        setLastCallEnded(session);
        setAudioLevel({ inboundRms: 0, outboundRms: 0, timestamp: Date.now() });
      }),

      socketService.on('audio:level', (data) => {
        setAudioLevel(data);
      }),

      socketService.on('modem:telemetry', (data) => {
        setTelemetry(data);
      }),

      socketService.on('gateway:alert', (alert) => {
        setRecentAlerts((prev) => [alert, ...prev.slice(0, 9)]);
      }),
    ];

    return () => {
      unsubscribeState();
      unsubs.forEach((unsub) => unsub());
      socketService.disconnect();
    };
  }, [refreshHealth]);

  // A missed socket event (reconnect, sleeping tab, gateway reload) must not leave a finished call on screen.
  // The gateway's AT-free status is the source of truth; the full health snapshot is read only on a mismatch.
  useEffect(() => {
    let misses = 0;
    let stopped = false;
    const sync = async () => {
      try {
        const status = await apiClient.getHardwareStatus();
        if (stopped) return;
        const shown = activeCallRef.current;
        const decision = reconcileCall(shown ? { id: shown.id, state: shown.state } : null, status.call, misses);
        misses = decision.misses;
        if (decision.action === 'clear') setActiveCall(null);
        else if (decision.action === 'refresh') await refreshHealth();
      } catch {
        // an unreachable gateway is already reported by the connection state; keep what is shown. The dashboard server's own
        // view of the gateway is refreshed now and then so the hardware mode and ports stay right while this browser has none.
        if (!stopped && Date.now() - lastRelayAt.current > 15_000) void refreshRelay();
      }
    };
    const timer = setInterval(sync, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [refreshHealth, refreshRelay]);

  // Actions
  const dial = async (request: DialRequestInput): Promise<CallSession> => {
    const result = await apiClient.dial(request);
    setActiveCall(result.call);
    return result.call;
  };

  const answer = async (): Promise<CallSession> => {
    const result = await apiClient.answer();
    setActiveCall(result.call);
    return result.call;
  };

  const hangup = async (reason?: string): Promise<void> => {
    await apiClient.hangup(reason);
    setActiveCall(null);
    setAudioLevel({ inboundRms: 0, outboundRms: 0, timestamp: Date.now() });
  };

  const sendDtmf = async (request: DtmfRequestInput): Promise<void> => {
    await apiClient.sendDtmf(request);
  };

  const triggerMockInbound = async (request: TriggerMockInboundInput): Promise<void> => {
    await apiClient.triggerMockInbound(request);
  };

  const clearAlerts = () => setRecentAlerts([]);

  // The gateway is the authority on its hardware. Without an answer from it (directly or through the dashboard server) the
  // mode is unknown: it is never assumed to be a simulation, and never shown as one.
  const hardware = useMemo(() => hardwareView(health, relay), [health, relay]);
  const issue = useMemo(() => (health ? null : linkIssue(healthError, relay)), [health, healthError, relay]);
  const isSimulated = hardware.mode === 'mock';
  const driverType = hardware.mode;

  return (
    <GatewayContext.Provider
      value={{
        connectionState,
        health,
        activeCall,
        audioLevel,
        telemetry,
        recentAlerts,
        isSimulated,
        driverType,
        hardware,
        linkIssue: issue,
        lastCallEnded,
        isLoading,
        error,
        refreshHealth,
        dial,
        answer,
        hangup,
        sendDtmf,
        triggerMockInbound,
        clearAlerts,
      }}
    >
      {children}
    </GatewayContext.Provider>
  );
}

export function useGateway(): GatewayContextValue {
  const context = useContext(GatewayContext);
  if (!context) {
    throw new Error('useGateway must be used within a GatewayProvider');
  }
  return context;
}
