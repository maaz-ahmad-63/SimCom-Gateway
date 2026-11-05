import { OpenAiCompatibleSpec } from '../catalog.js';
import { FetchLike, redactSecrets, requestWithRetry } from './http.js';
import { AiProviderError, LlmChunk, LlmMessage, LlmProvider, LlmRequest, LlmToolCall, LlmUsage } from './types.js';

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

/** A count from a usage field, or undefined when the field is absent or not a non-negative number. Never 0 for "not reported". */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function usageFrom(payload: any): LlmUsage | undefined {
  const usage = payload?.usage ?? payload?.x_groq?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  // Where each provider puts what was served from / written to its cache: OpenAI and Groq in prompt_tokens_details.cached_tokens,
  // DeepSeek-style hosts as prompt_cache_hit_tokens, Anthropic-style replies as cache_read/creation_input_tokens. Only a number that
  // is really there is recorded; no field means "not reported".
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object' ? usage.prompt_tokens_details : {};
  const cached = count(details.cached_tokens) ?? count(usage.prompt_cache_hit_tokens) ?? count(usage.cache_read_input_tokens);
  const written = count(usage.cache_creation_input_tokens) ?? count(details.cache_write_tokens) ?? count(details.cache_creation_tokens);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Number(usage.total_tokens ?? prompt + completion),
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
  };
}

/** Parameters only OpenAI's own API is documented to take; they are never sent to another host. */
function isOpenAiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Streaming chat completions for every OpenAI-compatible provider in the source catalog (OpenAI,
 * Groq, Telnyx). Per-family parameters come straight from the source's *_llm.py. Retries happen only
 * until the first byte of the reply; once chunks have been delivered nothing is replayed (the source
 * sets retry_on_chunk_sent=False for the same reason).
 */
/** The wire form of one message: the model's tool calls and the tool results use OpenAI's field names. */
function wireMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if ('toolCalls' in m) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

/** A provider's own refusal of the tools field (as opposed to any other bad request). */
const TOOLS_REJECTED = /\b(tools?|functions?|tool_choice)\b/i;

export class OpenAiCompatibleLlm implements LlmProvider {
  readonly name: string;
  /** Set when the provider rejected a request that carried tools: tools are never sent to it again by this instance. */
  private toolsRejected = false;

  constructor(private readonly options: LlmOptions) {
    this.name = options.spec.provider;
  }

  get supportsTools(): boolean {
    return this.options.spec.toolCalling && !this.toolsRejected;
  }

  private open(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const o = this.options;
    return requestWithRetry(
      `${o.spec.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `${o.spec.authScheme === 'basic' ? 'Basic' : 'Bearer'} ${o.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
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
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const o = this.options;
    const withTools = this.supportsTools && (request.tools?.length ?? 0) > 0;
    const body: Record<string, unknown> = {
      model: o.spec.model,
      messages: [{ role: 'system', content: request.system }, ...request.messages.map(wireMessage)],
      stream: true,
      ...o.spec.body,
    };
    if (withTools) {
      body.tools = request.tools!.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    if (o.maxTokens !== null) body.max_tokens = o.maxTokens + (o.spec.reasoningTokenAllowance ?? 0);
    if (isOpenAiHost(o.spec.baseUrl)) {
      // OpenAI only reports usage in a stream when asked, and it can route requests that share a prompt prefix together when told
      // what the prefix is. Nothing is added to any other provider's request.
      if (body.stream_options === undefined) body.stream_options = { include_usage: true };
      if (request.cacheKey && body.prompt_cache_key === undefined) body.prompt_cache_key = request.cacheKey;
    }

    let response: Response;
    try {
      response = await this.open(body, signal);
    } catch (error) {
      // The provider refused the tools field itself: remember it, and answer this request the way a model without tools would.
      const status = error instanceof AiProviderError ? error.details.status : undefined;
      if (withTools && (status === 400 || status === 422) && TOOLS_REJECTED.test((error as Error).message) && !signal.aborted) {
        this.toolsRejected = true;
        delete body.tools;
        delete body.tool_choice;
        response = await this.open(body, signal);
      } else {
        throw error;
      }
    }
    if (!response.body) throw new AiProviderError(this.name, 'llm', 'response had no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    // Tool calls arrive in pieces (the name once, the JSON arguments across many chunks), keyed by index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    const takeToolCalls = (): LlmToolCall[] | undefined => {
      if (pending.size === 0) return undefined;
      const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([index, c]) => ({ id: c.id || `call_${index}`, name: c.name, arguments: c.args }));
      pending.clear();
      return calls;
    };
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
            const leftover = takeToolCalls();
            if (leftover) yield { toolCalls: leftover };
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
          const finishReason = payload?.choices?.[0]?.finish_reason;
          if (finishReason) finished = true;
          const delta = payload?.choices?.[0]?.delta?.content;
          for (const piece of payload?.choices?.[0]?.delta?.tool_calls ?? []) {
            const index = Number.isInteger(piece?.index) ? piece.index : 0;
            const entry = pending.get(index) ?? { id: '', name: '', args: '' };
            if (typeof piece?.id === 'string' && piece.id) entry.id = piece.id;
            if (typeof piece?.function?.name === 'string') entry.name += piece.function.name;
            if (typeof piece?.function?.arguments === 'string') entry.args += piece.function.arguments;
            pending.set(index, entry);
          }
          const usage = usageFrom(payload);
          const reason = typeof finishReason === 'string' ? { finishReason } : {};
          // The calls are complete once the model says it has finished the message.
          const toolCalls = finishReason ? takeToolCalls() : undefined;
          const calls = toolCalls ? { toolCalls } : {};
          if (typeof delta === 'string' && delta.length > 0) yield { delta, usage, ...reason, ...calls };
          else if (usage || finishReason) yield { usage, ...reason, ...calls };
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
