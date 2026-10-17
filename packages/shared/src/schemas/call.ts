import { z } from 'zod';

/**
 * Strict E.164 phone number pattern:
 * Must start with optional +, followed by 1 to 15 digits.
 * Forbids semicolons, newlines, carriage returns, or AT commands.
 */
export const phoneNumberSchema = z
  .string()
  .trim()
  .regex(
    /^\+?[1-9]\d{6,14}$/,
    'Phone number must be a valid E.164 formatted number with 7 to 15 digits (e.g. +919876543210 or 9876543210)'
  );

export const dialRequestSchema = z.object({
  phoneNumber: phoneNumberSchema,
  timeoutSeconds: z.number().int().min(5).max(120).optional().default(45),
  callerId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const dtmfRequestSchema = z.object({
  digit: z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#']),
  durationMs: z.number().int().min(50).max(2000).optional().default(200),
});

export const triggerMockInboundSchema = z.object({
  phoneNumber: phoneNumberSchema.default('+919876543210'),
  ringCount: z.number().int().min(1).max(20).optional().default(5),
});

/**
 * Strict boolean for env-style values. z.coerce.boolean() is unsafe here because it turns the
 * string "false" into true. Unset or empty falls back to the field default; anything that is
 * not an obvious boolean is rejected instead of guessed.
 */
const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') return undefined;
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return value;
  }, z.boolean().default(defaultValue));

export const gatewayConfigSchema = z.object({
  port: z.coerce.number().int().min(1024).max(65535).default(4000),
  host: z.string().default('127.0.0.1'),
  corsOrigin: z.string().default('http://localhost:3000'),
  modemDriver: z.enum(['hardware', 'mock']).default('mock'),
  atPort: z.string().default('COM20'),
  atBaudRate: z.coerce.number().default(115200),
  audioPort: z.string().default('COM19'),
  audioBaudRate: z.coerce.number().default(115200),
  audioSampleRate: z.coerce.number().default(8000),
  /** Unrestricted whole-call raw dump. Off by default; the bounded PCM capture test is the safe alternative. */
  enableAudioDumps: envBoolean(false),
  enableUsbAudioDiagnostic: envBoolean(false),
  /** Opt-in: capture <= 5 s of the USB audio stream during an ACTIVE call. */
  enableUsbPcmCaptureTest: envBoolean(false),
  /** Opt-in, separate: write a short low-volume tone to the USB audio port during an ACTIVE call. */
  enableUsbPcmOutboundToneTest: envBoolean(false),
  audioDumpDir: z.string().default('./audio-dumps'),
  sqliteDbPath: z.string().default('./data/gateway.sqlite'),
  gatewayApiKey: z.string().min(8, 'API Key must be at least 8 characters'),
  commandTimeoutMs: z.coerce.number().default(5000),
  dialTimeoutMs: z.coerce.number().default(20000),
  autoReconnect: envBoolean(true),
});

export type DialRequestInput = z.infer<typeof dialRequestSchema>;
export type DtmfRequestInput = z.infer<typeof dtmfRequestSchema>;
export type TriggerMockInboundInput = z.infer<typeof triggerMockInboundSchema>;
export type GatewayConfigInput = z.infer<typeof gatewayConfigSchema>;
