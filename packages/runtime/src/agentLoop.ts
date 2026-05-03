/**
 * Minimal agent loop on top of LlmClient.
 *
 * For chat with no tools, this is a thin wrapper around generateChat
 * that returns the assembled text + usage. When tools are non-empty,
 * the loop alternates: model emits tool_call → caller dispatches the
 * tool → model continues. Loop terminates on stop_reason=end_turn,
 * an explicit max_iterations cap, or an error.
 *
 * This is the launching pad for pi-agent-core integration. For now,
 * the loop is hand-rolled with a small tool dispatcher; once
 * pi-agent-core's npm package is wired into this repo we can swap the
 * inner loop to use it without changing this surface.
 */

import type {
  ChatMessage,
  GenerateChatEvent,
  LlmClient,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from "./llmClient";

export interface AgentTool {
  definition: ToolDefinition;
  /** Invoked when the model calls this tool. Receives the parsed
   *  arguments (per the tool's JSON Schema) and returns a string the
   *  model can read in its next turn. */
  invoke: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface AgentLoopOptions {
  llmClient: LlmClient;
  model: string;
  systemPrompt: string;
  initialUserMessage: string;
  tools?: AgentTool[];
  /** Max iterations (model turns) before forcing a stop. Default 8. */
  maxIterations?: number;
  /** Per-token streaming sink; useful for chat UIs. */
  onDelta?: (text: string) => void;
  /** Lifecycle hook fired when the model invokes a tool. */
  onToolCall?: (call: ToolCall, result: string) => void;
}

export interface AgentLoopResult {
  text: string;
  iterations: number;
  toolCalls: { call: ToolCall; result: string }[];
  usage?: TokenUsage;
  stopReason: string;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const tools = opts.tools ?? [];
  const maxIterations = opts.maxIterations ?? 8;

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.initialUserMessage },
  ];

  const toolDefs = tools.map((t) => t.definition);
  const toolByName = new Map(tools.map((t) => [t.definition.name, t]));

  let finalText = "";
  let iterations = 0;
  const toolCalls: { call: ToolCall; result: string }[] = [];
  let usage: TokenUsage | undefined;
  let stopReason = "end_turn";

  while (iterations < maxIterations) {
    iterations++;
    const calls: ToolCall[] = [];
    let turnText = "";

    const stream = opts.llmClient.generateChat({
      model: opts.model,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
    });

    for await (const ev of stream as AsyncIterable<GenerateChatEvent>) {
      if (ev.kind === "delta") {
        turnText += ev.text;
        opts.onDelta?.(ev.text);
      } else if (ev.kind === "tool_call") {
        calls.push(ev.call);
      } else if (ev.kind === "done") {
        stopReason = ev.stopReason;
        usage = ev.usage ?? usage;
        // Include any tool_calls only sent at done.
        for (const c of ev.toolCalls) {
          if (!calls.some((existing) => existing.id === c.id)) calls.push(c);
        }
        if (ev.finalText) turnText = ev.finalText;
        if (ev.errorMessage) {
          finalText = ev.errorMessage;
          return { text: finalText, iterations, toolCalls, usage, stopReason: "error" };
        }
      }
    }

    finalText = turnText;

    // No tool calls → done.
    if (calls.length === 0) break;

    // Push the assistant turn that produced the calls.
    messages.push({
      role: "assistant",
      content: turnText,
      toolCalls: calls,
    });

    // Dispatch each tool, append the result message.
    for (const call of calls) {
      const tool = toolByName.get(call.name);
      let result: string;
      if (!tool) {
        result = `error: tool '${call.name}' not registered`;
      } else {
        try {
          const args = call.argumentsJson
            ? (JSON.parse(call.argumentsJson) as Record<string, unknown>)
            : {};
          const r = await tool.invoke(args);
          result = typeof r === "string" ? r : JSON.stringify(r);
        } catch (err) {
          result = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      toolCalls.push({ call, result });
      opts.onToolCall?.(call, result);
      messages.push({
        role: "tool",
        content: result,
        toolCallId: call.id,
      });
    }
  }

  return { text: finalText, iterations, toolCalls, usage, stopReason };
}
