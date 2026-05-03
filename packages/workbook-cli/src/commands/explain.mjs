// `workbook explain <rule-id>` — print rule rationale, examples, and fix
// guidance. Reads the rule's own `rationale`/`exampleBefore`/`exampleAfter`
// fields so docs and the linter can never drift.

import { RULES, RULES_BY_ID } from "../checks/registry.mjs";

/**
 * @param {{ _: string[] }} flags  flags._[0] is the rule id
 */
export async function runExplain(flags) {
  const ruleId = flags._?.[0];
  if (!ruleId) {
    process.stdout.write("workbook explain: rule id required.\n\n");
    listRules();
    process.exit(2);
  }

  const rule = RULES_BY_ID.get(ruleId);
  if (!rule) {
    process.stderr.write(`workbook explain: unknown rule '${ruleId}'\n\n`);
    listRules();
    process.exit(2);
  }

  const lines = [
    `${rule.id}  [${rule.severity}]${rule.fixable ? "  (fixable)" : ""}`,
    "",
    rule.description,
    "",
    rule.rationale,
  ];
  if (rule.exampleBefore || rule.exampleAfter) {
    lines.push("");
    if (rule.exampleBefore) {
      lines.push("// Before (violation):");
      lines.push(rule.exampleBefore);
    }
    if (rule.exampleAfter) {
      if (rule.exampleBefore) lines.push("");
      lines.push("// After (fixed):");
      lines.push(rule.exampleAfter);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function listRules() {
  process.stdout.write("Available rules:\n");
  for (const r of RULES) {
    process.stdout.write(`  ${r.id}  [${r.severity}]\n    ${r.description}\n`);
  }
}
