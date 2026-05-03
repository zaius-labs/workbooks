/**
 * Agent tools for in-workbook authoring.
 *
 * Returns AgentTool[] suitable for `runAgentLoop({ tools })`. Tools
 * read and mutate the surrounding workbook via a ReactiveExecutor.
 * Mutations trigger the DAG to re-execute, so the next turn the
 * model sees up-to-date outputs without an explicit run step.
 *
 * Design intent: the agent is *inside* the workbook, not next to it.
 * It treats cells the way a pair-programming partner treats files —
 * read what's there, append what's needed, edit what's wrong.
 *
 * Not exposed: cell deletion. The single-document model is
 * append-only from the agent's side; humans handle deletion. Lets us
 * skip the "did the agent just nuke my work" failure mode.
 *
 * Pi-agent-core compatibility: this is a thin AgentTool[] surface
 * matching `agentLoop.ts`. When the embedded Rust agent runtime
 * (P9 / core-6ul.10) lands, the same tool semantics translate
 * directly — only the dispatch layer changes.
 */

import type { AgentTool } from "./agentLoop";
import type { ReactiveExecutor } from "./reactiveExecutor";
import type { Cell, CellOutput } from "./wasmBridge";

export interface CreateWorkbookAgentToolsOptions {
  executor: ReactiveExecutor;
  /** Optional VFS for query_data tool. Pass `null` to omit query_data. */
  vfs?: {
    exists: (path: string) => boolean;
    readText: (path: string) => string;
  };
  /** Wasm module exposing runPolarsSql for query_data. Pass `null` to omit. */
  wasm?: {
    runPolarsSql?: (sql: string, csv: string) => CellOutput[];
  };
  /** Default CSV path for query_data when the agent doesn't specify. */
  defaultCsvPath?: string;
  /**
   * Generate ids for newly-appended cells. Defaults to "cell-<n>" where n
   * is one larger than the highest numeric suffix in existing ids.
   */
  newCellId?: (existing: Cell[]) => string;
}

