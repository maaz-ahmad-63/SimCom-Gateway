import type { LlmChunk, LlmMessage, LlmProvider, LlmRequest, LlmToolSpec } from '../../src/ai/providers/types.js';

/** A model that follows a script and records exactly what it was sent. */
export class ToolLlm implements LlmProvider {
  readonly name = 'tool-llm';
  readonly requests: Array<{ system: string; messages: LlmMessage[]; tools?: LlmToolSpec[] }> = [];
  constructor(
    private readonly steps: Array<{ text?: string; calls?: Array<{ name: string; args: unknown }> }>,
    readonly supportsTools = true
  ) {}
  async *stream(request: LlmRequest): AsyncIterable<LlmChunk> {
    this.requests.push({ system: request.system, messages: structuredClone(request.messages), tools: request.tools });
    const n = this.requests.length;
    const step = this.steps[n - 1] ?? this.steps[this.steps.length - 1] ?? { text: 'Okay.' };
    if (step.text) yield { delta: step.text };
    if (step.calls) {
      yield { toolCalls: step.calls.map((c, i) => ({ id: `call_${n}_${i}`, name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) })), finishReason: 'tool_calls' };
    } else {
      yield { finishReason: 'stop' };
    }
  }
}
