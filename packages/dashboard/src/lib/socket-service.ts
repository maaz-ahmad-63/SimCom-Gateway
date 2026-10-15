import { io, Socket } from 'socket.io-client';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  CallSession,
  CallStateChangeEvent,
  GatewayHealthStatus,
  ModemNetworkStatus,
  ModemSignalQuality,
  UrcEvent,
} from '@sim-gateway/shared';
import { getGatewayClientConfig } from './config';

export type SocketConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export type SocketListener<T> = (data: T) => void;

export class GatewaySocketService {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private connectionState: SocketConnectionState = 'disconnected';
  private stateChangeListeners = new Set<(state: SocketConnectionState) => void>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('gateway-config-changed', () => {
        this.reconnect();
      });
    }
  }

  getConnectionState(): SocketConnectionState {
    return this.connectionState;
  }

  onStateChange(listener: (state: SocketConnectionState) => void): () => void {
    this.stateChangeListeners.add(listener);
    listener(this.connectionState);
    return () => this.stateChangeListeners.delete(listener);
  }

  connect(): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (this.socket?.connected) {
      return this.socket;
    }

    if (this.socket) {
      this.socket.disconnect();
    }

    const { gatewayUrl, apiKey } = getGatewayClientConfig();
    this.updateState('connecting');

    this.socket = io(gatewayUrl, {
      auth: { token: apiKey },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      this.updateState('connected');
    });

    this.socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') {
        this.updateState('disconnected');
      } else {
        this.updateState('connecting');
      }
    });

    this.socket.on('connect_error', (_err) => {
      this.updateState('error');
    });

    return this.socket;
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.updateState('disconnected');
  }

  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  on<E extends keyof ServerToClientEvents>(
    event: E,
    listener: ServerToClientEvents[E]
  ): () => void {
    const socket = this.socket || this.connect();
    socket.on(event as any, listener as any);

    return () => {
      socket.off(event as any, listener as any);
    };
  }

  emit<E extends keyof ClientToServerEvents>(
    event: E,
    ...args: Parameters<ClientToServerEvents[E]>
  ): void {
    const socket = this.socket || this.connect();
    (socket.emit as any)(event, ...args);
  }

  private updateState(newState: SocketConnectionState): void {
    if (this.connectionState !== newState) {
      this.connectionState = newState;
      this.stateChangeListeners.forEach((fn) => fn(newState));
    }
  }
}

// Global default singleton instance
export const socketService = new GatewaySocketService();
