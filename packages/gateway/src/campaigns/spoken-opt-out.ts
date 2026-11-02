import type { CallSession } from '@sim-gateway/shared';
import { CallContextRegistry } from './call-context.js';
import { CampaignStore } from './store.js';

/**
 * The person on a campaign call clearly asked not to be called again: remember the number globally, at once. It only adds
 * protection: the number is skipped in every campaign that still has it queued (retries included) and in every later campaign.
 * It does nothing for a call that is not a campaign call, and it never ends or changes the call.
 */
export function recordSpokenOptOut(store: CampaignStore, contexts: CallContextRegistry, call: CallSession): boolean {
  const ctx = contexts.forCall(call);
  const contact = ctx ? store.getContact(ctx.contactId) : null;
  if (!contact?.phoneE164) return false;
  store.addDoNotCall(contact.phoneE164, 'asked not to be called again during a campaign call', 'spoken');
  return true;
}
