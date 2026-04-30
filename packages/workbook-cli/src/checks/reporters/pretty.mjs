// Pretty (TTY-friendly) reporter for `workbook check`. Astro/Biome
// inspired: file:line:col, severity badge, message, single-line advice,
// optional source caret. Emits to stdout. Returns void.
//
// Color is ANSI-coded directly (no chalk dep) and gated on TTY +
// FORCE_COLOR / NO_COLOR env vars.

import fs from "node:fs";

const isTTY = process.stdout.isTTY;
const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== "";
const forceColor = process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true";
const useColor = forceColor || (isTTY && !noColor);

const C = useColor
  ? {
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      blue: (s) => `\x1b[34m${s}\x1b[0m`,
      gray: (s) => `\x1b[90m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    }
  : {
      red: (s) => s,
      yellow: (s) => s,
      blue: (s) => s,
      gray: (s) => s,
      bold: (s) => s,
      dim: (s) => s,
      cyan: (s) => s,
    };

const sevBadge = {
  error: C.red("error"),
  warn: C.yellow("warn "),
  info: C.blue("info "),
};

/**
 * @param {Diagnostic[]} diagnostics
 * @param {{ filesScanned: number, durationMs: number }} summary
 */
export function reportPretty(diagnostics, summary) {
  if (diagnostics.length === 0) {
    process.stdout.write(
      `${C.bold(C.cyan("✓"))} workbook check — no issues (${summary.filesScanned} files, ${summary.durationMs}ms)\n`,
    );
    return;
  }

  // Group by file for tighter output.
  const byFile = new Map();
  for (const d of diagnostics) {
    if (!byFile.has(d.filePath)) byFile.set(d.filePath, []);
    byFile.get(d.filePath).push(d);
  }

  for (const [filePath, diags] of byFile) {
    process.stdout.write(`\n${C.bold(filePath)}\n`);
    let sourceLines = null;
    try {
      sourceLines = fs.readFileSync(filePath, "utf8").split("\n");
    } catch {
      // ignore — non-fatal, we just skip the source caret
    }
    for (const d of diags) {
      const loc = C.gray(`${d.line}:${d.col}`);
      process.stdout.write(`  ${sevBadge[d.severity]} ${loc}  ${d.message}  ${C.dim(C.cyan(d.ruleId))}\n`);
      if (sourceLines && sourceLines[d.line - 1] != null) {
        const src = sourceLines[d.line - 1];
        process.stdout.write(`       ${C.dim("│")} ${src}\n`);
        const caretWidth = Math.max(1, (d.endCol ?? d.col + 1) - d.col);
        const caret = " ".repeat(d.col - 1) + "^".repeat(caretWidth);
        process.stdout.write(`       ${C.dim("│")} ${C.red(caret)}\n`);
      }
      if (d.advice) {
        process.stdout.write(`       ${C.cyan("→")} ${d.advice}\n`);
      }
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warnCount = diagnostics.filter((d) => d.severity === "warn").length;
  const infoCount = diagnostics.filter((d) => d.severity === "info").length;
  const parts = [];
  if (errorCount) parts.push(C.red(`${errorCount} error${errorCount === 1 ? "" : "s"}`));
  if (warnCount) parts.push(C.yellow(`${warnCount} warning${warnCount === 1 ? "" : "s"}`));
  if (infoCount) parts.push(C.blue(`${infoCount} info`));
  process.stdout.write(
    `\n${parts.join(", ")} across ${byFile.size} file${byFile.size === 1 ? "" : "s"} (${summary.filesScanned} scanned, ${summary.durationMs}ms)\n`,
  );
  process.stdout.write(
    C.dim(`run \`workbook explain <rule-id>\` for details on any rule.\n`),
  );
}
