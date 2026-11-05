import { formatBytes, formatDuration } from './ivr';

/**
 * "Generate audio" for the IVR audio library: the dashboard's copy of what the gateway's /api/ivr/generate routes return (the shared
 * package resolves through its built dist, so these stay dashboard-local like the rest of ./ivr), and the pure helpers the form uses.
 */

export interface TtsVoiceChoice {
  name: string;
  label: string;
}

/** One text-to-speech model of the Model Hub, with whether it can be used right now. */
export interface TtsModelChoice {
  key: string;
  label: string;
  provider: string;
  protocol: string | null;
  /** The provider's own model ids that can be picked (empty: the voice decides). */
  models: string[];
  defaultModel: string | null;
  defaultVoice: string;
  voices: TtsVoiceChoice[];
  sampleRates: number[];
  available: boolean;
  unavailableReason: string | null;
  /** The model the AI agent currently speaks with. */
  current: boolean;
}

export interface TtsOptions {
  sampleRate: number;
  maxChars: number;
  models: TtsModelChoice[];
}

export interface GenerateRequest {
  text: string;
  model: string;
  providerModel?: string;
  voice?: string;
  /** The gateway refuses without it: the text goes to a provider that may bill for it. */
  confirmBilling: true;
}

export interface GeneratedInfo {
  model: string;
  provider: string;
  providerModel: string | null;
  voice: string;
  chars: number;
  sourceSampleRate: number;
  converted: boolean;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  bytes: number;
  durationMs: number;
  generationMs: number;
}

export interface GenerateResponse {
  success: boolean;
  info: GeneratedInfo;
  audioWavBase64: string;
}

/** The model to start on: the one asked for if it can be used, else the one the AI agent uses, else the first usable one ('' when none). */
export function chooseModel(options: TtsOptions, preferred?: string | null): string {
  const usable = options.models.filter((m) => m.available);
  return (usable.find((m) => m.key === preferred) ?? usable.find((m) => m.current) ?? usable[0])?.key ?? '';
}

/** The voices to offer for a model: the registry's list, with the default voice included even when the list does not name it. */
export function voicesOf(model: TtsModelChoice | undefined): TtsVoiceChoice[] {
  if (!model) return [];
  const list = [...model.voices];
  if (model.defaultVoice && !list.some((v) => v.name === model.defaultVoice)) list.unshift({ name: model.defaultVoice, label: `${model.defaultVoice} (default)` });
  return list;
}

/** Why Generate cannot be pressed yet, as a sentence; null when it can. */
export function generateProblem(input: { text: string; modelKey: string; options: TtsOptions | null }): string | null {
  const { options } = input;
  if (!options) return 'The voice models have not loaded yet.';
  if (!options.models.some((m) => m.available)) return 'No voice model can be used right now. Set a provider API key in the AI Agent settings first.';
  if (!input.modelKey) return 'Choose a voice model.';
  const model = options.models.find((m) => m.key === input.modelKey);
  if (!model) return 'That voice model no longer exists. Choose another.';
  if (!model.available) return model.unavailableReason ?? 'That voice model cannot be used right now.';
  const text = input.text.trim();
  if (text.length === 0) return 'Enter the announcement text.';
  if (text.length > options.maxChars) return `The text is ${text.length} characters; the limit is ${options.maxChars}.`;
  return null;
}

/** A library name from the first words of the text (at most 60 characters), or '' when the text has none. */
export function suggestName(text: string): string {
  const words = text
    .replace(/[.,;:!?"“”‘’()[\]{}<>/\\|@#$%^&*+=~`_]+/g, ' ') // punctuation only: letters of every script stay
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
  return words.length > 60 ? words.slice(0, 60).replace(/\s+\S*$/, '') : words;
}

/** A file name safe on every system, always ending in .wav. */
export function wavFileName(name: string): string {
  const base = name
    .trim()
    .replace(/\.wav$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '') // what Windows and other systems refuse in a file name
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'announcement'}.wav`;
}

/** The gateway's base64 WAV as a Blob the browser can play, download and upload as it is. */
export function wavBlobFromBase64(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}

/** One line about a generated file. */
export function describeGenerated(info: GeneratedInfo): string {
  const parts = [`${formatDuration(info.durationMs)}`, `${info.sampleRate} Hz mono ${info.bitsPerSample}-bit WAV`, formatBytes(info.bytes), `${info.provider}, voice ${info.voice}`];
  if (info.converted) parts.push(`converted from ${info.sourceSampleRate} Hz`);
  return parts.join(' · ');
}

/** What the generated audio was made from, so the form can say when the text or voice has changed since. */
export const generationSignature = (input: { text: string; modelKey: string; providerModel: string; voice: string }): string =>
  JSON.stringify([input.text.trim(), input.modelKey, input.providerModel, input.voice]);
