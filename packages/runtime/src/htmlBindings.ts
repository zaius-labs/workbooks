/**
 * HTML-first workbook bindings.
 *
 * The DOM IS the workbook. Author a workbook as plain HTML using a
 * small custom-element vocabulary; the runtime parses the document at
 * mount time, builds the same internal spec the JSON path produces,
 * and drives the executor. No build step, no framework, view-source
 * works, fork-in-the-browser works.
 *
 *   <wb-workbook name="example">
 *     <wb-input name="n" type="number" default="40"/>
 *     <wb-cell id="doubled" language="rhai" reads="n">n * 2</wb-cell>
 *     <wb-cell id="summary" language="rhai" reads="doubled">doubled + 1</wb-cell>
 *     <wb-output for="summary"/>
 *   </wb-workbook>
 *
 * Plus agent + tool elements for in-workbook agents:
 *
 *   <wb-agent id="analyst" model="openai/gpt-4o-mini" reads="result">
 *     <wb-system>You are a precise data analyst.</wb-system>
 *     <wb-tool ref="result"/>
 *   </wb-agent>
 *   <wb-chat for="analyst"/>
 *
 * Plugin API (`registerWorkbookCell`) lets third-party packages ship
 * new cell languages by registering an executor; HTML authors then
 * use `<wb-cell language="my-language">…</wb-cell>` and the new cell
 * type Just Works.
 */

import { ReactiveExecutor } from "./reactiveExecutor";
import { createRuntimeClient } from "./wasmBridge";
import type {
  Cell,
  CellLanguage,
  CellOutput,
  RuntimeClient,
  RuntimeClientOptions,
} from "./wasmBridge";
import type { CellState } from "./reactiveExecutor";
import type { LlmClient } from "./llmClient";
import { runAgentLoop } from "./agentLoop";
import { sanitizeSvg } from "./util/sanitize";

// ----------------------------------------------------------------------
// Plugin registry — third parties can register cell languages.
// ----------------------------------------------------------------------

export interface CustomCellExecutor {
  /** Called when this cell needs to run. Return CellOutput[]. */
  execute: (req: {
    source: string;
    params: Record<string, unknown>;
    cellId: string;
    ctx: WorkbookContext;
  }) => Promise<CellOutput[]> | CellOutput[];
  /** Optional: render a custom output element. If unset, default
   *  output rendering kicks in (text/csv/image dispatch). */
  renderOutput?: (target: HTMLElement, outputs: CellOutput[]) => void;
}

const customCellRegistry = new Map<string, CustomCellExecutor>();

export function registerWorkbookCell(language: string, impl: CustomCellExecutor): void {
  customCellRegistry.set(language, impl);
}

export function getRegisteredCell(language: string): CustomCellExecutor | undefined {
  return customCellRegistry.get(language);
}

// ----------------------------------------------------------------------
// Workbook context — shared across all elements inside a <wb-workbook>.
// ----------------------------------------------------------------------

export interface WorkbookContext {
  client: RuntimeClient;
  llmClient?: LlmClient;
  /** Synchronously read the latest output value for a cell id. Used by
   *  agents that want cell results as tool inputs. */
  read: (cellId: string) => CellOutput[] | undefined;
  /** Imperatively run a cell now (e.g. when an agent invokes a tool). */
  runCell: (cellId: string) => Promise<CellOutput[]>;
}

// ----------------------------------------------------------------------
// Spec extraction from DOM.
// ----------------------------------------------------------------------

interface AgentSpec {
  id: string;
  model: string;
  systemPrompt: string;
  reads: string[];
  tools: string[];
}

interface WorkbookHtmlSpec {
  name: string;
  cells: Cell[];
  inputs: Record<string, unknown>;
  agents: AgentSpec[];
}

/**
 * Workbook identifier shape — used for cell ids, input names, agent
 * ids, and any other slot whose value flows into a CSS attribute
 * selector or HTML attribute. Locked to a conservative shape so the
 * later querySelectorAll(`wb-output[for="${id}"]`) call sites can't
 * be tricked into matching unintended nodes.
 *
 * Letters, digits, underscore, hyphen. Must start with a letter.
 * Max 64 characters. Enough for human-readable ids; rejects any
 * character that has special meaning in attribute selectors
 * (`"]`, `,`, whitespace, etc.). closes core-0id.3
 */
