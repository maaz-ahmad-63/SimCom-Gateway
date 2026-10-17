import { OpenAiCompatibleSpec } from '../catalog.js';
import { FetchLike, redactSecrets, requestWithRetry } from './http.js';
import { AiProviderError, ChatMessage, LlmChunk, LlmProvider, LlmUsage } from './types.js';

export interface LlmOptions {
  spec: OpenAiCompatibleSpec;
  apiKey: string;
  fetchImpl: FetchLike;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  maxRetries: number;
  maxTokens: number | null;
  sleep?: (ms: number) => Promise<void>;
}

function usageFrom(payload: any): LlmUsage | undefined {
  const usage = payload?.usage ?? payload?.x_groq?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(usage.total_tokens ?? prompt + completion),
  };
}

/**
 * Streaming chat completions for every OpenAI-compatible provider in the source catalog (OpenAI,
 * Groq, Telnyx). Per-family parameters come straight from the source's *_llm.py. Retries happen only
 * until the first byte of the reply; once chunks have been delivered nothing is replayed (the source
 * sets retry_on_chunk_sent=False for the same reason).
 */
export class OpenAiCompatibleLlm implements LlmProvider {
  readonly name: string;

  constructor(private readonly options: LlmOptions) {
    this.name = options.spec.provider;
  }

  async *stream(
    request: { system: string; messages: ChatMessage[] },
    signal: AbortSignal
  ): AsyncIterable<LlmChunk> {
    const o = this.options;
    const body: Record<string, unknown> = {
      model: o.spec.model,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      stream: true,
      ...o.spec.body,
    };
    if (o.maxTokens !== null) body.max_tokens = o.maxTokens;

    const response = await requestWithRetry(
      `${o.spec.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      },
      {
        provider: this.name,
        stage: 'llm',
        fetchImpl: o.fetchImpl,
        timeoutMs: o.firstTokenTimeoutMs,
        bodyTimeoutMs: o.totalTimeoutMs,
        maxRetries: o.maxRetries,
        signal,
        sleep: o.sleep,
      }
    );
    if (!response.body) throw new AiProviderError(this.name, 'llm', 'response had no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    const stop = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            finished = true;
            return;
          }
          let payload: any;
          try {
            payload = JSON.parse(data);
          } catch {
            continue; // a malformed keep-alive line is not worth failing the turn
          }
          if (payload?.error) {
            throw new AiProviderError(this.name, 'llm', `stream error: ${redactSecrets(String(payload.error?.message ?? 'unknown'))}`);
          }
          if (payload?.choices?.[0]?.finish_reason) finished = true;
          const delta = payload?.choices?.[0]?.delta?.content;
          const usage = usageFrom(payload);
          if (typeof delta === 'string' && delta.length > 0) yield { delta, usage };
          else if (usage) yield { usage };
        }
      }
      // The stream ended: a cancelled or timed-out body also ends here, so say which it was.
      if (signal.aborted) throw new AiProviderError(this.name, 'llm', 'cancelled', { aborted: true });
      if (!finished) {
        throw new AiProviderError(this.name, 'llm', 'stream ended before the reply was complete (timeout or dropped connection)', {
          timedOut: true,
        });
      }
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (signal.aborted) throw new AiProviderError(this.name, 'llm', 'cancelled', { aborted: true });
      throw new AiProviderError(this.name, 'llm', `stream interrupted or timed out: ${redactSecrets((error as Error).message ?? '')}`, {
        timedOut: true,
      });
    } finally {
      signal.removeEventListener('abort', stop);
      reader.cancel().catch(() => {});
    }
  }
}
