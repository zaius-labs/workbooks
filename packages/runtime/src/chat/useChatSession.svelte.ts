/**
 * Headless chat-session engine (Phase W4.1a).
 *
 * The `useChatSession()` factory returns a small reactive object that
 * owns the entire conversation state for a single chat surface:
 *
 *   - the message log (system + user + assistant + tool turns)
 *   - the streaming state of the current model turn
 *   - the bag of WorkbookBlocks the agent has emitted (lands on the
 *     canvas; some block kinds also re-render in the chat thread)
 *   - the API-key + model selection (persisted to localStorage)
 *   - tools, drop handlers, blockRegistry passed in at construction
 *
 * UI layers (`ChatPanel`, `ChatCanvas`, the high-level `<Chat>` preset
 * wrapper) bind to a session — they do NOT own state. The same session
 * can be rendered by multiple components simultaneously: a chat panel
 * on the left, a canvas on the right, both reading the same reactive
 * source. That's how rail-mode multi-session layouts compose, and how
 * authors can mount a custom layout while keeping the engine consistent.
 *
 * The engine is framework-agnostic at the message-shape level (it
 * reuses the LLM-client / agentLoop types) but exposes Svelte 5 runes
 * for reactivity. Non-Svelte hosts can read `.snapshot()` and write
 * via `.send()` / `.dropFile()`; they just don't get the auto-reactive
 * binding.
 */

import {
  createBrowserLlmClient,
  type ChatMessage,
  type GenerateChatEvent,
  type LlmClient,
  type ToolCall,
} from "../llmClient";
import type { AgentTool } from "../agentLoop";
import type { WorkbookBlock } from "../types";

/* ============================================================
 *                       Public types
 * ============================================================ */

/**
 * One renderable item in the chat thread. Every model turn produces
 * one or more of these; user turns are a single `user` entry; tool
 * calls produce a `tool_call` entry that the UI can render as a step
 * card and (optionally) inline-render the resulting block when the
 * tool returns one.
 */
export type ChatThreadItem =
  | { kind: "user"; id: string; text: string; attachments?: ChatAttachment[]; createdAt: number }
  | {
      kind: "assistant";
      id: string;
      text: string;
      /** True while the assistant is mid-stream. */
      streaming: boolean;
      createdAt: number;
    }
  | {
      kind: "tool_call";
      id: string;
      callId: string;
      toolName: string;
      argsJson: string;
      /** Populated once the tool returns. */
      result?: string;
      /** When the tool emitted a block, render it inline. */
      block?: WorkbookBlock;
      /** When the tool errored, the message. */
      error?: string;
      createdAt: number;
    }
  | {
      kind: "drop";
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      block?: WorkbookBlock;
      createdAt: number;
    };

/**
 * Attachment carried alongside a user message. Files dropped into the
 * canvas surface as `drop` thread items separately; this is for the
 * "user attached a screenshot to this message" case.
 */
export interface ChatAttachment {
  kind: "image" | "file";
  filename: string;
  mimeType: string;
  /** Base64 (image) or null (file metadata only). */
  base64?: string;
}

/**
 * A drop handler. Receives the dropped File; returns a WorkbookBlock to
 * land on the canvas (and as the `block` field of the corresponding
 * `drop` thread item), or null to skip rendering. Returning a Block
 * shaped `kind: "code"` with `code: "<error>"` is the recommended way
 * to surface a "couldn't parse this" outcome.
 */
export type DropHandler = (file: File) => Promise<WorkbookBlock | null> | WorkbookBlock | null;

export interface ChatSessionOptions {
  /** System prompt prepended to every model turn. */
  systemPrompt: string;
  /** Tools the agent can call. May be empty for a chat-only surface. */
  tools?: AgentTool[];
  /** mime-type → handler for files dropped on the canvas. */
  dropHandlers?: Record<string, DropHandler>;
  /** Default model id (e.g. "openai/gpt-4o-mini"). Author can override
   *  via the model picker; this is the seed value. */
  defaultModel?: string;
  /** localStorage key prefix. Each Chat instance on the same origin
   *  needs its own prefix or settings collide. Default "wb.chat". */
  storagePrefix?: string;
  /** Override the LLM client (testing, custom transport, gateway). When
   *  omitted, the session lazily builds a browser direct client from
   *  the API key on first send. */
  llmClient?: LlmClient;
  /** Cap on agent loop iterations per user turn. Default 8. */
  maxIterations?: number;
  /** Optional initial messages (replays a prior session). */
  initialThread?: ChatThreadItem[];
}

