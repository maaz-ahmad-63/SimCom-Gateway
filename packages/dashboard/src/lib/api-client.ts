import {
  AiAgentProfile,
  AiConversationReadiness,
  AiCatalogResponse,
  AiCredentialCheck,
  AiCredentialStatus,
  AiInspectorEvent,
  AiMode,
  AiReadinessView,
  AiSessionView,
  AiSettingsView,
  AiTestResponseReadiness,
  AiTestResponseResult,
  AiTurnLogEntry,
  AiUsageTotals,
  CallSession,
  DialRequestInput,
  DtmfRequestInput,
  GatewayHealthStatus,
  TriggerMockInboundInput,
} from '@sim-gateway/shared';
import { getGatewayClientConfig } from './config';
import type { HardwarePorts, HardwareStatus } from './hardware-ops';

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

export interface AiStateResponse {
  settings: AiSettingsView;
  readiness: AiReadinessView;
  credentials: AiCredentialStatus[];
  sessions: AiSessionView[];
  usageToday: AiUsageTotals;
  testResponse: AiTestResponseReadiness;
  conversation: AiConversationReadiness;
}

export interface AiRecording {
  name: string;
  bytes: number;
  modifiedAt: string;
  kind: 'wav' | 'raw-pcm';
  seconds: number | null;
}

export interface AiLlmTestResult {
  model: string;
  reply: string;
  firstTokenMs: number | null;
  totalMs: number;
  usage: { promptTokens: number; completionTokens: number } | null;
  estimatedCostUsd: number | null;
  mock: boolean;
}

export interface AiTtsPreviewResult {
  voice: string;
  provider: string;
  format: string;
  bytes: number;
  seconds: number;
  generationMs: number;
  chars: number;
  estimatedCostUsd: number | null;
  transmittedToCaller: false;
  audioWavBase64: string;
  mock: boolean;
}

export interface AiTtsCompatibility {
  provider: string;
  voice: string;
  gatewayFormat: string | null;
  providerSupportsGatewayRate: boolean | null;
  outboundPathVerified: boolean;
  statements: string[];
}

export interface AiSttRecordingResult {
  source: 'recording';
  file: string;
  format: string;
  startSeconds: number;
  seconds: number;
  assessment: { decision: string; rms: number; peak: number; voicedRatio: number };
  transcript: string;
  sttMs: number;
  estimatedCostUsd: number | null;
  mock: boolean;
  note: string;
}

