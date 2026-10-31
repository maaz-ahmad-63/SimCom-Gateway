import type { AiCatalogOption, AiCatalogResponse, AiSettingsView } from '@sim-gateway/shared';

/** The per-direction agent fields the gateway returns next to the shared agent profile. Empty: that kind of call uses the shared value. */
export interface DirectionAgentFields {
  inboundInstructions?: string;
  inboundGreeting?: string;
  outboundInstructions?: string;
  outboundGreeting?: string;
}

/** The fields the dashboard edits. A subset of what GET /api/ai/settings returns. */
export interface SettingsDraft {
  stt: string;
  llm: string;
  tts: string;
  ttsVoice: string;
  /** The provider's model, or null for its default. */
  ttsModel: string | null;
  language: string;
  showTranscripts: boolean;
  /** Stream caller audio to Deepgram while they speak. */
  sttStreaming: boolean;
  diagnosticRecording: boolean;
  audioSampleRate: number | null;
  autoHandle: AiSettingsView['autoHandle'];
  automation: AiSettingsView['automation'];
  agent: {
    name: string;
    instructions: string;
    greeting: string;
    enabled: boolean;
    allowHangup: boolean;
  } & DirectionAgentFields;
  params: AiSettingsView['params'];
}

export function draftFromSettings(s: AiSettingsView): SettingsDraft {
  const direction = s.agent as AiSettingsView['agent'] & DirectionAgentFields;
  return {
    stt: s.stt,
    llm: s.llm,
    tts: s.tts,
    ttsVoice: s.ttsVoice,
    ttsModel: (s as { ttsModel?: string | null }).ttsModel ?? null,
    language: s.agent.language,
    showTranscripts: s.showTranscripts,
    sttStreaming: (s as { sttStreaming?: boolean }).sttStreaming ?? false,
    diagnosticRecording: s.diagnosticRecording,
    audioSampleRate: s.audioSampleRate,
    autoHandle: s.autoHandle,
    automation: { ...s.automation },
    agent: {
      name: s.agent.name,
      instructions: s.agent.instructions,
      greeting: s.agent.greeting,
      inboundInstructions: direction.inboundInstructions ?? '',
      inboundGreeting: direction.inboundGreeting ?? '',
      outboundInstructions: direction.outboundInstructions ?? '',
      outboundGreeting: direction.outboundGreeting ?? '',
      enabled: s.agent.enabled,
      allowHangup: s.agent.allowHangup,
    },
    params: { ...s.params },
  };
}

type Patch = Record<string, unknown>;

/** Only what changed, shaped for PUT /api/ai/settings. An empty object means there is nothing to save. */
export function buildSettingsPatch(original: SettingsDraft, draft: SettingsDraft): Patch {
  const patch: Patch = {};
  for (const key of ['stt', 'llm', 'tts', 'ttsVoice', 'ttsModel', 'language', 'showTranscripts', 'sttStreaming', 'diagnosticRecording'] as const) {
    if (draft[key] !== original[key]) patch[key] = draft[key];
  }
  if (draft.audioSampleRate !== original.audioSampleRate) patch.audioSampleRate = draft.audioSampleRate;
  if (draft.autoHandle !== original.autoHandle) patch.autoHandle = draft.autoHandle;
  const automation: Patch = {};
  for (const key of Object.keys(draft.automation) as Array<keyof SettingsDraft['automation']>) {
    if (draft.automation[key] !== original.automation[key]) automation[key] = draft.automation[key];
  }
  if (Object.keys(automation).length > 0) patch.automation = automation;
  const agent: Patch = {};
  for (const key of ['name', 'instructions', 'greeting', 'inboundInstructions', 'inboundGreeting', 'outboundInstructions', 'outboundGreeting', 'enabled', 'allowHangup'] as const) {
    if (draft.agent[key] !== original.agent[key]) agent[key] = draft.agent[key];
  }
  if (Object.keys(agent).length > 0) patch.agent = agent;
  const params: Patch = {};
  for (const key of Object.keys(draft.params) as Array<keyof SettingsDraft['params']>) {
    if (draft.params[key] !== original.params[key]) params[key] = draft.params[key];
  }
  if (Object.keys(params).length > 0) patch.params = params;
  return patch;
}

export const isDirty = (original: SettingsDraft, draft: SettingsDraft): boolean =>
  Object.keys(buildSettingsPatch(original, draft)).length > 0;

const find = (options: AiCatalogOption[], key: string) => options.find((o) => o.key === key);