const VALID_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function validId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return VALID_ID.test(raw) ? raw : null;
}

/** Normalize comma/whitespace-separated ids; reject any malformed token. */
function validIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => VALID_ID.test(s));
}

export function parseWorkbookHtml(root: Element): WorkbookHtmlSpec {
  const name = root.getAttribute("name") ?? "html-workbook";
  const cells: Cell[] = [];
  const inputs: Record<string, unknown> = {};
  const agents: AgentSpec[] = [];

  // Inputs.
  for (const el of root.querySelectorAll("wb-input")) {
    const nm = validId(el.getAttribute("name"));
    if (!nm) continue;
    const type = el.getAttribute("type") ?? "text";
    const def = el.getAttribute("default") ?? el.textContent?.trim() ?? "";
    inputs[nm] = coerceValue(def, type);
  }

  // Cells.
  for (const el of root.querySelectorAll("wb-cell")) {
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const language = (el.getAttribute("language") as CellLanguage) ?? "rhai";
    const reads = validIdList(el.getAttribute("reads"));
    const provides = validIdList(el.getAttribute("provides"));
    if (!provides.length) provides.push(id);
    const source = el.textContent?.trim() ?? "";
    const cell: Cell = { id, language, source, dependsOn: reads, provides };
    cells.push(cell);
  }

  // Agents.
  for (const el of root.querySelectorAll("wb-agent")) {
    const id = validId(el.getAttribute("id"));
    if (!id) continue;
    const model = el.getAttribute("model") ?? "openai/gpt-4o-mini";
    const reads = validIdList(el.getAttribute("reads"));
    const systemEl = el.querySelector("wb-system");
    const systemPrompt = systemEl?.textContent?.trim() ?? "";
    const tools = [...el.querySelectorAll("wb-tool")]
      .map((t) => validId(t.getAttribute("ref")))
      .filter((s): s is string => Boolean(s));
    agents.push({ id, model, systemPrompt, reads, tools });
  }

  return { name, cells, inputs, agents };
}

function coerceValue(raw: string, type: string): unknown {
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "boolean") return raw === "true" || raw === "1";
  return raw;
}

// ----------------------------------------------------------------------
// Mount — turn the DOM into a running workbook.
// ----------------------------------------------------------------------

export interface MountOptions {
  /** Required: how to load the wasm runtime. */
  loadWasm: RuntimeClientOptions["loadWasm"];
  /** Optional LLM client for agent + chat elements. */
  llmClient?: LlmClient;
  /** Override the document. Defaults to global `document`. */
  doc?: Document;
}

