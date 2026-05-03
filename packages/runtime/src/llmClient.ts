/**
 * LLM service client (typed contract from
 * `proto/workbook/llm/v1/llm.proto`).
 *
 * Workbook cells (chat, agent, embed) call into LlmClient; they don't
 * fetch providers directly. The transport layer below picks an
 * implementation per tier:
 *
 *   Tier 1 (browser)  →  createBrowserLlmClient()  — fetch direct;
 *                        API key from input binding.
 *   Tier 2 (worker)   →  createGatewayLlmClient()  — through CF AI
 *                        Gateway; key never on the client.
 *   Tier 3 (managed)  →  createConnectLlmClient()  — Connect-RPC over
 *                        HTTP; key fully server-side.
 *
 * Same surface, three transports. Caller code is identical regardless
 * of where the workbook lands.
 *
 * Status: T-LLM.1 baseline — the proto + browser transport. Streaming
 * shape matches the proto (delta / tool_call / done events). Tool-use
 * loops live one layer up (pi-agent-core wrapper, T-LLM.2).
 */

// --- TS counterparts of the proto types ------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content?: string;
  contentParts?: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  displayName?: string;
}

export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url?: string; base64?: string; mimeType?: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments matching the tool's parameters schema. */
  argumentsJson: string;
}

export interface GenerateChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  budgetTokens?: number;
  providerOptions?: Record<string, unknown>;
  /** Aborts the stream when fired. */
  signal?: AbortSignal;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "cancelled"
  | "error";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

