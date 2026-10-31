import { performance } from 'node:perf_hooks';
import { LlmToolCall, LlmToolSpec } from '../providers/types.js';
import { ToolContext, ToolDefinition, ToolMode, ToolOutcome, ToolRun } from './types.js';

export interface ToolRegistryOptions {
  /** Longest argument text accepted from the model. */
  maxArgumentChars?: number;
  /** Longest result text handed back to the model. */
  maxResultChars?: number;
}

/**
 * The tools the model may call. The list is read at the start of every turn, so enabling or disabling a tool in the dashboard
 * takes effect on the next reply without a restart. Everything a model produces is untrusted: the name must be one this call's
 * mode allows, the arguments must parse and pass the tool's strict schema, and execution is bounded by a timeout. A failure of
 * any kind comes back as an error result for the model to report honestly; it never throws into the call.
 */
export class ToolRegistry {
  private readonly maxArgumentChars: number;
  private readonly maxResultChars: number;

  constructor(private readonly source: () => ToolDefinition<any>[], options: ToolRegistryOptions = {}) {
    this.maxArgumentChars = options.maxArgumentChars ?? 4000;
    this.maxResultChars = options.maxResultChars ?? 600;
  }

  private forMode(mode: ToolMode): ToolDefinition<any>[] {
    return this.source().filter((t) => t.modes.includes(mode));
  }

  /** The functions to offer the model on a call in `mode`. Empty when there are none (the model is then used without tools). */
  specsFor(mode: ToolMode): LlmToolSpec[] {
    return this.forMode(mode).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /** Run one call the model made. Never throws. */
  async run(call: LlmToolCall, ctx: Omit<ToolContext, 'signal'>, turnSignal: AbortSignal): Promise<ToolRun> {
    const started = performance.now();
    const finish = (outcome: ToolOutcome): ToolRun => {
      const body = outcome.ok ? { ok: true, result: outcome.message, ...(outcome.data ? { data: outcome.data } : {}) } : { ok: false, error: outcome.code, message: outcome.message };
      let content = JSON.stringify(body);
      if (content.length > this.maxResultChars) content = JSON.stringify({ ...body, ...(outcome.ok ? { data: undefined, result: outcome.message.slice(0, this.maxResultChars - 60) } : { message: outcome.message.slice(0, this.maxResultChars - 60) }) });
      return { name: call.name, ok: outcome.ok, code: outcome.ok ? null : outcome.code, durationMs: performance.now() - started, content };
    };

    const tool = this.forMode(ctx.mode).find((t) => t.name === call.name);
    if (!tool) return finish({ ok: false, code: 'unknown_tool', message: `There is no tool named "${call.name.slice(0, 60)}" available on this call. Do not call it again; continue the conversation without it.` });

    if (call.arguments.length > this.maxArgumentChars) return finish({ ok: false, code: 'arguments_too_large', message: 'The arguments were too long and were not used.' });
    let raw: unknown;
    try {
      raw = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    } catch {
      return finish({ ok: false, code: 'invalid_json', message: 'The arguments were not valid JSON, so nothing was done. Call the tool again with valid JSON arguments, or continue without it.' });
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return finish({ ok: false, code: 'invalid_arguments', message: `The arguments were rejected (${issues}). Nothing was done.` });
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([turnSignal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        tool.execute(parsed.data, { ...ctx, signal }),
        new Promise<ToolOutcome>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ ok: false, code: 'timeout', message: `The tool did not finish within ${Math.round(tool.timeoutMs / 1000)} seconds, so it is not known whether it worked. Do not say it worked.` });
          }, tool.timeoutMs);
          timer.unref?.();
        }),
      ]);
      return finish(outcome);
    } catch (error) {
      if (turnSignal.aborted) return finish({ ok: false, code: 'cancelled', message: 'The turn was cancelled before the tool finished.' });
      // Generic on purpose: provider text can carry request details, and the model repeats what it is told.
      return finish({ ok: false, code: 'tool_error', message: 'The tool failed unexpectedly, so nothing is known to have been done. Do not say it worked.' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