export async function mountHtmlWorkbook(opts: MountOptions): Promise<{
  executor: ReactiveExecutor;
  ctx: WorkbookContext;
  spec: WorkbookHtmlSpec;
}> {
  const doc = opts.doc ?? document;
  const root = doc.querySelector("wb-workbook");
  if (!root) throw new Error("mountHtmlWorkbook: no <wb-workbook> in document");

  const spec = parseWorkbookHtml(root);

  // Build a runtime client that knows how to dispatch built-in cells via
  // wasm AND custom-registered cells via the plugin registry.
  const wasmClient = createRuntimeClient({
    loadWasm: opts.loadWasm,
    llmClient: opts.llmClient,
  });

  // Wrap so custom cell types take precedence over wasm dispatch.
  const client: RuntimeClient = {
    ...wasmClient,
    async runCell(req) {
      const custom = customCellRegistry.get(req.cell.language);
      if (custom) {
        const outputs = await custom.execute({
          source: req.cell.source ?? "",
          params: (req.params ?? {}) as Record<string, unknown>,
          cellId: req.cell.id,
          ctx: ctxRef.current!,
        });
        return { outputs };
      }
      return wasmClient.runCell(req);
    },
  };

  // Forward-declared so the wrapper above can read it once we build it.
  const ctxRef: { current: WorkbookContext | null } = { current: null };

  // Track latest output per cell so agents/tools can read.
  const outputCache = new Map<string, CellOutput[]>();

  const executor = new ReactiveExecutor({
    client,
    cells: spec.cells,
    inputs: spec.inputs,
    workbookSlug: spec.name,
    onCellState: (state: CellState) => {
      if (state.status === "ok" && state.outputs) {
        outputCache.set(state.cellId, state.outputs);
      }
      // Push to any <wb-output for="cellId"> elements. cellId is
      // already locked to VALID_ID at parse time (core-0id.3) but
      // CSS.escape is cheap defense-in-depth — guarantees the
      // selector can't be tricked even if parser validation regresses.
      for (const out of doc.querySelectorAll(`wb-output[for="${CSS.escape(state.cellId)}"]`)) {
        renderOutputElement(out as HTMLElement, state, spec.cells);
      }
    },
  });

  const ctx: WorkbookContext = {
    client,
    llmClient: opts.llmClient,
    read: (cellId) => outputCache.get(cellId),
    runCell: async (cellId) => {
      const cell = spec.cells.find((c) => c.id === cellId);
      if (!cell) throw new Error(`runCell: unknown cell '${cellId}'`);
      const params: Record<string, unknown> = {};
      for (const dep of cell.dependsOn ?? []) {
        const out = outputCache.get(dep);
        if (out?.[0]?.kind === "text") params[dep] = (out[0] as { content: string }).content;
        else if (spec.inputs[dep] !== undefined) params[dep] = spec.inputs[dep];
      }
      const resp = await client.runCell({
        runtimeId: "imperative",
        cell,
        params,
      });
      outputCache.set(cellId, resp.outputs);
      return resp.outputs;
    },
  };
  ctxRef.current = ctx;

  // Bind <wb-input> values to the executor.
  for (const inp of doc.querySelectorAll("wb-input")) {
    bindInputElement(inp as HTMLElement, executor);
  }

  // Wire <wb-chat> elements to their agents.
  for (const chat of doc.querySelectorAll("wb-chat")) {
    bindChatElement(chat as HTMLElement, ctx, spec);
  }

  // Wire <wb-agent> trigger buttons (manual run for now).
  for (const agentEl of doc.querySelectorAll("wb-agent")) {
    bindAgentElement(agentEl as HTMLElement, ctx, spec);
  }

  await executor.runAll();
  return { executor, ctx, spec };
}

// ----------------------------------------------------------------------
// Element wiring.
// ----------------------------------------------------------------------