export class GatewayApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly details?: Array<{ path: string; message: string }>,
    /** Readiness blockers or validation issues the gateway attached to the refusal. */
    public readonly reasons: string[] = []
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
      const reasons: string[] = [
        ...(Array.isArray(errorBody?.blockers) ? errorBody.blockers : []),
        ...(Array.isArray(errorBody?.issues) ? errorBody.issues : []),
      ].filter((r: unknown): r is string => typeof r === 'string');

      throw new GatewayApiError(errorMessage, response.status, errorCode, errorDetails, reasons);
    }

    return (await response.json()) as T;
  }

  /** GET /api/gateway/health */
  async getHealth(): Promise<GatewayHealthStatus> {
    return this.request<GatewayHealthStatus>('/api/gateway/health');
  }

  /** GET /api/gateway/hardware/status — built from known state; sends no AT command. */
  async getHardwareStatus(): Promise<HardwareStatus> {
    return this.request<HardwareStatus>('/api/gateway/hardware/status');
  }

  /** GET /api/gateway/hardware/ports — lists serial ports; opens none. */
  async getHardwarePorts(): Promise<HardwarePorts> {
    return this.request<HardwarePorts>('/api/gateway/hardware/ports');
  }

  /** GET /api/gateway/hardware/modem-info — AT queries; the gateway refuses during a call. */
  async getHardwareModemInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/api/gateway/hardware/modem-info');
  }

  /** GET /api/gateway/hardware/logs */
  async getHardwareLogs(level: 'info' | 'warn' | 'error' = 'warn', limit = 100): Promise<{ entries: Array<{ at: string; level: string; line: string }> }> {
    return this.request(`/api/gateway/hardware/logs?level=${level}&limit=${limit}`);
  }

  /** GET /api/gateway/hardware/report — redacted text for a support message. */
  async getHardwareReport(): Promise<{ timestamp: string; report: string }> {
    return this.request('/api/gateway/hardware/report');
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
  /** timeoutSeconds is optional on the wire: the gateway schema defaults it to 45. */
  async dial(request: Omit<DialRequestInput, "timeoutSeconds"> & { timeoutSeconds?: number }): Promise<{ success: boolean; call: CallSession }> {
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


  // ---- AI control center (/api/ai) -------------------------------------------------------------

  private aiJson<T>(endpoint: string, method: string, body?: unknown): Promise<T> {
    return this.request<T>(`/api/ai${endpoint}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  getAiState(): Promise<AiStateResponse> {
    return this.aiJson('/state', 'GET');
  }
  getAiCatalog(): Promise<AiCatalogResponse> {
    return this.aiJson('/catalog', 'GET');
  }
  getAiEvents(callId?: string): Promise<{ events: AiInspectorEvent[] }> {
    return this.aiJson(`/events${callId ? `?callId=${encodeURIComponent(callId)}` : ''}`, 'GET');
  }
  saveAiSettings(patch: Record<string, unknown>): Promise<AiSettingsView> {
    return this.aiJson('/settings', 'PUT', patch);
  }
  saveAiAgent(patch: Partial<AiAgentProfile>): Promise<AiAgentProfile> {
    return this.aiJson('/agent', 'PUT', patch);
  }
  setAiMode(mode: AiMode): Promise<{ mode: AiMode; readiness: AiReadinessView }> {
    return this.aiJson('/mode', 'POST', { mode });
  }
  /** The key travels to the gateway once and is never returned. */
  saveAiCredential(name: string, value: string): Promise<{ credentials: AiCredentialStatus[] }> {
    return this.aiJson(`/credentials/${encodeURIComponent(name)}`, 'PUT', { value });
  }
  removeAiCredential(name: string): Promise<{ credentials: AiCredentialStatus[] }> {
    return this.aiJson(`/credentials/${encodeURIComponent(name)}`, 'DELETE');
  }
  validateAiCredential(
    name: string
  ): Promise<{ check: AiCredentialCheck; detail: string; credentials: AiCredentialStatus[] }> {
    return this.aiJson(`/credentials/${encodeURIComponent(name)}/validate`, 'POST');
  }
  attestAiAudio(kind: 'inbound' | 'outbound', note: string): Promise<{ settings: AiSettingsView; readiness: AiReadinessView }> {
    return this.aiJson(`/attestations/${kind}`, 'POST', { note });
  }
  revokeAiAttestation(kind: 'inbound' | 'outbound'): Promise<{ settings: AiSettingsView; readiness: AiReadinessView }> {
    return this.aiJson(`/attestations/${kind}`, 'DELETE');
  }
  armAiCall(callId: string): Promise<{ success: boolean }> {
    return this.aiJson(`/calls/${encodeURIComponent(callId)}/arm`, 'POST');
  }
  /** One reply, spoken to the remote party, for this one click. Billable; the gateway re-checks everything. */
  playAiTestResponse(callId: string): Promise<AiTestResponseResult> {
    return this.aiJson(`/calls/${encodeURIComponent(callId)}/test-response`, 'POST', { confirmBilling: true, confirmPlayToCaller: true });
  }
  /**
   * Per call: let the agent answer every finished caller utterance (listen, transcribe, generate, speak, listen).
   * Enabling is billable and speaks to the remote party, so it carries both confirmations; disabling never needs them.
   */
  setAiConversation(callId: string, enabled: boolean): Promise<{ success: boolean; enabled: boolean; conversation: AiConversationReadiness }> {
    return this.aiJson(`/calls/${encodeURIComponent(callId)}/conversation`, 'POST', enabled ? { enabled, confirmBilling: true, confirmPlayToCaller: true } : { enabled });
  }
  disarmAiCall(callId: string): Promise<{ success: boolean }> {
    return this.aiJson(`/calls/${encodeURIComponent(callId)}/disarm`, 'POST');
  }
  listAiRecordings(): Promise<{ recordings: AiRecording[] }> {
    return this.aiJson('/recordings', 'GET');
  }
  testAiStt(input: { file: string; startSeconds?: number; durationSeconds?: number }): Promise<AiSttRecordingResult> {
    return this.aiJson('/test/stt', 'POST', { ...input, confirmBilling: true });
  }
  testAiLlm(prompt: string): Promise<AiLlmTestResult> {
    return this.aiJson('/test/llm', 'POST', { prompt, confirmBilling: true });
  }
  previewAiTts(text: string): Promise<AiTtsPreviewResult> {
    return this.aiJson('/test/tts', 'POST', { text, confirmBilling: true });
  }
  getAiTtsCompatibility(): Promise<AiTtsCompatibility> {
    return this.aiJson('/test/tts/compatibility', 'GET');
  }
  getAiUsage(range: 'today' | '7d' | '30d' | 'all'): Promise<{ range: string; totals: AiUsageTotals }> {
    return this.aiJson(`/usage?range=${range}`, 'GET');
  }
  listAiTurns(limit = 50): Promise<{ turns: AiTurnLogEntry[] }> {
    return this.aiJson(`/turns?limit=${limit}`, 'GET');
  }
  clearAiTurns(): Promise<{ removed: number }> {
    return this.aiJson('/turns', 'DELETE');
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
