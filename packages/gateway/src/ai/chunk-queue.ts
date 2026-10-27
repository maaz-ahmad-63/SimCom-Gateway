/**
 * A single-consumer buffer of audio chunks that a producer fills while a consumer drains. Used so a text-to-speech
 * request can start downloading the moment a sentence exists (while the previous sentence is still playing) and the
 * player can start on the first bytes instead of waiting for the whole sentence.
 *
 * A failure is delivered after everything already buffered has been read, so audio that arrived is not thrown away.
 */
export class ChunkQueue implements AsyncIterable<Buffer> {
  private items: Buffer[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private error: unknown = null;
  private failed = false;

  push(chunk: Buffer): void {
    if (this.closed) return;
    this.items.push(chunk);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.failed = true;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failed) throw this.error;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}
