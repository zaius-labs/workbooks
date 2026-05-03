// Workbook config loader. Looks for workbook.config.{js,mjs} in the
// project root, validates required fields, applies defaults.
//
// A minimal config:
//
//   export default {
//     name: "my workbook",
//     slug: "my-workbook",
//     entry: "src/index.html",
//   };
//
// Extended:
//
//   export default {
//     name: "my workbook",
//     slug: "my-workbook",
//     entry: "src/index.html",
//     env: {
//       OPENROUTER_API_KEY: { required: true, secret: true, prompt: "sk-or-…" },
//     },
//     runtimeFeatures: ["polars", "rhai", "charts"],  // hint only, not enforced
//     vite: { /* extra Vite config merged in */ },
//   };

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CANDIDATES = ["workbook.config.mjs", "workbook.config.js"];

export async function loadConfig(projectDir) {
  const root = path.resolve(projectDir);
  let configPath = null;
  for (const c of CANDIDATES) {
    const p = path.join(root, c);
    try { await fs.access(p); configPath = p; break; } catch {}
  }
  if (!configPath) {
    throw new Error(
      `no workbook.config.{js,mjs} found in ${root}.\n` +
      `Create one with at minimum: { name, slug, entry }.`,
    );
  }

  const mod = await import(pathToFileURL(configPath).href);
  const cfg = mod.default ?? mod;
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`${configPath} did not export a config object (use 'export default {...}')`);
  }

  if (!cfg.slug || typeof cfg.slug !== "string") {
    throw new Error(`workbook.config: 'slug' is required (string, kebab-case)`);
  }
  if (!cfg.entry || typeof cfg.entry !== "string") {
    throw new Error(`workbook.config: 'entry' is required (path to entry HTML file, relative to project root)`);
  }
  const entryAbs = path.resolve(root, cfg.entry);
  try { await fs.access(entryAbs); } catch {
    throw new Error(`workbook.config: entry not found: ${cfg.entry} (resolved to ${entryAbs})`);
  }

  // Workbook type — canonical rendering profile. Must be one of:
  //   "document" — sdoc-style read-mostly artifact (prose + auto-rendered blocks)
  //   "notebook" — Jupyter-style linear runner with cells + reactive DAG
  //   "spa"      — full canvas app (chat-app, svelte-app); author renders custom UI
  // Defaults to "spa" since it's the least opinionated.
  const VALID_TYPES = new Set(["document", "notebook", "spa"]);
  const type = cfg.type ?? "spa";
  if (!VALID_TYPES.has(type)) {
    throw new Error(`workbook.config: 'type' must be one of: ${[...VALID_TYPES].join(", ")} (got '${type}')`);
  }

  // Icons — accept short form (single string path) or long form (array of
  // { src, sizes?, type? }). Normalize to the long form. If neither is
  // provided, the build plugin substitutes a default workbook glyph so
  // every saved .html has a recognizable browser-tab icon.
  let icons = null;
  if (typeof cfg.icon === "string" && cfg.icon) {
    icons = [{ src: cfg.icon }];
  } else if (Array.isArray(cfg.icons)) {
    icons = cfg.icons.map((entry, i) => {
      if (typeof entry === "string") return { src: entry };
      if (entry && typeof entry === "object" && typeof entry.src === "string") {
        return { src: entry.src, sizes: entry.sizes, type: entry.type };
      }
      throw new Error(
        `workbook.config: icons[${i}] must be a string path or { src, sizes?, type? }`,
      );
    });
  }
  if (icons) {
    for (const icon of icons) {
      const abs = path.resolve(root, icon.src);
      try { await fs.access(abs); }
      catch { throw new Error(`workbook.config: icon not found: ${icon.src} (resolved to ${abs})`); }
    }
  }

  // Encryption — optional. Configures the CLI's --encrypt build stage.
  // Build flags override any of these. Shape:
  //
  //   encrypt: {
  //     method: "passphrase",        // v1 supports passphrase only
  //     scope: "full",               // v1 ships "full" (user mode in P3.x)
  //     passwordEnv: "WORKBOOK_PASSWORD",  // env var to read at build
  //     devPassword: "dev-fixture",  // used by `workbook dev --encrypt`
  //   }
  //
  // Validation here catches typos / wrong types early; the actual
  // encrypt stage in build.mjs handles missing env vars at runtime.
  const VALID_METHODS = new Set(["passphrase"]); // multi-unlock in P3.x
  const VALID_SCOPES = new Set(["full"]);        // user-scope in P3.x
  let encrypt = null;
  if (cfg.encrypt !== undefined && cfg.encrypt !== null) {
    if (typeof cfg.encrypt !== "object" || Array.isArray(cfg.encrypt)) {
      throw new Error(
        `workbook.config: 'encrypt' must be an object (or omitted)`,
      );
    }
    const method = cfg.encrypt.method ?? "passphrase";
    if (!VALID_METHODS.has(method)) {
      throw new Error(
        `workbook.config: encrypt.method must be one of: ${[...VALID_METHODS].join(", ")} (got '${method}')`,
      );
    }
    const scope = cfg.encrypt.scope ?? "full";
    if (!VALID_SCOPES.has(scope)) {
      throw new Error(
        `workbook.config: encrypt.scope must be one of: ${[...VALID_SCOPES].join(", ")} (got '${scope}')`,
      );
    }
    encrypt = {
      method,
      scope,
      passwordEnv: cfg.encrypt.passwordEnv ?? "WORKBOOK_PASSWORD",
      devPassword: cfg.encrypt.devPassword ?? null,
    };
  }

  // Save-on-Cmd+S — author-controlled state envelope, on by default.
  // Authors override the state via window.serializeWorkbookState /
  // window.rehydrateWorkbookState in their main.js. Disable entirely
  // by setting save.enabled = false (e.g. a chess SPA that has no
  // meaningful state to persist beyond the move list, which it
  // already syncs over WebRTC).
  let save = { enabled: true };
  if (cfg.save !== undefined) {
    if (cfg.save === false || cfg.save === null) {
      save = { enabled: false };
    } else if (typeof cfg.save === "object" && !Array.isArray(cfg.save)) {
      save = { enabled: cfg.save.enabled !== false };
    } else {
      throw new Error(
        `workbook.config: 'save' must be a boolean or { enabled?: boolean }`,
      );
    }
  }

  // Permissions — declared by the workbook author, surfaced to the
  // user as a one-time approval dialog the first time the daemon
  // serves the file. Each entry needs a `reason` string explaining
  // WHY the workbook needs the capability; the dialog quotes that
  // string verbatim so users see plain English, not jargon.
  //
  // Recognized ids:
  //   agents   — open ACP sessions to Claude Code / Codex / etc.
  //   autosave — write-back to the .html file as the user
  //              edits (default behavior on for save-capable apps,
  //              but still declared so the dialog explains it)
  //   secrets  — store + use API keys via the keychain proxy
  //   network  — make HTTPS calls (already host-allowlisted by the
  //              `secrets` declaration below)
  //
  // Workbooks that don't declare permissions get a transparent-
  // pass — the daemon doesn't gate anything. Declaring permissions
  // is opt-in; once you do, the daemon enforces (today: agents
  // gate; future phases extend to the rest).
  const permissions = {};
  if (cfg.permissions !== undefined && cfg.permissions !== null) {
    if (typeof cfg.permissions !== "object" || Array.isArray(cfg.permissions)) {
      throw new Error("workbook.config: 'permissions' must be an object");
    }
    const KNOWN = new Set(["agents", "autosave", "secrets", "network"]);
    for (const [id, decl] of Object.entries(cfg.permissions)) {
      if (!KNOWN.has(id)) {
        throw new Error(
          `workbook.config: unknown permission id ${JSON.stringify(id)} ` +
          `(known: ${[...KNOWN].join(", ")})`,
        );
      }
      const reason = (decl && typeof decl === "object" && typeof decl.reason === "string")
        ? decl.reason
        : null;
      if (!reason) {
        throw new Error(
          `workbook.config: permissions.${id} requires a 'reason: string' ` +
          `explaining why this capability is needed (shown to the user).`,
        );
      }
      permissions[id] = { reason };
    }
  }

  // Install-prompt copy — coarse author override of the SDK's
  // FEATURE_CATALOG. Whatever the author puts here gets baked into
  // a `<script id="wb-install-prompts" type="application/json">`
  // block; the runtime calls `registerFeatures(...)` at startup so
  // the install wall (any variant) shows their copy instead of the
  // generic catalog default.
  //
  //   installPrompts: {
  //     agents: {
  //       title: "Bring your own LLM",
  //       reason: "colorwave's chat is great, but Claude Code or " +
  //               "Codex CLI gives you a real co-edit loop.",
  //     },
  //   }
  //
  // Keys map to feature ids the SDK's `gateFeature` / `requireBinding`
  // uses (agents / autosave / secrets / network / acp / daemon).
  // Authors only need to override the features they actually use —
  // unspecified keys keep the catalog default.
  const installPrompts = {};
  if (cfg.installPrompts !== undefined && cfg.installPrompts !== null) {
    if (typeof cfg.installPrompts !== "object" || Array.isArray(cfg.installPrompts)) {
      throw new Error("workbook.config: 'installPrompts' must be an object");
    }
    for (const [feature, copy] of Object.entries(cfg.installPrompts)) {
      if (!copy || typeof copy !== "object") {
        throw new Error(
          `workbook.config: installPrompts.${feature} must be an object`,
        );
      }
      const out = {};
      if (copy.title !== undefined) {
        if (typeof copy.title !== "string" || !copy.title.trim()) {
          throw new Error(
            `workbook.config: installPrompts.${feature}.title must be a non-empty string`,
          );
        }
        out.title = copy.title.trim();
      }
      if (copy.reason !== undefined) {
        if (typeof copy.reason !== "string" || !copy.reason.trim()) {
          throw new Error(
            `workbook.config: installPrompts.${feature}.reason must be a non-empty string`,
          );
        }
        out.reason = copy.reason.trim();
      }
      if (Object.keys(out).length === 0) {
        throw new Error(
          `workbook.config: installPrompts.${feature} must specify title and/or reason`,
        );
      }
      installPrompts[feature] = out;
    }
  }

  // Wasm variant — picks which pre-built slice of runtime-wasm to
  // inline. SPA-shape workbooks save megabytes by opting into a
  // smaller variant; data-app workbooks (sql/ML) need the default.
  // See packages/workbook-cli/src/util/runtime.mjs `variantToPkgDir`.
  const VALID_WASM_VARIANTS = new Set(["default", "minimal", "app"]);
  const wasmVariant = cfg.wasmVariant ?? "default";
  if (!VALID_WASM_VARIANTS.has(wasmVariant)) {
    throw new Error(
      `workbook.config: 'wasmVariant' must be one of: ${[...VALID_WASM_VARIANTS].join(", ")} (got '${wasmVariant}')`,
    );
  }
  // Variant-coverage check is on by default — warns at build time
  // when the chosen variant doesn't ship a symbol the bundle
  // references. Workbooks that intentionally feature-detect against
  // optional surfaces (e.g. `if (wasm.arrowEncodeJsonRows) { ... }`)
  // can opt out with `wasmVariantCheck: false` to silence.
  const wasmVariantCheck = cfg.wasmVariantCheck !== false;

  // Secrets policy — declares which integration keys the workbook
  // uses and which HTTPS hosts each one is allowed to be sent to.
  // Baked into the workbook-spec script at build time and enforced
  // at runtime by workbooksd's /proxy endpoint. Secrets without a
  // declaration here are still set/usable but accept any HTTPS
  // host (legacy mode); declaring a domain list locks the secret
  // to those hosts and refuses everything else.
  //
  //   secrets: {
  //     FAL_API_KEY:       { domains: ["fal.run", "*.fal.run"] },
  //     ELEVENLABS_API_KEY:{ domains: ["api.elevenlabs.io"] },
  //   }
  const secrets = {};
  if (cfg.secrets !== undefined && cfg.secrets !== null) {
    if (typeof cfg.secrets !== "object" || Array.isArray(cfg.secrets)) {
      throw new Error("workbook.config: 'secrets' must be an object keyed by secret id");
    }
    for (const [id, decl] of Object.entries(cfg.secrets)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        throw new Error(`workbook.config: secret id ${JSON.stringify(id)} must match [A-Za-z0-9_-]{1,64}`);
      }
      const domains = Array.isArray(decl?.domains) ? decl.domains : [];
      if (!domains.every((d) => typeof d === "string" && d.length > 0)) {
        throw new Error(`workbook.config: secrets[${id}].domains must be an array of non-empty strings`);
      }
      secrets[id] = { domains };
    }
  }

  return {
    root,
    configPath,
    name: cfg.name ?? cfg.slug,
    slug: cfg.slug,
    type,
    version: cfg.version ?? "0.1",
    entry: cfg.entry,
    entryAbs,
    env: cfg.env ?? {},
    icons,                      // null means "use the default workbook glyph"
    runtimeFeatures: cfg.runtimeFeatures ?? [],
    wasmVariant,
    wasmVariantCheck,
    secrets,
    permissions,
    installPrompts,
    vite: cfg.vite ?? {},
    // Inline assets unless explicitly disabled; --no-wasm flag flips this.
    inlineRuntime: cfg.inlineRuntime ?? true,
    encrypt,                    // null when not configured
    save,                       // { enabled: true } default
  };
}
