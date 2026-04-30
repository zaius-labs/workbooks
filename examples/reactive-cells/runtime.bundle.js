// packages/runtime/src/sqliteSidecar.ts
var sqlite3Promise = null;
async function loadSqlite3() {
  if (!sqlite3Promise) {
    sqlite3Promise = (async () => {
      const specifier = "@sqlite.org/sqlite-wasm";
      let mod;
      try {
        mod = await import(
          /* @vite-ignore */
          specifier
        );
      } catch {
        throw new Error(
          "sqlite cells require @sqlite.org/sqlite-wasm \u2014 install it as a peer dep or pre-bundle it with your workbook host"
        );
      }
      const sqlite3 = await mod.default({
        print: () => {
        },
        printErr: () => {
        }
      });
      return sqlite3;
    })();
  }
  return sqlite3Promise;
}
function csvCell(v) {
  if (v === null || v === void 0) return "";
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const head = cols.map(csvCell).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return `${head}
${body}`;
}
function createSqliteDispatcher() {
  const handles = /* @__PURE__ */ new Map();
  function key(workbookSlug, dataId) {
    return `${workbookSlug}::${dataId}`;
  }
  async function openDb(bytes) {
    const sqlite3 = await loadSqlite3();
    const db = new sqlite3.oo1.DB(":memory:", "ct");
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_READONLY ?? 4;
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer,
      "main",
      bytes,
      bytes.byteLength,
      bytes.byteLength,
      flags
    );
    if (rc !== 0) {
      db.close();
      throw new Error(`sqlite3_deserialize failed (rc=${rc})`);
    }
    return db;
  }
  return {
    async exec({ workbookSlug, dataId, dbBytes, sql }) {
      const k = key(workbookSlug, dataId);
      let entry = handles.get(k);
      if (entry && entry.bytesRef !== dbBytes) {
        try {
          entry.db.close();
        } catch {
        }
        entry = void 0;
        handles.delete(k);
      }
      if (!entry) {
        const db = await openDb(dbBytes);
        entry = { db, bytesRef: dbBytes };
        handles.set(k, entry);
      }
      const trimmed = sql.trim();
      if (!trimmed) {
        return [{ kind: "text", content: "", mime_type: "text/csv" }];
      }
      let rows;
      try {
        rows = entry.db.exec({
          sql: trimmed,
          returnValue: "resultRows",
          rowMode: "object"
        });
      } catch (err2) {
        return [
          {
            kind: "error",
            message: err2 instanceof Error ? err2.message : String(err2)
          }
        ];
      }
      const csv = rowsToCsv(rows);
      return [
        { kind: "text", content: csv, mime_type: "text/csv" },
        { kind: "table", sql_table: dataId, row_count: rows.length }
      ];
    },
    dispose() {
      for (const entry of handles.values()) {
        try {
          entry.db.close();
        } catch {
        }
      }
      handles.clear();
    }
  };
}

// packages/runtime/src/wasmBridge.ts
function createRuntimeClient(opts) {
  let wasmPromise = null;
  let sqlite = null;
  const memoryBuffers = /* @__PURE__ */ new Map();
  const docHandles = /* @__PURE__ */ new Map();
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
        const memoryTables = {};
        if (req.memoryTables && req.cell.dependsOn) {
          for (const dep of req.cell.dependsOn) {
            const t = req.memoryTables[dep];
            if (t instanceof Uint8Array) memoryTables[dep] = t;
          }
        }
        if (Object.keys(memoryTables).length > 0) {
          if (!wasm.runPolarsSqlIpc) {
            throw new Error(
              "polars cell references a <wb-memory> table but the runtime build does not expose runPolarsSqlIpc \u2014 rebuild runtime-wasm with the `ipc` polars feature and the wasm-bindgen export wired"
            );
          }
          const outputs2 = wasm.runPolarsSqlIpc(sql, memoryTables);
          return { outputs: outputs2 };
        }
        let csv = req.params?.csv ?? "";
        if (!csv && req.params && req.cell.dependsOn) {
          for (const dep of req.cell.dependsOn) {
            const v = req.params[dep];
            if (typeof v === "string" && v.length > 0) {
              csv = v;
              break;
            }
          }
        }
        const outputs = wasm.runPolarsSql(sql, csv);
        return { outputs };
      }
      if (lang === "sqlite") {
        let dataId = null;
        let dbBytes = null;
        if (req.params && req.cell.dependsOn) {
          for (const dep of req.cell.dependsOn) {
            const v = req.params[dep];
            if (v instanceof Uint8Array) {
              dataId = dep;
              dbBytes = v;
              break;
            }
          }
        }
        if (!dbBytes || !dataId) {
          throw new Error(
            'sqlite cells require a `reads=` reference to a <wb-data mime="application/x-sqlite3"> block holding the database bytes'
          );
        }
        if (!sqlite) sqlite = createSqliteDispatcher();
        const outputs = await sqlite.exec({
          workbookSlug: req.runtimeId || "default",
          dataId,
          dbBytes,
          sql: req.cell.source ?? ""
        });
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
      if (sqlite) {
        sqlite.dispose();
        sqlite = null;
      }
    },
    async buildInfo() {
      const wasm = await ensureWasm();
      return wasm.build_info();
    },
    async registerMemory(id, bytes) {
      if (memoryBuffers.has(id)) {
        throw new Error(`memory id already registered: ${id}`);
      }
      memoryBuffers.set(id, bytes);
    },
    async appendMemory(id, rows) {
      const existing = memoryBuffers.get(id);
      if (!existing) {
        throw new Error(`memory id not registered: ${id}`);
      }
      const wasm = await ensureWasm();
      let combined;
      if (wasm.appendArrowIpc) {
        combined = wasm.appendArrowIpc(existing, rows);
      } else {
        console.warn(
          "appendMemory: runtime-wasm missing appendArrowIpc binding \u2014 falling back to naive concatenation, which truncates at the first EOS marker on subsequent appends. Rebuild runtime-wasm."
        );
        combined = new Uint8Array(existing.byteLength + rows.byteLength);
        combined.set(existing, 0);
        combined.set(rows, existing.byteLength);
      }
      memoryBuffers.set(id, combined);
      const sha256 = await sha256HexFromBytes(combined);
      return { sha256, bytes: combined.byteLength };
    },
    async exportMemory(id) {
      const bytes = memoryBuffers.get(id);
      if (!bytes) throw new Error(`memory id not registered: ${id}`);
      return bytes;
    },
    async registerDoc(id, handle) {
      if (docHandles.has(id)) {
        throw new Error(`doc id already registered: ${id}`);
      }
      docHandles.set(id, handle);
    },
    async docMutate(id, ops) {
      const handle = docHandles.get(id);
      if (!handle) {
        throw new Error(`doc id not registered: ${id}`);
      }
      const snapshot = handle.mutate(ops);
      const sha256 = await sha256HexFromBytes(snapshot);
      return { sha256, bytes: snapshot.byteLength, snapshot };
    },
    async exportDoc(id) {
      const handle = docHandles.get(id);
      if (!handle) throw new Error(`doc id not registered: ${id}`);
      return handle.exportSnapshot();
    },
    async readDoc(id) {
      const handle = docHandles.get(id);
      if (!handle) throw new Error(`doc id not registered: ${id}`);
      return handle.toJSON();
    },
    getDocHandle(id) {
      return docHandles.get(id);
    }
  };
}
async function sha256HexFromBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// packages/runtime/src/cellAnalyzer.ts
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

