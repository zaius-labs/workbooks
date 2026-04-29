var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// ../../../runtime/src/duckdbSidecar.ts
var duckdbSidecar_exports = {};
__export(duckdbSidecar_exports, {
  runDuckdbSql: () => runDuckdbSql
});
async function ensureDuckdb() {
  if (dbInstance) return dbInstance;
  if (duckdbPromise) return await duckdbPromise;
  duckdbPromise = (async () => {
    const duckdb = await import(
      /* @vite-ignore */
      "@duckdb/duckdb-wasm"
    );
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerScript = `importScripts("${bundle.mainWorker}");`;
    const workerUrl = URL.createObjectURL(
      new Blob([workerScript], { type: "application/javascript" })
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    dbInstance = db;
    return { db };
  })();
  await duckdbPromise;
  if (!dbInstance) throw new Error("duckdb instance not initialized");
  return dbInstance;
}
async function runDuckdbSql(sql, csv) {
  const db = await ensureDuckdb();
  if (csv && db.registerFileText) {
    await db.registerFileText("data.csv", csv);
  }
  const conn = await db.connect();
  try {
    if (csv) {
      try {
        await conn.query(
          "CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv_auto('data.csv', HEADER=TRUE)"
        );
      } catch (err) {
        return [{
          kind: "error",
          message: `duckdb csv load: ${err instanceof Error ? err.message : String(err)}`
        }];
      }
    }
    const result = await conn.query(sql);
    const rows = result.toArray();
    const headers = result.schema.fields.map((f) => f.name);
    const csvOut = renderCsv(headers, rows);
    return [{
      kind: "text",
      content: csvOut,
      mime_type: "text/csv"
    }];
  } catch (err) {
    return [{
      kind: "error",
      message: err instanceof Error ? err.message : String(err)
    }];
  } finally {
    await conn.close();
  }
}
function renderCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escapeCsv).join(","));
  for (const row of rows) {
    const r = row;
    lines.push(headers.map((h) => escapeCsv(formatCell(r[h]))).join(","));
  }
  return lines.join("\n") + "\n";
}
function formatCell(v) {
  if (v == null) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function escapeCsv(s) {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
var duckdbPromise, dbInstance;
var init_duckdbSidecar = __esm({
  "../../../runtime/src/duckdbSidecar.ts"() {
    "use strict";
    duckdbPromise = null;
    dbInstance = null;
  }
});

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
      if (lang === "duckdb") {
        const { runDuckdbSql: runDuckdbSql2 } = await Promise.resolve().then(() => (init_duckdbSidecar(), duckdbSidecar_exports));
        const sql = req.cell.source ?? "";
        const csv = req.params?.csv ?? "";
        const outputs = await runDuckdbSql2(sql, csv);
        return { outputs };
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
    case "duckdb":
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
   */
  async executeFrom(changedProvides) {
    const gen = ++this.generation;
    const runtimeId = await this.ensureRuntime();
    const order = topologicalOrder([...this.cells.values()]);
    const dirty = changedProvides == null ? new Set(order.map((c) => c.id)) : computeDirtySet(order, new Set(changedProvides));
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
        const text = await resp.text().catch(() => "");
        yield {
          kind: "done",
          stopReason: "error",
          finalText: "",
          toolCalls: [],
          errorMessage: `provider ${resp.status}: ${text || resp.statusText}`,
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

// ../../../runtime/src/htmlBindings.ts
var customCellRegistry = /* @__PURE__ */ new Map();
function registerWorkbookCell(language, impl) {
  customCellRegistry.set(language, impl);
}
function parseWorkbookHtml(root) {
  const name = root.getAttribute("name") ?? "html-workbook";
  const cells = [];
  const inputs = {};
  const agents = [];
  for (const el of root.querySelectorAll("wb-input")) {
    const nm = el.getAttribute("name");
    if (!nm) continue;
    const type = el.getAttribute("type") ?? "text";
    const def = el.getAttribute("default") ?? el.textContent?.trim() ?? "";
    inputs[nm] = coerceValue(def, type);
  }
  for (const el of root.querySelectorAll("wb-cell")) {
    const id = el.getAttribute("id");
    const language = el.getAttribute("language") ?? "rhai";
    if (!id) continue;
    const reads = (el.getAttribute("reads") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const provides = (el.getAttribute("provides") ?? id).split(",").map((s) => s.trim()).filter(Boolean);
    const source = el.textContent?.trim() ?? "";
    const cell = { id, language, source, dependsOn: reads, provides };
    cells.push(cell);
  }
  for (const el of root.querySelectorAll("wb-agent")) {
    const id = el.getAttribute("id");
    if (!id) continue;
    const model = el.getAttribute("model") ?? "openai/gpt-4o-mini";
    const reads = (el.getAttribute("reads") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const systemEl = el.querySelector("wb-system");
    const systemPrompt = systemEl?.textContent?.trim() ?? "";
    const tools = [...el.querySelectorAll("wb-tool")].map((t) => t.getAttribute("ref")).filter((s) => Boolean(s));
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
      for (const out of doc.querySelectorAll(`wb-output[for="${state.cellId}"]`)) {
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
    div.innerHTML = o.content;
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
  const outputs = document.querySelectorAll(`wb-output[for="${agent.id}"]`);
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
    el.innerHTML = `<div class="wb-out error">wb-chat: no agent with id '${agentId}'</div>`;
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
    const text = inputEl.value.trim();
    if (!text) return;
    history.push({ role: "user", content: text });
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

// ../../../runtime/src/markdown.ts
function escapeHtml2(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
function renderMarkdown(src) {
  const text = String(src ?? "");
  const blocks = [];
  const FENCE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g;
  const withPlaceholders = text.replace(FENCE, (_m, lang, body) => {
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
    if (!/^(https?:\/\/|\/|#)/.test(url)) return m;
    const t = title ? ` title="${escapeHtml2(title)}"` : "";
    return `<a href="${escapeHtml2(url)}" target="_blank" rel="noreferrer noopener"${t}>${label}</a>`;
  });
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
    (_m, lead, url) => `${lead}<a href="${escapeHtml2(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml2(url)}</a>`
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
              description: "One of: rhai, polars, sqlite, duckdb, candle-inference, linfa-train, wasm-fn, chat"
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
  "duckdb",
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
