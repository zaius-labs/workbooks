// Remark plugin: rewrite fenced code blocks tagged with a workbook
// language into <NotebookCell> Svelte component invocations that
// auto-register with the surrounding <Notebook> chrome (play button,
// status indicator, output rendering).
//
// Markdown input:
//
//     ```polars id="by_region"
//     SELECT region, SUM(revenue) AS total FROM data GROUP BY region
//     ```
//
// Output (post-mdsvex compile):
//
//     <NotebookCell id="by_region" language="polars" source={`SELECT
//     region, SUM(revenue) AS total FROM data GROUP BY region`} />
//
// The author wraps their .svx body in <Notebook> (or imports a
// layout that does) — they import NotebookCell once at the top and
// the rest of the document is just markdown.
//
// Code fences whose lang is NOT a workbook language (e.g. ```js,
// ```bash) pass through untouched and render as syntax-highlighted
// prose. Code blocks without a language also pass through.

import { visit } from "unist-util-visit";

const WORKBOOK_LANGUAGES = new Set([
  "rhai",
  "polars",
  "sqlite",
  "duckdb",
  "candle-inference",
  "linfa-train",
  "wasm-fn",
  "chat",
]);

/**
 * Optional info-string syntax we parse:
 *
 *     ```<lang> id="<id>" reads="a,b" provides="c"
 *
 * Everything after the lang is parsed as space-separated key=value
 * attributes (quoted or bare). Values are passed through as HTML
 * attributes on the <wb-cell> element.
 */
function parseInfoString(meta) {
  if (!meta) return {};
  const out = {};
  // Match key="value" or key='value' or key=value (no spaces).
  const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(meta)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out[key] = value;
  }
  return out;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/** Encode a string as a Svelte template-literal expression value:
 *  `{`backtick-string`}`. Escapes backticks + ${ in the source so
 *  user content can never break the template literal. */
function asTemplateExpr(s) {
  const escaped = String(s)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return "{`" + escaped + "`}";
}

export function remarkWorkbookCells() {
  return (tree) => {
    visit(tree, "code", (node, index, parent) => {
      if (!node.lang || !WORKBOOK_LANGUAGES.has(node.lang)) return;
      const attrs = parseInfoString(node.meta);
      const id = attrs.id;
      // Static attrs go as plain HTML attributes on the component;
      // source goes as a template-literal expression so multi-line
      // content + special chars stay intact.
      const attrPairs = [`language="${escapeAttr(node.lang)}"`];
      if (id) attrPairs.push(`id="${escapeAttr(id)}"`);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "id") continue;
        attrPairs.push(`${k}="${escapeAttr(v)}"`);
      }
      const sourceExpr = asTemplateExpr(node.value);
      const html =
        `<NotebookCell ${attrPairs.join(" ")} source=${sourceExpr} />`;
      // Replace the code node with an html node — mdsvex passes html
      // nodes through untouched, so this lands as raw component
      // invocation in the compiled .svelte output.
      parent.children[index] = { type: "html", value: html };
    });
  };
}
