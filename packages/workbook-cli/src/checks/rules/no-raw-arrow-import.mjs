// workbook/correctness/no-raw-arrow-import
//
// Forbid direct `apache-arrow` imports in workbook source. Use the
// `workbook:data` virtual module instead — it wraps apache-arrow with
// the right defaults (Utf8 strings, no dictionary encoding) so the
// resulting Arrow IPC actually round-trips through polars-wasm.

const RULE_ID = "workbook/correctness/no-raw-arrow-import";

// Match either `import ... from 'apache-arrow'` (any quote style, any
// import shape including dynamic `import('apache-arrow')`) or
// `require('apache-arrow')`. Keeps the matched literal so we can point
// the diagnostic at the column where 'apache-arrow' starts.
const PATTERNS = [
  /from\s+(['"])apache-arrow\1/g,           // import ... from 'apache-arrow'
  /import\s*\(\s*(['"])apache-arrow\1/g,     // dynamic import('apache-arrow')
  /require\s*\(\s*(['"])apache-arrow\1/g,    // require('apache-arrow')
];

export default {
  id: RULE_ID,
  severity: "error",
  fixable: false, // can't auto-rewrite — API surface differs
  description:
    "Don't import 'apache-arrow' directly — use the 'workbook:data' virtual module",
  rationale: `
Polars-wasm (the SQL engine inside the workbook runtime) does not bundle
the \`dtype-categorical\` feature, so it cannot decode Arrow tables that
contain dictionary-encoded strings.

apache-arrow's \`tableFromArrays({col: ["a","b"]})\` dictionary-encodes
strings *by default*. Result: your data builds fine, but \`wb.sql()\`
throws "activate dtype-categorical" the moment it touches your strings.

The fix is to always materialize string columns as plain Utf8 vectors
before building the table. The \`workbook:data\` virtual module exposes
\`fromArrays\` that does exactly this; it's the only path you need.

If you have a real reason to reach past the facade (e.g. you're using
RecordBatch streaming and you know what you're doing), suppress this
rule with an inline comment:

    // workbook-disable-next-line workbook/correctness/no-raw-arrow-import
    import * as arrow from "apache-arrow";
`.trim(),
  exampleBefore: `import { tableFromArrays } from "apache-arrow";
const t = tableFromArrays({ ticker: ["AAPL", "GOOG"], close: [180, 140] });`,
  exampleAfter: `import { fromArrays } from "workbook:data";
const t = fromArrays({ ticker: ["AAPL", "GOOG"], close: [180, 140] });`,
  extensions: ["js", "mjs", "ts", "mts", "svelte", "html"],

  check({ filePath, content }) {
    const diagnostics = [];
    const lines = content.split("\n");
    // Build line-start offsets so we can map a global index to (line,col).
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") lineStarts.push(i + 1);
    }
    const indexToLineCol = (idx) => {
      // binary search would be cleaner; small files don't need it
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, col: idx - lineStarts[lo] + 1 };
    };

    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(content)) !== null) {
        const literalStart = m.index + m[0].indexOf("apache-arrow");
        const { line, col } = indexToLineCol(literalStart);

        // Honor inline suppression: a comment on the *same line* or
        // the *previous line* containing the rule id.
        const suppressed =
          (lines[line - 1] && lines[line - 1].includes(`workbook-disable ${RULE_ID}`)) ||
          (lines[line - 1] && lines[line - 1].includes(`workbook-disable-line ${RULE_ID}`)) ||
          (lines[line - 2] && lines[line - 2].includes(`workbook-disable-next-line ${RULE_ID}`));
        if (suppressed) continue;

        diagnostics.push({
          ruleId: RULE_ID,
          severity: "error",
          filePath,
          line,
          col,
          endLine: line,
          endCol: col + "apache-arrow".length,
          message: "direct 'apache-arrow' import — use 'workbook:data' instead",
          advice: "import { fromArrays, tableFromIPC } from 'workbook:data'",
        });
      }
    }
    return diagnostics;
  },
};