/* ============================================================
 *                       Implementation
 * ============================================================ */

export interface ChatSession {
  /** Reactive thread list. Components $derived/$effect on this. */
  readonly thread: ChatThreadItem[];
  /** Reactive list of blocks the agent has emitted (the canvas). */
  readonly canvasBlocks: WorkbookBlock[];
  /** Reactive busy flag — true while a model turn is in flight. */
  readonly busy: boolean;
  /** Reactive last-error string (cleared on next send). */
  readonly lastError: string | null;
  /** Reactive: whether an API key is present. */
  readonly hasKey: boolean;
  /** Currently selected model id. Reactive. */
  readonly model: string;

  /** Send a user message; runs the agent loop. */
  send(text: string, attachments?: ChatAttachment[]): Promise<void>;
  /** Drop a file onto the canvas; routes through dropHandlers. */
  dropFile(file: File): Promise<void>;
  /** Abort the in-flight model turn. */
  abort(): void;
  /** Reset the conversation (keeps key + model). */
  reset(): void;
  /** Set the API key (persists). */
  setKey(key: string): void;
  /** Clear the API key (removes from storage). */
  clearKey(): void;
  /** Change the active model (persists). */
  setModel(model: string): void;
  /** Imperative add a block to the canvas (author hooks). */
  addCanvasBlock(block: WorkbookBlock): void;
}

const DEFAULT_MODEL = "openai/gpt-4o-mini";

