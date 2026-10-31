import { z } from 'zod';

/**
 * The model registry: one list of providers and one flat list of models (registry.json). Strict: an unknown field, a wrong type or
 * a value outside its range is an error. Keys never appear here: a provider names the environment variable that holds its key
 * (`credential`), the existing encrypted store or the environment resolves it, and anything that looks like a secret is rejected.
 */

export const SCHEMA_VERSION = 2;

/** Ids are lowercase so lookups are unambiguous; every existing catalog key fits (nova-3, stt-rt-v5, groq_qwen_3_8_27b ...). */
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'must be 1-64 characters: lowercase letters, digits, "_", "-" or "."');
/** The NAME of the environment variable (or stored credential) that holds the key. Never the key. */
export const credentialName = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}(_API_KEY|_API_TOKEN)$/, 'must be an UPPER_CASE variable name ending _API_KEY or _API_TOKEN, such as MYPROVIDER_API_KEY');

const url = (schemes: string[], what: string) =>
  z
    .string()
    .max(500)
    .refine((v) => {
      try {
        const u = new URL(v);
        return schemes.includes(u.protocol) && !u.username && !u.password;
      } catch {
        return false;
      }
    }, `must be ${what} without embedded credentials`);
export const httpsUrl = url(['https:'], 'an https URL');
/** A model endpoint may be a WebSocket URL for the protocols that stream over one. */
export const endpointUrl = url(['https:', 'wss:'], 'an https or wss URL');

export type Stage = 'llm' | 'stt' | 'tts';
export const stageSchema = z.enum(['llm', 'stt', 'tts']);

// ---------------------------------------------------------------------------------------------- providers and models

export const providerSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(80),
    /** The variable holding the API key (resolved by the encrypted store first, then the environment); null for none. */
    credential: credentialName.nullable(),
    /** The base URL of an OpenAI-compatible API: used by every model of this provider that speaks the openai-chat protocol. */
    baseUrl: httpsUrl.nullable().optional(),
    /** How the key is presented to an OpenAI-compatible API: "Authorization: Bearer <key>" (the default) or "Authorization: Basic <key>" (Inworld). */
    authScheme: z.enum(['bearer', 'basic']).optional(),
    enabled: z.boolean().default(true),
    note: z.string().max(500).optional(),
  })
  .strict();
export type ProviderEntry = z.infer<typeof providerSchema>;

export const modelSchema = z
  .object({
    id: idSchema,
    stage: stageSchema,
    provider: idSchema,
    /** The wire protocol that serves it (see protocols.ts); null lists a model no protocol implements yet (it says why). */
    protocol: z.string().min(1).max(64).nullable(),
    /** The provider's own model id, sent as written. TTS: the default model; more go in options.models. */
    model: z.string().min(1).max(200).nullable(),
    label: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    /** Other names this model answers to (language models). */
    aliases: z.array(z.string().min(1).max(120)).max(40).default([]),
    /** Overrides the endpoint for this model alone (a full URL for most protocols, the base URL for openai-chat). */
    endpoint: endpointUrl.nullable().optional(),
    /** Settings of the model's protocol, validated by that protocol (see protocols.ts). */
    options: z.record(z.string().max(64), z.unknown()).default({}),
    unavailableReason: z.string().max(300).nullable().optional(),
  })
  .strict();
export type ModelEntry = z.infer<typeof modelSchema>;

export interface RegistryFile {
  providers: ProviderEntry[];
  models: ModelEntry[];
}

export const registryHeadSchema = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), providers: z.array(z.unknown()), models: z.array(z.unknown()) }).strict();

// ---------------------------------------------------------------------------------------------- option building blocks

/** A request-body value: a literal, or one the operator can override from an environment variable (validated, with its own message). */
export const envValueSchema = z
  .object({
    $env: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    default: z.union([z.string(), z.number()]),
    oneOf: z.array(z.string()).max(20).optional(),
    integer: z.object({ min: z.number().int(), max: z.number().int() }).strict().optional(),
    message: z.string().max(200).optional(),
  })
  .strict();
export type EnvValue = z.infer<typeof envValueSchema>;
export const bodyValueSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), envValueSchema]);

export const voiceOptionSchema = z.object({ name: z.string().min(1).max(120), id: z.string().min(1).max(200).optional(), label: z.string().max(120).optional() }).strict();
export type VoiceOption = z.infer<typeof voiceOptionSchema>;

// ---------------------------------------------------------------------------------------------- secrets

/** Anything that looks like a secret value. A registry is shared and exported: it must never contain one. */
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bgsk_[A-Za-z0-9]{16,}/, /\bAIza[0-9A-Za-z_-]{20,}/, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b[A-Za-z0-9+/]{40,}={0,2}\b/];

export function findSecretLike(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') return SECRET_SHAPES.some((re) => re.test(value)) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretLike(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findSecretLike(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
