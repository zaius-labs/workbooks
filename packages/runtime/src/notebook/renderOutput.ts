/**
 * Render CellOutput[] to HTML string suitable for {@html ...} in a
 * Svelte component. Kept as a pure-string function so it works
 * outside Svelte too — consumers can call it from any rendering
 * context. Returned HTML uses the styling hooks from NotebookCell's
 * scoped CSS (.num for right-aligned numerics, etc.).
 *
 * Output kinds handled:
 *   - text (text/csv) → table
 *   - text (other)    → <div>text</div>
 *   - image (svg)     → inline SVG
 *   - image (other)   → <img src="data:..."/>
 *   - table           → placeholder text (host should fetch sql_table separately)
 *   - error           → error block
 *   - stream          → fenced text
 *
 * Escapes HTML in plain text outputs. SVG images are inlined as-is,
 * which is correct for SVG produced by our runtime — that path is
 * controlled. If a workbook has untrusted SVG sources, sanitize
 * upstream.
 */

import type { CellOutput } from "../wasmBridge";

export function renderCellOutput(outputs: CellOutput[]): string {
  return outputs.map(renderOne).join("\n");
}

function renderOne(o: CellOutput): string {
  switch (o.kind) {
    case "text": {
      if (o.mime_type === "text/csv") return csvToTable(o.content);
      return `<div class="nb-out-text">${escapeHtml(o.content)}</div>`;
    }
    case "image": {
      if (o.mime_type === "image/svg+xml") {
        return `<div class="nb-out-image">${o.content}</div>`;
      }
      return `<img class="nb-out-image" src="data:${o.mime_type};base64,${o.content}" alt=""/>`;
    }
    case "table": {
      const rows = o.row_count != null ? `, ${o.row_count} rows` : "";
      return `<div class="nb-out-tableref">[table ${escapeHtml(o.sql_table)}${rows}]</div>`;
    }
    case "error":
      return `<div class="nb-out-error">${escapeHtml(o.message)}</div>`;
    case "stream":
      return `<pre class="nb-out-stream">${escapeHtml(o.content)}</pre>`;
  }
}

function csvToTable(csv: string): string {
  const rows = csv.trim().split("\n").map(parseRow);
  if (!rows.length) return "";
  const head = rows[0];
  const body = rows.slice(1);
  const headerHtml = "<tr>" + head.map((c) => `<th>${escapeHtml(c)}</th>`).join("") + "</tr>";
  const bodyHtml = body
    .map((row) => {
      const cells = row
        .map((c) => {
          const cls = isNumeric(c) ? ' class="num"' : "";
          return `<td${cls}>${escapeHtml(c)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table>`;
}

function parseRow(row: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function isNumeric(s: string): boolean {
  return s !== "" && !isNaN(Number(s));
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;"
      : c === '"' ? "&quot;" : "&#39;",
  );
}