export function useChatSession(options: ChatSessionOptions): ChatSession {
  const prefix = options.storagePrefix ?? "wb.chat";
  const KEY_STORAGE = `${prefix}.apiKey`;
  const MODEL_STORAGE = `${prefix}.model`;

  // ── reactive state ────────────────────────────────────────
  const thread = $state<ChatThreadItem[]>(options.initialThread ?? []);
  const canvasBlocks = $state<WorkbookBlock[]>([]);
  const sessionState = $state({
    busy: false,
    lastError: null as string | null,
    apiKey: readStorage(KEY_STORAGE) ?? "",
    model: readStorage(MODEL_STORAGE) ?? options.defaultModel ?? DEFAULT_MODEL,
  });

  // ── non-reactive engine state ─────────────────────────────
  let abortController: AbortController | null = null;
  const tools = options.tools ?? [];
  const toolByName = new Map(tools.map((t) => [t.definition.name, t]));
  const toolDefs = tools.map((t) => t.definition);
  const dropHandlers = { ...(options.dropHandlers ?? {}) };
  const maxIterations = options.maxIterations ?? 8;

  // Lazily-built llmClient. Rebuilt when the api key changes.
  let cachedClient: LlmClient | null = options.llmClient ?? null;
  let cachedClientKey: string | null = options.llmClient ? "__provided__" : null;
  function getClient(): LlmClient | null {
    if (options.llmClient) return options.llmClient;
    if (!sessionState.apiKey) return null;
    if (cachedClientKey === sessionState.apiKey && cachedClient) return cachedClient;
    cachedClient = createBrowserLlmClient({ apiKey: sessionState.apiKey });
    cachedClientKey = sessionState.apiKey;
    return cachedClient;
  }

  /**
   * Build the OpenAI-style messages payload from the current thread.
   * Mirrors the format `agentLoop.runAgentLoop` expects, but inlined
   * here because a chat session needs to track partial assistant turns
   * + tool-call/result pairs as separate thread items.
   */
  function messagesFromThread(): ChatMessage[] {
    const out: ChatMessage[] = [
      { role: "system", content: options.systemPrompt },
    ];
    let pendingAssistantToolCalls: ToolCall[] = [];
    let pendingAssistantText = "";

    const flushAssistant = () => {
      if (pendingAssistantText || pendingAssistantToolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: pendingAssistantText,
          toolCalls:
            pendingAssistantToolCalls.length > 0
              ? pendingAssistantToolCalls
              : undefined,
        });
        pendingAssistantText = "";
        pendingAssistantToolCalls = [];
      }
    };

    for (const item of thread) {
      if (item.kind === "user") {
        flushAssistant();
        if (item.attachments && item.attachments.length > 0) {
          const parts: NonNullable<ChatMessage["contentParts"]> = [];
          if (item.text) parts.push({ kind: "text", text: item.text });
          for (const a of item.attachments) {
            if (a.kind === "image" && a.base64) {
              parts.push({
                kind: "image",
                base64: a.base64,
                mimeType: a.mimeType,
              });
            }
          }
          out.push({ role: "user", contentParts: parts });
        } else {
          out.push({ role: "user", content: item.text });
        }
      } else if (item.kind === "assistant" && !item.streaming) {
        pendingAssistantText += item.text;
      } else if (item.kind === "tool_call" && item.result !== undefined) {
        // The tool_call must be flushed as part of the assistant turn
        // that emitted it, then the tool result follows.
        pendingAssistantToolCalls.push({
          id: item.callId,
          name: item.toolName,
          argumentsJson: item.argsJson,
        });
        flushAssistant();
        out.push({
          role: "tool",
          toolCallId: item.callId,
          content: item.result,
        });
      } else if (item.kind === "drop" && item.block) {
        // Surface dropped files as a synthetic user message describing
        // what landed; the agent treats it as context. Drops without a
        // resolved block become a hint-only message.
        flushAssistant();
        out.push({
          role: "user",
          content:
            `[${item.filename} · ${item.mimeType} · ${item.size} bytes — ` +
            `rendered as ${item.block.kind} block]`,
        });
      }
    }
    flushAssistant();
    return out;
  }

  /** Run one agent loop turn, streaming into the thread. */
  async function runTurn(initialUserMessage?: ChatThreadItem): Promise<void> {
    const client = getClient();
    if (!client) {
      sessionState.lastError = "API key required";
      return;
    }
    sessionState.busy = true;
    sessionState.lastError = null;
    abortController = new AbortController();

    if (initialUserMessage) thread.push(initialUserMessage);

    let iter = 0;

    try {
      while (iter < maxIterations) {
        iter++;
        const assistantId = newId();
        let assistantText = "";
        const turnToolCalls = new Map<string, ToolCall>();

        thread.push({
          kind: "assistant",
          id: assistantId,
          text: "",
          streaming: true,
          createdAt: Date.now(),
        });

        const stream = client.generateChat({
          model: sessionState.model,
          messages: messagesFromThread(),
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          signal: abortController.signal,
        });

        let stopReason = "end_turn";
        let errorMessage: string | undefined;

        for await (const ev of stream as AsyncIterable<GenerateChatEvent>) {
          if (ev.kind === "delta") {
            assistantText += ev.text;
            patchAssistant(assistantId, assistantText, true);
          } else if (ev.kind === "tool_call") {
            turnToolCalls.set(ev.call.id, ev.call);
          } else if (ev.kind === "done") {
            stopReason = ev.stopReason;
            for (const c of ev.toolCalls) {
              if (!turnToolCalls.has(c.id)) turnToolCalls.set(c.id, c);
            }
            if (ev.finalText && !assistantText) {
              assistantText = ev.finalText;
            }
            errorMessage = ev.errorMessage;
          }
        }

        // Finalize assistant turn (drop the streaming flag).
        patchAssistant(assistantId, assistantText, false);

        if (errorMessage) {
          sessionState.lastError = errorMessage;
          break;
        }
        if (turnToolCalls.size === 0) break;

        // Dispatch each tool, append a tool_call thread item per call.
        for (const call of turnToolCalls.values()) {
          const item: ChatThreadItem = {
            kind: "tool_call",
            id: newId(),
            callId: call.id,
            toolName: call.name,
            argsJson: call.argumentsJson,
            createdAt: Date.now(),
          };
          thread.push(item);
          await dispatchTool(call, item);
        }

        if (stopReason === "cancelled" || stopReason === "error") break;
      }
    } catch (err) {
      sessionState.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      sessionState.busy = false;
      abortController = null;
    }
  }

  /** Patch the streaming assistant turn in-place. */
  function patchAssistant(id: string, text: string, streaming: boolean): void {
    const idx = thread.findIndex((t) => t.kind === "assistant" && t.id === id);
    if (idx < 0) return;
    const cur = thread[idx];
    if (cur.kind !== "assistant") return;
    thread[idx] = { ...cur, text, streaming };
  }

  /** Patch a tool_call thread item with its result + optional block. */
  function patchToolCall(id: string, fields: Partial<Extract<ChatThreadItem, { kind: "tool_call" }>>): void {
    const idx = thread.findIndex((t) => t.kind === "tool_call" && t.id === id);
    if (idx < 0) return;
    const cur = thread[idx];
    if (cur.kind !== "tool_call") return;
    thread[idx] = { ...cur, ...fields };
  }

  /** Run a tool, attach result + any emitted block. */
  async function dispatchTool(
    call: ToolCall,
    item: Extract<ChatThreadItem, { kind: "tool_call" }>,
  ): Promise<void> {
    const tool = toolByName.get(call.name);
    if (!tool) {
      patchToolCall(item.id, {
        error: `tool '${call.name}' not registered`,
        result: `error: tool '${call.name}' not registered`,
      });
      return;
    }
    let args: Record<string, unknown> = {};
    try {
      args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchToolCall(item.id, {
        error: `invalid args: ${message}`,
        result: `error: invalid args: ${message}`,
      });
      return;
    }
    try {
      const raw = await tool.invoke(args);
      // Tool return contract: either a string (back to the model) or an
      // object with shape { result: string, block?: WorkbookBlock }.
      // The block-emitting form is what makes generative-UI work.
      let resultText: string;
      let block: WorkbookBlock | undefined;
      if (typeof raw === "string") {
        resultText = raw;
      } else if (raw && typeof raw === "object") {
        const obj = raw as { result?: string; block?: WorkbookBlock };
        resultText =
          typeof obj.result === "string"
            ? obj.result
            : JSON.stringify(raw);
        block = obj.block;
      } else {
        resultText = JSON.stringify(raw);
      }
      patchToolCall(item.id, { result: resultText, block });
      if (block) canvasBlocks.push(block);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchToolCall(item.id, {
        error: message,
        result: `error: ${message}`,
      });
    }
  }

  // ── public API ────────────────────────────────────────────

  return {
    get thread() {
      return thread;
    },
    get canvasBlocks() {
      return canvasBlocks;
    },
    get busy() {
      return sessionState.busy;
    },
    get lastError() {
      return sessionState.lastError;
    },
    get hasKey() {
      return !!options.llmClient || sessionState.apiKey.length > 0;
    },
    get model() {
      return sessionState.model;
    },

    async send(text: string, attachments?: ChatAttachment[]) {
      if (!text.trim() && (!attachments || attachments.length === 0)) return;
      const userItem: ChatThreadItem = {
        kind: "user",
        id: newId(),
        text,
        attachments,
        createdAt: Date.now(),
      };
      await runTurn(userItem);
    },

    async dropFile(file: File) {
      const handler =
        dropHandlers[file.type] ??
        dropHandlers[mimeFamily(file.type)] ??
        dropHandlers["*"];
      let block: WorkbookBlock | null = null;
      if (handler) {
        try {
          block = await handler(file);
        } catch (err) {
          // Surface the failure as a code block so the agent + user see
          // exactly what went wrong, rather than swallowing it.
          const message = err instanceof Error ? err.message : String(err);
          block = {
            kind: "code",
            language: "text",
            source: `dropHandler(${file.type}) failed: ${message}`,
          } as unknown as WorkbookBlock;
        }
      }
      const dropItem: ChatThreadItem = {
        kind: "drop",
        id: newId(),
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        block: block ?? undefined,
        createdAt: Date.now(),
      };
      thread.push(dropItem);
      if (block) canvasBlocks.push(block);
    },

    abort() {
      if (abortController) abortController.abort();
    },

    reset() {
      thread.length = 0;
      canvasBlocks.length = 0;
      sessionState.lastError = null;
    },

    setKey(key: string) {
      sessionState.apiKey = key;
      writeStorage(KEY_STORAGE, key);
      // Force client rebuild on next request.
      cachedClient = options.llmClient ?? null;
      cachedClientKey = options.llmClient ? "__provided__" : null;
    },

    clearKey() {
      sessionState.apiKey = "";
      removeStorage(KEY_STORAGE);
      cachedClient = options.llmClient ?? null;
      cachedClientKey = options.llmClient ? "__provided__" : null;
    },

    setModel(model: string) {
      sessionState.model = model;
      writeStorage(MODEL_STORAGE, model);
    },

    addCanvasBlock(block: WorkbookBlock) {
      canvasBlocks.push(block);
    },
  };
}

/* ============================================================
 *                       Helpers
 * ============================================================ */

function newId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

/** "text/csv" → "text/*", "application/json" → "application/*". */
function mimeFamily(mime: string): string {
  if (!mime) return "*";
  const slash = mime.indexOf("/");
  return slash > 0 ? `${mime.slice(0, slash)}/*` : mime;
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* localStorage unavailable (sandboxed iframe, private mode) */
  }
}

function removeStorage(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* same */
  }
}
