// JSON reporter for `workbook check` — the agent contract.
//
// Emits NDJSON (newline-delimited JSON): one diagnostic per line, then
// a final summary line. Tools can stream-parse without loading the
// whole output. Each line is a complete, self-describing JSON object.
//
// Schema (stable; semver-pinned to the CLI version):
//
//   diagnostic line:
//     {
//       "kind": "diagnostic",
//       "ruleId": "workbook/correctness/no-raw-arrow-import",
//       "severity": "error" | "warn" | "info",
//       "filePath": "examples/stocks/main.js",
//       "line": 199, "col": 26,
//       "endLine": 199, "endCol": 38,
//       "message": "...",
//       "advice": "..."
//     }
//
//   summary line (always last):
//     {
//       "kind": "summary",
//       "errorCount": 2, "warnCount": 0, "infoCount": 0,
//       "filesScanned": 47,
//       "durationMs": 134
//     }

/**
 * @param {Diagnostic[]} diagnostics
 * @param {{ filesScanned: number, durationMs: number }} summary
 */
export function reportJson(diagnostics, summary) {
  for (const d of diagnostics) {
    process.stdout.write(JSON.stringify({ kind: "diagnostic", ...d }) + "\n");
  }
  process.stdout.write(
    JSON.stringify({
      kind: "summary",
      errorCount: diagnostics.filter((d) => d.severity === "error").length,
      warnCount: diagnostics.filter((d) => d.severity === "warn").length,
      infoCount: diagnostics.filter((d) => d.severity === "info").length,
      filesScanned: summary.filesScanned,
      durationMs: summary.durationMs,
    }) + "\n",
  );
}
