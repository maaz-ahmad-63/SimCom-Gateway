import type { AudioVerificationResponse, CallAudioVerification } from './audio-verification';
import type { TtsVoicesResponse } from './tts-voices';
import type { CredentialImportPreview, CredentialImportResult } from './env-import';
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
import type { RecordingsResponse } from './recordings';
import type { Attempt, Campaign, ColumnMapping, Contact, ContactStatus, Counts, CsvPreview, ImportResult, Review, RunnerStatus } from './campaigns';
import type { CampaignUsage, LlmChoice } from './campaign-config';
import type { BackupInfo, NetworkReading, OpsAlert, OpsHealth } from './ops';

/** The gateway API version this dashboard was built for. A gateway on another version says so on the System health page. */
export const DASHBOARD_API_VERSION = 1;
import { callQueryString } from './campaign-calls';
import type { CallAnalytics, CallList, CallQuery, CampaignCallDetail } from './campaign-calls';
import type { SheetsConfig, SheetsStatus, SheetsTestResult } from './integrations';
import type { IvrAssetMeta, IvrAudioRules, IvrConfig, IvrOverview, IvrPublished, IvrStatus, IvrValidation } from './ivr';
import type { GenerateRequest, GenerateResponse, TtsOptions } from './ivr-generate';
import type { EntryKind, HubView, ProposalDetail, SourceCheck, Stage, TestResult, ValidationIssue } from './model-hub';
import { buildQuery } from './observability';
import type { CallDetail, CallFilters, CallRow, Overview, Paged, TraceEvent } from './observability';

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

  /**
   * GET /api/gateway/recordings — complete-call recordings (not diagnostic captures). With `callIds` it answers for exactly those calls
   * (the call history asks about the page it is showing), and each one says whether it can be played.
   */
  async getRecordings(callIds?: string[]): Promise<RecordingsResponse> {
    const query = callIds && callIds.length > 0 ? `?ids=${callIds.map(encodeURIComponent).join(',')}` : '';
    return this.request<RecordingsResponse>(`/api/gateway/recordings${query}`);
  }

  /**
   * GET /api/gateway/recordings/:callId/audio.wav: the ONE combined recording of a call, fetched with the API key (an <audio> tag cannot
   * send it, so the file is fetched here and played from the browser's own copy).
   */
  async downloadRecording(callId: string): Promise<Blob> {
    const { gatewayUrl, apiKey } = this.getConfig();
    let response: Response;
    try {
      response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/gateway/recordings/${encodeURIComponent(callId)}/audio.wav`, {
        headers: { 'x-api-key': apiKey },
      });
    } catch {
      throw new GatewayApiError(`Network error: Failed to connect to Gateway at ${gatewayUrl}.`, 0, 'NETWORK_ERROR');
    }
    if (response.status === 404) throw new GatewayApiError('No recording exists for this call.', 404, 'RECORDING_NOT_FOUND');
    if (response.status === 401) throw new GatewayApiError('The gateway did not accept the API key, so the recording was not sent.', 401);
    if (!response.ok) throw new GatewayApiError(`Could not load the recording (HTTP ${response.status})`, response.status);
    return response.blob();
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
  /** Automatic call-audio verification: whether it is on, the call in progress (or the last one), and recent calls. */
  getAudioVerification(limit = 20): Promise<AudioVerificationResponse> {
    return this.aiJson(`/audio-verification?limit=${encodeURIComponent(String(limit))}`, 'GET');
  }
  getCallAudioVerification(callId: string): Promise<CallAudioVerification> {
    return this.aiJson(`/audio-verification/${encodeURIComponent(callId)}`, 'GET');
  }
  /** Diagnostic: arm the key-press test on a call in progress (a person asks the caller to press the key). */
  armAudibilityKeyTest(callId: string, key = '1'): Promise<CallAudioVerification> {
    return this.aiJson(`/audio-verification/${encodeURIComponent(callId)}/key-test`, 'POST', { key });
  }
  getAiCatalog(): Promise<AiCatalogResponse> {
    return this.aiJson('/catalog', 'GET');
  }
  /** A text-to-speech option's voices, read from the provider by the gateway (cached there; `refresh` asks the provider again). */
  getTtsVoices(tts: string, opts: { model?: string | null; refresh?: boolean } = {}): Promise<TtsVoicesResponse> {
    const q = new URLSearchParams();
    if (opts.model) q.set('model', opts.model);
    if (opts.refresh) q.set('refresh', '1');
    const qs = q.toString();
    return this.aiJson(`/voices/${encodeURIComponent(tts)}${qs ? `?${qs}` : ''}`, 'GET');
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
  /** What importing pasted .env text would do. Nothing is stored. */
  previewCredentialImport(text: string): Promise<CredentialImportPreview> {
    return this.aiJson('/credentials/import/preview', 'POST', { text });
  }
  /** Stores the recognised keys from pasted .env text (only the chosen names, when given) in the gateway's encrypted store. */
  applyCredentialImport(text: string, only?: string[]): Promise<CredentialImportResult> {
    return this.aiJson('/credentials/import/apply', 'POST', only ? { text, only } : { text });
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

  // ---- AI Model Hub (the provider and model registry, with prices kept apart) ----
  /** Every list the hub shows comes from here; the dashboard keeps no model list of its own. */
  getModelHub(): Promise<HubView> {
    return this.request('/api/ai/registry');
  }
  validateRegistryEntry(kind: EntryKind, entry: unknown): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
    return this.request('/api/ai/registry/validate', { method: 'POST', body: JSON.stringify({ kind, entry }) });
  }
  validateRegistryDocument(document: unknown): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
    return this.request('/api/ai/registry/validate', { method: 'POST', body: JSON.stringify({ document }) });
  }
  createProvider(entry: unknown): Promise<{ success: true; registry: HubView }> {
    return this.request('/api/ai/registry/providers', { method: 'POST', body: JSON.stringify(entry) });
  }
  updateProvider(id: string, patch: Record<string, unknown>): Promise<{ success: true; registry: HubView }> {
    return this.request(`/api/ai/registry/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  deleteProvider(id: string): Promise<{ success: true; registry: HubView }> {
    return this.request(`/api/ai/registry/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  createModel(entry: unknown): Promise<{ success: true; registry: HubView }> {
    return this.request('/api/ai/registry/models', { method: 'POST', body: JSON.stringify(entry) });
  }
  updateModel(stage: Stage, id: string, patch: Record<string, unknown>): Promise<{ success: true; registry: HubView }> {
    return this.request(`/api/ai/registry/models/${stage}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  deleteModel(stage: Stage, id: string): Promise<{ success: true; registry: HubView }> {
    return this.request(`/api/ai/registry/models/${stage}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  /** With no ids: add the default entries missing from the registry. With ids: reset those entries to their defaults. */
  restoreRegistryDefaults(ids?: Array<{ kind: 'provider'; id: string } | { kind: 'model'; stage: Stage; id: string }>): Promise<{ success: true; registry: HubView }> {
    return this.request('/api/ai/registry/restore-defaults', { method: 'POST', body: JSON.stringify({ ids }) });
  }
  exportRegistry(): Promise<Record<string, unknown>> {
    return this.request('/api/ai/registry/export');
  }
  importRegistry(document: unknown): Promise<{ success: true; registry: HubView }> {
    return this.request('/api/ai/registry/import', { method: 'POST', body: JSON.stringify({ document }) });
  }
  /** Read-only: lists the provider's models or voices with its key; nothing is generated or billed. */
  testRegistryProvider(id: string): Promise<TestResult> {
    return this.request(`/api/ai/registry/test/provider/${encodeURIComponent(id)}`, { method: 'POST' });
  }
  /**
   * A language model is tested with one very short REAL request (billed): pass confirmBilling once the operator has agreed. Speech models
   * get a read-only check of the key and the provider's model list.
   */
  testRegistryModel(stage: Stage, id: string, options: { confirmBilling?: boolean } = {}): Promise<TestResult> {
    return this.request(`/api/ai/registry/test/model/${stage}/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(options) });
  }
  /** Fetches the official pricing sources, only when asked. It changes no price. */
  checkPricingSources(providerIds?: string[]): Promise<{ checks: SourceCheck[]; registry: HubView }> {
    return this.request('/api/ai/registry/pricing/check', { method: 'POST', body: JSON.stringify({ providerIds, force: true }) });
  }
  proposePrices(entries: unknown[], note?: string): Promise<{ success: true; proposal: ProposalDetail; registry: HubView }> {
    return this.request('/api/ai/registry/pricing/proposals', { method: 'POST', body: JSON.stringify({ entries, note }) });
  }
  getPriceProposal(id: string): Promise<ProposalDetail> {
    return this.request(`/api/ai/registry/pricing/proposals/${encodeURIComponent(id)}`);
  }
  approvePriceProposal(id: string, options: { onlyIds?: string[]; overrideIds?: string[] } = {}): Promise<{ success: true; applied: string[]; skipped: Array<{ id: string; reason: string }>; registry: HubView }> {
    return this.request(`/api/ai/registry/pricing/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify(options) });
  }
  rejectPriceProposal(id: string, note?: string): Promise<{ success: true; registry: HubView }> {
    return this.request(`/api/ai/registry/pricing/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify({ note }) });
  }

  // ---- integrations (Google Sheets) ----
  getGoogleSheets(): Promise<SheetsStatus> {
    return this.request('/api/integrations/google-sheets');
  }
  saveGoogleSheets(patch: Partial<SheetsConfig>): Promise<SheetsStatus> {
    return this.request('/api/integrations/google-sheets', { method: 'PUT', body: JSON.stringify(patch) });
  }
  /** The key file travels to the gateway once and is never returned. */
  saveGoogleSheetsCredential(serviceAccountJson: string): Promise<SheetsStatus> {
    return this.request('/api/integrations/google-sheets/credential', { method: 'PUT', body: JSON.stringify({ serviceAccountJson }) });
  }
  deleteGoogleSheetsCredential(): Promise<SheetsStatus> {
    return this.request('/api/integrations/google-sheets/credential', { method: 'DELETE' });
  }
  /** Read-only: signs in and opens the sheet, never writes to it. */
  testGoogleSheets(): Promise<{ result: SheetsTestResult; status: SheetsStatus }> {
    return this.request('/api/integrations/google-sheets/test', { method: 'POST' });
  }

  // ---- campaigns ----
  listCampaigns(): Promise<{ campaigns: Array<Campaign & { counts: Counts }> }> {
    return this.request('/api/campaigns');
  }
  createCampaign(name: string, settings?: Record<string, unknown>): Promise<{ campaign: Campaign; counts: Counts }> {
    return this.request('/api/campaigns', { method: 'POST', body: JSON.stringify({ name, settings }) });
  }
  getCampaign(id: string): Promise<{ campaign: Campaign; counts: Counts; runner: RunnerStatus | null }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}`);
  }
  updateCampaign(id: string, patch: { name?: string; settings?: Record<string, unknown>; config?: { prompt?: string; llmKey?: string | null } }): Promise<{ campaign: Campaign; counts: Counts; runner: RunnerStatus | null }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  deleteCampaign(id: string): Promise<{ success: boolean }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  /** With a mapping (and optionally the campaign whose country code and consent rule apply) the answer also previews what an import would do. Nothing is stored. */
  previewCampaignCsv(csv: string, options: { mapping?: ColumnMapping; campaignId?: string } = {}): Promise<CsvPreview> {
    return this.request('/api/campaigns/preview-csv', { method: 'POST', body: JSON.stringify({ csv, ...options }) });
  }
  /** The language models a campaign can choose, whether each can be used now, and what is known about its prompt caching. */
  getCampaignLlmOptions(): Promise<{ models: LlmChoice[] }> {
    return this.request('/api/campaigns/llm-options');
  }
  /** What the campaign's calls used, as the providers reported it. */
  getCampaignUsage(id: string): Promise<CampaignUsage> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/usage`);
  }
  // ---- operations: health, alerts, network, backups ----------------------------------------------------------------------------------
  getOpsHealth(refresh = false): Promise<OpsHealth> {
    return this.request(`/api/ops/health${refresh ? '?refresh=1' : ''}`);
  }
  getOpsAlerts(): Promise<{ alerts: OpsAlert[] }> {
    return this.request('/api/ops/alerts');
  }
  getOpsAlertHistory(page = 1): Promise<{ page: number; pageSize: number; total: number; items: OpsAlert[] }> {
    return this.request(`/api/ops/alerts/history?page=${page}&pageSize=25`);
  }
  acknowledgeOpsAlert(id: number): Promise<{ alert: OpsAlert }> {
    return this.request(`/api/ops/alerts/${id}/acknowledge`, { method: 'POST', body: '{}' });
  }
  dismissOpsAlert(id: number): Promise<{ alert: OpsAlert }> {
    return this.request(`/api/ops/alerts/${id}/dismiss`, { method: 'POST', body: '{}' });
  }
  /** Re-reads the state behind an alert. It never reconnects hardware, restarts anything or places a call. */
  recheckOpsAlert(id: number): Promise<{ alert: OpsAlert; health: OpsHealth }> {
    return this.request(`/api/ops/alerts/${id}/recheck`, { method: 'POST', body: '{}' });
  }
  getOpsAlertDiagnostics(id: number): Promise<{ alert: OpsAlert; details: unknown }> {
    return this.request(`/api/ops/alerts/${id}/diagnostics`);
  }
  getOpsNetwork(): Promise<{ reading: NetworkReading | null }> {
    return this.request('/api/ops/network');
  }
  refreshOpsNetwork(): Promise<{ reading: NetworkReading }> {
    return this.request('/api/ops/network/refresh', { method: 'POST', body: '{}' });
  }
  getOpsBackups(): Promise<{ backups: BackupInfo[]; pendingRestore: { name: string; stagedAt: string } | null }> {
    return this.request('/api/ops/backups');
  }
  createOpsBackup(): Promise<{ backup: BackupInfo }> {
    return this.request('/api/ops/backups', { method: 'POST', body: '{}' });
  }
  stageOpsRestore(name: string): Promise<{ staged: string; requiresRestart: boolean; message: string }> {
    return this.request('/api/ops/backups/restore', { method: 'POST', body: JSON.stringify({ name, confirm: true }) });
  }
  cancelOpsRestore(): Promise<{ cancelled: boolean }> {
    return this.request('/api/ops/backups/restore', { method: 'DELETE' });
  }
  getOpsVersion(): Promise<{ app: string; schema: number; node: string; apiVersion: number; startedAt: string; compatible: boolean; message: string }> {
    return this.request(`/api/ops/version?dashboardApi=${DASHBOARD_API_VERSION}`);
  }
  /** The support bundle, fetched with the API key (a plain link cannot send it). It holds no keys, passwords, phone numbers or transcripts. */
  async downloadSupportBundle(): Promise<Blob> {
    const { gatewayUrl, apiKey } = this.getConfig();
    let response: Response;
    try {
      response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/ops/support-bundle`, { headers: { 'x-api-key': apiKey } });
    } catch {
      throw new GatewayApiError(`Network error: Failed to connect to Gateway at ${gatewayUrl}.`, 0, 'NETWORK_ERROR');
    }
    if (!response.ok) throw new GatewayApiError(`Could not create the support bundle (HTTP ${response.status})`, response.status);
    return response.blob();
  }

  /** One campaign's call records (the table), filtered, searched, sorted and paged by the gateway. */
  listCampaignCalls(id: string, query: CallQuery = {}): Promise<CallList> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/calls${callQueryString(query)}`);
  }
  getCampaignCall(id: string, attemptId: number): Promise<{ call: CampaignCallDetail }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/calls/${attemptId}`);
  }
  getCampaignAnalytics(id: string): Promise<CallAnalytics> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/analytics`);
  }
  /** Asks the model to read this call again. The earlier result is kept. */
  analyzeCampaignCall(id: string, attemptId: number): Promise<{ result: { status: string; reason?: string }; call: CampaignCallDetail }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/calls/${attemptId}/analyze`, { method: 'POST', body: '{}' });
  }
  correctCampaignCall(id: string, attemptId: number, patch: NonNullable<ReturnType<typeof import('./campaign-calls').correctionPatch>>): Promise<{ call: CampaignCallDetail }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/calls/${attemptId}/classification`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  clearCampaignCallCorrection(id: string, attemptId: number): Promise<{ removed: boolean; call: CampaignCallDetail }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/calls/${attemptId}/classification`, { method: 'DELETE' });
  }
  /** The filtered records as a CSV file, fetched with the API key (a plain link cannot send it). */
  async downloadCampaignCallsCsv(id: string, query: CallQuery = {}): Promise<Blob> {
    const { gatewayUrl, apiKey } = this.getConfig();
    let response: Response;
    try {
      response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/campaigns/${encodeURIComponent(id)}/calls/export.csv${callQueryString({ ...query, page: undefined, pageSize: undefined })}`, { headers: { 'x-api-key': apiKey } });
    } catch {
      throw new GatewayApiError(`Network error: Failed to connect to Gateway at ${gatewayUrl}.`, 0, 'NETWORK_ERROR');
    }
    if (!response.ok) throw new GatewayApiError(`Could not export the calls (HTTP ${response.status})`, response.status);
    return response.blob();
  }
  importCampaignContacts(id: string, csv: string, mapping: ColumnMapping): Promise<ImportResult> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify({ csv, mapping }) });
  }
  listCampaignContacts(id: string, query: { status?: ContactStatus; q?: string; page: number; pageSize: number }): Promise<{ page: number; pageSize: number; total: number; items: Contact[] }> {
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
    if (query.status) params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/contacts?${params.toString()}`);
  }
  getCampaignContact(id: string, contactId: number): Promise<{ contact: Contact; attempts: Attempt[] }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/contacts/${contactId}`);
  }
  optOutCampaignContact(id: string, contactId: number): Promise<{ skippedContacts: number }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/contacts/${contactId}/opt-out`, { method: 'POST' });
  }
  getCampaignReview(id: string): Promise<Review> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/review`);
  }
  /** Runs a completed or stopped campaign again on its current contact list. The same confirmation as a first start. */
  restartCampaign(id: string, confirmName: string): Promise<{ skippedAtStart: number; campaign: Campaign; counts: Counts }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/restart`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, confirmName, acknowledgements: { realCalls: true, regulations: true, consent: true } }),
    });
  }
  startCampaign(id: string, confirmName: string): Promise<{ skippedAtStart: number; campaign: Campaign; counts: Counts }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, confirmName, acknowledgements: { realCalls: true, regulations: true, consent: true } }),
    });
  }
  controlCampaign(id: string, action: 'pause' | 'resume' | 'stop'): Promise<{ campaign: Campaign; counts: Counts }> {
    return this.request(`/api/campaigns/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  }
  getCampaignReadiness(): Promise<{ blockers: string[]; runner: RunnerStatus }> {
    return this.request('/api/campaigns/readiness');
  }
  listDoNotCall(): Promise<{ total: number; items: Array<{ phone: string; reason: string | null; source: string; addedAt: string }> }> {
    return this.request('/api/campaigns/do-not-call');
  }
  addDoNotCall(phone: string, reason?: string, defaultCountryCode?: string): Promise<{ phone: string; skippedContacts: number }> {
    return this.request('/api/campaigns/do-not-call', { method: 'POST', body: JSON.stringify({ phone, reason: reason || undefined, defaultCountryCode: defaultCountryCode || undefined }) });
  }
  removeDoNotCall(phone: string): Promise<{ removed: boolean }> {
    return this.request(`/api/campaigns/do-not-call/${encodeURIComponent(phone)}`, { method: 'DELETE' });
  }

  // ---- call observability (read-only, database-backed) ----
  getObservabilityOverview(filters: CallFilters): Promise<Overview & { success: boolean }> {
    return this.request(`/api/observability/overview${buildQuery(filters)}`);
  }
  listObservabilityCalls(filters: CallFilters, page: { page: number; pageSize: number }): Promise<Paged<CallRow> & { success: boolean }> {
    return this.request(`/api/observability/calls${buildQuery(filters, page)}`);
  }
  getObservabilityStatus(): Promise<{ success: boolean; events: number; oldestAt: string | null; failedWrites: number; retention: { retentionDays: number; maxEvents: number } | null }> {
    return this.request('/api/observability/status');
  }
  getObservabilityCall(id: string): Promise<CallDetail & { success: boolean }> {
    return this.request(`/api/observability/calls/${encodeURIComponent(id)}`);
  }
  listObservabilityErrors(filters: CallFilters, page: { page: number; pageSize: number }): Promise<Paged<TraceEvent> & { success: boolean }> {
    return this.request(`/api/observability/errors${buildQuery(filters, page)}`);
  }

  // ---- IVR (the gateway's /api/ivr) -----------------------------------------------------------------------------------------------

  /** GET /api/ivr: status, draft, published configuration, validation, audio library, limits and whether the controller is running. */
  getIvr(): Promise<IvrOverview> {
    return this.request('/api/ivr');
  }
  /** PUT /api/ivr/draft: the draft must match the model but may be incomplete. */
  saveIvrDraft(config: IvrConfig): Promise<{ success: boolean; draft: IvrConfig; validation: IvrValidation; status: IvrStatus }> {
    return this.request('/api/ivr/draft', { method: 'PUT', body: JSON.stringify(config) });
  }
  /** DELETE /api/ivr/draft: back to the published configuration (or an empty one). */
  discardIvrDraft(): Promise<{ success: boolean; draft: IvrConfig; validation: IvrValidation; status: IvrStatus }> {
    return this.request('/api/ivr/draft', { method: 'DELETE' });
  }
  /** POST /api/ivr/validate: checks the given configuration, or the saved draft when none is given. Changes nothing. */
  validateIvr(config?: IvrConfig): Promise<{ success: boolean; validation: IvrValidation }> {
    return this.request('/api/ivr/validate', { method: 'POST', body: JSON.stringify(config ?? {}) });
  }
  /** POST /api/ivr/publish: refused (422, with details) unless the saved draft is complete. */
  publishIvr(): Promise<{ success: boolean; published: IvrPublished; status: IvrStatus }> {
    return this.request('/api/ivr/publish', { method: 'POST' });
  }
  /** PUT /api/ivr/enabled: off by default; refused (409) until something is published. */
  setIvrEnabled(enabled: boolean): Promise<{ success: boolean; enabled: boolean; status: IvrStatus }> {
    return this.request('/api/ivr/enabled', { method: 'PUT', body: JSON.stringify({ enabled }) });
  }
  /** POST /api/ivr/assets?name=...: the WAV file itself is the request body, stored exactly as sent. */
  uploadIvrAsset(file: Blob, name: string): Promise<{ success: boolean; asset: IvrAssetMeta; duplicate: boolean; assets: IvrAssetMeta[]; audio: IvrAudioRules }> {
    return this.request(`/api/ivr/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: file });
  }
  /** GET /api/ivr/generate/options: the Model Hub's voice models and whether each can be used now. Calls no provider. */
  async getIvrTtsOptions(): Promise<TtsOptions> {
    return this.request('/api/ivr/generate/options');
  }
  /** POST /api/ivr/generate: speech from text, as a base64 WAV already in the IVR format. Stores nothing; add it with uploadIvrAsset. */
  generateIvrAudio(input: GenerateRequest): Promise<GenerateResponse> {
    return this.request('/api/ivr/generate', { method: 'POST', body: JSON.stringify(input) });
  }
  /** DELETE /api/ivr/assets/:id: refused (409) while the draft or the published configuration uses the file. */
  deleteIvrAsset(id: string): Promise<{ success: boolean; removed: boolean; assets: IvrAssetMeta[]; audio: IvrAudioRules }> {
    return this.request(`/api/ivr/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  /** GET /api/ivr/assets/:id/audio: the stored WAV, authenticated, for the preview player. */
  async downloadIvrAsset(id: string): Promise<Blob> {
    const { gatewayUrl, apiKey } = this.getConfig();
    let response: Response;
    try {
      response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/ivr/assets/${encodeURIComponent(id)}/audio`, { headers: { 'x-api-key': apiKey } });
    } catch {
      throw new GatewayApiError(`Network error: Failed to connect to Gateway at ${gatewayUrl}.`, 0, 'NETWORK_ERROR');
    }
    if (!response.ok) throw new GatewayApiError(`Could not load the audio file (HTTP ${response.status})`, response.status);
    return response.blob();
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
