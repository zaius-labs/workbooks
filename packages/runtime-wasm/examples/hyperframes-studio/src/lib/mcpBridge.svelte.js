// MCP bridge — exposes the workbook's tool surface as a known
// `window.__workbook_mcp` global so an external host (the planned
// `@work.books/cli mcp <file>` command, running this page via
// Playwright) can list and invoke tools through MCP.
//
// The same `buildTools()` array drives both:
//   - the in-app chat agent (agent.svelte.js's send loop)
//   - this MCP bridge
// Tool implementations are pure closures over composition / assets,
// so calls from outside the chat agent do exactly what calls from
// inside it would do — there's no second LLM in the loop and no
// separate translation layer.
//
// The host can also identify itself + push status updates so the
// MCP panel UI can show "● connected to claude-code · editing".

import { buildTools } from "./agent.svelte.js";

const MAX_LOG = 50;

class McpBridgeStore {
  /** True once a host has called mount() and registered the global. */
  mounted = $state(false);
  /** True after the host explicitly declares itself or invokes any
   *  tool — distinguishes "page loaded" from "actively driven". */
  connected = $state(false);
  /** Free-text label the host can set, e.g. "claude-code", "codex". */
  clientName = $state(null);
  /** Coarse status the host updates: idle | working | editing | error. */
  status = $state("idle");
  /** Recent tool invocations — trimmed to MAX_LOG, newest first. */
  activity = $state([]);

  mount() {
    if (typeof window === "undefined" || this.mounted) return;
    const tools = buildTools();
    const byName = new Map(tools.map((t) => [t.definition.name, t]));

    window.__workbook_mcp = {
      // Stable contract version. Bump when the surface changes in a
      // breaking way; the CLI bridge can refuse old versions.
      version: 1,

      meta: () => ({
        slug: detectSlug(),
        name: typeof document !== "undefined" ? document.title : "workbook",
        contract: 1,
      }),

      listTools: () =>
        tools.map((t) => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.parameters ?? { type: "object", properties: {} },
        })),

      invoke: async (name, args) => {
        const tool = byName.get(name);
        if (!tool) throw new Error(`unknown tool: ${name}`);
        const parsed = typeof args === "string" ? safeJson(args) : (args ?? {});
        const startedAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
        this.connected = true;
        this.status = name === "set_composition" || name === "patch_clip" || name === "add_asset_clip"
          ? "editing"
          : "working";
        try {
          const result = await tool.invoke(parsed);
          const dur = Math.round((performance.now?.() ?? Date.now()) - startedAt);
          this.log({ name, args: parsed, result: String(result ?? ""), durationMs: dur, ok: true });
          this.status = "idle";
          return String(result ?? "");
        } catch (e) {
          const dur = Math.round((performance.now?.() ?? Date.now()) - startedAt);
          const msg = e?.message ?? String(e);
          this.log({ name, args: parsed, result: msg, durationMs: dur, ok: false });
          this.status = "error";
          throw e;
        }
      },

      /** Host introduces itself. Optional but lets the UI show
       *  "connected to claude-code". */
      setClient: (name) => {
        this.clientName = String(name || "").slice(0, 80) || null;
        this.connected = true;
      },

      /** Coarse status hint from the host. Free-form but the UI
       *  recognises idle / working / editing / rendering / error. */
      setStatus: (status) => {
        this.status = String(status || "idle");
      },

      /** Disconnect notification. Host should call on shutdown so
       *  the UI can show ○ no client. */
      disconnect: () => {
        this.connected = false;
        this.clientName = null;
        this.status = "idle";
      },
    };

    this.mounted = true;
  }

  log(entry) {
    const next = [{
      id: Math.random().toString(36).slice(2, 10),
      ts: Date.now(),
      ...entry,
    }, ...this.activity];
    this.activity = next.slice(0, MAX_LOG);
  }

  clearLog() { this.activity = []; }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function detectSlug() {
  if (typeof document === "undefined") return "workbook";
  const el = document.getElementById("workbook-spec");
  if (el) {
    try {
      const spec = JSON.parse(el.textContent || "{}");
      if (spec?.manifest?.slug) return spec.manifest.slug;
    } catch {}
  }
  return "workbook";
}

export const mcpBridge = new McpBridgeStore();

/** True when the page was opened with `#mcp` (or `?mcp=…`) in the
 *  URL — we hide the chat tab and promote MCP to the primary view
 *  so the user sees what the external host is doing. */
export function isMcpMode() {
  if (typeof location === "undefined") return false;
  return /[?#]mcp(=|&|$)/i.test(location.href) || location.hash === "#mcp";
}
