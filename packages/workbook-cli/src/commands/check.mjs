// `workbook check` — lint a workbook source tree.
//
// Walks the project, collects every rule-relevant file, runs the rule
// registry against each, and emits diagnostics through the chosen
// reporter (pretty for TTY, json for tools/agents).
//
// Exit codes:
//   0  — no errors (warnings/info OK)
//   1  — at least one error
//   2  — fatal CLI error (config not found, bad flags)

import path from "node:path";
import fs from "node:fs/promises";
import { RULES, selectRules } from "../checks/registry.mjs";
import { walkFiles } from "../checks/walk.mjs";
import { reportPretty } from "../checks/reporters/pretty.mjs";
import { reportJson } from "../checks/reporters/json.mjs";

/**
 * @param {{
 *   project?: string,
 *   reporter?: "pretty"|"json",
 *   rules?: string,        // comma-separated rule ids to run; default = all
 *   "min-severity"?: "error"|"warn"|"info",
 * }} flags
 */
export async function runCheck(flags = {}) {
  const projectArg = flags.project ?? ".";
  const project = path.resolve(projectArg);
  try {
    const stat = await fs.stat(project);
    if (!stat.isDirectory()) {
      process.stderr.write(`workbook check: ${project} is not a directory\n`);
      process.exit(2);
    }
  } catch {
    process.stderr.write(`workbook check: cannot stat ${project}\n`);
    process.exit(2);
  }

  const reporter = flags.reporter === "json" ? "json" : "pretty";
  const requestedIds = typeof flags.rules === "string"
    ? flags.rules.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const rules = selectRules(requestedIds);
  if (rules.length === 0) {
    process.stderr.write(
      `workbook check: no matching rules (requested: ${flags.rules})\n` +
      `available: ${RULES.map((r) => r.id).join(", ")}\n`,
    );
    process.exit(2);
  }

  // Union of all extensions every rule cares about.
  const extensions = new Set();
  for (const r of rules) for (const e of r.extensions) extensions.add(e);

  const t0 = Date.now();
  const diagnostics = [];
  let filesScanned = 0;
  for await (const { abs, rel } of walkFiles(project, extensions)) {
    filesScanned++;
    let content;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const ext = path.extname(abs).slice(1).toLowerCase();
    for (const rule of rules) {
      if (!rule.extensions.includes(ext)) continue;
      const found = rule.check({ filePath: rel, content });
      for (const d of found) diagnostics.push(d);
    }
  }

  // Severity gate.
  const minSeverity = flags["min-severity"] ?? "info";
  const sevRank = { info: 0, warn: 1, error: 2 };
  const minRank = sevRank[minSeverity] ?? 0;
  const filtered = diagnostics.filter((d) => sevRank[d.severity] >= minRank);

  const summary = { filesScanned, durationMs: Date.now() - t0 };
  if (reporter === "json") reportJson(filtered, summary);
  else reportPretty(filtered, summary);

  const hasErrors = filtered.some((d) => d.severity === "error");
  process.exit(hasErrors ? 1 : 0);
}
