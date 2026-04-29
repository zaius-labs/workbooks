var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// ../runtime/src/duckdbSidecar.ts
var exports_duckdbSidecar = {};
__export(exports_duckdbSidecar, {
  runDuckdbSql: () => runDuckdbSql
});
async function ensureDuckdb() {
  if (dbInstance)
    return dbInstance;
  if (duckdbPromise)
    return await duckdbPromise;
  duckdbPromise = (async () => {
    const duckdb = await import("@duckdb/duckdb-wasm");
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerScript = `importScripts("${bundle.mainWorker}");`;
    const workerUrl = URL.createObjectURL(new Blob([workerScript], { type: "application/javascript" }));
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger;
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    dbInstance = db;
    return { db };
  })();
  await duckdbPromise;
  if (!dbInstance)
    throw new Error("duckdb instance not initialized");
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
        await conn.query("CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv_auto('data.csv', HEADER=TRUE)");
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
  return lines.join(`
`) + `
`;
}
function formatCell(v) {
  if (v == null)
    return "";
  if (typeof v === "bigint")
    return v.toString();
  if (typeof v === "number")
    return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean")
    return v ? "true" : "false";
  if (typeof v === "string")
    return v;
  if (v instanceof Date)
    return v.toISOString();
  return String(v);
}
function escapeCsv(s) {
  if (/[",\n\r]/.test(s))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}
var duckdbPromise = null, dbInstance = null;

// ../runtime/src/wasmBridge.ts
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
        if (!wasm.runRhai)
          throw new Error("runtime built without rhai-glue feature");
        const outputs = wasm.runRhai(req.cell.source ?? "", req.params ?? {});
        return { outputs };
      }
      if (lang === "polars") {
        if (!wasm.runPolarsSql)
          throw new Error("runtime built without polars-frames feature");
        const sql = req.cell.source ?? "";
        const csv = req.params?.csv ?? "";
        const outputs = wasm.runPolarsSql(sql, csv);
        return { outputs };
      }
      if (lang === "sqlite") {
        throw new Error("sqlite cell dispatcher not yet wired (P2.5)");
      }
      if (lang === "duckdb") {
        const { runDuckdbSql: runDuckdbSql2 } = await Promise.resolve().then(() => exports_duckdbSidecar);
        const sql = req.cell.source ?? "";
        const csv = req.params?.csv ?? "";
        const outputs = await runDuckdbSql2(sql, csv);
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
// ../runtime/src/cellAnalyzer.ts
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
  const reads = new Set;
  for (const m of src.matchAll(SQL_FROM_RE))
    reads.add(m[1]);
  for (const m of src.matchAll(SQL_JOIN_RE))
    reads.add(m[1]);
  const ctes = new Set;
  for (const m of src.matchAll(SQL_WITH_RE))
    ctes.add(m[1]);
  for (const m of src.matchAll(SQL_WITH_FOLLOW_RE))
    ctes.add(m[1]);
  return [...reads].filter((name) => !ctes.has(name));
}
var RHAI_LET_RE = /\blet\s+([a-zA-Z_][\w]*)/g;
var RHAI_IDENT_RE = /\b([a-zA-Z_][\w]*)\b/g;
var RHAI_KEYWORDS = new Set([
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
  const provides = new Set;
  for (const m of noStrings.matchAll(RHAI_LET_RE))
    provides.add(m[1]);
  const reads = new Set;
  for (const m of noStrings.matchAll(RHAI_IDENT_RE)) {
    const name = m[1];
    if (provides.has(name))
      continue;
    if (RHAI_KEYWORDS.has(name))
      continue;
    if (/^\d/.test(name))
      continue;
    reads.add(name);
  }
  return [...reads];
}
function dedupe(xs) {
  return [...new Set(xs)];
}
// ../runtime/src/reactiveExecutor.ts
class ReactiveExecutor {
  client;
  cells = new Map;
  inputs = new Map;
  states = new Map;
  onCellState;
  debounceMs;
  workbookSlug;
  runtimeId = null;
  runtimePromise = null;
  generation = 0;
  debounceTimer = null;
  constructor(opts) {
    this.client = opts.client;
    this.onCellState = opts.onCellState ?? (() => {});
    this.debounceMs = opts.debounceMs ?? 200;
    this.workbookSlug = opts.workbookSlug ?? "live";
    for (const cell of opts.cells)
      this.cells.set(cell.id, cell);
    if (opts.inputs) {
      for (const [k, v] of Object.entries(opts.inputs))
        this.inputs.set(k, v);
    }
    for (const [id] of this.cells) {
      this.states.set(id, { cellId: id, status: "pending" });
    }
  }
  setInput(name, value) {
    this.inputs.set(name, value);
    this.scheduleRun([name]);
  }
  setCell(cell) {
    this.cells.set(cell.id, cell);
    if (!this.states.has(cell.id)) {
      this.states.set(cell.id, { cellId: cell.id, status: "pending" });
    }
    this.scheduleRun(analyzeCell(cell).provides);
  }
  runAll() {
    return this.executeFrom(null);
  }
  destroy() {
    if (this.debounceTimer)
      clearTimeout(this.debounceTimer);
    if (this.runtimeId) {
      this.client.destroyRuntime(this.runtimeId).catch(() => {});
    }
  }
  scheduleRun(changedProvides) {
    if (this.debounceTimer)
      clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.executeFrom(changedProvides).catch((err) => {
        for (const id of this.cells.keys()) {
          this.transition(id, { status: "error", error: String(err) });
        }
      });
    }, this.debounceMs);
  }
  async ensureRuntime() {
    if (this.runtimeId)
      return this.runtimeId;
    if (this.runtimePromise)
      return this.runtimePromise;
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
      if (gen !== this.generation)
        return;
      if (!dirty.has(cell.id))
        continue;
      const analysis = analyzeCell(cell);
      const upstreamErrored = analysis.reads.some((name) => {
        const provider = providerOf(name, [...this.cells.values()]);
        if (!provider)
          return false;
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
  collectParams(cell) {
    const a = analyzeCell(cell);
    const params = {};
    const allCells = [...this.cells.values()];
    for (const name of a.reads) {
      if (this.inputs.has(name)) {
        params[name] = this.inputs.get(name);
        continue;
      }
      const provider = allCells.find((c) => analyzeCell(c).provides.includes(name));
      if (!provider)
        continue;
      const state = this.states.get(provider.id);
      if (state?.status !== "ok" || !state.outputs?.length)
        continue;
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
}
function topologicalOrder(cells) {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const providers = new Map;
  for (const cell of cells) {
    const a = analyzeCell(cell);
    for (const name of a.provides)
      providers.set(name, cell.id);
  }
  const visited = new Set;
  const onStack = new Set;
  const order = [];
  const visit = (cellId) => {
    if (visited.has(cellId) || onStack.has(cellId))
      return;
    onStack.add(cellId);
    const cell = byId.get(cellId);
    if (cell) {
      const a = analyzeCell(cell);
      for (const dep of a.reads) {
        const upstream = providers.get(dep);
        if (upstream && upstream !== cellId)
          visit(upstream);
      }
      order.push(cell);
    }
    onStack.delete(cellId);
    visited.add(cellId);
  };
  for (const cell of cells)
    visit(cell.id);
  return order;
}
function computeDirtySet(order, seedNames) {
  const dirtyProvides = new Set(seedNames);
  const dirtyCells = new Set;
  for (const cell of order) {
    const a = analyzeCell(cell);
    if (a.reads.some((name) => dirtyProvides.has(name))) {
      dirtyCells.add(cell.id);
      for (const name of a.provides)
        dirtyProvides.add(name);
    }
  }
  return dirtyCells;
}
function providerOf(name, cells) {
  for (const cell of cells) {
    if (analyzeCell(cell).provides.includes(name))
      return cell;
  }
  return;
}
function scalarFromOutputs(outputs) {
  for (const out of outputs) {
    if (out.kind !== "text")
      continue;
    const trimmed = out.content.trim();
    const n = Number(trimmed);
    if (!Number.isNaN(n) && Number.isFinite(n))
      return n;
    return trimmed;
  }
  return outputs[0];
}
export {
  createRuntimeClient,
  analyzeCell,
  ReactiveExecutor
};
