'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
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
import { apiClient } from '../api-client';
import { socketService, SocketConnectionState } from '../socket-service';

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
  isSimulated: boolean;
  driverType: 'hardware' | 'mock';
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

  const refreshHealth = useCallback(async () => {
    try {
      setError(null);
      const data = await apiClient.getHealth();
      setHealth(data);
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
    } finally {
      setIsLoading(false);
    }
  }, []);

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

  const isSimulated = health?.isSimulated ?? true;
  const driverType = health?.driverType ?? 'mock';

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
