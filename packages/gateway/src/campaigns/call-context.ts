import type { CallSession } from '@sim-gateway/shared';

export interface CallContextEntry {
  /** Added to this call's system prompt. */
  contextBlock: string;
  /** Spoken instead of the global greeting on this call only. */
  greeting?: string | null;
  campaignId: string;
  contactId: number;
  /**
   * Set when the campaign has its own prompt: it IS this call's system prompt, replacing the gateway's outbound/shared agent
   * instructions for this call only. Fixed when the call is placed, so editing the campaign never changes a call in progress.
   */
  systemPrompt?: string;
  /** A Model Hub model chosen for this campaign (null/absent: the gateway's selected model answers). */
  llmKey?: string | null;
  /** Names the campaign version's shared prompt prefix to a provider that can use that to route prompt-cache hits. */
  promptCacheKey?: string;
  /** The campaign configuration version this call was created with, and the fingerprint of its prompt. */
  configVersion?: number;
  promptSha?: string;
}

/**
 * Hands one contact's details from the campaign runner to the AI for exactly one call. It is looked up from the call's own
 * metadata (set at dial time), so the details are registered before the call exists and can never reach another call.
 */
export class CallContextRegistry {
  private readonly byContact = new Map<number, CallContextEntry>();

  register(entry: CallContextEntry): void {
    this.byContact.set(entry.contactId, entry);
  }

  clear(contactId: number): void {
    this.byContact.delete(contactId);
  }

  forCall(call: CallSession): CallContextEntry | null {
    const id = call.metadata?.campaignContactId;
    return typeof id === 'number' ? (this.byContact.get(id) ?? null) : null;
  }

  get size(): number {
    return this.byContact.size;
  }
}
