// Rule registry for `workbook check`.
//
// Each rule is a plain object with a stable id, severity, file-pattern,
// and a check() function returning per-file diagnostics. Rules are
// registered statically (imported below) so they ship with the CLI
// and can be enumerated for --explain without running them.
//
// Rule id format mirrors Biome:
//   workbook/<category>/<kebab-name>
// Categories:
//   correctness  — code that is wrong (will fail at runtime)
//   portability  — code that works in dev but not in the single-file artifact
//   style        — non-functional consistency
//   performance  — bundle size or runtime cost
//   security     — sandbox / CSP / provenance violations

import noRawArrowImport from "./rules/no-raw-arrow-import.mjs";
import noExternalFetch from "./rules/no-external-fetch.mjs";

/** @type {ReadonlyArray<Rule>} */
export const RULES = Object.freeze([
  noRawArrowImport,
  noExternalFetch,
]);

/** @type {ReadonlyMap<string, Rule>} */
export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/**
 * @typedef {Object} Diagnostic
 * @property {string} ruleId
 * @property {"error"|"warn"|"info"} severity
 * @property {string} filePath  absolute or project-relative path
 * @property {number} line      1-indexed
 * @property {number} col       1-indexed
 * @property {number=} endLine
 * @property {number=} endCol
 * @property {string} message
 * @property {string=} advice   single-line fix hint
 */

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {"error"|"warn"|"info"} severity
 * @property {boolean} fixable     true if the rule supports --fix
 * @property {boolean=} fixSafe    true if --fix is safe to apply blindly
 * @property {string} description  one-line summary
 * @property {string} rationale    multi-paragraph markdown for --explain
 * @property {string=} exampleBefore  code snippet showing the violation
 * @property {string=} exampleAfter   code snippet showing the fix
 * @property {ReadonlyArray<string>} extensions  file extensions to scan ("js","mjs","svelte","html")
 * @property {(ctx: { filePath: string, content: string }) => Diagnostic[]} check
 */

/** Filter rules by id list (or all if none given). */
export function selectRules(ids) {
  if (!ids || ids.length === 0) return RULES;
  const set = new Set(ids);
  return RULES.filter((r) => set.has(r.id));
}