export type GenerateChatEvent =
  | { kind: "delta"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | {
      kind: "done";
      stopReason: StopReason;
      finalText: string;
      toolCalls: ToolCall[];
      usage?: TokenUsage;
      latencyMs?: number;
      errorMessage?: string;
    };

export interface EmbedRequest {
  model: string;
  inputs: string[];
}

export interface EmbedResponse {
  embeddings: number[][];
  usage?: TokenUsage;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  capabilities: string[];
  contextWindow?: number;
  pricePerMillionInputTokens?: number;
  pricePerMillionOutputTokens?: number;
}

export interface DescribeResponse {
  transportName: string;
  transportVersion: string;
  availableModels: ModelInfo[];
}

/** The runtime LLM client. Tier-portable. */
export interface LlmClient {
  generateChat(req: GenerateChatRequest): AsyncIterable<GenerateChatEvent>;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
  describe(): Promise<DescribeResponse>;
}

// ---------------------------------------------------------------------
// Tier 1 — Browser direct transport.
//
// Calls OpenRouter's chat-completions endpoint by default (single
// provider with broadest model coverage and CORS-enabled). Other
// providers slot in by swapping `baseUrl` + adapter functions.
// ---------------------------------------------------------------------

export interface BrowserLlmClientOptions {
  /** Provider API key. Stored in localStorage by the host UI; never
   *  shipped in workbook content. */
  apiKey: string;
  /** Override for non-OpenRouter providers. Default: OpenRouter. */
  baseUrl?: string;
  /** Default model when the request doesn't specify one. */
  defaultModel?: string;
  /** Optional fetch impl (testing). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function createBrowserLlmClient(opts: BrowserLlmClientOptions): LlmClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const defaultModel = opts.defaultModel ?? "openai/gpt-4o-mini";

  return {
    async *generateChat(req): AsyncIterable<GenerateChatEvent> {
      const start = performance.now();
      const body: Record<string, unknown> = {
        model: req.model || defaultModel,
        messages: req.messages.map(toOpenAiMessage),
        stream: true,
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
      if (req.topP !== undefined) body.top_p = req.topP;
      if (req.stop?.length) body.stop = req.stop;
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      if (req.providerOptions) Object.assign(body, req.providerOptions);

      const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          // OpenRouter ranking — encourages provider routing analytics.
          "HTTP-Referer": "https://github.com/zaius-labs/workbooks",
          "X-Title": "@workbook/runtime",
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        yield {
          kind: "done",
          stopReason: "error",
          finalText: "",
          toolCalls: [],
          errorMessage: `provider ${resp.status}: ${text || resp.statusText}`,
          latencyMs: performance.now() - start,
        };
        return;
      }

      let finalText = "";
      const toolCalls = new Map<number, ToolCall>();
      let usage: TokenUsage | undefined;
      let stopReason: StopReason = "end_turn";

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // parseEvent appends every text delta it sees to this array;
      // the outer loop drains + yields. Arrow functions can't yield
      // from the enclosing async generator, so we collect-then-emit.
      const pendingDeltas: string[] = [];

      // Parse one SSE event (the chunk between two \n\n boundaries).
      // Hoisted so the same logic handles both the per-chunk loop AND
      // any trailing partial event flushed after the stream closes.
      const parseEvent = (event: string) => {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const ev = JSON.parse(payload);
            const choice = ev.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (typeof delta.content === "string" && delta.content.length > 0) {
              finalText += delta.content;
              pendingDeltas.push(delta.content);
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCalls.get(idx) ?? {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  argumentsJson: "",
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.argumentsJson += tc.function.arguments;
                toolCalls.set(idx, existing);
              }
            }
            if (choice.finish_reason) {
              stopReason = mapStopReason(choice.finish_reason);
            }
            if (ev.usage) {
              usage = {
                promptTokens: ev.usage.prompt_tokens ?? 0,
                completionTokens: ev.usage.completion_tokens ?? 0,
                cachedPromptTokens: ev.usage.prompt_tokens_details?.cached_tokens,
                reasoningTokens: ev.usage.completion_tokens_details?.reasoning_tokens,
              };
            }
          } catch {
            /* skip malformed event */
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush any bytes the decoder was buffering for an
            // incomplete multibyte sequence at the previous boundary.
            buf += decoder.decode();
            break;
          }
          buf += decoder.decode(value, { stream: true });

          // SSE parse: events end with \n\n (or \r\n\r\n on
          // CRLF-strict servers — match either).
          const delim = /\r?\n\r?\n/g;
          let m: RegExpExecArray | null;
          let lastIdx = 0;
          while ((m = delim.exec(buf)) !== null) {
            const event = buf.slice(lastIdx, m.index);
            lastIdx = m.index + m[0].length;
            parseEvent(event);
            while (pendingDeltas.length > 0) {
              yield { kind: "delta", text: pendingDeltas.shift()! };
            }
          }
          if (lastIdx > 0) buf = buf.slice(lastIdx);
        }

        // Stream closed. Some providers terminate the connection
        // without a trailing \n\n, leaving the final event stuck in
        // buf. Process whatever's there so we don't lose tail tokens.
        // Symptom: replies cut off at "The " when the model had
        // generated the full sentence.
        if (buf.trim().length > 0) {
          parseEvent(buf);
          while (pendingDeltas.length > 0) {
            yield { kind: "delta", text: pendingDeltas.shift()! };
          }
          buf = "";
        }
      } catch (err) {
        yield {
          kind: "done",
          stopReason: "error",
          finalText,
          toolCalls: [...toolCalls.values()],
          usage,
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: performance.now() - start,
        };
        return;
      }

      // Surface tool calls as separate events for callers that prefer
      // event-driven handling (matches the proto stream shape).
      for (const tc of toolCalls.values()) {
        yield { kind: "tool_call", call: tc };
      }

      yield {
        kind: "done",
        stopReason,
        finalText,
        toolCalls: [...toolCalls.values()],
        usage,
        latencyMs: performance.now() - start,
      };
    },

    async embed(req): Promise<EmbedResponse> {
      const resp = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          input: req.inputs,
        }),
      });
      if (!resp.ok) {
        throw new Error(`embed ${resp.status}: ${await resp.text().catch(() => "")}`);
      }
      const json = await resp.json();
      return {
        embeddings: (json.data ?? []).map((d: { embedding: number[] }) => d.embedding),
        usage: json.usage
          ? {
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: 0,
            }
          : undefined,
      };
    },

    async describe(): Promise<DescribeResponse> {
      try {
        const resp = await fetchImpl(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${opts.apiKey}` },
        });
        const json = resp.ok ? await resp.json() : { data: [] };
        const available = (json.data ?? []).map((m: ModelDataRaw): ModelInfo => ({
          id: m.id,
          displayName: m.name ?? m.id,
          capabilities: inferCapabilities(m),
          contextWindow: m.context_length,
          pricePerMillionInputTokens: m.pricing?.prompt
            ? Number(m.pricing.prompt) * 1_000_000
            : undefined,
          pricePerMillionOutputTokens: m.pricing?.completion
            ? Number(m.pricing.completion) * 1_000_000
            : undefined,
        }));
        return {
          transportName: baseUrl.includes("openrouter") ? "openrouter" : "openai-compatible",
          transportVersion: "browser-direct/1",
          availableModels: available,
        };
      } catch {
        return {
          transportName: "openai-compatible",
          transportVersion: "browser-direct/1",
          availableModels: [],
        };
      }
    },
  };
}

// --- Helpers ---------------------------------------------------------

interface ModelDataRaw {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string };
  supports_tool_calling?: boolean;
}

function toOpenAiMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role };
  if (m.contentParts?.length) {
    out.content = m.contentParts.map((p) =>
      p.kind === "text"
        ? { type: "text", text: p.text }
        : { type: "image_url", image_url: { url: p.url ?? `data:${p.mimeType};base64,${p.base64}` } },
    );
  } else {
    out.content = m.content ?? "";
  }
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.argumentsJson },
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  return out;
}

function mapStopReason(r: string): StopReason {
  switch (r) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    case "function_call": return "tool_use";
    case "content_filter": return "error";
    default: return "end_turn";
  }
}

function inferCapabilities(m: ModelDataRaw): string[] {
  const caps = ["chat"];
  if (m.architecture?.modality?.includes("image")) caps.push("vision");
  if (m.supports_tool_calling) caps.push("tool_use");
  return caps;
}
