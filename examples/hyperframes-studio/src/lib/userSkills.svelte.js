// User-uploaded skill registry — drag-and-drop markdown files the
// agent can load via `load_skill("user/<name>")`.
//
// Storage: a Loro list keyed "user-skills" inside the workbook's
// CRDT doc (see loroBackend.svelte.js). Round-trips through the
// .workbook.html file on Cmd+S. No browser cache.
//
// The agent's load_skill tool checks this registry alongside the
// vendored skills bundle (see skills.js). User skills are always
// prefixed `user/` to distinguish them from vendored ones.

import {
  bootstrapLoro,
  getDoc,
  readUserSkills,
  pushUserSkill,
  removeUserSkillByName,
} from "./loroBackend.svelte.js";

const MAX_SKILL_BYTES = 1 * 1024 * 1024; // 1 MB markdown file cap

class UserSkillsStore {
  // [{ name, content }]  where name is the unprefixed skill key
  // (e.g. "house-style") — the load_skill agent tool prefixes
  // "user/" automatically.
  items = $state([]);
  hydrated = $state(false);

  constructor() {
    if (getDoc()) {
      const stored = readUserSkills();
      if (stored.length > 0) this.items = stored;
      this.hydrated = true;
    } else {
      bootstrapLoro()
        .then(() => {
          const stored = readUserSkills();
          if (stored.length > 0) this.items = stored;
          this.hydrated = true;
        })
        .catch(() => { this.hydrated = true; });
    }
  }

  /** Add a skill from a markdown File object. The skill name is
   *  derived from the file name (stripped of .md) — must match
   *  /^[a-z0-9][a-z0-9_-]*$/ once normalized. */
  async addFromFile(file) {
    if (!file) throw new Error("no file");
    if (file.size > MAX_SKILL_BYTES) {
      throw new Error(`Skill too large (${(file.size / 1024).toFixed(1)} KB) — limit is 1 MB.`);
    }
    const text = await file.text();
    if (!text.trim()) throw new Error("Skill file is empty");

    const name = String(file.name)
      .replace(/\.md$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    if (!name) throw new Error("Couldn't derive a valid skill name from the file");

    if (this.items.some((s) => s.name === name)) {
      throw new Error(`A skill named '${name}' already exists. Remove it first or rename the file.`);
    }

    const skill = { name, content: text };
    this.items = [...this.items, skill];
    await pushUserSkill(skill);
    return skill;
  }

  async addFromText(name, content) {
    const trimmed = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!trimmed) throw new Error("name is required");
    if (this.items.some((s) => s.name === trimmed)) {
      throw new Error(`A skill named '${trimmed}' already exists.`);
    }
    const skill = { name: trimmed, content: String(content ?? "") };
    this.items = [...this.items, skill];
    await pushUserSkill(skill);
    return skill;
  }

  remove(name) {
    this.items = this.items.filter((s) => s.name !== name);
    removeUserSkillByName(name);
  }

  /** Lookup by unprefixed name. The skills.js loadSkill checks here
   *  before falling back to the vendored bundle. */
  get(name) {
    return this.items.find((s) => s.name === name) ?? null;
  }
}

export const userSkills = new UserSkillsStore();
