import { describe, expect, it } from 'vitest';
import { DeepgramStreamingStt, WsLike } from '../../src/ai/providers/stt-stream.js';
import { FORMAT_8K, sleep } from './helpers.js';

// Calls a239ca50 and 114431fb: every utterance opened a new Deepgram connection (stream_openMs about 1.7 s to the AU endpoint),
// so a merged-audio replay waited 3.4 s and a short reply waited for the connection too. A spare connection is now kept ready.

class FakeWs implements WsLike {
  readyState = 0;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onerror: WsLike['onerror'] = null;
  onclose: WsLike['onclose'] = null;
  readonly sent: Array<Buffer | string> = [];
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  get keepAlives() {
    return this.sent.filter((m) => typeof m === 'string' && m.includes('KeepAlive')).length;
  }
  get audioBytes() {
    return this.sent.filter((m): m is Buffer => Buffer.isBuffer(m)).reduce((n, b) => n + b.length, 0);
  }
}

function build(over: Partial<ConstructorParameters<typeof DeepgramStreamingStt>[0]> = {}) {
  const sockets: FakeWs[] = [];
  const provider = new DeepgramStreamingStt({
    apiKey: 'test-key',
    model: 'nova-3',
    language: 'en',
    keyterms: [],
    finalizeTimeoutMs: 1500,
    warmStandby: true,
    keepAliveMs: 20,
    webSocketFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    ...over,
  });
  return { provider, sockets };
}

describe('a spare Deepgram connection is kept ready', () => {
  it('warm() opens one connection ahead of the first word, and does not open a second while it is usable', () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    provider.warm(FORMAT_8K);
    expect(sockets).toHaveLength(1);
    provider.dispose();
  });

  it('an utterance takes the ready connection: no new connection is opened for it, its audio goes out at once, and the next spare is opened', async () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    sockets[0].open(); // the spare finished connecting while nobody was speaking
    const stream = provider.open(FORMAT_8K, new AbortController().signal);
    expect(sockets).toHaveLength(1);
    stream.push(Buffer.alloc(3200));
    expect(sockets[0].audioBytes).toBe(3200); // sent immediately: nothing queued behind a connection
    await sleep(5);
    expect(sockets).toHaveLength(2); // the next utterance (or a merged replay) will find a spare as well
    provider.dispose();
  });

  it('reports an open time of 0 for a connection that was already open, not its age', async () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    sockets[0].open();
    await sleep(60);
    const stream = provider.open(FORMAT_8K, new AbortController().signal);
    stream.push(Buffer.alloc(3200));
    void stream.finalize(undefined, 50);
    await sleep(80);
    expect(stream.finalizeOutcome?.diag).toMatchObject({ openMs: 0 });
    provider.dispose();
  });

  it('keeps an idle spare alive with KeepAlive, and stops once an utterance has taken it', async () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    sockets[0].open();
    await sleep(90);
    expect(sockets[0].keepAlives).toBeGreaterThanOrEqual(2);
    provider.open(FORMAT_8K, new AbortController().signal);
    const sent = sockets[0].keepAlives;
    await sleep(80);
    expect(sockets[0].keepAlives).toBe(sent);
    provider.dispose();
  });

  it('opens a fresh connection when the spare failed, so an utterance never waits on a dead one', () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    sockets[0].onerror?.();
    const stream = provider.open(FORMAT_8K, new AbortController().signal);
    expect(stream.error).toBeNull();
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    provider.dispose();
  });

  it('aborting the utterance closes the connection it took', () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    sockets[0].open();
    const abort = new AbortController();
    provider.open(FORMAT_8K, abort.signal);
    abort.abort();
    expect(sockets[0].readyState).toBe(3);
    provider.dispose();
  });

  it('dispose() closes the spare and stops warming (the call ended)', async () => {
    const { provider, sockets } = build();
    provider.warm(FORMAT_8K);
    sockets[0].open();
    provider.dispose();
    expect(sockets[0].readyState).toBe(3);
    provider.warm(FORMAT_8K);
    expect(sockets).toHaveLength(1);
  });

  it('without warmStandby nothing is kept: warm() does nothing and each utterance opens its own connection, as before', async () => {
    const { provider, sockets } = build({ warmStandby: false });
    provider.warm(FORMAT_8K);
    expect(sockets).toHaveLength(0);
    provider.open(FORMAT_8K, new AbortController().signal);
    await sleep(5);
    expect(sockets).toHaveLength(1);
  });
});
