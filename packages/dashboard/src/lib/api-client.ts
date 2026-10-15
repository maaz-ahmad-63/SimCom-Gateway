import {
  CallSession,
  DialRequestInput,
  DtmfRequestInput,
  GatewayHealthStatus,
  TriggerMockInboundInput,
} from '@sim-gateway/shared';
import { getGatewayClientConfig } from './config';

export interface CallEventRecord {
  id: number;
  callId: string;
  eventType: string;
  previousState: string | null;
  currentState: string | null;
  payload: Record<string, unknown> | null;
  timestamp: string;
  createdAt: string;
}

export interface CallsListResponse {
  success: boolean;
  calls: CallSession[];
  total: number;
  limit: number;
  offset: number;
}

export interface CallDetailResponse {
  success: boolean;
  call: CallSession;
  events: CallEventRecord[];
}

export class GatewayApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly details?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = 'GatewayApiError';
  }
}

export class GatewayApiClient {
  private customUrl?: string;
  private customApiKey?: string;

  constructor(options?: { gatewayUrl?: string; apiKey?: string }) {
    this.customUrl = options?.gatewayUrl;
    this.customApiKey = options?.apiKey;
  }

  private getConfig(): { gatewayUrl: string; apiKey: string } {
    if (this.customUrl && this.customApiKey) {
      return { gatewayUrl: this.customUrl, apiKey: this.customApiKey };
    }
    return getGatewayClientConfig();
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const { gatewayUrl, apiKey } = this.getConfig();
    const url = `${gatewayUrl.replace(/\/+$/, '')}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      ...(options.headers as Record<string, string>),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
      });
    } catch (networkError) {
      throw new GatewayApiError(
        `Network error: Failed to connect to Gateway at ${gatewayUrl}. Please ensure gateway service is running and network is reachable.`,
        0,
        'NETWORK_ERROR'
      );
    }

    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        // Failed to parse JSON error response
      }

      const errorMessage =
        errorBody?.error || `HTTP ${response.status}: ${response.statusText}`;
      const errorCode = errorBody?.code;
      const errorDetails = errorBody?.details;

      throw new GatewayApiError(errorMessage, response.status, errorCode, errorDetails);
    }

    return (await response.json()) as T;
  }

  /** GET /api/gateway/health */
  async getHealth(): Promise<GatewayHealthStatus> {
    return this.request<GatewayHealthStatus>('/api/gateway/health');
  }

  /** GET /api/calls */
  async listCalls(options: { limit?: number; offset?: number } = {}): Promise<CallsListResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', options.limit.toString());
    if (options.offset !== undefined) params.set('offset', options.offset.toString());
    const query = params.toString() ? `?${params.toString()}` : '';

    return this.request<CallsListResponse>(`/api/calls${query}`);
  }

  /** GET /api/calls/:id */
  async getCallById(callId: string): Promise<CallDetailResponse> {
    return this.request<CallDetailResponse>(`/api/calls/${encodeURIComponent(callId)}`);
  }

  /** POST /api/calls/dial */
  async dial(request: DialRequestInput): Promise<{ success: boolean; call: CallSession }> {
    return this.request<{ success: boolean; call: CallSession }>('/api/calls/dial', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /** POST /api/calls/answer */
  async answer(): Promise<{ success: boolean; call: CallSession }> {
    return this.request<{ success: boolean; call: CallSession }>('/api/calls/answer', {
      method: 'POST',
    });
  }

  /** POST /api/calls/hangup */
  async hangup(reason?: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>('/api/calls/hangup', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  /** POST /api/calls/dtmf */
  async sendDtmf(request: DtmfRequestInput): Promise<{ success: boolean; digit: string }> {
    return this.request<{ success: boolean; digit: string }>('/api/calls/dtmf', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /** POST /api/mock/trigger-inbound */
  async triggerMockInbound(
    request: TriggerMockInboundInput
  ): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>('/api/mock/trigger-inbound', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
}

// Global default singleton instance
export const apiClient = new GatewayApiClient();
