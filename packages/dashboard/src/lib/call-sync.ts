/**
 * Keeps the dashboard's idea of the current call honest. Socket events can be missed (a reconnect, a sleeping tab,
 * the gateway reloading), and the old code only re-read the gateway on connect, so a finished call could stay on
 * screen as "DIALING" forever. The gateway's AT-free hardware status is polled and compared with what is shown.
 */
export interface ShownCall {
  id?: string;
  state: string;
}

export interface GatewayCall {
  id?: string;
  state: string;
}

export type SyncAction = 'none' | 'clear' | 'refresh';

/** How many polls in a row must say "no call" before a shown call is cleared (a fresh call can race one poll). */
export const CLEAR_AFTER_MISSES = 2;

export function reconcileCall(
  shown: ShownCall | null,
  gateway: GatewayCall | null,
  misses: number
): { action: SyncAction; misses: number } {
  if (!gateway) {
    if (!shown) return { action: 'none', misses: 0 };
    const next = misses + 1;
    return next >= CLEAR_AFTER_MISSES ? { action: 'clear', misses: 0 } : { action: 'none', misses: next };
  }
  // The gateway has a call: re-read the full session when we show none, or a different call, or a different state.
  const different = !shown || (gateway.id !== undefined && shown.id !== undefined && shown.id !== gateway.id) || shown.state !== gateway.state;
  return { action: different ? 'refresh' : 'none', misses: 0 };
}
