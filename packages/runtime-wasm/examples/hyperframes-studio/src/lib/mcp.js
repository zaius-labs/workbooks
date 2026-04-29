// MCP exposure manifest — the subset of agent tools we'd surface
// over the Model Context Protocol when the workbook is hosted via
// `workbook mcp <file>`. Asset-registry-bound tools are excluded
// because they depend on session state that doesn't exist in a
// headless invocation.

export const MCP_TOOLS = [
  {
    name: "get_composition",
    summary: "Read the current composition HTML.",
    note: "Embedded data URLs are redacted to @hf-asset:<id> placeholders.",
  },
  {
    name: "set_composition",
    summary: "Replace the composition HTML in place.",
    note: "Provide the full body. Asset placeholders round-trip cleanly.",
  },
  {
    name: "patch_clip",
    summary: "Update one clip's start / duration / lane in place.",
    note: "Faster than set_composition for retime / move / playback-start edits.",
  },
  {
    name: "list_clips",
    summary: "Parse the composition and list every [data-start] clip.",
    note: "Returns id, start, duration, label, role, group.",
  },
  {
    name: "house_style",
    summary: "Get the HyperFrames composition conventions checklist.",
    note: "Static reference doc — useful for compositor agents.",
  },
];

/** Best-effort detection of the workbook's on-disk path. Browsers
 *  don't expose the file path of a file:// URL directly, but
 *  decoding location.pathname gets close. For http(s):// origins
 *  we return the URL; the user can override in the path field. */
export function detectWorkbookPath() {
  if (typeof location === "undefined") return "";
  if (location.protocol === "file:") {
    try { return decodeURIComponent(location.pathname); }
    catch { return location.pathname; }
  }
  return location.href;
}

/** The slug used as the MCP server's name in client configs. Reads
 *  from the manifest emitted by the workbook CLI; falls back to
 *  the document title or a generic name. */
export function detectSlug() {
  if (typeof document === "undefined") return "workbook";
  const specEl = document.getElementById("workbook-spec");
  if (specEl) {
    try {
      const spec = JSON.parse(specEl.textContent || "{}");
      if (spec?.manifest?.slug) return spec.manifest.slug;
    } catch {}
  }
  const t = document.title?.split("·")[0]?.trim();
  return t?.replace(/\s+/g, "-").toLowerCase() || "workbook";
}

// ─── Snippet builders ──────────────────────────────────────────
// Each returns the canonical config / command for a host. The
// path is the user's resolved workbook path (or a placeholder).

export function claudeCodeCommand({ slug, path }) {
  return `claude mcp add ${slug} -- npx -y @work.books/cli@latest mcp "${path}"`;
}

export function claudeDesktopJson({ slug, path }) {
  return JSON.stringify({
    mcpServers: {
      [slug]: {
        command: "npx",
        args: ["-y", "@work.books/cli@latest", "mcp", path],
      },
    },
  }, null, 2);
}

export function cursorJson({ slug, path }) {
  // Cursor's .cursor/mcp.json shape matches Claude Desktop's.
  return claudeDesktopJson({ slug, path });
}

export function codexJson({ slug, path }) {
  // OpenAI Codex CLI's MCP config surface as of cutoff.
  return JSON.stringify({
    mcp: {
      servers: {
        [slug]: {
          command: "npx",
          args: ["-y", "@work.books/cli@latest", "mcp", path],
        },
      },
    },
  }, null, 2);
}

export function installPrompt({ slug, path }) {
  return `Please install this MCP server for me. Run:

\`claude mcp add ${slug} -- npx -y @work.books/cli@latest mcp "${path}"\`

Or if I'm using a different client (Cursor, Codex), add it to the equivalent
mcp.json. The server exposes a HyperFrames composition I'm editing —
get_composition / set_composition / patch_clip / list_clips / house_style.

Confirm once it's wired up and list the tools it advertises.`;
}