export function createWorkbookAgentTools(
  opts: CreateWorkbookAgentToolsOptions,
): AgentTool[] {
  const { executor, vfs, wasm, defaultCsvPath } = opts;
  const newId = opts.newCellId ?? defaultNewCellId;

  const tools: AgentTool[] = [
    {
      definition: {
        name: "list_cells",
        description:
          "List every cell in the current workbook with id, language, and a one-line summary. " +
          "Use this first to understand what's already there before appending or editing.",
        parameters: { type: "object", properties: {} },
      },
      invoke: () => {
        const cells = executor.listCells();
        if (!cells.length) return "(no cells yet)";
        return cells.map((c) => {
          const state = executor.getState(c.id);
          const status = state?.status ?? "pending";
          const summary = c.source ? firstLine(c.source) : "(no source)";
          return `${c.id}\t${c.language}\t${status}\t${summary}`;
        }).join("\n");
      },
    },
    {
      definition: {
        name: "read_cell",
        description:
          "Read a cell's full source plus its most recent outputs. " +
          "Use to inspect existing work before deciding whether to append a new cell or edit this one.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Cell id (from list_cells)." } },
          required: ["id"],
        },
      },
      invoke: ({ id }) => {
        const cell = executor.getCell(String(id));
        if (!cell) return `error: no cell with id '${id}'`;
        const state = executor.getState(String(id));
        const lines: string[] = [];
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
          lines.push(`## error\n${state.error}`);
        }
        return lines.join("\n");
      },
    },
    {
      definition: {
        name: "append_cell",
        description:
          "Append a new cell to the workbook. Cell re-executes immediately as part of the DAG. " +
          "Returns the cell id so you can read back its output on the next turn.",
        parameters: {
          type: "object",
          properties: {
            language: {
              type: "string",
              description: "One of: rhai, polars, sqlite, candle-inference, linfa-train, wasm-fn, chat",
            },
            source: { type: "string", description: "Cell source code or query." },
            id: {
              type: "string",
              description: "Optional explicit cell id. Auto-generated if omitted.",
            },
          },
          required: ["language", "source"],
        },
      },
      invoke: async ({ language, source, id }) => {
        if (!source || typeof source !== "string") return "error: source is required";
        const lang = String(language) as Cell["language"];
        if (!isCellLanguage(lang)) return `error: unknown language '${language}'`;
        const existing = executor.listCells();
        const cellId = (typeof id === "string" && id) ? id : newId(existing);
        if (executor.getCell(cellId)) {
          return `error: cell '${cellId}' already exists; use edit_cell to replace.`;
        }
        executor.setCell({ id: cellId, language: lang, source });
        return `appended ${cellId} (${lang}). DAG re-executing — use read_cell on next turn to see outputs.`;
      },
    },
    {
      definition: {
        name: "edit_cell",
        description:
          "Replace an existing cell's source. The cell and everything downstream re-runs. " +
          "Use to fix errors found via read_cell or to refine logic.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Cell id." },
            source: { type: "string", description: "New source." },
          },
          required: ["id", "source"],
        },
      },
      invoke: ({ id, source }) => {
        const cell = executor.getCell(String(id));
        if (!cell) return `error: no cell with id '${id}'`;
        executor.setCell({ ...cell, source: String(source ?? "") });
        return `updated ${cell.id}. DAG re-executing — use read_cell on next turn to see outputs.`;
      },
    },
  ];

  // Optional query_data — only attached when the host wired up a VFS + wasm.
  if (vfs && wasm?.runPolarsSql) {
    tools.push({
      definition: {
        name: "query_data",
        description:
          "Run a Polars-SQL query against a CSV in the workbook VFS without adding a cell. " +
          "Use for quick scoping; promote to append_cell once you know what you want.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "SQL string. Table name is `data`." },
            csv_path: {
              type: "string",
              description: defaultCsvPath
                ? `VFS path to CSV. Default: ${defaultCsvPath}.`
                : "VFS path to CSV.",
            },
          },
          required: ["sql"],
        },
      },
      invoke: ({ sql, csv_path }) => {
        const path = (typeof csv_path === "string" && csv_path) ? csv_path : defaultCsvPath;
        if (!path) return "error: csv_path is required (no default configured).";
        if (!vfs.exists(path)) return `error: ${path} not found in VFS`;
        try {
          const csv = vfs.readText(path);
          const outputs = wasm.runPolarsSql!(String(sql), csv);
          const csvOut = outputs.find((o) => o.kind === "text" && o.mime_type === "text/csv");
          return csvOut ? csvOut.content : JSON.stringify(outputs);
        } catch (e) {
          return `error: ${(e as Error).message ?? String(e)}`;
        }
      },
    });
  }

  return tools;
}

// ----------------------------------------------------------------------

const VALID_LANGUAGES: ReadonlySet<Cell["language"]> = new Set([
  "rhai", "polars", "sqlite",
  "candle-inference", "linfa-train", "wasm-fn", "chat",
]);

function isCellLanguage(s: string): s is Cell["language"] {
  return VALID_LANGUAGES.has(s as Cell["language"]);
}

function defaultNewCellId(existing: Cell[]): string {
  let max = 0;
  for (const c of existing) {
    const m = c.id.match(/^cell-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `cell-${max + 1}`;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  const line = i === -1 ? s : s.slice(0, i);
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

function formatOutput(out: CellOutput): string {
  switch (out.kind) {
    case "text": {
      const mime = out.mime_type ? ` (${out.mime_type})` : "";
      return `[text${mime}]\n${truncate(out.content, 1500)}`;
    }
    case "image":
      return `[image ${out.mime_type}, ${out.content.length} base64 chars]`;
    case "table": {
      const rows = out.row_count != null ? `, ${out.row_count} rows` : "";
      return `[table ${out.sql_table}${rows}]`;
    }
    case "error":
      return `[error]\n${out.message}`;
    case "stream":
      return `[stream]\n${truncate(out.content, 1500)}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
