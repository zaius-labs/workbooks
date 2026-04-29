var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// ../../../runtime/src/wasmBridge.ts
function createRuntimeClient(opts) {
  let wasmPromise = null;
  function ensureWasm() {
    if (!wasmPromise) {
      wasmPromise = (async () => {
        const mod = await opts.loadWasm();
        await mod.default();
        return mod;
      })();
    }
    return wasmPromise;
  }
  return {
    async initRuntime(req) {
      const wasm = await ensureWasm();
      return wasm.initRuntime({
        workbook_slug: req.workbookSlug,
        environment: req.environment
      });
    },
    async runCell(req) {
      const wasm = await ensureWasm();
      const lang = req.cell.language;
      if (lang === "rhai") {
        if (!wasm.runRhai) throw new Error("runtime built without rhai-glue feature");
        const outputs = wasm.runRhai(req.cell.source ?? "", req.params ?? {});
        return { outputs };
      }
      if (lang === "polars") {
        if (!wasm.runPolarsSql) throw new Error("runtime built without polars-frames feature");
        const sql = req.cell.source ?? "";
        const csv = req.params?.csv ?? "";
        const outputs = wasm.runPolarsSql(sql, csv);
        return { outputs };
      }
      if (lang === "sqlite") {
        throw new Error("sqlite cell dispatcher not yet wired (P2.5)");
      }
      if (lang === "chat") {
        if (!opts.llmClient) {
          throw new Error(
            "chat cells require an llmClient \u2014 pass one to createRuntimeClient"
          );
        }
        const params = req.params ?? {};
        const userMessage = String(params.message ?? params.user ?? "");
        const history = Array.isArray(params.history) ? params.history : [];
        const messages = [];
        if (req.cell.source) {
          messages.push({ role: "system", content: req.cell.source });
        }
        for (const m of history) {
          if (m && typeof m === "object") {
            messages.push(m);
          }
        }
        if (userMessage) messages.push({ role: "user", content: userMessage });
        const model = params.model ?? req.cell.spec?.model ?? "openai/gpt-4o-mini";
        const stream = opts.llmClient.generateChat({
          model,
          messages,
          temperature: typeof params.temperature === "number" ? params.temperature : void 0,
          maxOutputTokens: typeof params.maxOutputTokens === "number" ? params.maxOutputTokens : void 0
        });
        const outputs = [];
        for await (const ev of stream) {
          if (ev.kind === "delta") {
            outputs.push({ kind: "stream", content: ev.text });
          } else if (ev.kind === "done") {
            if (ev.stopReason === "error") {
              outputs.push({ kind: "error", message: ev.errorMessage ?? "llm error" });
            } else {
              outputs.push({
                kind: "text",
                content: ev.finalText,
                mime_type: "text/plain"
              });
            }
          }
        }
        return { outputs };
      }
      if (lang === "candle-inference") {
        if (!wasm.candleSmokeTest) {
          throw new Error("runtime built without candle feature");
        }
        const outputs = wasm.candleSmokeTest();
        return { outputs };
      }
      if (lang === "linfa-train") {
        if (!wasm.linfaSmokeTest) {
          throw new Error("runtime built without linfa feature");
        }
        const outputs = wasm.linfaSmokeTest();
        return { outputs };
      }
      throw new Error(`unsupported cell language: ${lang}`);
    },
    async pauseRuntime(runtimeId) {
      const wasm = await ensureWasm();
      wasm.pauseRuntime?.({ runtime_id: runtimeId });
    },
    async destroyRuntime(runtimeId) {
      const wasm = await ensureWasm();
      wasm.destroyRuntime?.({ runtime_id: runtimeId });
    },
    async buildInfo() {
      const wasm = await ensureWasm();
      return wasm.build_info();
    }
  };
}

// ../../../runtime/src/cellAnalyzer.ts
function analyzeCell(cell) {
  const provides = cell.provides && cell.provides.length > 0 ? cell.provides : defaultProvides(cell);
  const reads = cell.dependsOn && cell.dependsOn.length > 0 ? cell.dependsOn : extractReads(cell);
  return {
    reads: dedupe(reads),
    provides: dedupe(provides)
  };
}
function defaultProvides(cell) {
  return [cell.id];
}
function extractReads(cell) {
  const src = cell.source ?? "";
  switch (cell.language) {
    case "polars":
    case "sqlite":
      return extractSqlReads(src);
    case "rhai":
      return extractRhaiReads(src);
    case "wasm-fn":
    case "candle-inference":
    case "linfa-train":
      return [];
    default:
      return [];
  }
}
var SQL_FROM_RE = /\bfrom\s+([a-zA-Z_][\w]*)/gi;
var SQL_JOIN_RE = /\bjoin\s+([a-zA-Z_][\w]*)/gi;
var SQL_WITH_RE = /\bwith\s+([a-zA-Z_][\w]*)\s+as\s*\(/gi;
var SQL_WITH_FOLLOW_RE = /,\s*([a-zA-Z_][\w]*)\s+as\s*\(/gi;
function extractSqlReads(src) {
  const reads = /* @__PURE__ */ new Set();
  for (const m of src.matchAll(SQL_FROM_RE)) reads.add(m[1]);
  for (const m of src.matchAll(SQL_JOIN_RE)) reads.add(m[1]);
  const ctes = /* @__PURE__ */ new Set();
  for (const m of src.matchAll(SQL_WITH_RE)) ctes.add(m[1]);
  for (const m of src.matchAll(SQL_WITH_FOLLOW_RE)) ctes.add(m[1]);
  return [...reads].filter((name) => !ctes.has(name));
}
var RHAI_LET_RE = /\blet\s+([a-zA-Z_][\w]*)/g;
var RHAI_IDENT_RE = /\b([a-zA-Z_][\w]*)\b/g;
var RHAI_KEYWORDS = /* @__PURE__ */ new Set([
  "let",
  "const",
  "if",
  "else",
  "for",
  "in",
  "while",
  "loop",
  "do",
  "until",
  "break",
  "continue",
  "return",
  "fn",
  "private",
  "switch",
  "default",
  "throw",
  "try",
  "catch",
  "import",
  "export",
  "as",
  "true",
  "false",
  "null",
  "this",
  "is",
  "not",
  "Fn",
  "call",
  "curry",
  "type_of",
  "print",
  "debug",
  "to_string",
  "to_int",
  "to_float",
  "len",
  "push",
  "pop",
  "shift"
]);
function extractRhaiReads(src) {
  const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const noStrings = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const provides = /* @__PURE__ */ new Set();
  for (const m of noStrings.matchAll(RHAI_LET_RE)) provides.add(m[1]);
  const reads = /* @__PURE__ */ new Set();
  for (const m of noStrings.matchAll(RHAI_IDENT_RE)) {
    const name = m[1];
    if (provides.has(name)) continue;
    if (RHAI_KEYWORDS.has(name)) continue;
    if (/^\d/.test(name)) continue;
    reads.add(name);
  }
  return [...reads];
}
function dedupe(xs) {
  return [...new Set(xs)];
}

// ../../../runtime/src/reactiveExecutor.ts
var ReactiveExecutor = class {
  constructor(opts) {
    __publicField(this, "client");
    __publicField(this, "cells", /* @__PURE__ */ new Map());
    __publicField(this, "inputs", /* @__PURE__ */ new Map());
    __publicField(this, "states", /* @__PURE__ */ new Map());
    __publicField(this, "onCellState");
    __publicField(this, "debounceMs");
    __publicField(this, "workbookSlug");
    __publicField(this, "runtimeId", null);
    __publicField(this, "runtimePromise", null);
    /** Generation counter — bumped on each run so stale runs short-circuit. */
    __publicField(this, "generation", 0);
    __publicField(this, "debounceTimer", null);
    this.client = opts.client;
    this.onCellState = opts.onCellState ?? (() => {
    });
    this.debounceMs = opts.debounceMs ?? 200;
    this.workbookSlug = opts.workbookSlug ?? "live";
    for (const cell of opts.cells) this.cells.set(cell.id, cell);
    if (opts.inputs) {
      for (const [k, v] of Object.entries(opts.inputs)) this.inputs.set(k, v);
    }
    for (const [id] of this.cells) {
      this.states.set(id, { cellId: id, status: "pending" });
    }
  }
  /**
   * Update an input value. Schedules a debounced re-execution of any cell
   * that reads this input (and their downstream cascade).
   */
  setInput(name, value) {
    this.inputs.set(name, value);
    this.scheduleRun([name]);
  }
  /**
   * Replace a cell's source/spec. Re-runs that cell and everything
   * downstream of it.
   */
  setCell(cell) {
    this.cells.set(cell.id, cell);
    if (!this.states.has(cell.id)) {
      this.states.set(cell.id, { cellId: cell.id, status: "pending" });
    }
    this.scheduleRun(analyzeCell(cell).provides);
  }
  /** Execute all cells from scratch. */
  runAll() {
    return this.executeFrom(null);
  }
  /**
   * Re-run a single cell + every cell downstream of it. Use this for
   * "click Run on this cell" UX — `setCell()` only triggers downstream
   * cells, but the user clicking Run wants the cell itself to re-run
   * as well.
   *
   * If `id` is unknown the call is a no-op (returns resolved).
   */
  runCell(id) {
    if (!this.cells.has(id)) return Promise.resolve();
    return this.executeFrom([id], [id]);
  }
  /** Snapshot of every cell currently in the executor, in insertion order.
   *  Used by the agent harness to give a model the current notebook state. */
  listCells() {
    return [...this.cells.values()];
  }
  getCell(id) {
    return this.cells.get(id);
  }
  /** Read the most recent state (status + outputs) for a cell.
   *  Returns undefined for unknown cell ids. */
  getState(id) {
    return this.states.get(id);
  }
  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.runtimeId) {
      this.client.destroyRuntime(this.runtimeId).catch(() => {
      });
    }
  }
  // --------------------------------------------------------------
  scheduleRun(changedProvides) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.executeFrom(changedProvides).catch((err) => {
        for (const id of this.cells.keys()) {
          this.transition(id, { status: "error", error: String(err) });
        }
      });
    }, this.debounceMs);
  }
  async ensureRuntime() {
    if (this.runtimeId) return this.runtimeId;
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const resp = await this.client.initRuntime({
        workbookSlug: this.workbookSlug,
        environment: {}
      });
      this.runtimeId = resp.runtimeId;
      return resp.runtimeId;
    })();
    return this.runtimePromise;
  }
  /**
   * Execute the subgraph of cells reachable from `changedProvides`. If
   * `changedProvides` is null, runs every cell (initial load / runAll).
   *
   * `forceIds` (optional) is a list of cell ids to include in the
   * dirty set regardless of dependency analysis — used by `runCell()`
   * to make "click Run on this cell" actually re-execute the cell.
   * Cells whose `reads` intersect with `forceIds` are dirty too
   * (they depend on a forced cell's output).
   */
  async executeFrom(changedProvides, forceIds = []) {
    const gen = ++this.generation;
    const runtimeId = await this.ensureRuntime();
    const order = topologicalOrder([...this.cells.values()]);
    const dirty = changedProvides == null ? new Set(order.map((c) => c.id)) : computeDirtySet(order, new Set(changedProvides));
    for (const id of forceIds) dirty.add(id);
    for (const cell of order) {
      if (dirty.has(cell.id)) {
        this.transition(cell.id, { status: "stale" });
      }
    }
    for (const cell of order) {
      if (gen !== this.generation) return;
      if (!dirty.has(cell.id)) continue;
      const analysis = analyzeCell(cell);
      const upstreamErrored = analysis.reads.some((name) => {
        const provider = providerOf(name, [...this.cells.values()]);
        if (!provider) return false;
        return this.states.get(provider.id)?.status === "error";
      });
      if (upstreamErrored) {
        this.transition(cell.id, {
          status: "stale",
          error: "upstream error"
        });
        continue;
      }
      this.transition(cell.id, { status: "running" });
      const start = performance.now();
      try {
        const params = this.collectParams(cell);
        const resp = await this.client.runCell({
          runtimeId,
          cell,
          params
        });
        const elapsed = performance.now() - start;
        this.transition(cell.id, {
          status: "ok",
          outputs: resp.outputs,
          lastRunMs: elapsed
        });
      } catch (err) {
        this.transition(cell.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  /**
   * Collect param bindings for `cell` — workbook inputs + upstream cell
   * outputs. Each name in `cell` reads (per cellAnalyzer) is resolved:
   *   1. as a workbook input (`this.inputs`)
   *   2. as the parsed scalar output of an upstream cell that `provides`
   *      that name (using the cell that produced it most recently)
   *
   * Scalar coercion: text/plain outputs that parse as a number return a
   * JS number; otherwise the raw string. Non-text outputs come through
   * stringified (callers that want richer typing extend this in P3.11).
   */
  collectParams(cell) {
    const a = analyzeCell(cell);
    const params = {};
    const allCells = [...this.cells.values()];
    for (const name of a.reads) {
      if (this.inputs.has(name)) {
        params[name] = this.inputs.get(name);
        continue;
      }
      const provider = allCells.find(
        (c) => analyzeCell(c).provides.includes(name)
      );
      if (!provider) continue;
      const state = this.states.get(provider.id);
      if (state?.status !== "ok" || !state.outputs?.length) continue;
      params[name] = scalarFromOutputs(state.outputs);
    }
    return params;
  }
  transition(cellId, patch) {
    const prev = this.states.get(cellId) ?? { cellId, status: "pending" };
    const next = { ...prev, ...patch, cellId };
    this.states.set(cellId, next);
    this.onCellState(next);
  }
};
function topologicalOrder(cells) {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const providers = /* @__PURE__ */ new Map();
  for (const cell of cells) {
    const a = analyzeCell(cell);
    for (const name of a.provides) providers.set(name, cell.id);
  }
  const visited = /* @__PURE__ */ new Set();
  const onStack = /* @__PURE__ */ new Set();
  const order = [];
  const visit = (cellId) => {
    if (visited.has(cellId) || onStack.has(cellId)) return;
    onStack.add(cellId);
    const cell = byId.get(cellId);
    if (cell) {
      const a = analyzeCell(cell);
      for (const dep of a.reads) {
        const upstream = providers.get(dep);
        if (upstream && upstream !== cellId) visit(upstream);
      }
      order.push(cell);
    }
    onStack.delete(cellId);
    visited.add(cellId);
  };
  for (const cell of cells) visit(cell.id);
  return order;
}
function computeDirtySet(order, seedNames) {
  const dirtyProvides = new Set(seedNames);
  const dirtyCells = /* @__PURE__ */ new Set();
  for (const cell of order) {
    const a = analyzeCell(cell);
    if (a.reads.some((name) => dirtyProvides.has(name))) {
      dirtyCells.add(cell.id);
      for (const name of a.provides) dirtyProvides.add(name);
    }
  }
  return dirtyCells;
}
function providerOf(name, cells) {
  for (const cell of cells) {
    if (analyzeCell(cell).provides.includes(name)) return cell;
  }
  return void 0;
}
function scalarFromOutputs(outputs) {
  for (const out of outputs) {
    if (out.kind !== "text") continue;
    const trimmed = out.content.trim();
    const n = Number(trimmed);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
    return trimmed;
  }
  return outputs[0];
}

// ../../../runtime/src/llmClient.ts
var DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
function createBrowserLlmClient(opts) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const defaultModel = opts.defaultModel ?? "openai/gpt-4o-mini";
  return {
    async *generateChat(req) {
      const start = performance.now();
      const body = {
        model: req.model || defaultModel,
        messages: req.messages.map(toOpenAiMessage),
        stream: true
      };
      if (req.temperature !== void 0) body.temperature = req.temperature;
      if (req.maxOutputTokens !== void 0) body.max_tokens = req.maxOutputTokens;
      if (req.topP !== void 0) body.top_p = req.topP;
      if (req.stop?.length) body.stop = req.stop;
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters }
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
          "X-Title": "@workbook/runtime"
        },
        body: JSON.stringify(body),
        signal: req.signal
      });
      if (!resp.ok || !resp.body) {
        const text2 = await resp.text().catch(() => "");
        yield {
          kind: "done",
          stopReason: "error",
          finalText: "",
          toolCalls: [],
          errorMessage: `provider ${resp.status}: ${text2 || resp.statusText}`,
          latencyMs: performance.now() - start
        };
        return;
      }
      let finalText = "";
      const toolCalls = /* @__PURE__ */ new Map();
      let usage;
      let stopReason = "end_turn";
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const event = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            for (const line of event.split("\n")) {
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
                  yield { kind: "delta", text: delta.content };
                }
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const existing = toolCalls.get(idx) ?? {
                      id: tc.id ?? "",
                      name: tc.function?.name ?? "",
                      argumentsJson: ""
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
                    reasoningTokens: ev.usage.completion_tokens_details?.reasoning_tokens
                  };
                }
              } catch {
              }
            }
          }
        }
      } catch (err) {
        yield {
          kind: "done",
          stopReason: "error",
          finalText,
          toolCalls: [...toolCalls.values()],
          usage,
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: performance.now() - start
        };
        return;
      }
      for (const tc of toolCalls.values()) {
        yield { kind: "tool_call", call: tc };
      }
      yield {
        kind: "done",
        stopReason,
        finalText,
        toolCalls: [...toolCalls.values()],
        usage,
        latencyMs: performance.now() - start
      };
    },
    async embed(req) {
      const resp = await fetchImpl(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`
        },
        body: JSON.stringify({
          model: req.model,
          input: req.inputs
        })
      });
      if (!resp.ok) {
        throw new Error(`embed ${resp.status}: ${await resp.text().catch(() => "")}`);
      }
      const json = await resp.json();
      return {
        embeddings: (json.data ?? []).map((d) => d.embedding),
        usage: json.usage ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: 0
        } : void 0
      };
    },
    async describe() {
      try {
        const resp = await fetchImpl(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${opts.apiKey}` }
        });
        const json = resp.ok ? await resp.json() : { data: [] };
        const available = (json.data ?? []).map((m) => ({
          id: m.id,
          displayName: m.name ?? m.id,
          capabilities: inferCapabilities(m),
          contextWindow: m.context_length,
          pricePerMillionInputTokens: m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : void 0,
          pricePerMillionOutputTokens: m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : void 0
        }));
        return {
          transportName: baseUrl.includes("openrouter") ? "openrouter" : "openai-compatible",
          transportVersion: "browser-direct/1",
          availableModels: available
        };
      } catch {
        return {
          transportName: "openai-compatible",
          transportVersion: "browser-direct/1",
          availableModels: []
        };
      }
    }
  };
}
function toOpenAiMessage(m) {
  const out = { role: m.role };
  if (m.contentParts?.length) {
    out.content = m.contentParts.map(
      (p) => p.kind === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.url ?? `data:${p.mimeType};base64,${p.base64}` } }
    );
  } else {
    out.content = m.content ?? "";
  }
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.argumentsJson }
    }));
  }
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  return out;
}
function mapStopReason(r) {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "error";
    default:
      return "end_turn";
  }
}
function inferCapabilities(m) {
  const caps = ["chat"];
  if (m.architecture?.modality?.includes("image")) caps.push("vision");
  if (m.supports_tool_calling) caps.push("tool_use");
  return caps;
}

