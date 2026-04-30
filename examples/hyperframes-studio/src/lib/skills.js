// Vendored HyperFrames skills bundle.
//
// Copied from `node_modules/hyperframes/dist/skills/` (upstream
// repo: heygen-com/hyperframes). 40 markdown files, ~292 KB raw,
// keyed by path for on-demand load by the chat agent. Vite's
// import.meta.glob with `query: "?raw"` reads each .md file at
// build time and inlines the string content into the bundle, so
// the workbook stays self-contained — no network fetch at load.
//
// We keep the upstream directory shape (hyperframes/, gsap/,
// hyperframes-cli/, plus references/ and palettes/ subfolders)
// so anyone familiar with HyperFrames-the-package finds the same
// paths here.
//
// Refresh path: re-run `cp -R node_modules/hyperframes/dist/skills
// /. src/skills/` after upstream ships a new release.

const skillFiles = import.meta.glob("../skills/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

function parseFrontmatter(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: String(md) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    meta[k] = v;
  }
  return { meta, body: String(md).slice(m[0].length) };
}

// Index every file under a normalized key. "hyperframes/SKILL.md"
// becomes "hyperframes/SKILL"; "hyperframes/references/captions.md"
// becomes "hyperframes/references/captions".
const files = {};
for (const [path, content] of Object.entries(skillFiles)) {
  const key = path.replace(/^.*\/skills\//, "").replace(/\.md$/, "");
  files[key] = String(content);
}

// One Skill per top-level directory whose SKILL.md exists.
function buildSkills() {
  const out = [];
  for (const [key, content] of Object.entries(files)) {
    if (!key.endsWith("/SKILL")) continue;
    const skillKey = key.slice(0, -"/SKILL".length);
    const { meta } = parseFrontmatter(content);
    const fileList = Object.keys(files)
      .filter((k) => k === skillKey + "/SKILL" || k.startsWith(skillKey + "/"))
      .sort();
    out.push({
      key: skillKey,
      name: meta.name || skillKey,
      description: meta.description || "",
      files: fileList,
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

const skills = buildSkills();

/** Get the registered skills with their summary metadata. */
export function listSkills() {
  return skills;
}

import { userSkills } from "./userSkills.svelte.js";

/** Load a skill file by normalized path. Accepts:
 *    - the skill key alone (loads its SKILL.md): "hyperframes"
 *    - explicit SKILL: "hyperframes/SKILL"
 *    - a sub-document path: "hyperframes/references/captions"
 *    - a user-uploaded skill: "user/<name>"
 *  Returns the raw markdown string, or null if not found. */
export function loadSkill(path) {
  if (typeof path !== "string" || !path) return null;
  const norm = path.replace(/\.md$/, "").replace(/^\/+|\/+$/g, "");
  if (norm.startsWith("user/")) {
    const found = userSkills.get(norm.slice("user/".length));
    return found ? found.content : null;
  }
  if (files[norm]) return files[norm];
  if (files[norm + "/SKILL"]) return files[norm + "/SKILL"];
  return null;
}

/** All registered file keys — useful for fuzzy-search support. */
export function listSkillFiles() {
  return Object.keys(files).sort();
}

/** Format the skill frontmatter as a system-prompt block. Mirrors
 *  the Anthropic Skills / Pi-core convention of progressive
 *  disclosure: every skill's name + description is always in the
 *  prompt (cheap), the body is only loaded when the agent decides
 *  it's relevant via load_skill('<key>'). */
export function skillsPromptBlock() {
  const lines = skills.map((s) => `- ${s.key}: ${s.description}`);
  // Also surface user-uploaded skills so the agent knows it can
  // call load_skill('user/<name>') for them.
  for (const us of userSkills.items) {
    const description = (us.content.match(/^#+\s+(.+)/m)?.[1] ?? "user-provided skill").trim();
    lines.push(`- user/${us.name}: ${description}`);
  }
  if (!lines.length) return "";
  return [
    "",
    "Available skills (call load_skill('<key>') to read; sub-paths like 'hyperframes/references/captions' work too; user-provided skills are prefixed 'user/'):",
    ...lines,
  ].join("\n");
}