function bindInputElement(el: HTMLElement, executor: ReactiveExecutor): void {
  const name = el.getAttribute("name");
  if (!name) return;
  const type = el.getAttribute("type") ?? "text";
  const def = el.getAttribute("default") ?? "";

  // Replace the element's children with a real form control. (We keep
  // the wb-input element as the host so authors don't have to wrap.)
  if (el.querySelector("input, textarea, select")) return; // already wired

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

function renderOutputElement(
  el: HTMLElement,
  state: CellState,
  cells: Cell[],
): void {
  const cellId = el.getAttribute("for");
  if (!cellId) return;
  const cell = cells.find((c) => c.id === cellId);
  el.dataset.status = state.status;
  el.classList.toggle("wb-output-ok", state.status === "ok");
  el.classList.toggle("wb-output-running", state.status === "running");
  el.classList.toggle("wb-output-error", state.status === "error");
  el.classList.toggle("wb-output-stale", state.status === "stale");

  if (state.status === "running") {
    el.innerHTML = `<span class="wb-muted wb-mono" style="font-size: var(--t-sm);">running…</span>`;
    return;
  }
  if (state.status === "error") {
    el.innerHTML = `<div class="wb-out error">${escapeHtml(state.error ?? "(error)")}</div>`;
    return;
  }
  if (state.status !== "ok" || !state.outputs) return;

  // Custom output renderer wins.
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

function renderOutput(o: CellOutput): HTMLElement {
  if (o.kind === "image" && o.mime_type === "image/svg+xml") {
    const div = document.createElement("div");
    // SVG is not a safe subset of HTML. <svg><script>, on*= handlers,
    // and <foreignObject><iframe src=javascript:> all execute if we
    // drop raw SVG into innerHTML. closes core-0id.2
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

function csvToTable(csv: string): HTMLElement {
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

function parseCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
}

// ----------------------------------------------------------------------
// Agent + Chat UI bindings.
// ----------------------------------------------------------------------

function bindAgentElement(
  el: HTMLElement,
  ctx: WorkbookContext,
  spec: WorkbookHtmlSpec,
): void {
  const id = el.getAttribute("id");
  if (!id) return;
  const agent = spec.agents.find((a) => a.id === id);
  if (!agent) return;

  // Inline content rendering — show the agent's last completion when
  // bound by a <wb-output for="agentId">. The chat element handles
  // multi-turn; standalone agent cells run once at mount or on click.
  if (el.hasAttribute("auto") || el.hasAttribute("trigger") === false) {
    runAgentOnce(el, ctx, agent).catch((err) => console.warn("agent run", err));
  }
}

async function runAgentOnce(
  el: HTMLElement,
  ctx: WorkbookContext,
  agent: AgentSpec,
): Promise<void> {
  if (!ctx.llmClient) return;
  // Build context from the agent's `reads` cells.
  const contextLines: string[] = [];
  for (const ref of agent.reads) {
    const out = ctx.read(ref);
    if (out?.[0]?.kind === "text") {
      contextLines.push(`### ${ref}\n${(out[0] as { content: string }).content}`);
    }
  }
  const userMessage =
    contextLines.length > 0
      ? `Context:\n\n${contextLines.join("\n\n")}\n\nProvide your analysis.`
      : "Begin.";

  const result = await runAgentLoop({
    llmClient: ctx.llmClient,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    initialUserMessage: userMessage,
    tools: [], // tool-use agent layer comes next
  });

  // Find the matching <wb-output for=agent.id> and update. agent.id
  // is locked to VALID_ID at parse time (core-0id.3); CSS.escape is
  // defense-in-depth.
  const outputs = document.querySelectorAll(`wb-output[for="${CSS.escape(agent.id)}"]`);
  for (const o of outputs) {
    (o as HTMLElement).innerHTML = "";
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.textContent = result.text;
    o.appendChild(div);
  }
}

function bindChatElement(
  el: HTMLElement,
  ctx: WorkbookContext,
  spec: WorkbookHtmlSpec,
): void {
  const agentId = el.getAttribute("for") ?? el.getAttribute("agent");
  if (!agentId) {
    el.innerHTML = `<div class="wb-out error">wb-chat: missing 'for' attribute</div>`;
    return;
  }
  const agent = spec.agents.find((a) => a.id === agentId);
  if (!agent) {
    // agentId is from getAttribute("for")/("agent"), workbook-controlled.
    // Escape before interpolating into the error message. closes core-0id.2 + .3
    el.innerHTML = `<div class="wb-out error">wb-chat: no agent with id '${escapeHtml(agentId)}'</div>`;
    return;
  }
  if (!ctx.llmClient) {
    el.innerHTML = `<div class="wb-out error">wb-chat: no llmClient configured</div>`;
    return;
  }

  // Render chat shell.
  el.innerHTML = `
    <div class="wb-chat">
      <div class="wb-chat-history" data-history></div>
      <div class="wb-chat-compose">
        <textarea class="wb-textarea" rows="2" data-input placeholder="Message ${escapeHtml(agentId)}…"></textarea>
        <button class="wb-btn run" data-send>Send</button>
      </div>
    </div>
  `;

  const history: { role: "user" | "assistant"; content: string }[] = [];
  const historyEl = el.querySelector("[data-history]") as HTMLElement;
  const inputEl = el.querySelector("[data-input]") as HTMLTextAreaElement;
  const sendBtn = el.querySelector("[data-send]") as HTMLButtonElement;

  function renderHistory(streamingText?: string) {
    historyEl.innerHTML = "";
    for (const m of history) {
      const div = document.createElement("div");
      div.className = `wb-chat-msg wb-chat-msg-${m.role}`;
      div.textContent = m.content;
      historyEl.appendChild(div);
    }
    if (streamingText !== undefined) {
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

    // Build messages: system + agent's read-context + history.
    const contextLines: string[] = [];
    for (const ref of agent.reads) {
      const out = ctx.read(ref);
      if (out?.[0]?.kind === "text") {
        contextLines.push(`### ${ref}\n${(out[0] as { content: string }).content}`);
      }
    }
    const augmentedSystem = contextLines.length > 0
      ? `${agent.systemPrompt}\n\nAvailable context (cell outputs):\n\n${contextLines.join("\n\n")}`
      : agent.systemPrompt;

    let streamed = "";
    try {
      const it = ctx.llmClient!.generateChat({
        model: agent.model,
        messages: [
          { role: "system", content: augmentedSystem },
          ...history.map((m) => ({ role: m.role, content: m.content })),
        ],
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
        content: `[error] ${err instanceof Error ? err.message : String(err)}`,
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