// ../../../runtime/src/agentLoop.ts
async function runAgentLoop(opts) {
  const tools = opts.tools ?? [];
  const maxIterations = opts.maxIterations ?? 8;
  const messages = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.initialUserMessage }
  ];
  const toolDefs = tools.map((t) => t.definition);
  const toolByName = new Map(tools.map((t) => [t.definition.name, t]));
  let finalText = "";
  let iterations = 0;
  const toolCalls = [];
  let usage;
  let stopReason = "end_turn";
  while (iterations < maxIterations) {
    iterations++;
    const calls = [];
    let turnText = "";
    const stream = opts.llmClient.generateChat({
      model: opts.model,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : void 0
    });
    for await (const ev of stream) {
      if (ev.kind === "delta") {
        turnText += ev.text;
        opts.onDelta?.(ev.text);
      } else if (ev.kind === "tool_call") {
        calls.push(ev.call);
      } else if (ev.kind === "done") {
        stopReason = ev.stopReason;
        usage = ev.usage ?? usage;
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
    if (calls.length === 0) break;
    messages.push({
      role: "assistant",
      content: turnText,
      toolCalls: calls
    });
    for (const call of calls) {
      const tool = toolByName.get(call.name);
      let result;
      if (!tool) {
        result = `error: tool '${call.name}' not registered`;
      } else {
        try {
          const args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
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
        toolCallId: call.id
      });
    }
  }
  return { text: finalText, iterations, toolCalls, usage, stopReason };
}

// ../../../../../../node_modules/.bun/dompurify@3.4.1/node_modules/dompurify/dist/purify.es.mjs
var {
  entries,
  setPrototypeOf,
  isFrozen,
  getPrototypeOf,
  getOwnPropertyDescriptor
} = Object;
var {
  freeze,
  seal,
  create
} = Object;
var {
  apply,
  construct
} = typeof Reflect !== "undefined" && Reflect;
if (!freeze) {
  freeze = function freeze2(x) {
    return x;
  };
}
if (!seal) {
  seal = function seal2(x) {
    return x;
  };
}
if (!apply) {
  apply = function apply2(func, thisArg) {
    for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) {
      args[_key - 2] = arguments[_key];
    }
    return func.apply(thisArg, args);
  };
}
if (!construct) {
  construct = function construct2(Func) {
    for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
      args[_key2 - 1] = arguments[_key2];
    }
    return new Func(...args);
  };
}
var arrayForEach = unapply(Array.prototype.forEach);
var arrayLastIndexOf = unapply(Array.prototype.lastIndexOf);
var arrayPop = unapply(Array.prototype.pop);
var arrayPush = unapply(Array.prototype.push);
var arraySplice = unapply(Array.prototype.splice);
var arrayIsArray = Array.isArray;
var stringToLowerCase = unapply(String.prototype.toLowerCase);
var stringToString = unapply(String.prototype.toString);
var stringMatch = unapply(String.prototype.match);
var stringReplace = unapply(String.prototype.replace);
var stringIndexOf = unapply(String.prototype.indexOf);
var stringTrim = unapply(String.prototype.trim);
var numberToString = unapply(Number.prototype.toString);
var booleanToString = unapply(Boolean.prototype.toString);
var bigintToString = typeof BigInt === "undefined" ? null : unapply(BigInt.prototype.toString);
var symbolToString = typeof Symbol === "undefined" ? null : unapply(Symbol.prototype.toString);
var objectHasOwnProperty = unapply(Object.prototype.hasOwnProperty);
var objectToString = unapply(Object.prototype.toString);
var regExpTest = unapply(RegExp.prototype.test);
var typeErrorCreate = unconstruct(TypeError);
function unapply(func) {
  return function(thisArg) {
    if (thisArg instanceof RegExp) {
      thisArg.lastIndex = 0;
    }
    for (var _len3 = arguments.length, args = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1; _key3 < _len3; _key3++) {
      args[_key3 - 1] = arguments[_key3];
    }
    return apply(func, thisArg, args);
  };
}
function unconstruct(Func) {
  return function() {
    for (var _len4 = arguments.length, args = new Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
      args[_key4] = arguments[_key4];
    }
    return construct(Func, args);
  };
}
function addToSet(set, array) {
  let transformCaseFunc = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : stringToLowerCase;
  if (setPrototypeOf) {
    setPrototypeOf(set, null);
  }
  if (!arrayIsArray(array)) {
    return set;
  }
  let l = array.length;
  while (l--) {
    let element = array[l];
    if (typeof element === "string") {
      const lcElement = transformCaseFunc(element);
      if (lcElement !== element) {
        if (!isFrozen(array)) {
          array[l] = lcElement;
        }
        element = lcElement;
      }
    }
    set[element] = true;
  }
  return set;
}
function cleanArray(array) {
  for (let index = 0; index < array.length; index++) {
    const isPropertyExist = objectHasOwnProperty(array, index);
    if (!isPropertyExist) {
      array[index] = null;
    }
  }
  return array;
}
function clone(object) {
  const newObject = create(null);
  for (const [property, value] of entries(object)) {
    const isPropertyExist = objectHasOwnProperty(object, property);
    if (isPropertyExist) {
      if (arrayIsArray(value)) {
        newObject[property] = cleanArray(value);
      } else if (value && typeof value === "object" && value.constructor === Object) {
        newObject[property] = clone(value);
      } else {
        newObject[property] = value;
      }
    }
  }
  return newObject;
}
function stringifyValue(value) {
  switch (typeof value) {
    case "string": {
      return value;
    }
    case "number": {
      return numberToString(value);
    }
    case "boolean": {
      return booleanToString(value);
    }
    case "bigint": {
      return bigintToString ? bigintToString(value) : "0";
    }
    case "symbol": {
      return symbolToString ? symbolToString(value) : "Symbol()";
    }
    case "undefined": {
      return objectToString(value);
    }
    case "function":
    case "object": {
      if (value === null) {
        return objectToString(value);
      }
      const valueAsRecord = value;
      const valueToString = lookupGetter(valueAsRecord, "toString");
      if (typeof valueToString === "function") {
        const stringified = valueToString(valueAsRecord);
        return typeof stringified === "string" ? stringified : objectToString(stringified);
      }
      return objectToString(value);
    }
    default: {
      return objectToString(value);
    }
  }
}
function lookupGetter(object, prop) {
  while (object !== null) {
    const desc = getOwnPropertyDescriptor(object, prop);
    if (desc) {
      if (desc.get) {
        return unapply(desc.get);
      }
      if (typeof desc.value === "function") {
        return unapply(desc.value);
      }
    }
    object = getPrototypeOf(object);
  }
  function fallbackValue() {
    return null;
  }
  return fallbackValue;
}
function isRegex(value) {
  try {
    regExpTest(value, "");
    return true;
  } catch (_unused) {
    return false;
  }
}
var html$1 = freeze(["a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b", "bdi", "bdo", "big", "blink", "blockquote", "body", "br", "button", "canvas", "caption", "center", "cite", "code", "col", "colgroup", "content", "data", "datalist", "dd", "decorator", "del", "details", "dfn", "dialog", "dir", "div", "dl", "dt", "element", "em", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "img", "input", "ins", "kbd", "label", "legend", "li", "main", "map", "mark", "marquee", "menu", "menuitem", "meter", "nav", "nobr", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section", "select", "shadow", "slot", "small", "source", "spacer", "span", "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "tr", "track", "tt", "u", "ul", "var", "video", "wbr"]);
var svg$1 = freeze(["svg", "a", "altglyph", "altglyphdef", "altglyphitem", "animatecolor", "animatemotion", "animatetransform", "circle", "clippath", "defs", "desc", "ellipse", "enterkeyhint", "exportparts", "filter", "font", "g", "glyph", "glyphref", "hkern", "image", "inputmode", "line", "lineargradient", "marker", "mask", "metadata", "mpath", "part", "path", "pattern", "polygon", "polyline", "radialgradient", "rect", "stop", "style", "switch", "symbol", "text", "textpath", "title", "tref", "tspan", "view", "vkern"]);
var svgFilters = freeze(["feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence"]);
var svgDisallowed = freeze(["animate", "color-profile", "cursor", "discard", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "foreignobject", "hatch", "hatchpath", "mesh", "meshgradient", "meshpatch", "meshrow", "missing-glyph", "script", "set", "solidcolor", "unknown", "use"]);
var mathMl$1 = freeze(["math", "menclose", "merror", "mfenced", "mfrac", "mglyph", "mi", "mlabeledtr", "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msup", "msubsup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "mprescripts"]);
var mathMlDisallowed = freeze(["maction", "maligngroup", "malignmark", "mlongdiv", "mscarries", "mscarry", "msgroup", "mstack", "msline", "msrow", "semantics", "annotation", "annotation-xml", "mprescripts", "none"]);
var text = freeze(["#text"]);
var html = freeze(["accept", "action", "align", "alt", "autocapitalize", "autocomplete", "autopictureinpicture", "autoplay", "background", "bgcolor", "border", "capture", "cellpadding", "cellspacing", "checked", "cite", "class", "clear", "color", "cols", "colspan", "controls", "controlslist", "coords", "crossorigin", "datetime", "decoding", "default", "dir", "disabled", "disablepictureinpicture", "disableremoteplayback", "download", "draggable", "enctype", "enterkeyhint", "exportparts", "face", "for", "headers", "height", "hidden", "high", "href", "hreflang", "id", "inert", "inputmode", "integrity", "ismap", "kind", "label", "lang", "list", "loading", "loop", "low", "max", "maxlength", "media", "method", "min", "minlength", "multiple", "muted", "name", "nonce", "noshade", "novalidate", "nowrap", "open", "optimum", "part", "pattern", "placeholder", "playsinline", "popover", "popovertarget", "popovertargetaction", "poster", "preload", "pubdate", "radiogroup", "readonly", "rel", "required", "rev", "reversed", "role", "rows", "rowspan", "spellcheck", "scope", "selected", "shape", "size", "sizes", "slot", "span", "srclang", "start", "src", "srcset", "step", "style", "summary", "tabindex", "title", "translate", "type", "usemap", "valign", "value", "width", "wrap", "xmlns"]);
var svg = freeze(["accent-height", "accumulate", "additive", "alignment-baseline", "amplitude", "ascent", "attributename", "attributetype", "azimuth", "basefrequency", "baseline-shift", "begin", "bias", "by", "class", "clip", "clippathunits", "clip-path", "clip-rule", "color", "color-interpolation", "color-interpolation-filters", "color-profile", "color-rendering", "cx", "cy", "d", "dx", "dy", "diffuseconstant", "direction", "display", "divisor", "dur", "edgemode", "elevation", "end", "exponent", "fill", "fill-opacity", "fill-rule", "filter", "filterunits", "flood-color", "flood-opacity", "font-family", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight", "fx", "fy", "g1", "g2", "glyph-name", "glyphref", "gradientunits", "gradienttransform", "height", "href", "id", "image-rendering", "in", "in2", "intercept", "k", "k1", "k2", "k3", "k4", "kerning", "keypoints", "keysplines", "keytimes", "lang", "lengthadjust", "letter-spacing", "kernelmatrix", "kernelunitlength", "lighting-color", "local", "marker-end", "marker-mid", "marker-start", "markerheight", "markerunits", "markerwidth", "maskcontentunits", "maskunits", "max", "mask", "mask-type", "media", "method", "mode", "min", "name", "numoctaves", "offset", "operator", "opacity", "order", "orient", "orientation", "origin", "overflow", "paint-order", "path", "pathlength", "patterncontentunits", "patterntransform", "patternunits", "points", "preservealpha", "preserveaspectratio", "primitiveunits", "r", "rx", "ry", "radius", "refx", "refy", "repeatcount", "repeatdur", "restart", "result", "rotate", "scale", "seed", "shape-rendering", "slope", "specularconstant", "specularexponent", "spreadmethod", "startoffset", "stddeviation", "stitchtiles", "stop-color", "stop-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke", "stroke-width", "style", "surfacescale", "systemlanguage", "tabindex", "tablevalues", "targetx", "targety", "transform", "transform-origin", "text-anchor", "text-decoration", "text-rendering", "textlength", "type", "u1", "u2", "unicode", "values", "viewbox", "visibility", "version", "vert-adv-y", "vert-origin-x", "vert-origin-y", "width", "word-spacing", "wrap", "writing-mode", "xchannelselector", "ychannelselector", "x", "x1", "x2", "xmlns", "y", "y1", "y2", "z", "zoomandpan"]);
var mathMl = freeze(["accent", "accentunder", "align", "bevelled", "close", "columnalign", "columnlines", "columnspacing", "columnspan", "denomalign", "depth", "dir", "display", "displaystyle", "encoding", "fence", "frame", "height", "href", "id", "largeop", "length", "linethickness", "lquote", "lspace", "mathbackground", "mathcolor", "mathsize", "mathvariant", "maxsize", "minsize", "movablelimits", "notation", "numalign", "open", "rowalign", "rowlines", "rowspacing", "rowspan", "rspace", "rquote", "scriptlevel", "scriptminsize", "scriptsizemultiplier", "selection", "separator", "separators", "stretchy", "subscriptshift", "supscriptshift", "symmetric", "voffset", "width", "xmlns"]);
var xml = freeze(["xlink:href", "xml:id", "xlink:title", "xml:space", "xmlns:xlink"]);
var MUSTACHE_EXPR = seal(/\{\{[\w\W]*|[\w\W]*\}\}/gm);
var ERB_EXPR = seal(/<%[\w\W]*|[\w\W]*%>/gm);
var TMPLIT_EXPR = seal(/\$\{[\w\W]*/gm);
var DATA_ATTR = seal(/^data-[\-\w.\u00B7-\uFFFF]+$/);
var ARIA_ATTR = seal(/^aria-[\-\w]+$/);
var IS_ALLOWED_URI = seal(
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  // eslint-disable-line no-useless-escape
);
var IS_SCRIPT_OR_DATA = seal(/^(?:\w+script|data):/i);
var ATTR_WHITESPACE = seal(
  /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g
  // eslint-disable-line no-control-regex
);
var DOCTYPE_NAME = seal(/^html$/i);
var CUSTOM_ELEMENT = seal(/^[a-z][.\w]*(-[.\w]+)+$/i);
var EXPRESSIONS = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  ARIA_ATTR,
  ATTR_WHITESPACE,
  CUSTOM_ELEMENT,
  DATA_ATTR,
  DOCTYPE_NAME,
  ERB_EXPR,
  IS_ALLOWED_URI,
  IS_SCRIPT_OR_DATA,
  MUSTACHE_EXPR,
  TMPLIT_EXPR
});
var NODE_TYPE = {
  element: 1,
  text: 3,
  // Deprecated
  progressingInstruction: 7,
  comment: 8,
  document: 9
};
var getGlobal = function getGlobal2() {
  return typeof window === "undefined" ? null : window;
};
var _createTrustedTypesPolicy = function _createTrustedTypesPolicy2(trustedTypes, purifyHostElement) {
  if (typeof trustedTypes !== "object" || typeof trustedTypes.createPolicy !== "function") {
    return null;
  }
  let suffix = null;
  const ATTR_NAME = "data-tt-policy-suffix";
  if (purifyHostElement && purifyHostElement.hasAttribute(ATTR_NAME)) {
    suffix = purifyHostElement.getAttribute(ATTR_NAME);
  }
  const policyName = "dompurify" + (suffix ? "#" + suffix : "");
  try {
    return trustedTypes.createPolicy(policyName, {
      createHTML(html2) {
        return html2;
      },
      createScriptURL(scriptUrl) {
        return scriptUrl;
      }
    });
  } catch (_) {
    console.warn("TrustedTypes policy " + policyName + " could not be created.");
    return null;
  }
};
var _createHooksMap = function _createHooksMap2() {
  return {
    afterSanitizeAttributes: [],
    afterSanitizeElements: [],
    afterSanitizeShadowDOM: [],
    beforeSanitizeAttributes: [],
    beforeSanitizeElements: [],
    beforeSanitizeShadowDOM: [],
    uponSanitizeAttribute: [],
    uponSanitizeElement: [],
    uponSanitizeShadowNode: []
  };
};
function createDOMPurify() {
  let window2 = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : getGlobal();
  const DOMPurify = (root) => createDOMPurify(root);
  DOMPurify.version = "3.4.1";
  DOMPurify.removed = [];
  if (!window2 || !window2.document || window2.document.nodeType !== NODE_TYPE.document || !window2.Element) {
    DOMPurify.isSupported = false;
    return DOMPurify;
  }
  let {
    document: document2
  } = window2;
  const originalDocument = document2;
  const currentScript = originalDocument.currentScript;
  const {
    DocumentFragment,
    HTMLTemplateElement,
    Node,
    Element,
    NodeFilter,
    NamedNodeMap = window2.NamedNodeMap || window2.MozNamedAttrMap,
    HTMLFormElement,
    DOMParser,
    trustedTypes
  } = window2;
  const ElementPrototype = Element.prototype;
  const cloneNode = lookupGetter(ElementPrototype, "cloneNode");
  const remove = lookupGetter(ElementPrototype, "remove");
  const getNextSibling = lookupGetter(ElementPrototype, "nextSibling");
  const getChildNodes = lookupGetter(ElementPrototype, "childNodes");
  const getParentNode = lookupGetter(ElementPrototype, "parentNode");
  if (typeof HTMLTemplateElement === "function") {
    const template = document2.createElement("template");
    if (template.content && template.content.ownerDocument) {
      document2 = template.content.ownerDocument;
    }
  }
  let trustedTypesPolicy;
  let emptyHTML = "";
  const {
    implementation,
    createNodeIterator,
    createDocumentFragment,
    getElementsByTagName
  } = document2;
  const {
    importNode
  } = originalDocument;
  let hooks = _createHooksMap();
  DOMPurify.isSupported = typeof entries === "function" && typeof getParentNode === "function" && implementation && implementation.createHTMLDocument !== void 0;
  const {
    MUSTACHE_EXPR: MUSTACHE_EXPR2,
    ERB_EXPR: ERB_EXPR2,
    TMPLIT_EXPR: TMPLIT_EXPR2,
    DATA_ATTR: DATA_ATTR2,
    ARIA_ATTR: ARIA_ATTR2,
    IS_SCRIPT_OR_DATA: IS_SCRIPT_OR_DATA2,
    ATTR_WHITESPACE: ATTR_WHITESPACE2,
    CUSTOM_ELEMENT: CUSTOM_ELEMENT2
  } = EXPRESSIONS;
  let {
    IS_ALLOWED_URI: IS_ALLOWED_URI$1
  } = EXPRESSIONS;
  let ALLOWED_TAGS = null;
  const DEFAULT_ALLOWED_TAGS = addToSet({}, [...html$1, ...svg$1, ...svgFilters, ...mathMl$1, ...text]);
  let ALLOWED_ATTR = null;
  const DEFAULT_ALLOWED_ATTR = addToSet({}, [...html, ...svg, ...mathMl, ...xml]);
  let CUSTOM_ELEMENT_HANDLING = Object.seal(create(null, {
    tagNameCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    attributeNameCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    allowCustomizedBuiltInElements: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: false
    }
  }));
  let FORBID_TAGS = null;
  let FORBID_ATTR = null;
  const EXTRA_ELEMENT_HANDLING = Object.seal(create(null, {
    tagCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    attributeCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    }
  }));
  let ALLOW_ARIA_ATTR = true;
  let ALLOW_DATA_ATTR = true;
  let ALLOW_UNKNOWN_PROTOCOLS = false;
  let ALLOW_SELF_CLOSE_IN_ATTR = true;
  let SAFE_FOR_TEMPLATES = false;
  let SAFE_FOR_XML = true;
  let WHOLE_DOCUMENT = false;
  let SET_CONFIG = false;
  let FORCE_BODY = false;
  let RETURN_DOM = false;
  let RETURN_DOM_FRAGMENT = false;
  let RETURN_TRUSTED_TYPE = false;
  let SANITIZE_DOM = true;
  let SANITIZE_NAMED_PROPS = false;
  const SANITIZE_NAMED_PROPS_PREFIX = "user-content-";
  let KEEP_CONTENT = true;
  let IN_PLACE = false;
  let USE_PROFILES = {};
  let FORBID_CONTENTS = null;
  const DEFAULT_FORBID_CONTENTS = addToSet({}, ["annotation-xml", "audio", "colgroup", "desc", "foreignobject", "head", "iframe", "math", "mi", "mn", "mo", "ms", "mtext", "noembed", "noframes", "noscript", "plaintext", "script", "style", "svg", "template", "thead", "title", "video", "xmp"]);
  let DATA_URI_TAGS = null;
  const DEFAULT_DATA_URI_TAGS = addToSet({}, ["audio", "video", "img", "source", "image", "track"]);
  let URI_SAFE_ATTRIBUTES = null;
  const DEFAULT_URI_SAFE_ATTRIBUTES = addToSet({}, ["alt", "class", "for", "id", "label", "name", "pattern", "placeholder", "role", "summary", "title", "value", "style", "xmlns"]);
  const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
  let NAMESPACE = HTML_NAMESPACE;
  let IS_EMPTY_INPUT = false;
  let ALLOWED_NAMESPACES = null;
  const DEFAULT_ALLOWED_NAMESPACES = addToSet({}, [MATHML_NAMESPACE, SVG_NAMESPACE, HTML_NAMESPACE], stringToString);
  let MATHML_TEXT_INTEGRATION_POINTS = addToSet({}, ["mi", "mo", "mn", "ms", "mtext"]);
  let HTML_INTEGRATION_POINTS = addToSet({}, ["annotation-xml"]);
  const COMMON_SVG_AND_HTML_ELEMENTS = addToSet({}, ["title", "style", "font", "a", "script"]);
  let PARSER_MEDIA_TYPE = null;
  const SUPPORTED_PARSER_MEDIA_TYPES = ["application/xhtml+xml", "text/html"];
  const DEFAULT_PARSER_MEDIA_TYPE = "text/html";
  let transformCaseFunc = null;
  let CONFIG = null;
  const formElement = document2.createElement("form");
  const isRegexOrFunction = function isRegexOrFunction2(testValue) {
    return testValue instanceof RegExp || testValue instanceof Function;
  };
  const _parseConfig = function _parseConfig2() {
    let cfg = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    if (CONFIG && CONFIG === cfg) {
      return;
    }
    if (!cfg || typeof cfg !== "object") {
      cfg = {};
    }
    cfg = clone(cfg);
    PARSER_MEDIA_TYPE = // eslint-disable-next-line unicorn/prefer-includes
    SUPPORTED_PARSER_MEDIA_TYPES.indexOf(cfg.PARSER_MEDIA_TYPE) === -1 ? DEFAULT_PARSER_MEDIA_TYPE : cfg.PARSER_MEDIA_TYPE;
    transformCaseFunc = PARSER_MEDIA_TYPE === "application/xhtml+xml" ? stringToString : stringToLowerCase;
    ALLOWED_TAGS = objectHasOwnProperty(cfg, "ALLOWED_TAGS") && arrayIsArray(cfg.ALLOWED_TAGS) ? addToSet({}, cfg.ALLOWED_TAGS, transformCaseFunc) : DEFAULT_ALLOWED_TAGS;
    ALLOWED_ATTR = objectHasOwnProperty(cfg, "ALLOWED_ATTR") && arrayIsArray(cfg.ALLOWED_ATTR) ? addToSet({}, cfg.ALLOWED_ATTR, transformCaseFunc) : DEFAULT_ALLOWED_ATTR;
    ALLOWED_NAMESPACES = objectHasOwnProperty(cfg, "ALLOWED_NAMESPACES") && arrayIsArray(cfg.ALLOWED_NAMESPACES) ? addToSet({}, cfg.ALLOWED_NAMESPACES, stringToString) : DEFAULT_ALLOWED_NAMESPACES;
    URI_SAFE_ATTRIBUTES = objectHasOwnProperty(cfg, "ADD_URI_SAFE_ATTR") && arrayIsArray(cfg.ADD_URI_SAFE_ATTR) ? addToSet(clone(DEFAULT_URI_SAFE_ATTRIBUTES), cfg.ADD_URI_SAFE_ATTR, transformCaseFunc) : DEFAULT_URI_SAFE_ATTRIBUTES;
    DATA_URI_TAGS = objectHasOwnProperty(cfg, "ADD_DATA_URI_TAGS") && arrayIsArray(cfg.ADD_DATA_URI_TAGS) ? addToSet(clone(DEFAULT_DATA_URI_TAGS), cfg.ADD_DATA_URI_TAGS, transformCaseFunc) : DEFAULT_DATA_URI_TAGS;
    FORBID_CONTENTS = objectHasOwnProperty(cfg, "FORBID_CONTENTS") && arrayIsArray(cfg.FORBID_CONTENTS) ? addToSet({}, cfg.FORBID_CONTENTS, transformCaseFunc) : DEFAULT_FORBID_CONTENTS;
    FORBID_TAGS = objectHasOwnProperty(cfg, "FORBID_TAGS") && arrayIsArray(cfg.FORBID_TAGS) ? addToSet({}, cfg.FORBID_TAGS, transformCaseFunc) : clone({});
    FORBID_ATTR = objectHasOwnProperty(cfg, "FORBID_ATTR") && arrayIsArray(cfg.FORBID_ATTR) ? addToSet({}, cfg.FORBID_ATTR, transformCaseFunc) : clone({});
    USE_PROFILES = objectHasOwnProperty(cfg, "USE_PROFILES") ? cfg.USE_PROFILES && typeof cfg.USE_PROFILES === "object" ? clone(cfg.USE_PROFILES) : cfg.USE_PROFILES : false;
    ALLOW_ARIA_ATTR = cfg.ALLOW_ARIA_ATTR !== false;
    ALLOW_DATA_ATTR = cfg.ALLOW_DATA_ATTR !== false;
    ALLOW_UNKNOWN_PROTOCOLS = cfg.ALLOW_UNKNOWN_PROTOCOLS || false;
    ALLOW_SELF_CLOSE_IN_ATTR = cfg.ALLOW_SELF_CLOSE_IN_ATTR !== false;
    SAFE_FOR_TEMPLATES = cfg.SAFE_FOR_TEMPLATES || false;
    SAFE_FOR_XML = cfg.SAFE_FOR_XML !== false;
    WHOLE_DOCUMENT = cfg.WHOLE_DOCUMENT || false;
    RETURN_DOM = cfg.RETURN_DOM || false;
    RETURN_DOM_FRAGMENT = cfg.RETURN_DOM_FRAGMENT || false;
    RETURN_TRUSTED_TYPE = cfg.RETURN_TRUSTED_TYPE || false;
    FORCE_BODY = cfg.FORCE_BODY || false;
    SANITIZE_DOM = cfg.SANITIZE_DOM !== false;
    SANITIZE_NAMED_PROPS = cfg.SANITIZE_NAMED_PROPS || false;
    KEEP_CONTENT = cfg.KEEP_CONTENT !== false;
    IN_PLACE = cfg.IN_PLACE || false;
    IS_ALLOWED_URI$1 = isRegex(cfg.ALLOWED_URI_REGEXP) ? cfg.ALLOWED_URI_REGEXP : IS_ALLOWED_URI;
    NAMESPACE = typeof cfg.NAMESPACE === "string" ? cfg.NAMESPACE : HTML_NAMESPACE;
    MATHML_TEXT_INTEGRATION_POINTS = objectHasOwnProperty(cfg, "MATHML_TEXT_INTEGRATION_POINTS") && cfg.MATHML_TEXT_INTEGRATION_POINTS && typeof cfg.MATHML_TEXT_INTEGRATION_POINTS === "object" ? clone(cfg.MATHML_TEXT_INTEGRATION_POINTS) : addToSet({}, ["mi", "mo", "mn", "ms", "mtext"]);
    HTML_INTEGRATION_POINTS = objectHasOwnProperty(cfg, "HTML_INTEGRATION_POINTS") && cfg.HTML_INTEGRATION_POINTS && typeof cfg.HTML_INTEGRATION_POINTS === "object" ? clone(cfg.HTML_INTEGRATION_POINTS) : addToSet({}, ["annotation-xml"]);
    const customElementHandling = objectHasOwnProperty(cfg, "CUSTOM_ELEMENT_HANDLING") && cfg.CUSTOM_ELEMENT_HANDLING && typeof cfg.CUSTOM_ELEMENT_HANDLING === "object" ? clone(cfg.CUSTOM_ELEMENT_HANDLING) : create(null);
    CUSTOM_ELEMENT_HANDLING = create(null);
    if (objectHasOwnProperty(customElementHandling, "tagNameCheck") && isRegexOrFunction(customElementHandling.tagNameCheck)) {
      CUSTOM_ELEMENT_HANDLING.tagNameCheck = customElementHandling.tagNameCheck;
    }
    if (objectHasOwnProperty(customElementHandling, "attributeNameCheck") && isRegexOrFunction(customElementHandling.attributeNameCheck)) {
      CUSTOM_ELEMENT_HANDLING.attributeNameCheck = customElementHandling.attributeNameCheck;
    }
    if (objectHasOwnProperty(customElementHandling, "allowCustomizedBuiltInElements") && typeof customElementHandling.allowCustomizedBuiltInElements === "boolean") {
      CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements = customElementHandling.allowCustomizedBuiltInElements;
    }
    if (SAFE_FOR_TEMPLATES) {
      ALLOW_DATA_ATTR = false;
    }
    if (RETURN_DOM_FRAGMENT) {
      RETURN_DOM = true;
    }
    if (USE_PROFILES) {
      ALLOWED_TAGS = addToSet({}, text);
      ALLOWED_ATTR = create(null);
      if (USE_PROFILES.html === true) {
        addToSet(ALLOWED_TAGS, html$1);
        addToSet(ALLOWED_ATTR, html);
      }
      if (USE_PROFILES.svg === true) {
        addToSet(ALLOWED_TAGS, svg$1);
        addToSet(ALLOWED_ATTR, svg);
        addToSet(ALLOWED_ATTR, xml);
      }
      if (USE_PROFILES.svgFilters === true) {
        addToSet(ALLOWED_TAGS, svgFilters);
        addToSet(ALLOWED_ATTR, svg);
        addToSet(ALLOWED_ATTR, xml);
      }
      if (USE_PROFILES.mathMl === true) {
        addToSet(ALLOWED_TAGS, mathMl$1);
        addToSet(ALLOWED_ATTR, mathMl);
        addToSet(ALLOWED_ATTR, xml);
      }
    }
    EXTRA_ELEMENT_HANDLING.tagCheck = null;
    EXTRA_ELEMENT_HANDLING.attributeCheck = null;
    if (objectHasOwnProperty(cfg, "ADD_TAGS")) {
      if (typeof cfg.ADD_TAGS === "function") {
        EXTRA_ELEMENT_HANDLING.tagCheck = cfg.ADD_TAGS;
      } else if (arrayIsArray(cfg.ADD_TAGS)) {
        if (ALLOWED_TAGS === DEFAULT_ALLOWED_TAGS) {
          ALLOWED_TAGS = clone(ALLOWED_TAGS);
        }
        addToSet(ALLOWED_TAGS, cfg.ADD_TAGS, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_ATTR")) {
      if (typeof cfg.ADD_ATTR === "function") {
        EXTRA_ELEMENT_HANDLING.attributeCheck = cfg.ADD_ATTR;
      } else if (arrayIsArray(cfg.ADD_ATTR)) {
        if (ALLOWED_ATTR === DEFAULT_ALLOWED_ATTR) {
          ALLOWED_ATTR = clone(ALLOWED_ATTR);
        }
        addToSet(ALLOWED_ATTR, cfg.ADD_ATTR, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_URI_SAFE_ATTR") && arrayIsArray(cfg.ADD_URI_SAFE_ATTR)) {
      addToSet(URI_SAFE_ATTRIBUTES, cfg.ADD_URI_SAFE_ATTR, transformCaseFunc);
    }
    if (objectHasOwnProperty(cfg, "FORBID_CONTENTS") && arrayIsArray(cfg.FORBID_CONTENTS)) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.FORBID_CONTENTS, transformCaseFunc);
    }
    if (objectHasOwnProperty(cfg, "ADD_FORBID_CONTENTS") && arrayIsArray(cfg.ADD_FORBID_CONTENTS)) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.ADD_FORBID_CONTENTS, transformCaseFunc);
    }
    if (KEEP_CONTENT) {
      ALLOWED_TAGS["#text"] = true;
    }
    if (WHOLE_DOCUMENT) {
      addToSet(ALLOWED_TAGS, ["html", "head", "body"]);
    }
    if (ALLOWED_TAGS.table) {
      addToSet(ALLOWED_TAGS, ["tbody"]);
      delete FORBID_TAGS.tbody;
    }
    if (cfg.TRUSTED_TYPES_POLICY) {
      if (typeof cfg.TRUSTED_TYPES_POLICY.createHTML !== "function") {
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');
      }
      if (typeof cfg.TRUSTED_TYPES_POLICY.createScriptURL !== "function") {
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');
      }
      trustedTypesPolicy = cfg.TRUSTED_TYPES_POLICY;
      emptyHTML = trustedTypesPolicy.createHTML("");
    } else {
      if (trustedTypesPolicy === void 0) {
        trustedTypesPolicy = _createTrustedTypesPolicy(trustedTypes, currentScript);
      }
      if (trustedTypesPolicy !== null && typeof emptyHTML === "string") {
        emptyHTML = trustedTypesPolicy.createHTML("");
      }
    }
    if (freeze) {
      freeze(cfg);
    }
    CONFIG = cfg;
  };
  const ALL_SVG_TAGS = addToSet({}, [...svg$1, ...svgFilters, ...svgDisallowed]);
  const ALL_MATHML_TAGS = addToSet({}, [...mathMl$1, ...mathMlDisallowed]);
  const _checkValidNamespace = function _checkValidNamespace2(element) {
    let parent = getParentNode(element);
    if (!parent || !parent.tagName) {
      parent = {
        namespaceURI: NAMESPACE,
        tagName: "template"
      };
    }
    const tagName = stringToLowerCase(element.tagName);
    const parentTagName = stringToLowerCase(parent.tagName);
    if (!ALLOWED_NAMESPACES[element.namespaceURI]) {
      return false;
    }
    if (element.namespaceURI === SVG_NAMESPACE) {
      if (parent.namespaceURI === HTML_NAMESPACE) {
        return tagName === "svg";
      }
      if (parent.namespaceURI === MATHML_NAMESPACE) {
        return tagName === "svg" && (parentTagName === "annotation-xml" || MATHML_TEXT_INTEGRATION_POINTS[parentTagName]);
      }
      return Boolean(ALL_SVG_TAGS[tagName]);
    }
    if (element.namespaceURI === MATHML_NAMESPACE) {
      if (parent.namespaceURI === HTML_NAMESPACE) {
        return tagName === "math";
      }
      if (parent.namespaceURI === SVG_NAMESPACE) {
        return tagName === "math" && HTML_INTEGRATION_POINTS[parentTagName];
      }
      return Boolean(ALL_MATHML_TAGS[tagName]);
    }
    if (element.namespaceURI === HTML_NAMESPACE) {
      if (parent.namespaceURI === SVG_NAMESPACE && !HTML_INTEGRATION_POINTS[parentTagName]) {
        return false;
      }
      if (parent.namespaceURI === MATHML_NAMESPACE && !MATHML_TEXT_INTEGRATION_POINTS[parentTagName]) {
        return false;
      }
      return !ALL_MATHML_TAGS[tagName] && (COMMON_SVG_AND_HTML_ELEMENTS[tagName] || !ALL_SVG_TAGS[tagName]);
    }
    if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && ALLOWED_NAMESPACES[element.namespaceURI]) {
      return true;
    }
    return false;
  };
  const _forceRemove = function _forceRemove2(node) {
    arrayPush(DOMPurify.removed, {
      element: node
    });
    try {
      getParentNode(node).removeChild(node);
    } catch (_) {
      remove(node);
    }
  };
  const _removeAttribute = function _removeAttribute2(name, element) {
    try {
      arrayPush(DOMPurify.removed, {
        attribute: element.getAttributeNode(name),
        from: element
      });
    } catch (_) {
      arrayPush(DOMPurify.removed, {
        attribute: null,
        from: element
      });
    }
    element.removeAttribute(name);
    if (name === "is") {
      if (RETURN_DOM || RETURN_DOM_FRAGMENT) {
        try {
          _forceRemove(element);
        } catch (_) {
        }
      } else {
        try {
          element.setAttribute(name, "");
        } catch (_) {
        }
      }
    }
  };
  const _initDocument = function _initDocument2(dirty) {
    let doc = null;
    let leadingWhitespace = null;
    if (FORCE_BODY) {
      dirty = "<remove></remove>" + dirty;
    } else {
      const matches = stringMatch(dirty, /^[\r\n\t ]+/);
      leadingWhitespace = matches && matches[0];
    }
    if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && NAMESPACE === HTML_NAMESPACE) {
      dirty = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' + dirty + "</body></html>";
    }
    const dirtyPayload = trustedTypesPolicy ? trustedTypesPolicy.createHTML(dirty) : dirty;
    if (NAMESPACE === HTML_NAMESPACE) {
      try {
        doc = new DOMParser().parseFromString(dirtyPayload, PARSER_MEDIA_TYPE);
      } catch (_) {
      }
    }
    if (!doc || !doc.documentElement) {
      doc = implementation.createDocument(NAMESPACE, "template", null);
      try {
        doc.documentElement.innerHTML = IS_EMPTY_INPUT ? emptyHTML : dirtyPayload;
      } catch (_) {
      }
    }
    const body = doc.body || doc.documentElement;
    if (dirty && leadingWhitespace) {
      body.insertBefore(document2.createTextNode(leadingWhitespace), body.childNodes[0] || null);
    }
    if (NAMESPACE === HTML_NAMESPACE) {
      return getElementsByTagName.call(doc, WHOLE_DOCUMENT ? "html" : "body")[0];
    }
    return WHOLE_DOCUMENT ? doc.documentElement : body;
  };
  const _createNodeIterator = function _createNodeIterator2(root) {
    return createNodeIterator.call(
      root.ownerDocument || root,
      root,
      // eslint-disable-next-line no-bitwise
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION,
      null
    );
  };
  const _isClobbered = function _isClobbered2(element) {
    return element instanceof HTMLFormElement && (typeof element.nodeName !== "string" || typeof element.textContent !== "string" || typeof element.removeChild !== "function" || !(element.attributes instanceof NamedNodeMap) || typeof element.removeAttribute !== "function" || typeof element.setAttribute !== "function" || typeof element.namespaceURI !== "string" || typeof element.insertBefore !== "function" || typeof element.hasChildNodes !== "function");
  };
  const _isNode = function _isNode2(value) {
    return typeof Node === "function" && value instanceof Node;
  };
  function _executeHooks(hooks2, currentNode, data) {
    arrayForEach(hooks2, (hook) => {
      hook.call(DOMPurify, currentNode, data, CONFIG);
    });
  }
  const _sanitizeElements = function _sanitizeElements2(currentNode) {
    let content = null;
    _executeHooks(hooks.beforeSanitizeElements, currentNode, null);
    if (_isClobbered(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    const tagName = transformCaseFunc(currentNode.nodeName);
    _executeHooks(hooks.uponSanitizeElement, currentNode, {
      tagName,
      allowedTags: ALLOWED_TAGS
    });
    if (SAFE_FOR_XML && currentNode.hasChildNodes() && !_isNode(currentNode.firstElementChild) && regExpTest(/<[/\w!]/g, currentNode.innerHTML) && regExpTest(/<[/\w!]/g, currentNode.textContent)) {
      _forceRemove(currentNode);
      return true;
    }
    if (SAFE_FOR_XML && currentNode.namespaceURI === HTML_NAMESPACE && tagName === "style" && _isNode(currentNode.firstElementChild)) {
      _forceRemove(currentNode);
      return true;
    }
    if (currentNode.nodeType === NODE_TYPE.progressingInstruction) {
      _forceRemove(currentNode);
      return true;
    }
    if (SAFE_FOR_XML && currentNode.nodeType === NODE_TYPE.comment && regExpTest(/<[/\w]/g, currentNode.data)) {
      _forceRemove(currentNode);
      return true;
    }
    if (FORBID_TAGS[tagName] || !(EXTRA_ELEMENT_HANDLING.tagCheck instanceof Function && EXTRA_ELEMENT_HANDLING.tagCheck(tagName)) && !ALLOWED_TAGS[tagName]) {
      if (!FORBID_TAGS[tagName] && _isBasicCustomElement(tagName)) {
        if (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, tagName)) {
          return false;
        }
        if (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(tagName)) {
          return false;
        }
      }
      if (KEEP_CONTENT && !FORBID_CONTENTS[tagName]) {
        const parentNode = getParentNode(currentNode) || currentNode.parentNode;
        const childNodes = getChildNodes(currentNode) || currentNode.childNodes;
        if (childNodes && parentNode) {
          const childCount = childNodes.length;
          for (let i = childCount - 1; i >= 0; --i) {
            const childClone = cloneNode(childNodes[i], true);
            parentNode.insertBefore(childClone, getNextSibling(currentNode));
          }
        }
      }
      _forceRemove(currentNode);
      return true;
    }
    if (currentNode instanceof Element && !_checkValidNamespace(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    if ((tagName === "noscript" || tagName === "noembed" || tagName === "noframes") && regExpTest(/<\/no(script|embed|frames)/i, currentNode.innerHTML)) {
      _forceRemove(currentNode);
      return true;
    }
    if (SAFE_FOR_TEMPLATES && currentNode.nodeType === NODE_TYPE.text) {
      content = currentNode.textContent;
      arrayForEach([MUSTACHE_EXPR2, ERB_EXPR2, TMPLIT_EXPR2], (expr) => {
        content = stringReplace(content, expr, " ");
      });
      if (currentNode.textContent !== content) {
        arrayPush(DOMPurify.removed, {
          element: currentNode.cloneNode()
        });
        currentNode.textContent = content;
      }
    }
    _executeHooks(hooks.afterSanitizeElements, currentNode, null);
    return false;
  };
  const _isValidAttribute = function _isValidAttribute2(lcTag, lcName, value) {
    if (FORBID_ATTR[lcName]) {
      return false;
    }
    if (SANITIZE_DOM && (lcName === "id" || lcName === "name") && (value in document2 || value in formElement)) {
      return false;
    }
    if (ALLOW_DATA_ATTR && !FORBID_ATTR[lcName] && regExpTest(DATA_ATTR2, lcName)) ;
    else if (ALLOW_ARIA_ATTR && regExpTest(ARIA_ATTR2, lcName)) ;
    else if (EXTRA_ELEMENT_HANDLING.attributeCheck instanceof Function && EXTRA_ELEMENT_HANDLING.attributeCheck(lcName, lcTag)) ;
    else if (!ALLOWED_ATTR[lcName] || FORBID_ATTR[lcName]) {
      if (
        // First condition does a very basic check if a) it's basically a valid custom element tagname AND
        // b) if the tagName passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
        // and c) if the attribute name passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.attributeNameCheck
        _isBasicCustomElement(lcTag) && (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, lcTag) || CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(lcTag)) && (CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.attributeNameCheck, lcName) || CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.attributeNameCheck(lcName, lcTag)) || // Alternative, second condition checks if it's an `is`-attribute, AND
        // the value passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
        lcName === "is" && CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements && (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, value) || CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(value))
      ) ;
      else {
        return false;
      }
    } else if (URI_SAFE_ATTRIBUTES[lcName]) ;
    else if (regExpTest(IS_ALLOWED_URI$1, stringReplace(value, ATTR_WHITESPACE2, ""))) ;
    else if ((lcName === "src" || lcName === "xlink:href" || lcName === "href") && lcTag !== "script" && stringIndexOf(value, "data:") === 0 && DATA_URI_TAGS[lcTag]) ;
    else if (ALLOW_UNKNOWN_PROTOCOLS && !regExpTest(IS_SCRIPT_OR_DATA2, stringReplace(value, ATTR_WHITESPACE2, ""))) ;
    else if (value) {
      return false;
    } else ;
    return true;
  };
  const RESERVED_CUSTOM_ELEMENT_NAMES = addToSet({}, ["annotation-xml", "color-profile", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "missing-glyph"]);
  const _isBasicCustomElement = function _isBasicCustomElement2(tagName) {
    return !RESERVED_CUSTOM_ELEMENT_NAMES[stringToLowerCase(tagName)] && regExpTest(CUSTOM_ELEMENT2, tagName);
  };
  const _sanitizeAttributes = function _sanitizeAttributes2(currentNode) {
    _executeHooks(hooks.beforeSanitizeAttributes, currentNode, null);
    const {
      attributes
    } = currentNode;
    if (!attributes || _isClobbered(currentNode)) {
      return;
    }
    const hookEvent = {
      attrName: "",
      attrValue: "",
      keepAttr: true,
      allowedAttributes: ALLOWED_ATTR,
      forceKeepAttr: void 0
    };
    let l = attributes.length;
    while (l--) {
      const attr = attributes[l];
      const {
        name,
        namespaceURI,
        value: attrValue
      } = attr;
      const lcName = transformCaseFunc(name);
      const initValue = attrValue;
      let value = name === "value" ? initValue : stringTrim(initValue);
      hookEvent.attrName = lcName;
      hookEvent.attrValue = value;
      hookEvent.keepAttr = true;
      hookEvent.forceKeepAttr = void 0;
      _executeHooks(hooks.uponSanitizeAttribute, currentNode, hookEvent);
      value = hookEvent.attrValue;
      if (SANITIZE_NAMED_PROPS && (lcName === "id" || lcName === "name") && stringIndexOf(value, SANITIZE_NAMED_PROPS_PREFIX) !== 0) {
        _removeAttribute(name, currentNode);
        value = SANITIZE_NAMED_PROPS_PREFIX + value;
      }
      if (SAFE_FOR_XML && regExpTest(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (lcName === "attributename" && stringMatch(value, "href")) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (hookEvent.forceKeepAttr) {
        continue;
      }
      if (!hookEvent.keepAttr) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (!ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(/\/>/i, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (SAFE_FOR_TEMPLATES) {
        arrayForEach([MUSTACHE_EXPR2, ERB_EXPR2, TMPLIT_EXPR2], (expr) => {
          value = stringReplace(value, expr, " ");
        });
      }
      const lcTag = transformCaseFunc(currentNode.nodeName);
      if (!_isValidAttribute(lcTag, lcName, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (trustedTypesPolicy && typeof trustedTypes === "object" && typeof trustedTypes.getAttributeType === "function") {
        if (namespaceURI) ;
        else {
          switch (trustedTypes.getAttributeType(lcTag, lcName)) {
            case "TrustedHTML": {
              value = trustedTypesPolicy.createHTML(value);
              break;
            }
            case "TrustedScriptURL": {
              value = trustedTypesPolicy.createScriptURL(value);
              break;
            }
          }
        }
      }
      if (value !== initValue) {
        try {
          if (namespaceURI) {
            currentNode.setAttributeNS(namespaceURI, name, value);
          } else {
            currentNode.setAttribute(name, value);
          }
          if (_isClobbered(currentNode)) {
            _forceRemove(currentNode);
          } else {
            arrayPop(DOMPurify.removed);
          }
        } catch (_) {
          _removeAttribute(name, currentNode);
        }
      }
    }
    _executeHooks(hooks.afterSanitizeAttributes, currentNode, null);
  };
  const _sanitizeShadowDOM2 = function _sanitizeShadowDOM(fragment) {
    let shadowNode = null;
    const shadowIterator = _createNodeIterator(fragment);
    _executeHooks(hooks.beforeSanitizeShadowDOM, fragment, null);
    while (shadowNode = shadowIterator.nextNode()) {
      _executeHooks(hooks.uponSanitizeShadowNode, shadowNode, null);
      _sanitizeElements(shadowNode);
      _sanitizeAttributes(shadowNode);
      if (shadowNode.content instanceof DocumentFragment) {
        _sanitizeShadowDOM2(shadowNode.content);
      }
    }
    _executeHooks(hooks.afterSanitizeShadowDOM, fragment, null);
  };
  DOMPurify.sanitize = function(dirty) {
    let cfg = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
    let body = null;
    let importedNode = null;
    let currentNode = null;
    let returnNode = null;
    IS_EMPTY_INPUT = !dirty;
    if (IS_EMPTY_INPUT) {
      dirty = "<!-->";
    }
    if (typeof dirty !== "string" && !_isNode(dirty)) {
      dirty = stringifyValue(dirty);
      if (typeof dirty !== "string") {
        throw typeErrorCreate("dirty is not a string, aborting");
      }
    }
    if (!DOMPurify.isSupported) {
      return dirty;
    }
    if (!SET_CONFIG) {
      _parseConfig(cfg);
    }
    DOMPurify.removed = [];
    if (typeof dirty === "string") {
      IN_PLACE = false;
    }
    if (IN_PLACE) {
      const nn = dirty.nodeName;
      if (typeof nn === "string") {
        const tagName = transformCaseFunc(nn);
        if (!ALLOWED_TAGS[tagName] || FORBID_TAGS[tagName]) {
          throw typeErrorCreate("root node is forbidden and cannot be sanitized in-place");
        }
      }
    } else if (dirty instanceof Node) {
      body = _initDocument("<!---->");
      importedNode = body.ownerDocument.importNode(dirty, true);
      if (importedNode.nodeType === NODE_TYPE.element && importedNode.nodeName === "BODY") {
        body = importedNode;
      } else if (importedNode.nodeName === "HTML") {
        body = importedNode;
      } else {
        body.appendChild(importedNode);
      }
    } else {
      if (!RETURN_DOM && !SAFE_FOR_TEMPLATES && !WHOLE_DOCUMENT && // eslint-disable-next-line unicorn/prefer-includes
      dirty.indexOf("<") === -1) {
        return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? trustedTypesPolicy.createHTML(dirty) : dirty;
      }
      body = _initDocument(dirty);
      if (!body) {
        return RETURN_DOM ? null : RETURN_TRUSTED_TYPE ? emptyHTML : "";
      }
    }
    if (body && FORCE_BODY) {
      _forceRemove(body.firstChild);
    }
    const nodeIterator = _createNodeIterator(IN_PLACE ? dirty : body);
    while (currentNode = nodeIterator.nextNode()) {
      _sanitizeElements(currentNode);
      _sanitizeAttributes(currentNode);
      if (currentNode.content instanceof DocumentFragment) {
        _sanitizeShadowDOM2(currentNode.content);
      }
    }
    if (IN_PLACE) {
      return dirty;
    }
    if (RETURN_DOM) {
      if (SAFE_FOR_TEMPLATES) {
        body.normalize();
        let html2 = body.innerHTML;
        arrayForEach([MUSTACHE_EXPR2, ERB_EXPR2, TMPLIT_EXPR2], (expr) => {
          html2 = stringReplace(html2, expr, " ");
        });
        body.innerHTML = html2;
      }
      if (RETURN_DOM_FRAGMENT) {
        returnNode = createDocumentFragment.call(body.ownerDocument);
        while (body.firstChild) {
          returnNode.appendChild(body.firstChild);
        }
      } else {
        returnNode = body;
      }
      if (ALLOWED_ATTR.shadowroot || ALLOWED_ATTR.shadowrootmode) {
        returnNode = importNode.call(originalDocument, returnNode, true);
      }
      return returnNode;
    }
    let serializedHTML = WHOLE_DOCUMENT ? body.outerHTML : body.innerHTML;
    if (WHOLE_DOCUMENT && ALLOWED_TAGS["!doctype"] && body.ownerDocument && body.ownerDocument.doctype && body.ownerDocument.doctype.name && regExpTest(DOCTYPE_NAME, body.ownerDocument.doctype.name)) {
      serializedHTML = "<!DOCTYPE " + body.ownerDocument.doctype.name + ">\n" + serializedHTML;
    }
    if (SAFE_FOR_TEMPLATES) {
      arrayForEach([MUSTACHE_EXPR2, ERB_EXPR2, TMPLIT_EXPR2], (expr) => {
        serializedHTML = stringReplace(serializedHTML, expr, " ");
      });
    }
    return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? trustedTypesPolicy.createHTML(serializedHTML) : serializedHTML;
  };
  DOMPurify.setConfig = function() {
    let cfg = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    _parseConfig(cfg);
    SET_CONFIG = true;
  };
  DOMPurify.clearConfig = function() {
    CONFIG = null;
    SET_CONFIG = false;
  };
  DOMPurify.isValidAttribute = function(tag, attr, value) {
    if (!CONFIG) {
      _parseConfig({});
    }
    const lcTag = transformCaseFunc(tag);
    const lcName = transformCaseFunc(attr);
    return _isValidAttribute(lcTag, lcName, value);
  };
  DOMPurify.addHook = function(entryPoint, hookFunction) {
    if (typeof hookFunction !== "function") {
      return;
    }
    arrayPush(hooks[entryPoint], hookFunction);
  };
  DOMPurify.removeHook = function(entryPoint, hookFunction) {
    if (hookFunction !== void 0) {
      const index = arrayLastIndexOf(hooks[entryPoint], hookFunction);
      return index === -1 ? void 0 : arraySplice(hooks[entryPoint], index, 1)[0];
    }
    return arrayPop(hooks[entryPoint]);
  };
  DOMPurify.removeHooks = function(entryPoint) {
    hooks[entryPoint] = [];
  };
  DOMPurify.removeAllHooks = function() {
    hooks = _createHooksMap();
  };
  return DOMPurify;
}
var purify = createDOMPurify();

// ../../../runtime/src/util/sanitize.ts
var SVG_PROFILE = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Belt-and-suspenders — the SVG profile already blocks <script>
  // and on-event handlers, but list explicitly so a future profile
  // change in DOMPurify doesn't quietly weaken our policy.
  FORBID_TAGS: ["script", "foreignObject"],
  FORBID_ATTR: [
    "onclick",
    "onload",
    "onerror",
    "onmouseover",
    "onmouseout",
    "onfocus",
    "onblur",
    "onkeydown",
    "onkeyup",
    "onkeypress",
    "onchange",
    "onsubmit",
    "ondblclick",
    "onpointerdown",
    "onpointerup",
    "onanimationend",
    "onanimationstart",
    "onanimationiteration",
    "ontransitionend",
    "ontransitionstart"
  ]
};
function sanitizeSvg(svg2) {
  return purify.sanitize(svg2, SVG_PROFILE);
}

// ../../../runtime/src/htmlBindings.ts
var customCellRegistry = /* @__PURE__ */ new Map();
function registerWorkbookCell(language, impl) {
  customCellRegistry.set(language, impl);
}
var VALID_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function validId(raw) {
  if (!raw) return null;
  return VALID_ID.test(raw) ? raw : null;
}
function validIdList(raw) {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((s) => VALID_ID.test(s));
}
function parseWorkbookHtml(root) {
  const name = root.getAttribute("name") ?? "html-workbook";
  const cells = [];
  const inputs = {};
  const agents = [];
  for (const el of root.querySelectorAll("wb-input")) {
    const nm = validId(el.getAttribute("name"));
    if (!nm) continue;
    const type = el.getAttribute("type") ?? "text";
    const def = el.getAttribute("default") ?? el.textContent?.trim() ?? "";
    inputs[nm] = coerceValue(def, type);
  }
  for (const el of root.querySelectorAll("wb-cell")) {
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const language = el.getAttribute("language") ?? "rhai";
    const reads = validIdList(el.getAttribute("reads"));
    const provides = validIdList(el.getAttribute("provides"));
    if (!provides.length) provides.push(id);
    const source = el.textContent?.trim() ?? "";
    const cell = { id, language, source, dependsOn: reads, provides };
    cells.push(cell);
  }
  for (const el of root.querySelectorAll("wb-agent")) {
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const model = el.getAttribute("model") ?? "openai/gpt-4o-mini";
    const reads = validIdList(el.getAttribute("reads"));
    const systemEl = el.querySelector("wb-system");
    const systemPrompt = systemEl?.textContent?.trim() ?? "";
    const tools = [...el.querySelectorAll("wb-tool")].map((t) => validId(t.getAttribute("ref"))).filter((s) => Boolean(s));
    agents.push({ id, model, systemPrompt, reads, tools });
  }
  return { name, cells, inputs, agents };
}
function coerceValue(raw, type) {
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "boolean") return raw === "true" || raw === "1";
  return raw;
}
async function mountHtmlWorkbook(opts) {
  const doc = opts.doc ?? document;
  const root = doc.querySelector("wb-workbook");
  if (!root) throw new Error("mountHtmlWorkbook: no <wb-workbook> in document");
  const spec = parseWorkbookHtml(root);
  const wasmClient = createRuntimeClient({
    loadWasm: opts.loadWasm,
    llmClient: opts.llmClient
  });
  const client = {
    ...wasmClient,
    async runCell(req) {
      const custom = customCellRegistry.get(req.cell.language);
      if (custom) {
        const outputs = await custom.execute({
          source: req.cell.source ?? "",
          params: req.params ?? {},
          cellId: req.cell.id,
          ctx: ctxRef.current
        });
        return { outputs };
      }
      return wasmClient.runCell(req);
    }
  };
  const ctxRef = { current: null };
  const outputCache = /* @__PURE__ */ new Map();
  const executor = new ReactiveExecutor({
    client,
    cells: spec.cells,
    inputs: spec.inputs,
    workbookSlug: spec.name,
    onCellState: (state) => {
      if (state.status === "ok" && state.outputs) {
        outputCache.set(state.cellId, state.outputs);
      }
      for (const out of doc.querySelectorAll(`wb-output[for="${CSS.escape(state.cellId)}"]`)) {
        renderOutputElement(out, state, spec.cells);
      }
    }
  });
  const ctx = {
    client,
    llmClient: opts.llmClient,
    read: (cellId) => outputCache.get(cellId),
    runCell: async (cellId) => {
      const cell = spec.cells.find((c) => c.id === cellId);
      if (!cell) throw new Error(`runCell: unknown cell '${cellId}'`);
      const params = {};
      for (const dep of cell.dependsOn ?? []) {
        const out = outputCache.get(dep);
        if (out?.[0]?.kind === "text") params[dep] = out[0].content;
        else if (spec.inputs[dep] !== void 0) params[dep] = spec.inputs[dep];
      }
      const resp = await client.runCell({
        runtimeId: "imperative",
        cell,
        params
      });
      outputCache.set(cellId, resp.outputs);
      return resp.outputs;
    }
  };
  ctxRef.current = ctx;
  for (const inp of doc.querySelectorAll("wb-input")) {
    bindInputElement(inp, executor);
  }
  for (const chat of doc.querySelectorAll("wb-chat")) {
    bindChatElement(chat, ctx, spec);
  }
  for (const agentEl of doc.querySelectorAll("wb-agent")) {
    bindAgentElement(agentEl, ctx, spec);
  }
  await executor.runAll();
  return { executor, ctx, spec };
}
function bindInputElement(el, executor) {
  const name = el.getAttribute("name");
  if (!name) return;
  const type = el.getAttribute("type") ?? "text";
  const def = el.getAttribute("default") ?? "";
  if (el.querySelector("input, textarea, select")) return;
  const inputType = type === "number" ? "number" : type === "csv" ? "textarea" : "text";
  if (inputType === "textarea") {
    const ta = document.createElement("textarea");
    ta.value = def;
    ta.rows = 5;
    ta.style.width = "100%";
    ta.classList.add("wb-textarea");
    ta.addEventListener("input", () => executor.setInput(name, ta.value));
    el.appendChild(ta);
  } else {
    const input = document.createElement("input");
    input.type = inputType;
    input.value = def;
    input.classList.add("wb-input");
    if (inputType === "number") input.classList.add("num");
    else input.classList.add("text");
    input.addEventListener("input", () => {
      const v = inputType === "number" ? Number(input.value) : input.value;
      executor.setInput(name, v);
    });
    el.appendChild(input);
  }
}
function renderOutputElement(el, state, cells) {
  const cellId = el.getAttribute("for");
  if (!cellId) return;
  const cell = cells.find((c) => c.id === cellId);
  el.dataset.status = state.status;
  el.classList.toggle("wb-output-ok", state.status === "ok");
  el.classList.toggle("wb-output-running", state.status === "running");
  el.classList.toggle("wb-output-error", state.status === "error");
  el.classList.toggle("wb-output-stale", state.status === "stale");
  if (state.status === "running") {
    el.innerHTML = `<span class="wb-muted wb-mono" style="font-size: var(--t-sm);">running\u2026</span>`;
    return;
  }
  if (state.status === "error") {
    el.innerHTML = `<div class="wb-out error">${escapeHtml(state.error ?? "(error)")}</div>`;
    return;
  }
  if (state.status !== "ok" || !state.outputs) return;
  if (cell) {
    const custom = customCellRegistry.get(cell.language);
    if (custom?.renderOutput) {
      el.innerHTML = "";
      custom.renderOutput(el, state.outputs);
      return;
    }
  }
  el.innerHTML = "";
  for (const o of state.outputs) {
    el.appendChild(renderOutput(o));
  }
}
function renderOutput(o) {
  if (o.kind === "image" && o.mime_type === "image/svg+xml") {
    const div = document.createElement("div");
    div.innerHTML = sanitizeSvg(o.content);
    return div;
  }
  if (o.kind === "text" && o.mime_type === "text/csv") {
    return csvToTable(o.content);
  }
  if (o.kind === "text") {
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.style.fontFamily = "var(--font-sans)";
    div.textContent = o.content;
    return div;
  }
  if (o.kind === "error") {
    const div = document.createElement("div");
    div.className = "wb-out error";
    div.textContent = `ERROR: ${o.message}`;
    return div;
  }
  const pre = document.createElement("pre");
  pre.className = "wb-code";
  pre.textContent = JSON.stringify(o, null, 2);
  return pre;
}
function csvToTable(csv) {
  const rows = csv.trim().split("\n").map(parseCsvRow);
  const t = document.createElement("table");
  t.className = "wb-table";
  const thead = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const c of rows[0]) {
    const th = document.createElement("th");
    th.textContent = c;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (let i = 1; i < rows.length; i++) {
    const r = document.createElement("tr");
    for (const c of rows[i]) {
      const td = document.createElement("td");
      td.textContent = c;
      if (!isNaN(Number(c)) && c !== "") td.className = "num";
      r.appendChild(td);
    }
    tbody.appendChild(r);
  }
  t.appendChild(tbody);
  return t;
}
function parseCsvRow(row) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
}
function bindAgentElement(el, ctx, spec) {
  const id = el.getAttribute("id");
  if (!id) return;
  const agent = spec.agents.find((a) => a.id === id);
  if (!agent) return;
  if (el.hasAttribute("auto") || el.hasAttribute("trigger") === false) {
    runAgentOnce(el, ctx, agent).catch((err) => console.warn("agent run", err));
  }
}
async function runAgentOnce(el, ctx, agent) {
  if (!ctx.llmClient) return;
  const contextLines = [];
  for (const ref of agent.reads) {
    const out = ctx.read(ref);
    if (out?.[0]?.kind === "text") {
      contextLines.push(`### ${ref}
${out[0].content}`);
    }
  }
  const userMessage = contextLines.length > 0 ? `Context:

${contextLines.join("\n\n")}

Provide your analysis.` : "Begin.";
  const result = await runAgentLoop({
    llmClient: ctx.llmClient,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    initialUserMessage: userMessage,
    tools: []
    // tool-use agent layer comes next
  });
  const outputs = document.querySelectorAll(`wb-output[for="${CSS.escape(agent.id)}"]`);
  for (const o of outputs) {
    o.innerHTML = "";
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.textContent = result.text;
    o.appendChild(div);
  }
}
function bindChatElement(el, ctx, spec) {
  const agentId = el.getAttribute("for") ?? el.getAttribute("agent");
  if (!agentId) {
    el.innerHTML = `<div class="wb-out error">wb-chat: missing 'for' attribute</div>`;
    return;
  }
  const agent = spec.agents.find((a) => a.id === agentId);
  if (!agent) {
    el.innerHTML = `<div class="wb-out error">wb-chat: no agent with id '${escapeHtml(agentId)}'</div>`;
    return;
  }
  if (!ctx.llmClient) {
    el.innerHTML = `<div class="wb-out error">wb-chat: no llmClient configured</div>`;
    return;
  }
  el.innerHTML = `
    <div class="wb-chat">
      <div class="wb-chat-history" data-history></div>
      <div class="wb-chat-compose">
        <textarea class="wb-textarea" rows="2" data-input placeholder="Message ${escapeHtml(agentId)}\u2026"></textarea>
        <button class="wb-btn run" data-send>Send</button>
      </div>
    </div>
  `;
  const history = [];
  const historyEl = el.querySelector("[data-history]");
  const inputEl = el.querySelector("[data-input]");
  const sendBtn = el.querySelector("[data-send]");
  function renderHistory(streamingText) {
    historyEl.innerHTML = "";
    for (const m of history) {
      const div = document.createElement("div");
      div.className = `wb-chat-msg wb-chat-msg-${m.role}`;
      div.textContent = m.content;
      historyEl.appendChild(div);
    }
    if (streamingText !== void 0) {
      const div = document.createElement("div");
      div.className = "wb-chat-msg wb-chat-msg-assistant streaming";
      div.textContent = streamingText;
      historyEl.appendChild(div);
    }
    historyEl.scrollTop = historyEl.scrollHeight;
  }
  async function send() {
    const text2 = inputEl.value.trim();
    if (!text2) return;
    history.push({ role: "user", content: text2 });
    inputEl.value = "";
    sendBtn.disabled = true;
    renderHistory("");
    const contextLines = [];
    for (const ref of agent.reads) {
      const out = ctx.read(ref);
      if (out?.[0]?.kind === "text") {
        contextLines.push(`### ${ref}
${out[0].content}`);
      }
    }
    const augmentedSystem = contextLines.length > 0 ? `${agent.systemPrompt}

Available context (cell outputs):

${contextLines.join("\n\n")}` : agent.systemPrompt;
    let streamed = "";
    try {
      const it = ctx.llmClient.generateChat({
        model: agent.model,
        messages: [
          { role: "system", content: augmentedSystem },
          ...history.map((m) => ({ role: m.role, content: m.content }))
        ]
      });
      for await (const ev of it) {
        if (ev.kind === "delta") {
          streamed += ev.text;
          renderHistory(streamed);
        } else if (ev.kind === "done") {
          if (ev.errorMessage) {
            history.push({ role: "assistant", content: `[error] ${ev.errorMessage}` });
          } else {
            history.push({ role: "assistant", content: ev.finalText || streamed });
          }
        }
      }
    } catch (err) {
      history.push({
        role: "assistant",
        content: `[error] ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      renderHistory();
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }
  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
}

// ../../../runtime/src/util/url.ts
function normalize(raw) {
  return String(raw ?? "").replace(/^[ - \s]+/, "").replace(/[ - ]/g, "");
}
var SAFE_HREF = /^(?:https?:\/\/|mailto:|\/[^/]|#)/i;
function safeHref(raw) {
  const s = normalize(raw ?? "");
  if (!s) return null;
  return SAFE_HREF.test(s) ? s : null;
}

// ../../../runtime/src/markdown.ts
function escapeHtml2(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
function renderMarkdown(src) {
  const text2 = String(src ?? "");
  const blocks = [];
  const FENCE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g;
  const withPlaceholders = text2.replace(FENCE, (_m, lang, body) => {
    const id = blocks.length;
    const cls = lang ? ` class="language-${String(lang).toLowerCase()}"` : "";
    blocks.push(`<pre><code${cls}>${escapeHtml2(body)}</code></pre>`);
    return ` FENCE${id} `;
  });
  const escaped = escapeHtml2(withPlaceholders);
  const lines = escaped.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fenceMatch = line.match(/^ FENCE(\d+) $/);
    if (fenceMatch) {
      out.push(blocks[Number(fenceMatch[1])]);
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        rows.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(rows.join("\n")).replace(/\n/g, "<br/>")}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push("<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push("<ol>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ol>");
      continue;
    }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*&gt;\s?/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) && !/^ FENCE\d+ $/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`);
  }
  return out.join("");
}
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, body) => {
    codes.push(`<code>${body}</code>`);
    return ` CODE${codes.length - 1} `;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (m, label, url, title) => {
    const safe = safeHref(url);
    if (!safe) return m;
    const t = title ? ` title="${escapeHtml2(title)}"` : "";
    return `<a href="${escapeHtml2(safe)}" target="_blank" rel="noreferrer noopener"${t}>${label}</a>`;
  });
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
    (_m, lead, url) => {
      const safe = safeHref(url);
      if (!safe) return _m;
      return `${lead}<a href="${escapeHtml2(safe)}" target="_blank" rel="noreferrer noopener">${escapeHtml2(safe)}</a>`;
    }
  );
  s = s.replace(/ CODE(\d+) /g, (_m, n) => codes[Number(n)]);
  return s;
}

// ../../../runtime/src/agentTools.ts
function createWorkbookAgentTools(opts) {
  const { executor, vfs, wasm, defaultCsvPath } = opts;
  const newId = opts.newCellId ?? defaultNewCellId;
  const tools = [
    {
      definition: {
        name: "list_cells",
        description: "List every cell in the current workbook with id, language, and a one-line summary. Use this first to understand what's already there before appending or editing.",
        parameters: { type: "object", properties: {} }
      },
      invoke: () => {
        const cells = executor.listCells();
        if (!cells.length) return "(no cells yet)";
        return cells.map((c) => {
          const state = executor.getState(c.id);
          const status = state?.status ?? "pending";
          const summary = c.source ? firstLine(c.source) : "(no source)";
          return `${c.id}	${c.language}	${status}	${summary}`;
        }).join("\n");
      }
    },
    {
      definition: {
        name: "read_cell",
        description: "Read a cell's full source plus its most recent outputs. Use to inspect existing work before deciding whether to append a new cell or edit this one.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Cell id (from list_cells)." } },
          required: ["id"]
        }
      },
      invoke: ({ id }) => {
        const cell = executor.getCell(String(id));
        if (!cell) return `error: no cell with id '${id}'`;
        const state = executor.getState(String(id));
        const lines = [];
        lines.push(`# ${cell.id} (${cell.language})`);
        lines.push("");
        lines.push("## source");
        lines.push(cell.source ?? "(no source)");
        lines.push("");
        lines.push(`## status: ${state?.status ?? "pending"}`);
        if (state?.outputs?.length) {
          lines.push("");
          lines.push("## outputs");
          for (const out of state.outputs) {
            lines.push(formatOutput(out));
          }
        }
        if (state?.error) {
          lines.push("");
          lines.push(`## error
${state.error}`);
        }
        return lines.join("\n");
      }
    },
    {
      definition: {
        name: "append_cell",
        description: "Append a new cell to the workbook. Cell re-executes immediately as part of the DAG. Returns the cell id so you can read back its output on the next turn.",
        parameters: {
          type: "object",
          properties: {
            language: {
              type: "string",
              description: "One of: rhai, polars, sqlite, candle-inference, linfa-train, wasm-fn, chat"
            },
            source: { type: "string", description: "Cell source code or query." },
            id: {
              type: "string",
              description: "Optional explicit cell id. Auto-generated if omitted."
            }
          },
          required: ["language", "source"]
        }
      },
      invoke: async ({ language, source, id }) => {
        if (!source || typeof source !== "string") return "error: source is required";
        const lang = String(language);
        if (!isCellLanguage(lang)) return `error: unknown language '${language}'`;
        const existing = executor.listCells();
        const cellId = typeof id === "string" && id ? id : newId(existing);
        if (executor.getCell(cellId)) {
          return `error: cell '${cellId}' already exists; use edit_cell to replace.`;
        }
        executor.setCell({ id: cellId, language: lang, source });
        return `appended ${cellId} (${lang}). DAG re-executing \u2014 use read_cell on next turn to see outputs.`;
      }
    },
    {
      definition: {
        name: "edit_cell",
        description: "Replace an existing cell's source. The cell and everything downstream re-runs. Use to fix errors found via read_cell or to refine logic.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Cell id." },
            source: { type: "string", description: "New source." }
          },
          required: ["id", "source"]
        }
      },
      invoke: ({ id, source }) => {
        const cell = executor.getCell(String(id));
        if (!cell) return `error: no cell with id '${id}'`;
        executor.setCell({ ...cell, source: String(source ?? "") });
        return `updated ${cell.id}. DAG re-executing \u2014 use read_cell on next turn to see outputs.`;
      }
    }
  ];
  if (vfs && wasm?.runPolarsSql) {
    tools.push({
      definition: {
        name: "query_data",
        description: "Run a Polars-SQL query against a CSV in the workbook VFS without adding a cell. Use for quick scoping; promote to append_cell once you know what you want.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SQL string. Table name is `data`." },
            csv_path: {
              type: "string",
              description: defaultCsvPath ? `VFS path to CSV. Default: ${defaultCsvPath}.` : "VFS path to CSV."
            }
          },
          required: ["sql"]
        }
      },
      invoke: ({ sql, csv_path }) => {
        const path = typeof csv_path === "string" && csv_path ? csv_path : defaultCsvPath;
        if (!path) return "error: csv_path is required (no default configured).";
        if (!vfs.exists(path)) return `error: ${path} not found in VFS`;
        try {
          const csv = vfs.readText(path);
          const outputs = wasm.runPolarsSql(String(sql), csv);
          const csvOut = outputs.find((o) => o.kind === "text" && o.mime_type === "text/csv");
          return csvOut ? csvOut.content : JSON.stringify(outputs);
        } catch (e) {
          return `error: ${e.message ?? String(e)}`;
        }
      }
    });
  }
  return tools;
}
var VALID_LANGUAGES = /* @__PURE__ */ new Set([
  "rhai",
  "polars",
  "sqlite",
  "candle-inference",
  "linfa-train",
  "wasm-fn",
  "chat"
]);
function isCellLanguage(s) {
  return VALID_LANGUAGES.has(s);
}
function defaultNewCellId(existing) {
  let max = 0;
  for (const c of existing) {
    const m = c.id.match(/^cell-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `cell-${max + 1}`;
}
function firstLine(s) {
  const i = s.indexOf("\n");
  const line = i === -1 ? s : s.slice(0, i);
  return line.length > 80 ? line.slice(0, 79) + "\u2026" : line;
}
function formatOutput(out) {
  switch (out.kind) {
    case "text": {
      const mime = out.mime_type ? ` (${out.mime_type})` : "";
      return `[text${mime}]
${truncate(out.content, 1500)}`;
    }
    case "image":
      return `[image ${out.mime_type}, ${out.content.length} base64 chars]`;
    case "table": {
      const rows = out.row_count != null ? `, ${out.row_count} rows` : "";
      return `[table ${out.sql_table}${rows}]`;
    }
    case "error":
      return `[error]
${out.message}`;
    case "stream":
      return `[stream]
${truncate(out.content, 1500)}`;
  }
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}
export {
  ReactiveExecutor,
  analyzeCell,
  createBrowserLlmClient,
  createRuntimeClient,
  createWorkbookAgentTools,
  escapeHtml2 as escapeHtml,
  mountHtmlWorkbook,
  parseWorkbookHtml,
  registerWorkbookCell,
  renderMarkdown,
  runAgentLoop
};
/*! Bundled license information:

dompurify/dist/purify.es.mjs:
  (*! @license DOMPurify 3.4.1 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.1/LICENSE *)
*/