// packages/runtime/src/reactiveExecutor.ts
var ReactiveExecutor = class {
  client;
  cells = /* @__PURE__ */ new Map();
  inputs = /* @__PURE__ */ new Map();
  states = /* @__PURE__ */ new Map();
  onCellState;
  debounceMs;
  workbookSlug;
  runtimeId = null;
  runtimePromise = null;
  /** Generation counter — bumped on each run so stale runs short-circuit. */
  generation = 0;
  debounceTimer = null;
  constructor(opts) {
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
      this.executeFrom(changedProvides).catch((err2) => {
        for (const id of this.cells.keys()) {
          this.transition(id, { status: "error", error: String(err2) });
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
      } catch (err2) {
        this.transition(cell.id, {
          status: "error",
          error: err2 instanceof Error ? err2.message : String(err2)
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

// packages/runtime/src/llmClient.ts
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
      } catch (err2) {
        yield {
          kind: "done",
          stopReason: "error",
          finalText,
          toolCalls: [...toolCalls.values()],
          usage,
          errorMessage: err2 instanceof Error ? err2.message : String(err2),
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

// packages/runtime/src/agentLoop.ts
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
        } catch (err2) {
          result = `error: ${err2 instanceof Error ? err2.message : String(err2)}`;
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

// ../../node_modules/.bun/dompurify@3.4.1/node_modules/dompurify/dist/purify.es.mjs
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

// packages/runtime/src/util/sanitize.ts
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

// packages/runtime/src/modelArtifactResolver.ts
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// packages/runtime/src/encryption.ts
async function loadAge() {
  const specifier = "age-encryption";
  try {
    return await import(
      /* @vite-ignore */
      specifier
    );
  } catch {
    throw new Error(
      "age-encryption peer dep is missing. Install it with `npm install age-encryption` (or pre-bundle in your workbook host)."
    );
  }
}
async function decryptWithPassphrase(ciphertext, passphrase) {
  if (!passphrase) {
    throw new Error("decryptWithPassphrase: passphrase is required");
  }
  const { Decrypter } = await loadAge();
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  return d.decrypt(ciphertext);
}
async function decryptWithIdentity(ciphertext, identity) {
  if (!identity) {
    throw new Error("decryptWithIdentity: identity is required");
  }
  const { Decrypter } = await loadAge();
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(ciphertext);
}
async function decryptWithObjectIdentity(ciphertext, identity) {
  const { Decrypter } = await loadAge();
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(ciphertext);
}
function looksLikeAgeEnvelope(bytes) {
  const MAGIC = "age-encryption.org/v1";
  if (bytes.byteLength < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

// node_modules/@noble/ed25519/index.js
var ed25519_CURVE = Object.freeze({
  p: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn,
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffecn,
  d: 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n,
  Gx: 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an,
  Gy: 0x6666666666666666666666666666666666666666666666666666666666666658n
});
var { p: P, n: N, Gx, Gy, a: _a, d: _d, h } = ed25519_CURVE;
var L = 32;
var captureTrace = (...args) => {
  if ("captureStackTrace" in Error && typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(...args);
  }
};
var err = (message = "") => {
  const e = new Error(message);
  captureTrace(e, err);
  throw e;
};
var isBig = (n) => typeof n === "bigint";
var isStr = (s) => typeof s === "string";
var isBytes = (a) => a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
var abytes = (value, length, title = "") => {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    const msg = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    throw bytes ? new RangeError(msg) : new TypeError(msg);
  }
  return value;
};
var u8n = (len) => new Uint8Array(len);
var u8fr = (buf) => Uint8Array.from(buf);
var padh = (n, pad) => n.toString(16).padStart(pad, "0");
var bytesToHex = (b) => Array.from(abytes(b)).map((e) => padh(e, 2)).join("");
var C = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
var _ch = (ch) => {
  if (ch >= C._0 && ch <= C._9)
    return ch - C._0;
  if (ch >= C.A && ch <= C.F)
    return ch - (C.A - 10);
  if (ch >= C.a && ch <= C.f)
    return ch - (C.a - 10);
  return;
};
var hexToBytes = (hex) => {
  const e = "hex invalid";
  if (!isStr(hex))
    return err(e);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    return err(e);
  const array = u8n(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = _ch(hex.charCodeAt(hi));
    const n2 = _ch(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0)
      return err(e);
    array[ai] = n1 * 16 + n2;
  }
  return array;
};
var cr = () => globalThis?.crypto;
var subtle = () => cr()?.subtle ?? err("crypto.subtle must be defined, consider polyfill");
var concatBytes = (...arrs) => {
  let len = 0;
  for (const a of arrs)
    len += abytes(a).length;
  const r = u8n(len);
  let pad = 0;
  arrs.forEach((a) => {
    r.set(a, pad);
    pad += a.length;
  });
  return r;
};
var big = BigInt;
var assertRange = (n, min, max, msg = "bad number: out of range") => {
  if (!isBig(n))
    throw new TypeError(msg);
  if (min <= n && n < max)
    return n;
  throw new RangeError(msg);
};
var M = (a, b = P) => {
  const r = a % b;
  return r >= 0n ? r : b + r;
};
var P_MASK = (1n << 255n) - 1n;
var modP = (num) => {
  if (num < 0n)
    err("negative coordinate");
  let r = (num >> 255n) * 19n + (num & P_MASK);
  r = (r >> 255n) * 19n + (r & P_MASK);
  return r % P;
};
var modN = (a) => M(a, N);
var invert = (num, md) => {
  if (num === 0n || md <= 0n)
    err("no inverse n=" + num + " mod=" + md);
  let a = M(num, md), b = md, x = 0n, y = 1n, u = 1n, v = 0n;
  while (a !== 0n) {
    const q = b / a, r = b % a;
    const m = x - u * q, n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  return b === 1n ? M(x, md) : err("no inverse");
};
var callHash = (name) => {
  const fn = hashes[name];
  if (typeof fn !== "function")
    err("hashes." + name + " not set");
  return fn;
};
var checkDigest = (value) => abytes(value, 64, "digest");
var apoint = (p) => p instanceof Point ? p : err("Point expected");
var B256 = 2n ** 256n;
var Point = class _Point {
  static BASE;
  static ZERO;
  X;
  Y;
  Z;
  T;
  // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
  // on-curve or that T matches X*Y/Z.
  constructor(X, Y, Z, T) {
    const max = B256;
    this.X = assertRange(X, 0n, max);
    this.Y = assertRange(Y, 0n, max);
    this.Z = assertRange(Z, 1n, max);
    this.T = assertRange(T, 0n, max);
    Object.freeze(this);
  }
  static CURVE() {
    return ed25519_CURVE;
  }
  static fromAffine(p) {
    return new _Point(p.x, p.y, 1n, modP(p.x * p.y));
  }
  /** RFC8032 5.1.3: Bytes to Point. */
  static fromBytes(hex, zip215 = false) {
    const d = _d;
    const normed = u8fr(abytes(hex, L));
    const lastByte = hex[31];
    normed[31] = lastByte & ~128;
    const y = bytesToNumberLE(normed);
    const max = zip215 ? B256 : P;
    assertRange(y, 0n, max);
    const y2 = modP(y * y);
    const u = M(y2 - 1n);
    const v = modP(d * y2 + 1n);
    let { isValid, value: x } = uvRatio(u, v);
    if (!isValid)
      err("bad point: y not sqrt");
    const isXOdd = (x & 1n) === 1n;
    const isLastByteOdd = (lastByte & 128) !== 0;
    if (!zip215 && x === 0n && isLastByteOdd)
      err("bad point: x==0, isLastByteOdd");
    if (isLastByteOdd !== isXOdd)
      x = M(-x);
    return new _Point(x, y, 1n, modP(x * y));
  }
  static fromHex(hex, zip215) {
    return _Point.fromBytes(hexToBytes(hex), zip215);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const a = _a;
    const d = _d;
    const p = this;
    if (p.is0())
      return err("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * (aX2 + Y2));
    const right = M(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      return err("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      return err("bad point: equation left != right (2)");
    return this;
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    const X1Z2 = modP(X1 * Z2);
    const X2Z1 = modP(X2 * Z1);
    const Y1Z2 = modP(Y1 * Z2);
    const Y2Z1 = modP(Y2 * Z1);
    return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
  }
  is0() {
    return this.equals(I);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new _Point(M(-this.X), this.Y, this.Z, M(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const a = _a;
    const A = modP(X1 * X1);
    const B = modP(Y1 * Y1);
    const C2 = modP(2n * Z1 * Z1);
    const D = modP(a * A);
    const x1y1 = M(X1 + Y1);
    const E = M(modP(x1y1 * x1y1) - A - B);
    const G2 = M(D + B);
    const F = M(G2 - C2);
    const H = M(D - B);
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  /** Point addition. Complete formula. Cost: `8M + 1*k + 8add + 1*2`. */
  add(other) {
    const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
    const { X: X2, Y: Y2, Z: Z2, T: T2 } = apoint(other);
    const a = _a;
    const d = _d;
    const A = modP(X1 * X2);
    const B = modP(Y1 * Y2);
    const C2 = modP(modP(T1 * d) * T2);
    const D = modP(Z1 * Z2);
    const E = M(modP(M(X1 + Y1) * M(X2 + Y2)) - A - B);
    const F = M(D - C2);
    const G2 = M(D + C2);
    const H = M(B - modP(a * A));
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  subtract(other) {
    return this.add(apoint(other).negate());
  }
  /**
   * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
   * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n - scalar by which point is multiplied
   * @param safe - safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, safe = true) {
    if (!safe && n === 0n)
      return I;
    assertRange(n, 1n, N);
    if (!safe && this.is0())
      return I;
    if (n === 1n)
      return this;
    if (this.equals(G))
      return wNAF(n).p;
    let p = I;
    let f = G;
    for (let d = this; n > 0n; d = d.double(), n >>= 1n) {
      if (n & 1n)
        p = p.add(d);
      else if (safe)
        f = f.add(d);
    }
    return p;
  }
  multiplyUnsafe(scalar) {
    return this.multiply(scalar, false);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X, Y, Z } = this;
    if (this.equals(I))
      return { x: 0n, y: 1n };
    const iz = invert(Z, P);
    if (modP(Z * iz) !== 1n)
      err("invalid inverse");
    const x = modP(X * iz);
    const y = modP(Y * iz);
    return { x, y };
  }
  toBytes() {
    const { x, y } = this.toAffine();
    const b = numTo32bLE(y);
    b[31] |= x & 1n ? 128 : 0;
    return b;
  }
  toHex() {
    return bytesToHex(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(big(h), false);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    let p = this.multiply(N / 2n, false).double();
    if (N % 2n)
      p = p.add(this);
    return p.is0();
  }
};
var G = new Point(Gx, Gy, 1n, M(Gx * Gy));
var I = new Point(0n, 1n, 1n, 0n);
Point.BASE = G;
Point.ZERO = I;
var numTo32bLE = (num) => hexToBytes(padh(assertRange(num, 0n, B256), 64)).reverse();
var bytesToNumberLE = (b) => big("0x" + bytesToHex(u8fr(abytes(b)).reverse()));
var pow2 = (x, power) => {
  let r = x;
  while (power-- > 0n) {
    r = modP(r * r);
  }
  return r;
};
var pow_2_252_3 = (x) => {
  const x2 = modP(x * x);
  const b2 = modP(x2 * x);
  const b4 = modP(pow2(b2, 2n) * b2);
  const b5 = modP(pow2(b4, 1n) * x);
  const b10 = modP(pow2(b5, 5n) * b5);
  const b20 = modP(pow2(b10, 10n) * b10);
  const b40 = modP(pow2(b20, 20n) * b20);
  const b80 = modP(pow2(b40, 40n) * b40);
  const b160 = modP(pow2(b80, 80n) * b80);
  const b240 = modP(pow2(b160, 80n) * b80);
  const b250 = modP(pow2(b240, 10n) * b10);
  const pow_p_5_8 = modP(pow2(b250, 2n) * x);
  return { pow_p_5_8, b2 };
};
var RM1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n;
var uvRatio = (u, v) => {
  const v3 = modP(v * modP(v * v));
  const v7 = modP(modP(v3 * v3) * v);
  const pow = pow_2_252_3(modP(u * v7)).pow_p_5_8;
  let x = modP(u * modP(v3 * pow));
  const vx2 = modP(v * modP(x * x));
  const root1 = x;
  const root2 = modP(x * RM1);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === M(-u);
  const noRoot = vx2 === M(-u * RM1);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if ((M(x) & 1n) === 1n)
    x = M(-x);
  return { isValid: useRoot1 || useRoot2, value: x };
};
var modL_LE = (hash) => modN(bytesToNumberLE(hash));
var sha512s = (...m) => checkDigest(callHash("sha512")(concatBytes(...m)));
var hashFinishS = (res) => res.finish(sha512s(res.hashable));
var defaultVerifyOpts = { zip215: true };
var _verify = (sig, msg, publicKey, options = defaultVerifyOpts) => {
  sig = abytes(sig, 64);
  msg = abytes(msg);
  publicKey = abytes(publicKey, L);
  const { zip215 = true } = options;
  const r = sig.subarray(0, L);
  const s = bytesToNumberLE(sig.subarray(L, L * 2));
  let A, R, SB;
  let hashable = Uint8Array.of();
  let finished = false;
  try {
    A = Point.fromBytes(publicKey, zip215);
    R = Point.fromBytes(r, zip215);
    SB = G.multiply(s, false);
    hashable = concatBytes(r, publicKey, msg);
    finished = true;
  } catch (error) {
  }
  const finish = (hashed) => {
    if (!finished)
      return false;
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = modL_LE(hashed);
    const RkA = R.add(A.multiply(k, false));
    return RkA.subtract(SB).clearCofactor().is0();
  };
  return { hashable, finish };
};
var verify = (signature, message, publicKey, opts = defaultVerifyOpts) => hashFinishS(_verify(signature, message, publicKey, opts));
var hashes = {
  sha512Async: async (message) => {
    const s = subtle();
    const m = concatBytes(message);
    return u8n(await s.digest("SHA-512", m.buffer));
  },
  sha512: void 0
};
var W = 8;
var scalarBits = 256;
var pwindows = Math.ceil(scalarBits / W) + 1;
var pwindowSize = 2 ** (W - 1);
var precompute = () => {
  const points = [];
  let p = G;
  let b = p;
  for (let w = 0; w < pwindows; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < pwindowSize; i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var Gpows = void 0;
var ctneg = (cnd, p) => {
  const n = p.negate();
  return cnd ? n : p;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  let p = I;
  let f = G;
  const pow_2_w = 2 ** W;
  const maxNum = pow_2_w;
  const mask = big(pow_2_w - 1);
  const shiftBy = big(W);
  for (let w = 0; w < pwindows; w++) {
    let wbits = Number(n & mask);
    n >>= shiftBy;
    if (wbits > pwindowSize) {
      wbits -= maxNum;
      n += 1n;
    }
    const off = w * pwindowSize;
    const offF = off;
    const offP = off + Math.abs(wbits) - 1;
    const isEven = w % 2 !== 0;
    const isNeg = wbits < 0;
    if (wbits === 0) {
      f = f.add(ctneg(isEven, comp[offF]));
    } else {
      p = p.add(ctneg(isNeg, comp[offP]));
    }
  }
  if (n !== 0n)
    err("invalid wnaf");
  return { p, f };
};

// node_modules/@noble/hashes/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
function abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    const message = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    if (!bytes)
      throw new TypeError(message);
    throw new RangeError(message);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes2(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new RangeError('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor();
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h: h2, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h2, l];
  }
  return [Ah, Al];
}
var shrSH = (h2, _l, s) => h2 >>> s;
var shrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
var rotrSH = (h2, l, s) => h2 >>> s | l << 32 - s;
var rotrSL = (h2, l, s) => h2 << 32 - s | l >>> s;
var rotrBH = (h2, l, s) => h2 << 64 - s | l >>> s - 32;
var rotrBL = (h2, l, s) => h2 >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// node_modules/@noble/hashes/sha2.js
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA2_64B = class extends HashMD {
  constructor(outputLen) {
    super(128, outputLen, 16, false);
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var _SHA512 = class extends SHA2_64B {
  Ah = SHA512_IV[0] | 0;
  Al = SHA512_IV[1] | 0;
  Bh = SHA512_IV[2] | 0;
  Bl = SHA512_IV[3] | 0;
  Ch = SHA512_IV[4] | 0;
  Cl = SHA512_IV[5] | 0;
  Dh = SHA512_IV[6] | 0;
  Dl = SHA512_IV[7] | 0;
  Eh = SHA512_IV[8] | 0;
  El = SHA512_IV[9] | 0;
  Fh = SHA512_IV[10] | 0;
  Fl = SHA512_IV[11] | 0;
  Gh = SHA512_IV[12] | 0;
  Gl = SHA512_IV[13] | 0;
  Hh = SHA512_IV[14] | 0;
  Hl = SHA512_IV[15] | 0;
  constructor() {
    super(64);
  }
};
var sha512 = /* @__PURE__ */ createHasher(
  () => new _SHA512(),
  /* @__PURE__ */ oidNist(3)
);

// packages/runtime/src/signature.ts
hashes.sha512 = sha512;
var SIGNATURE_VERSION = "wbdata-sig-v1";
function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function canonicalBytes(b) {
  const enc = new TextEncoder();
  const head = enc.encode(
    `${SIGNATURE_VERSION}
id=${b.id}
mime=${b.mime}
encryption=${b.encryption}
sha256=${b.sha256}
`
  );
  const out = new Uint8Array(head.byteLength + b.ciphertext.byteLength);
  out.set(head, 0);
  out.set(b.ciphertext, head.byteLength);
  return out;
}
function verifyBlock(block, signature, expectedAuthorPubkey) {
  if (expectedAuthorPubkey && signature.pubkey !== expectedAuthorPubkey) {
    throw new Error(
      `signature pubkey mismatch: file claims '${signature.pubkey.slice(0, 12)}...' but caller pinned '${expectedAuthorPubkey.slice(0, 12)}...'`
    );
  }
  const pk = b64ToBytes(signature.pubkey);
  if (pk.byteLength !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${pk.byteLength}`);
  }
  const sig = b64ToBytes(signature.sig);
  if (sig.byteLength !== 64) {
    throw new Error(`Ed25519 signature must be 64 bytes, got ${sig.byteLength}`);
  }
  const msg = canonicalBytes(block);
  const ok = verify(sig, msg, pk);
  if (!ok) {
    throw new Error(
      `signature verification failed for block '${block.id}' \u2014 the file was modified after signing, or the signature is from a different author`
    );
  }
  return true;
}
function isSigned(block) {
  return typeof block.pubkey === "string" && typeof block.sig === "string";
}

// packages/runtime/src/workbookDataResolver.ts
var TEXT_MIMES = /* @__PURE__ */ new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl"
]);
function hostAllowed(rawUrl, allow) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return allow.some((h2) => h2.toLowerCase() === host);
}
async function defaultFetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`workbook data fetch failed: ${url} \u2192 ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function decompress(bytes, algo) {
  const supported = typeof DecompressionStream !== "undefined" && // @ts-expect-error — the constructor accepts any string; test by try/catch.
  (() => {
    try {
      new DecompressionStream(algo);
      return true;
    } catch {
      return false;
    }
  })();
  if (!supported) {
    throw new Error(
      `workbook data: ${algo} decompression not supported by this runtime`
    );
  }
  const ds = new DecompressionStream(algo);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
function createWorkbookDataResolver(opts = {}) {
  const allow = opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const cache = /* @__PURE__ */ new Map();
  let cachedPassword = null;
  const issuedHandles = /* @__PURE__ */ new Set();
  let inflightPasswordRequest = null;
  let idleTimer = null;
  function bumpIdleTimer() {
    const ms = opts.passphraseIdleTimeoutMs;
    if (!ms || ms <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      cachedPassword = null;
      idleTimer = null;
    }, ms);
  }
  async function getPassword() {
    if (cachedPassword !== null) return cachedPassword;
    if (inflightPasswordRequest) return inflightPasswordRequest;
    if (!opts.requestPassword) {
      throw new Error(
        "workbook data: encrypted block encountered but no requestPassword callback was passed to createWorkbookDataResolver. The host must wire a passphrase UX."
      );
    }
    inflightPasswordRequest = (async () => {
      try {
        const pw = await opts.requestPassword();
        if (!pw) {
          throw new Error("workbook data: empty passphrase from requestPassword");
        }
        cachedPassword = pw;
        return pw;
      } finally {
        inflightPasswordRequest = null;
      }
    })();
    return inflightPasswordRequest;
  }
  function forgetPassphrase() {
    cachedPassword = null;
    inflightPasswordRequest = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }
  async function decryptToHandle(ciphertext, block) {
    const wasm = opts.wasmIsolation.wasm;
    if (!wasm.ageDecryptToHandle || !wasm.handleDispose || !wasm.handleSize || !wasm.handleExport || !wasm.handleSha256) {
      throw new Error(
        "wasmIsolation: runtime build missing handle-registry bindings (ageDecryptToHandle / handleDispose / handleSize / handleExport / handleSha256)"
      );
    }
    let id = null;
    const ids = opts.x25519Identities ?? [];
    if (ids.length > 0 && wasm.ageDecryptWithIdentitiesToHandle) {
      try {
        id = wasm.ageDecryptWithIdentitiesToHandle(ciphertext, ids);
        bumpIdleTimer();
      } catch {
      }
    }
    if (id === null && opts.webauthnIdentity) {
      try {
        const plaintext = await decryptWithObjectIdentity(
          ciphertext,
          opts.webauthnIdentity
        );
        throw new Error(
          `workbook data ${block.id}: WebAuthn unlock under wasmIsolation is not yet supported. Drop wasmIsolation for blocks that need webauthnIdentity, or pre-decrypt to a server-side X25519 identity.`
        );
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    if (id === null) {
      const password = await getPassword();
      try {
        id = wasm.ageDecryptToHandle(ciphertext, password);
        bumpIdleTimer();
      } catch (e) {
        cachedPassword = null;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        throw new Error(
          `workbook data ${block.id}: decryption failed (likely wrong passphrase): ` + (e instanceof Error ? e.message : String(e))
        );
      }
    }
    const sha256 = block.source.sha256;
    const got = wasm.handleSha256(id);
    if (got !== sha256) {
      wasm.handleDispose(id);
      throw new Error(
        `workbook data integrity check failed for ${block.id}: expected ${sha256}, got ${got}`
      );
    }
    const wasmRef = wasm;
    const handle = {
      kind: "wasm-handle",
      id,
      bytes: wasmRef.handleSize(id),
      export() {
        return wasmRef.handleExport(id);
      },
      dispose() {
        wasmRef.handleDispose(id);
      }
    };
    issuedHandles.add(handle);
    return handle;
  }
  function hasAnyIdentity() {
    return (opts.x25519Identities?.length ?? 0) > 0 || Boolean(opts.webauthnIdentity);
  }
  async function tryDecryptWithIdentities(ciphertext) {
    for (const id of opts.x25519Identities ?? []) {
      try {
        return await decryptWithIdentity(ciphertext, id);
      } catch {
      }
    }
    if (opts.webauthnIdentity) {
      try {
        return await decryptWithObjectIdentity(
          ciphertext,
          opts.webauthnIdentity
        );
      } catch {
      }
    }
    return null;
  }
  async function decryptOrReprompt(ciphertext, blockId) {
    if (!looksLikeAgeEnvelope(ciphertext)) {
      throw new Error(
        `workbook data ${blockId}: bytes don't look like an age v1 envelope`
      );
    }
    if (hasAnyIdentity()) {
      const fromIdentity = await tryDecryptWithIdentities(ciphertext);
      if (fromIdentity) {
        bumpIdleTimer();
        return fromIdentity;
      }
      if (!opts.requestPassword) {
        throw new Error(
          `workbook data ${blockId}: none of the configured X25519/WebAuthn identities matched, and no requestPassword callback is configured. Either supply an identity that's a recipient of this block, or wire requestPassword for passphrase fallback.`
        );
      }
    }
    const password = await getPassword();
    try {
      const plaintext = await decryptWithPassphrase(ciphertext, password);
      bumpIdleTimer();
      return plaintext;
    } catch (e) {
      cachedPassword = null;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      throw new Error(
        `workbook data ${blockId}: decryption failed (likely wrong passphrase): ` + (e instanceof Error ? e.message : String(e))
      );
    }
  }
  async function fetchExternal(src, declaredBytes) {
    if (allow !== null && !hostAllowed(src, allow)) {
      throw new Error(
        `workbook data host not in allowlist: ${src}. Pass allowedHosts to createWorkbookDataResolver.`
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== void 0 && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook data size mismatch for ${src}: declared ${declaredBytes}, got ${bytes.byteLength}`
      );
    }
    return bytes;
  }
  async function verifyDigest(bytes, expectedSha, blockId) {
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook data integrity check failed for ${blockId}: expected ${expectedSha}, got ${got}`
      );
    }
  }
  function verifyOrPolicyCheck(block, ciphertext) {
    const policy = opts.signaturePolicy ?? "allow";
    if (isSigned(block)) {
      verifyBlock(
        {
          id: block.id,
          mime: block.mime,
          encryption: block.encryption ?? "",
          // sha256 in canonical bytes is the source-of-truth attribute
          // value — same string the author signed. Only binary forms
          // reach this code path so source.sha256 is always present.
          sha256: block.source.sha256,
          ciphertext
        },
        { pubkey: block.pubkey, sig: block.sig },
        opts.expectedAuthorPubkey
      );
    } else if (policy === "require") {
      throw new Error(
        `workbook data ${block.id}: signaturePolicy="require" but block is unsigned. Sign the block via "workbook encrypt --sign-key \u2026".`
      );
    }
  }
  async function resolveOne(block) {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };
    let bytes = null;
    let text2 = null;
    let handle = null;
    if (block.source.kind === "inline-text") {
      if (block.source.sha256) {
        const enc = new TextEncoder().encode(block.source.content);
        await verifyDigest(enc, block.source.sha256, block.id);
      }
      text2 = block.source.content;
    } else if (block.source.kind === "inline-base64") {
      bytes = decodeBase64(block.source.base64);
      verifyOrPolicyCheck(block, bytes);
      if (block.encryption === "age-v1" && opts.wasmIsolation) {
        handle = await decryptToHandle(bytes, block);
        bytes = null;
      } else if (block.encryption === "age-v1") {
        bytes = await decryptOrReprompt(bytes, block.id);
        await verifyDigest(bytes, block.source.sha256, block.id);
      } else {
        await verifyDigest(bytes, block.source.sha256, block.id);
      }
      if (block.compression && bytes) {
        bytes = await decompress(bytes, block.compression);
      }
    } else {
      bytes = await fetchExternal(block.source.src, block.source.bytes);
      verifyOrPolicyCheck(block, bytes);
      if (block.encryption === "age-v1" && opts.wasmIsolation) {
        handle = await decryptToHandle(bytes, block);
        bytes = null;
      } else if (block.encryption === "age-v1") {
        bytes = await decryptOrReprompt(bytes, block.id);
        await verifyDigest(bytes, block.source.sha256, block.id);
      } else {
        await verifyDigest(bytes, block.source.sha256, block.id);
      }
      if (block.compression && bytes) {
        bytes = await decompress(bytes, block.compression);
      }
    }
    let value;
    if (handle !== null) {
      value = handle;
    } else if (text2 !== null) {
      value = text2;
    } else if (bytes && TEXT_MIMES.has(block.mime)) {
      value = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } else if (bytes) {
      value = bytes;
    } else {
      throw new Error(`workbook data: no payload resolved for ${block.id}`);
    }
    const out = {
      id: block.id,
      mime: block.mime,
      value,
      fromCache: false
    };
    cache.set(block.id, out);
    return out;
  }
  return {
    resolve: resolveOne,
    async resolveAll(blocks) {
      const entries2 = await Promise.all(
        blocks.map(async (b) => [b.id, await resolveOne(b)])
      );
      return new Map(entries2);
    },
    clear() {
      cache.clear();
      for (const h2 of issuedHandles) {
        try {
          h2.dispose();
        } catch {
        }
      }
      issuedHandles.clear();
    },
    forgetPassphrase
  };
}

// packages/runtime/src/workbookMemoryResolver.ts
function hostAllowed2(rawUrl, allow) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return allow.some((h2) => h2.toLowerCase() === host);
}
async function defaultFetchBytes2(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`workbook memory fetch failed: ${url} \u2192 ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
function decodeBase642(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function looksLikeArrowIpcStream(bytes) {
  if (bytes.byteLength < 8) return false;
  return bytes[0] === 255 && bytes[1] === 255 && bytes[2] === 255 && bytes[3] === 255;
}
function createWorkbookMemoryResolver(opts = {}) {
  const allow = opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes2;
  const cache = /* @__PURE__ */ new Map();
  async function fetchExternal(src, expectedSha, declaredBytes) {
    if (allow !== null && !hostAllowed2(src, allow)) {
      throw new Error(
        `workbook memory host not in allowlist: ${src}. Pass allowedHosts to createWorkbookMemoryResolver.`
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== void 0 && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook memory size mismatch for ${src}: declared ${declaredBytes}, got ${bytes.byteLength}`
      );
    }
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook memory integrity check failed for ${src}: expected ${expectedSha}, got ${got}`
      );
    }
    return bytes;
  }
  async function resolveOne(block) {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };
    let bytes;
    if (block.source.kind === "inline-base64") {
      bytes = decodeBase642(block.source.base64);
      const got = await sha256Hex(bytes);
      if (got !== block.source.sha256) {
        throw new Error(
          `workbook memory integrity check failed for ${block.id}: expected ${block.source.sha256}, got ${got}`
        );
      }
    } else {
      bytes = await fetchExternal(
        block.source.src,
        block.source.sha256,
        block.source.bytes
      );
    }
    if (!looksLikeArrowIpcStream(bytes)) {
      throw new Error(
        `workbook memory ${block.id}: payload does not look like an Arrow IPC stream (missing 0xFFFFFFFF continuation marker)`
      );
    }
    const out = { id: block.id, bytes, fromCache: false };
    cache.set(block.id, out);
    return out;
  }
  return {
    resolve: resolveOne,
    async resolveAll(blocks) {
      const entries2 = await Promise.all(
        blocks.map(async (b) => [b.id, await resolveOne(b)])
      );
      return new Map(entries2);
    },
    clear() {
      cache.clear();
    }
  };
}

// packages/runtime/src/loroSidecar.ts
var loroPromise = null;
async function loadLoro() {
  if (!loroPromise) {
    loroPromise = (async () => {
      const w = typeof window !== "undefined" ? window : null;
      if (w && w.__wb_loro) return w.__wb_loro;
      try {
        const mod = await import(
          /* @vite-ignore */
          "loro-crdt"
        );
        return mod;
      } catch {
        throw new Error(
          "wb-doc cells require loro-crdt. In a single-file workbook, import it in your main.js and expose it as `window.__wb_loro = await import('loro-crdt')` before calling mountHtmlWorkbook."
        );
      }
    })();
  }
  return loroPromise;
}
function createLoroDispatcher() {
  const handles = /* @__PURE__ */ new Map();
  function walkPath(doc, path) {
    let cur;
    if (path.root.kind === "map") cur = doc.getMap(path.root.name);
    else if (path.root.kind === "list") cur = doc.getList(path.root.name);
    else cur = doc.getText(path.root.name);
    const steps = path.steps ?? [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.kind === "map") {
        const m = cur;
        if (typeof m.get !== "function") {
          throw new Error(
            `docMutate: path step ${i} expected Map, got non-Map value`
          );
        }
        cur = m.get(step.key);
      } else {
        const l = cur;
        if (typeof l.get !== "function") {
          throw new Error(
            `docMutate: path step ${i} expected List, got non-List value`
          );
        }
        cur = l.get(step.index);
      }
      if (cur === null || typeof cur !== "object") {
        throw new Error(
          `docMutate: path step ${i} yielded a primitive \u2014 can't descend further`
        );
      }
    }
    return cur;
  }
  function applyOp(doc, op) {
    const target = walkPath(doc, op.target);
    switch (op.kind) {
      case "map_set":
        target.set(op.key, op.value);
        return;
      case "map_delete":
        target.delete(op.key);
        return;
      case "list_push":
        target.push(op.value);
        return;
      case "list_insert":
        target.insert(op.index, op.value);
        return;
      case "list_delete":
        target.delete(op.index, op.count);
        return;
      case "text_insert":
        target.insert(op.index, op.text);
        return;
      case "text_delete":
        target.delete(op.index, op.count);
        return;
    }
  }
  function wrapHandle(doc) {
    return {
      toJSON: () => doc.toJSON(),
      exportSnapshot: () => doc.export({ mode: "snapshot" }),
      mutate(ops) {
        for (const op of ops) applyOp(doc, op);
        doc.commit();
        return doc.export({ mode: "snapshot" });
      },
      inner: () => doc
    };
  }
  return {
    async load({ id, bytes, force }) {
      const existing = handles.get(id);
      if (existing && !force) return existing;
      const loro = await loadLoro();
      const doc = new loro.LoroDoc();
      if (bytes && bytes.length > 0) {
        doc.import(bytes);
      }
      const handle = wrapHandle(doc);
      handles.set(id, handle);
      return handle;
    },
    get(id) {
      return handles.get(id);
    },
    dispose() {
      handles.clear();
    }
  };
}

// packages/runtime/src/workbookDocResolver.ts
function hostAllowed3(rawUrl, allow) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return allow.some((h2) => h2.toLowerCase() === host);
}
async function defaultFetchBytes3(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`workbook doc fetch failed: ${url} \u2192 ${resp.status}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
function decodeBase643(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function createWorkbookDocResolver(opts = {}) {
  const allow = opts.allowedHosts === null ? null : opts.allowedHosts ?? [];
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes3;
  const loro = opts.loroDispatcher ?? createLoroDispatcher();
  const cache = /* @__PURE__ */ new Map();
  async function fetchExternal(src, expectedSha, declaredBytes) {
    if (allow !== null && !hostAllowed3(src, allow)) {
      throw new Error(
        `workbook doc host not in allowlist: ${src}. Pass allowedHosts to createWorkbookDocResolver.`
      );
    }
    const bytes = await fetchBytes(src);
    if (declaredBytes !== void 0 && bytes.byteLength !== declaredBytes) {
      throw new Error(
        `workbook doc size mismatch for ${src}: declared ${declaredBytes}, got ${bytes.byteLength}`
      );
    }
    const got = await sha256Hex(bytes);
    if (got !== expectedSha) {
      throw new Error(
        `workbook doc integrity check failed for ${src}: expected ${expectedSha}, got ${got}`
      );
    }
    return bytes;
  }
  async function resolveOne(block) {
    const cached = cache.get(block.id);
    if (cached) return { ...cached, fromCache: true };
    let bytes;
    if (block.source.kind === "empty") {
      bytes = new Uint8Array(0);
    } else if (block.source.kind === "inline-base64") {
      bytes = decodeBase643(block.source.base64);
      const got = await sha256Hex(bytes);
      if (got !== block.source.sha256) {
        throw new Error(
          `workbook doc integrity check failed for ${block.id}: expected ${block.source.sha256}, got ${got}`
        );
      }
    } else {
      bytes = await fetchExternal(
        block.source.src,
        block.source.sha256,
        block.source.bytes
      );
    }
    let handle;
    if (block.format === "loro") {
      handle = await loro.load({ id: block.id, bytes });
    } else {
      throw new Error(`unsupported wb-doc format: ${block.format}`);
    }
    const out = { id: block.id, format: block.format, handle, fromCache: false };
    cache.set(block.id, out);
    return out;
  }
  return {
    resolve: resolveOne,
    async resolveAll(blocks) {
      const entries2 = await Promise.all(
        blocks.map(async (b) => [b.id, await resolveOne(b)])
      );
      return new Map(entries2);
    },
    clear() {
      cache.clear();
      loro.dispose();
    }
  };
}

// packages/runtime/src/htmlBindings.ts
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
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((s) => VALID_ID.test(s)).slice(0, MAX_REFS_PER_LIST);
}
var ALLOWED_LANGUAGES = /* @__PURE__ */ new Set([
  "rhai",
  "polars",
  "sqlite",
  "candle-inference",
  "linfa-train",
  "wasm-fn",
  "chat"
]);
var VALID_MODEL = /^[A-Za-z0-9._/:@-]{1,128}$/;
var MAX_CELLS = 256;
var MAX_INPUTS = 64;
var MAX_AGENTS = 32;
var MAX_TOOLS_PER_AGENT = 16;
var MAX_REFS_PER_LIST = 32;
var MAX_SOURCE_BYTES = 1 * 1024 * 1024;
var MAX_SYSTEM_PROMPT_BYTES = 100 * 1024;
var MAX_INPUT_DEFAULT_BYTES = 16 * 1024;
var ALLOWED_DATA_MIMES = /* @__PURE__ */ new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl",
  "application/x-sqlite3",
  "application/parquet",
  "application/octet-stream"
]);
var TEXT_DATA_MIMES = /* @__PURE__ */ new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/jsonl"
]);
var VALID_SHA256 = /^[a-f0-9]{64}$/;
var MAX_DATA_BLOCKS = 32;
var MAX_INLINE_TEXT_BYTES = 5 * 1024 * 1024;
var MAX_INLINE_BASE64_CHARS = 14e6;
var MAX_AGGREGATE_INLINE_BYTES = 25 * 1024 * 1024;
var MAX_EXTERNAL_DECLARED_BYTES = 500 * 1024 * 1024;
var MAX_MEMORY_BLOCKS = 16;
var MAX_DOC_BLOCKS = 8;
var ALLOWED_DOC_FORMATS = /* @__PURE__ */ new Set(["loro"]);
var MAX_HISTORY_BLOCKS = 2;
var ALLOWED_HISTORY_FORMATS = /* @__PURE__ */ new Set(["prolly-v1"]);
function clipString(raw, maxBytes) {
  if (raw.length <= maxBytes) return raw;
  return raw.slice(0, maxBytes);
}
function parseBytesAttr(raw) {
  if (!raw) return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_EXTERNAL_DECLARED_BYTES) {
    return void 0;
  }
  return Math.floor(n);
}
function isFetchableUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
function parseWorkbookHtml(root) {
  const name = root.getAttribute("name") ?? "html-workbook";
  const cells = [];
  const inputs = {};
  const agents = [];
  const data = [];
  const memory = [];
  const docs = [];
  const history = [];
  let aggregateInlineBytes = 0;
  for (const el of root.querySelectorAll("wb-input")) {
    if (Object.keys(inputs).length >= MAX_INPUTS) break;
    const nm = validId(el.getAttribute("name"));
    if (!nm) continue;
    const type = el.getAttribute("type") ?? "text";
    const rawDef = el.getAttribute("default") ?? el.textContent?.trim() ?? "";
    const def = clipString(rawDef, MAX_INPUT_DEFAULT_BYTES);
    inputs[nm] = coerceValue(def, type);
  }
  for (const el of root.querySelectorAll("wb-cell")) {
    if (cells.length >= MAX_CELLS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const rawLang = el.getAttribute("language") ?? "rhai";
    if (!ALLOWED_LANGUAGES.has(rawLang)) continue;
    const language = rawLang;
    const reads = validIdList(el.getAttribute("reads"));
    const provides = validIdList(el.getAttribute("provides"));
    if (!provides.length) provides.push(id);
    const source = clipString(el.textContent?.trim() ?? "", MAX_SOURCE_BYTES);
    const cell = { id, language, source, dependsOn: reads, provides };
    cells.push(cell);
  }
  for (const el of root.querySelectorAll("wb-agent")) {
    if (agents.length >= MAX_AGENTS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const rawModel = el.getAttribute("model") ?? "openai/gpt-4o-mini";
    if (!VALID_MODEL.test(rawModel)) continue;
    const model = rawModel;
    const reads = validIdList(el.getAttribute("reads"));
    const systemEl = el.querySelector("wb-system");
    const systemPrompt = clipString(
      systemEl?.textContent?.trim() ?? "",
      MAX_SYSTEM_PROMPT_BYTES
    );
    const tools = [...el.querySelectorAll("wb-tool")].map((t) => validId(t.getAttribute("ref"))).filter((s) => Boolean(s)).slice(0, MAX_TOOLS_PER_AGENT);
    agents.push({ id, model, systemPrompt, reads, tools });
  }
  const usedIds = /* @__PURE__ */ new Set([
    ...Object.keys(inputs),
    ...cells.map((c) => c.id),
    ...cells.flatMap((c) => c.provides ?? [])
  ]);
  for (const el of root.querySelectorAll("wb-data")) {
    if (data.length >= MAX_DATA_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const mime = (el.getAttribute("mime") ?? "").toLowerCase();
    if (!ALLOWED_DATA_MIMES.has(mime)) continue;
    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;
    const rawCompression = el.getAttribute("compression");
    const compression = rawCompression === "gzip" || rawCompression === "zstd" ? rawCompression : void 0;
    const rowsAttr = Number(el.getAttribute("rows"));
    const rows = Number.isFinite(rowsAttr) && rowsAttr >= 0 ? rowsAttr : void 0;
    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();
    const encryptionAttr = el.getAttribute("encryption");
    const encryption = encryptionAttr === "age-v1" ? "age-v1" : void 0;
    const pubkeyAttr = el.getAttribute("pubkey");
    const sigAttr = el.getAttribute("sig");
    const pubkey = pubkeyAttr && pubkeyAttr.length <= 64 && /^[A-Za-z0-9+/=]+$/.test(pubkeyAttr) ? pubkeyAttr : void 0;
    const sig = sigAttr && sigAttr.length <= 128 && /^[A-Za-z0-9+/=]+$/.test(sigAttr) ? sigAttr : void 0;
    let entry = null;
    if (srcAttr) {
      if (!sha256) continue;
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = { id, mime, rows, compression, encryption, pubkey, sig, source: { kind: "external", src: srcAttr, sha256, bytes } };
    } else if (encoding === "base64") {
      if (!sha256) continue;
      const raw = el.textContent ?? "";
      const base64 = raw.replace(/\s+/g, "");
      if (!base64) continue;
      if (base64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor(base64.length * 3 / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = { id, mime, rows, compression, encryption, pubkey, sig, source: { kind: "inline-base64", base64, sha256 } };
    } else if (TEXT_DATA_MIMES.has(mime)) {
      const content = clipString(el.textContent ?? "", MAX_INLINE_TEXT_BYTES);
      if (!content) continue;
      const byteLen = content.length;
      if (aggregateInlineBytes + byteLen > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += byteLen;
      entry = {
        id,
        mime,
        rows,
        compression,
        source: sha256 ? { kind: "inline-text", content, sha256 } : { kind: "inline-text", content }
      };
    } else {
      continue;
    }
    if (entry) data.push(entry);
  }
  for (const el of root.querySelectorAll("wb-memory")) {
    if (memory.length >= MAX_MEMORY_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;
    if (!sha256) continue;
    const rowsAttr = Number(el.getAttribute("rows"));
    const rows = Number.isFinite(rowsAttr) && rowsAttr >= 0 ? rowsAttr : void 0;
    const schemaIdAttr = el.getAttribute("schema-id");
    const schemaId = schemaIdAttr && validId(schemaIdAttr) ? schemaIdAttr : void 0;
    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();
    let entry = null;
    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = { id, schemaId, rows, source: { kind: "external", src: srcAttr, sha256, bytes } };
    } else if (encoding === "base64") {
      const raw = el.textContent ?? "";
      const base64 = raw.replace(/\s+/g, "");
      if (!base64) continue;
      if (base64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor(base64.length * 3 / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = { id, schemaId, rows, source: { kind: "inline-base64", base64, sha256 } };
    } else {
      continue;
    }
    if (entry) memory.push(entry);
  }
  for (const el of root.querySelectorAll("wb-doc")) {
    if (docs.length >= MAX_DOC_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const formatAttr = el.getAttribute("format");
    if (!formatAttr || !ALLOWED_DOC_FORMATS.has(formatAttr)) continue;
    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;
    const horizonAttr = Number(el.getAttribute("history-horizon"));
    const historyHorizon = Number.isFinite(horizonAttr) && horizonAttr >= 0 ? horizonAttr : void 0;
    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();
    const rawText = el.textContent ?? "";
    const inlineBase64 = encoding === "base64" ? rawText.replace(/\s+/g, "") : "";
    let entry = null;
    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      if (!sha256) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = {
        id,
        format: formatAttr,
        historyHorizon,
        source: { kind: "external", src: srcAttr, sha256, bytes }
      };
    } else if (inlineBase64) {
      if (!sha256) continue;
      if (inlineBase64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor(inlineBase64.length * 3 / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = {
        id,
        format: formatAttr,
        historyHorizon,
        source: { kind: "inline-base64", base64: inlineBase64, sha256 }
      };
    } else {
      entry = {
        id,
        format: formatAttr,
        historyHorizon,
        source: { kind: "empty" }
      };
    }
    if (entry) docs.push(entry);
  }
  for (const el of root.querySelectorAll("wb-history")) {
    if (history.length >= MAX_HISTORY_BLOCKS) break;
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const formatAttr = el.getAttribute("format");
    if (!formatAttr || !ALLOWED_HISTORY_FORMATS.has(formatAttr)) continue;
    const sha256Attr = (el.getAttribute("sha256") ?? "").toLowerCase();
    const sha256 = VALID_SHA256.test(sha256Attr) ? sha256Attr : null;
    if (!sha256) continue;
    const headShaAttr = (el.getAttribute("head-sha256") ?? "").toLowerCase();
    const headSha256 = VALID_SHA256.test(headShaAttr) ? headShaAttr : null;
    if (!headSha256) continue;
    const srcAttr = el.getAttribute("src");
    const encoding = (el.getAttribute("encoding") ?? "").toLowerCase();
    let entry = null;
    if (srcAttr) {
      if (!isFetchableUrl(srcAttr)) continue;
      const bytes = parseBytesAttr(el.getAttribute("bytes"));
      entry = {
        id,
        format: formatAttr,
        headSha256,
        source: { kind: "external", src: srcAttr, sha256, bytes }
      };
    } else if (encoding === "base64") {
      const raw = el.textContent ?? "";
      const base64 = raw.replace(/\s+/g, "");
      if (!base64) continue;
      if (base64.length > MAX_INLINE_BASE64_CHARS) continue;
      const approxBytes = Math.floor(base64.length * 3 / 4);
      if (aggregateInlineBytes + approxBytes > MAX_AGGREGATE_INLINE_BYTES) continue;
      aggregateInlineBytes += approxBytes;
      entry = {
        id,
        format: formatAttr,
        headSha256,
        source: { kind: "inline-base64", base64, sha256 }
      };
    } else {
      continue;
    }
    if (entry) history.push(entry);
  }
  return { name, cells, inputs, agents, data, memory, docs, history };
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
  const localRegistry = opts.cellRegistry;
  const lookupCustom = (language) => localRegistry?.get(language) ?? customCellRegistry.get(language);
  const wasmClient = createRuntimeClient({
    loadWasm: opts.loadWasm,
    llmClient: opts.llmClient
  });
  const registeredMemoryIds = new Set(spec.memory.map((m) => m.id));
  const client = {
    ...wasmClient,
    async runCell(req) {
      const custom = lookupCustom(req.cell.language);
      if (custom) {
        const outputs = await custom.execute({
          source: req.cell.source ?? "",
          params: req.params ?? {},
          cellId: req.cell.id,
          ctx: ctxRef.current
        });
        return { outputs };
      }
      const memoryTables = {};
      for (const dep of req.cell.dependsOn ?? []) {
        if (registeredMemoryIds.has(dep) && wasmClient.exportMemory) {
          memoryTables[dep] = await wasmClient.exportMemory(dep);
        }
      }
      const enriched = Object.keys(memoryTables).length > 0 ? { ...req, memoryTables } : req;
      return wasmClient.runCell(enriched);
    }
  };
  if (typeof window !== "undefined") {
    window.__wbRuntime = client;
  }
  const ctxRef = { current: null };
  const outputCache = /* @__PURE__ */ new Map();
  const dataResolver = opts.dataResolver ?? createWorkbookDataResolver();
  const resolvedData = await dataResolver.resolveAll(spec.data);
  const mergedInputs = { ...spec.inputs };
  for (const [id, resolved] of resolvedData) {
    mergedInputs[id] = resolved.value;
  }
  const memoryResolver = opts.memoryResolver ?? createWorkbookMemoryResolver();
  const resolvedMemory = await memoryResolver.resolveAll(spec.memory);
  for (const [id, resolved] of resolvedMemory) {
    if (client.registerMemory) {
      await client.registerMemory(id, resolved.bytes);
    }
  }
  const docResolver = opts.docResolver ?? createWorkbookDocResolver();
  const resolvedDocs = await docResolver.resolveAll(spec.docs);
  for (const [id, resolved] of resolvedDocs) {
    if (client.registerDoc) {
      await client.registerDoc(id, resolved.handle);
    }
    mergedInputs[id] = resolved.handle.toJSON();
  }
  if (opts.historyResolver && spec.history.length > 0) {
    await opts.historyResolver.resolveAll(spec.history);
  }
  const executor = new ReactiveExecutor({
    client,
    cells: spec.cells,
    inputs: mergedInputs,
    workbookSlug: spec.name,
    onCellState: (state) => {
      if (state.status === "ok" && state.outputs) {
        outputCache.set(state.cellId, state.outputs);
      }
      for (const out of doc.querySelectorAll(`wb-output[for="${CSS.escape(state.cellId)}"]`)) {
        renderOutputElement(out, state, spec.cells, lookupCustom);
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
function renderOutputElement(el, state, cells, lookupCustom) {
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
    const custom = lookupCustom(cell.language);
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
    runAgentOnce(el, ctx, agent).catch((err2) => console.warn("agent run", err2));
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
    } catch (err2) {
      history.push({
        role: "assistant",
        content: `[error] ${err2 instanceof Error ? err2.message : String(err2)}`
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

// packages/runtime/src/util/url.ts
function normalize(raw) {
  return String(raw ?? "").replace(/^[\u0000-\u001F\u00A0\s]+/, "").replace(/[\u0000-\u001F\u00A0]/g, "");
}
var SAFE_HREF = /^(?:https?:\/\/|mailto:|\/[^/]|#)/i;
function safeHref(raw) {
  const s = normalize(raw ?? "");
  if (!s) return null;
  return SAFE_HREF.test(s) ? s : null;
}

// packages/runtime/src/markdown.ts
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
    const h2 = line.match(/^(#{1,4})\s+(.*)$/);
    if (h2) {
      out.push(`<h${h2[1].length}>${inline(h2[2])}</h${h2[1].length}>`);
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

// packages/runtime/src/agentTools.ts
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

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)
*/
