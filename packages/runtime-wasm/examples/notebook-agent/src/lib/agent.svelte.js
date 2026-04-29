// Agent thread state + send loop. Wraps runAgentLoop with the
// in-workbook tool surface from createWorkbookAgentTools, streaming
// deltas + tool calls into a chronologically-ordered segment list.

import { getRuntime, notebook, vfs } from "./notebook.svelte.js";
import { env } from "./env.svelte.js";

const SYSTEM_PROMPT =
  "You are an agent embedded in an executable notebook. The user's notebook " +
  "has cells you can list, read, append, and edit. Cells re-execute automatically " +
  "on edit. Languages available: rhai (scripting), polars (SQL against in-VFS CSVs). " +
  "Default Polars table name is `data`; the default CSV is /workspace/customers.csv " +
  "with columns region, revenue, churn. " +
  "When the user asks for analysis, prefer adding or editing a cell over describing " +
  "the answer — the cell's output IS the answer, and the user can re-run it. " +
  "Always start by calling list_cells if you don't know what's there. " +
  "Use query_data only for quick scoping that doesn't deserve its own cell. " +
  "Reply concisely; show your work in tool calls, not prose.";

class AgentStore {
  thread = $state([]);          // [{ role, segments }]
  streaming = $state(null);     // { segments } during a turn, else null
  busy = $state(false);
  abortCtrl = null;

  async send(text) {
    if (!text.trim() || this.busy) return;
    if (!env.openrouterKey) return;

    const { wasm, bundle } = await getRuntime();
    const llm = bundle.createBrowserLlmClient({ apiKey: env.openrouterKey });
    const tools = bundle.createWorkbookAgentTools({
      executor: notebook.executor,
      vfs: { exists: vfs.exists, readText: vfs.readText },
      wasm,
      defaultCsvPath: "/workspace/customers.csv",
    });

    this.busy = true;
    this.streaming = { segments: [] };
    this.thread = [...this.thread, { role: "user", segments: [{ kind: "text", text }] }];

    let currentTextSeg = null;
    const onDelta = (delta) => {
      if (!currentTextSeg) {
        currentTextSeg = { kind: "text", text: "" };
        this.streaming.segments.push(currentTextSeg);
      }
      currentTextSeg.text += delta;
      // Trigger reactivity by reassigning the array.
      this.streaming = { segments: [...this.streaming.segments] };
    };
    const onToolCall = (call, result) => {
      currentTextSeg = null;
      this.streaming.segments.push({
        kind: "tool",
        name: call.name,
        argumentsJson: call.argumentsJson,
        result,
      });
      this.streaming = { segments: [...this.streaming.segments] };
    };

    try {
      const result = await bundle.runAgentLoop({
        llmClient: llm,
        model: "minimax/minimax-m2.7",
        systemPrompt: SYSTEM_PROMPT,
        initialUserMessage: this.flattenForPrompt(text),
        tools,
        maxIterations: 20,
        onDelta,
        onToolCall,
      });
      // If the loop ended with text we never streamed (uncommon), add it.
      const last = this.streaming.segments[this.streaming.segments.length - 1];
      if (result?.text && (!last || last.kind !== "text" || !last.text)) {
        onDelta(result.text);
      }
      this.thread = [
        ...this.thread,
        { role: "assistant", segments: this.streaming.segments },
      ];
    } catch (err) {
      onDelta(`\n[error] ${err?.message ?? err}`);
      this.thread = [
        ...this.thread,
        { role: "assistant", segments: this.streaming.segments },
      ];
    } finally {
      this.streaming = null;
      this.busy = false;
      this.abortCtrl = null;
    }
  }

  stop() { this.abortCtrl?.abort(); }

  flattenForPrompt(currentMessage) {
    if (!this.thread.length) return currentMessage;
    const flatten = (m) => m.role === "user"
      ? `User: ${m.segments[0]?.text ?? ""}`
      : "Assistant: " + m.segments
          .map((s) => s.kind === "text" ? s.text : `[used tool ${s.name}]`)
          .join("").trim();
    // thread doesn't include the just-pushed user message during this method's call site
    const prior = this.thread.slice(0, -1).map(flatten).join("\n\n");
    return prior
      ? `Earlier conversation:\n\n${prior}\n\nCurrent message:\n\n${currentMessage}`
      : currentMessage;
  }
}

export const agent = new AgentStore();
