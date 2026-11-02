/**
 * Which call the Call Logs page is showing, kept in the URL (?call=<id>) rather than in component state alone, so a click, a
 * shared link, the back button and a refresh all land on the same call. A response that arrives after the viewer has moved on
 * to another call is dropped (RequestGate), so a slow earlier request can never overwrite the call now on screen.
 */
const CALL_ID = /^[A-Za-z0-9:_.-]{1,80}$/;

export function isValidCallId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CALL_ID.test(value);
}

/** The selected call from a query string such as "?call=abc&x=1"; null when absent or not a plausible id. */
export function selectedCallFromSearch(search: string): string | null {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('call');
  return isValidCallId(value) ? value : null;
}

/** The query string with the selected call set or removed, leaving other parameters alone. */
export function searchWithCall(search: string, callId: string | null): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (callId && isValidCallId(callId)) params.set('call', callId);
  else params.delete('call');
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function callLogHref(callId: string): string {
  return `/observability${searchWithCall('', callId)}`;
}

/** Hands out a ticket per request; only the newest ticket may apply its result. */
export class RequestGate {
  private latest = 0;
  begin(): number {
    return ++this.latest;
  }
  isCurrent(ticket: number): boolean {
    return ticket === this.latest;
  }
  /** Invalidate everything in flight (the viewer left). */
  cancel(): void {
    this.latest++;
  }
}

/** One short line saying how a call went, for the list and the drawer header. */
export function callSummaryLine(c: { status: string; durationSeconds: number; turns: number; failedTurns: number; cancelledTurns?: number }): string {
  const parts = [`${c.turns} turn${c.turns === 1 ? '' : 's'}`];
  if (c.failedTurns > 0) parts.push(`${c.failedTurns} failed`);
  if (c.cancelledTurns && c.cancelledTurns > 0) parts.push(`${c.cancelledTurns} cancelled`);
  return parts.join(' · ');
}
