import type { CallSession } from '@sim-gateway/shared';
import { CallContextRegistry } from '../../campaigns/call-context.js';
import { skipReason } from '../../campaigns/policy.js';
import type { AttemptFinished } from '../../campaigns/runner.js';
import type { CampaignStore } from '../../campaigns/store.js';
import { saveContactTool } from '../../ai/tools/contact-tool.js';
import { ToolRegistry } from '../../ai/tools/registry.js';
import { SheetsService } from './service.js';
import type { SheetRecord } from './types.js';

/** The tools on offer, decided at the start of every turn from what the operator has switched on for each kind of call. */
export function createToolRegistry(sheets: SheetsService): ToolRegistry {
  return new ToolRegistry(() => {
    const modes = (['inbound', 'outbound'] as const).filter((m) => sheets.toolsEnabled(m));
    return modes.length > 0 ? [saveContactTool({ sink: sheets, modes })] : [];
  });
}

/**
 * Why nothing may be recorded for the person on this call, or null. A campaign call is checked against the same rules that decide
 * whether a contact may be called at all (do-not-call list, opt-out, declined consent), and a spoken opt-out during the call
 * lands on that list immediately. An inbound caller who gives their own details is not restricted by a campaign's lists.
 */
export function callRestriction(store: CampaignStore, contexts: CallContextRegistry, call: CallSession): string | null {
  const ctx = contexts.forCall(call);
  if (!ctx) return null;
  const contact = store.getContact(ctx.contactId);
  if (!contact) return 'the contact is not in the campaign';
  const settings = store.require(contact.campaignId).settings;
  return skipReason({ phoneE164: contact.phoneE164, consent: contact.consent, optOut: contact.optOut }, settings, contact.phoneE164 ? store.isDoNotCall(contact.phoneE164) : false);
}

/**
 * One outcome row per finished campaign call, written by the gateway itself from what the call did (never from anything the model
 * said). A person who asked not to be called is recorded as such with no name or number. Failure to write never affects the campaign.
 */
export function outcomeRecorder(sheets: SheetsService, store: CampaignStore): (info: AttemptFinished) => Promise<void> {
  return async (info) => {
    if (!sheets.outcomesEnabled()) return;
    const contact = store.getContact(info.contactId);
    const declined = !contact || contact.optOut || (info.phoneE164 !== null && store.isDoNotCall(info.phoneE164));
    const record: SheetRecord = {
      key: info.callId ? `call:${info.callId}:outcome` : `campaign:${info.campaignId}:${info.contactId}:attempt:${info.attempt}:outcome`,
      type: 'outcome',
      recordedAt: info.at,
      callId: info.callId ?? `no-call:${info.campaignId}:${info.contactId}:${info.attempt}`,
      campaignId: info.campaignId,
      contactId: info.contactId,
      direction: 'outbound',
      name: null,
      phone: declined ? null : info.phoneE164,
      email: null,
      outcome: declined && info.outcome === 'answered' ? 'opted_out' : info.outcome,
      detail: info.detail,
    };
    await sheets.saveRecord(record);
  };
}