/** Problems the operator should see before pressing Save. The gateway validates again regardless. */
export function validateDraft(draft: SettingsDraft, catalog: AiCatalogResponse): string[] {
  const problems: string[] = [];
  const stt = find(catalog.stt, draft.stt);
  const llm = find(catalog.llm, draft.llm);
  const tts = find(catalog.tts, draft.tts);
  if (!stt) problems.push(`Unknown speech-to-text provider '${draft.stt}'`);
  else if (!stt.implemented) problems.push(`${stt.label} is listed but not ported to the gateway yet`);
  if (!llm) problems.push(`Unknown language model '${draft.llm}'`);
  else if (!llm.implemented) problems.push(`${llm.label} is listed but not ported to the gateway yet`);
  if (!tts) problems.push(`Unknown text-to-speech provider '${draft.tts}'`);
  else if (!tts.implemented) problems.push(`${tts.label} is listed but not ported to the gateway yet`);
  else {
    if (!draft.ttsVoice.trim()) problems.push('Choose a voice');
    if (draft.tts === 'deepgram' && draft.ttsVoice && !draft.ttsVoice.startsWith('aura-')) {
      problems.push('Deepgram needs an Aura voice id (starts with aura-)');
    }
    if (draft.audioSampleRate !== null && tts.sampleRates && tts.sampleRates.length > 0 && !tts.sampleRates.includes(draft.audioSampleRate)) {
      problems.push(`${tts.label} cannot produce raw ${draft.audioSampleRate} Hz audio (supports ${tts.sampleRates.join(', ')})`);
    }
  }
  const a = draft.automation;
  if (!Number.isInteger(a.autoAnswerRings) || a.autoAnswerRings < 1 || a.autoAnswerRings > 10) problems.push('Answer after 1 to 10 rings');
  if (!Number.isInteger(a.maxCallSeconds) || a.maxCallSeconds < 30 || a.maxCallSeconds > 3600) problems.push('AI time limit per call must be 30 to 3600 seconds');
  if (a.autoAnswer && draft.autoHandle !== 'inbound' && draft.autoHandle !== 'all') {
    problems.push('Auto-answer needs "Attach the AI automatically" set to incoming calls (or both), otherwise a call would be answered and nobody would listen');
  }
  if (a.autoAnswer && !a.autoActivateUsbAudio) {
    problems.push('Auto-answer needs automatic USB audio activation, otherwise the answered call has no audio for the AI');
  }
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(draft.language)) problems.push('Language must look like en or en-US');
  if (draft.agent.instructions.length > 8000) problems.push('Instructions are limited to 8000 characters');
  if (draft.agent.greeting.length > 500) problems.push('The greeting is limited to 500 characters');
  for (const [label, value] of [['Inbound', draft.agent.inboundInstructions], ['Outbound', draft.agent.outboundInstructions]] as const) {
    if ((value ?? '').length > 8000) problems.push(`${label} instructions are limited to 8000 characters`);
  }
  for (const [label, value] of [['inbound', draft.agent.inboundGreeting], ['outbound', draft.agent.outboundGreeting]] as const) {
    if ((value ?? '').length > 500) problems.push(`The ${label} greeting is limited to 500 characters`);
  }
  if (!draft.agent.name.trim()) problems.push('Give the agent a name');
  const p = draft.params;
  if (p.maxTokens !== null && (!Number.isInteger(p.maxTokens) || p.maxTokens < 16 || p.maxTokens > 4096)) {
    problems.push('Max tokens must be a whole number from 16 to 4096, or empty');
  }
  if (p.sttTimeoutMs < 500 || p.sttTimeoutMs > 60000) problems.push('STT timeout must be 500-60000 ms');
  if (p.llmFirstTokenTimeoutMs < 500 || p.llmFirstTokenTimeoutMs > 60000) problems.push('LLM first-token timeout must be 500-60000 ms');
  if (p.llmTotalTimeoutMs < 1000 || p.llmTotalTimeoutMs > 120000) problems.push('LLM total timeout must be 1000-120000 ms');
  if (p.ttsTimeoutMs < 500 || p.ttsTimeoutMs > 60000) problems.push('TTS timeout must be 500-60000 ms');
  if (p.maxResponseChars < 50 || p.maxResponseChars > 5000) problems.push('Max reply length must be 50-5000 characters');
  if (p.vadMinSilenceMs < 100 || p.vadMinSilenceMs > 5000) problems.push('End-of-speech silence must be 100-5000 ms');
  if (!(p.vadRmsThreshold >= 0.0005 && p.vadRmsThreshold <= 0.5)) problems.push('Speech level threshold must be between 0.0005 and 0.5');
  return problems;
}

/** Voices offered for a TTS provider, or an empty list when the provider has none to choose from. */
export function voicesFor(catalog: AiCatalogResponse, tts: string): Array<{ id: string; label: string }> {
  return find(catalog.tts, tts)?.voices ?? [];
}

/**
 * Switching TTS provider invalidates the old voice. Returns the draft with a voice that belongs to the
 * new provider, never silently keeping one from the old provider.
 */
export function selectTtsProvider(draft: SettingsDraft, catalog: AiCatalogResponse, tts: string): SettingsDraft {
  const voices = voicesFor(catalog, tts);
  // A model id belongs to one provider: choosing another provider returns to that provider's default model.
  return { ...draft, tts, ttsVoice: voices[0]?.id ?? '', ttsModel: null };
}

/** Order-preserving de-duplication (avoids spreading a Set, which this project's TS target does not allow). */
export const unique = <T,>(items: T[]): T[] => items.filter((v, i) => items.indexOf(v) === i);
