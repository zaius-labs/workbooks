// Single bash tool for the agent.
//
// Backed by `just-bash` — a real virtual-filesystem bash environment
// (cat / sed / grep / awk / pipes / redirects / `>` / `>>` / heredocs /
// loops / functions / glob). The agent gets ONE tool, runs shell
// commands against the workbook's "files":
//
//   /workbook/composition.html      live composition (read+write)
//   /workbook/assets/list.txt       asset id → name/kind/duration
//   /workbook/skills/<key>.md       every skill, one file each
//
// Read-write contract: BEFORE every exec we write the current
// composition into the VFS; AFTER exec we read it back and (if it
// changed) commit through composition.set so the iframe + Loro doc
// pick up the edit.
//
// Asset references in composition.html stay as
//   src="@hf-asset:<id>"
// placeholders the whole way through bash. The studio expands those
// to real data URLs at commit time.

import { Bash } from "just-bash";
import { composition, redactDataUrlsForAgent, expandAssetPlaceholders } from "./composition.svelte.js";
import { assets } from "./assets.svelte.js";
import { listSkillFiles, loadSkill } from "./skills.js";
import { userSkills } from "./userSkills.svelte.js";

const COMPOSITION_PATH = "/workbook/composition.html";
const ASSETS_LIST_PATH = "/workbook/assets/list.txt";
const SKILLS_DIR = "/workbook/skills";

let _bash = null;

function buildAssetsListing() {
  if (!assets.items.length) {
    return "(no assets imported · drop files into the Assets panel " +
           "or paste a URL to link external media)\n";
  }
  const lines = ["# imports listed below — reference in HTML via src=\"@hf-asset:<id>\""];
  for (const a of assets.items) {
    lines.push(`${a.id}\t${a.kind}\t${a.name}${a.duration ? `\t${a.duration}s` : ""}`);
  }
  return lines.join("\n") + "\n";
}

function buildSkillFiles() {
  const out = {};
  for (const key of listSkillFiles()) {
    const md = loadSkill(key);
    if (typeof md === "string") out[`${SKILLS_DIR}/${key}.md`] = md;
  }
  for (const us of userSkills.items) {
    out[`${SKILLS_DIR}/user/${us.name}.md`] = us.content;
  }
  return out;
}

function ensureBash() {
  if (_bash) return _bash;
  // Initial seed: current composition + asset listing + every skill
  // as its own file. Subsequent execs refresh composition.html in
  // place so Loro mutations are reflected without rebuilding the
  // shell.
  _bash = new Bash({
    cwd: "/workbook",
    files: {
      [COMPOSITION_PATH]: redactDataUrlsForAgent(composition.html),
      [ASSETS_LIST_PATH]: buildAssetsListing(),
      ...buildSkillFiles(),
    },
  });
  return _bash;
}

/**
 * Run a bash script against the workbook VFS. Returns { stdout,
 * stderr, exitCode } — same shape as just-bash's exec result, plus
 * a `summary` line the agent gets as the tool result.
 */
export async function runBash(script) {
  const bash = ensureBash();

  // Sync composition + assets BEFORE exec (composition may have
  // changed since the last call — user dragged a clip, dropped an
  // asset, etc.).
  await bash.fs.writeFile(COMPOSITION_PATH, redactDataUrlsForAgent(composition.html));
  await bash.fs.writeFile(ASSETS_LIST_PATH, buildAssetsListing());

  const result = await bash.exec(String(script ?? ""));

  // Read composition back. If the script changed it, commit through
  // composition.set. The redact/expand round-trip preserves asset
  // placeholders.
  let compositionChanged = false;
  try {
    const after = await bash.fs.readFile(COMPOSITION_PATH, "utf8");
    const before = redactDataUrlsForAgent(composition.html);
    if (after !== before) {
      composition.set(expandAssetPlaceholders(after));
      compositionChanged = true;
    }
  } catch {
    // composition.html was rm'd by the script — ignore; leave
    // composition store untouched. Agent will see exit code etc.
  }

  // Format the agent-visible result. just-bash's stdout/stderr are
  // already strings; we trim trailing newlines and prepend a status
  // line ONLY when the change was applied or the exit was non-zero
  // (so a successful read+inspect pass stays terse).
  const out = String(result.stdout ?? "").replace(/\n+$/, "");
  const err = String(result.stderr ?? "").replace(/\n+$/, "");
  const exit = Number(result.exitCode ?? 0);

  const lines = [];
  if (out) lines.push(out);
  if (err) lines.push(`stderr:\n${err}`);
  if (exit !== 0) lines.push(`exit ${exit}`);
  if (compositionChanged) {
    const n = composition.clips.length;
    const total = composition.totalDuration;
    lines.push(
      `(composition updated · ${n} clip${n === 1 ? "" : "s"} · ${total.toFixed(1)}s)`,
    );
  }
  return lines.join("\n") || "(no output)";
}
