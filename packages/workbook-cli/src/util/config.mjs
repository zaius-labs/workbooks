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
  //   "presentation" — fixed-ratio slide deck with interactive HTML slides
  // Defaults to "spa" since it's the least opinionated.
  const VALID_TYPES = new Set(["document", "notebook", "spa", "presentation"]);
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

  // Source bundle — embed a gzipped JSON snapshot of the project source
  // inside the compiled .html so recipients can `workbook unbundle`.
  // On by default for unencrypted builds (W1.3 of the workbooks pivot
  // 2026-05-04). Authors with proprietary trees opt out via
  // `bundle: { enabled: false }`. `additionalIgnore` accepts gitignore-
  // lite patterns; `includeGit: true` ships the .git/ directory too.
  let bundle = { enabled: true, includeGit: false, additionalIgnore: [] };
  if (cfg.bundle !== undefined && cfg.bundle !== null) {
    if (cfg.bundle === false) {
      bundle = { enabled: false, includeGit: false, additionalIgnore: [] };
    } else if (typeof cfg.bundle === "object" && !Array.isArray(cfg.bundle)) {
      bundle = {
        enabled: cfg.bundle.enabled !== false,
        includeGit: cfg.bundle.includeGit === true,
        additionalIgnore: Array.isArray(cfg.bundle.additionalIgnore)
          ? cfg.bundle.additionalIgnore.slice()
          : [],
      };
      if (
        !bundle.additionalIgnore.every((p) => typeof p === "string" && p.length > 0)
      ) {
        throw new Error(
          "workbook.config: bundle.additionalIgnore must be an array of non-empty strings",
        );
      }
    } else {
      throw new Error(
        "workbook.config: 'bundle' must be a boolean or " +
          "{ enabled?, includeGit?, additionalIgnore? }",
      );
    }
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
    // Author + description surface on the hosted viewer's trust prompt
    // (workbooks.sh/w/<id>). Both optional; if absent the splash falls
    // back to slug-only display. Author is per-workbook so the same
    // account can publish under different display names.
    author: typeof cfg.author === "string" ? cfg.author.trim() : null,
    description:
      typeof cfg.description === "string" ? cfg.description.trim() : null,
    // Group env vars the workbook uses at runtime, e.g.
    //   connect: {
    //     OPENAI_KEY: { inject: "bearer", domains: ["api.openai.com"] }
    //   }
    // Distinct from the legacy `env` field below (daemon-era runtime
    // prompts). The workbook code calls
    //   wbFetch(url, { env: "OPENAI_KEY", ... })
    // and the broker proxy splices the group's stored value into the
    // outbound header IF the URL host matches the var's domains.
    // Plaintext never reaches the workbook.
    connect: extractConnectDeclarations(cfg.connect),
    // Tools the workbook advertises to MCP clients. Same shape as
    // an MCP tool definition — name, description, input_schema —
    // baked into manifest.tools[] at build time. Extracted here,
    // indexed by the broker, surfaced to agents via the workbooks
    // MCP server. No separate authoring file: declare them in
    // workbook.config.mjs > tools: { fn_name: { description, input } }
    // Public manifest entries (no handler paths — those stay internal).
    tools: extractToolDeclarations(cfg.tools).manifest,
    // Build-time only: handler path per tool. Used by the tools
    // Worker bundler at publish; not baked into the artifact.
    _toolHandlers: extractToolDeclarations(cfg.tools).handlers,
    // Optional distribution wrappers. Recipients consume the tools[]
    // surface through one of these packages. No new capability — the
    // HTTP /call surface always works regardless; package config
    // changes how the surface gets advertised to friendly clients.
    package: extractPackageDeclarations(cfg.package),
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
    bundle,                     // source-bundle settings; default enabled
  };
}

/**
 * Validate + normalize the `connect` block from workbook.config.mjs.
 * Returns a plain object that the build pipeline bakes into the
 * workbook manifest as `manifest.connect`.
 *
 * Shape:
 *   connect: {
 *     OPENAI_KEY: { inject: "bearer", domains: ["api.openai.com"] },
 *     STRIPE_KEY: { inject: "header:Stripe-Account", template: "{value}", domains: ["api.stripe.com"] },
 *   }
 *
 * Naming: keys are UPPER_SNAKE env-var-style identifiers, 1-64 chars.
 * Workbook code refers to them by name via `env: "OPENAI_KEY"` on
 * each proxy call.
 *
 * Inject directives:
 *   - "bearer"               → Authorization: Bearer <value> (or template)
 *   - "header:HeaderName"    → set that header to the template
 *   - "query:paramName"      → append/set query param
 *
 * Domains: array of host patterns. Same wildcard rules as
 * workbooksd's wb-secrets-policy: exact match, or "*.example.com"
 * for any subdomain. Empty → broker will reject every call.
 */
/**
 * Validate + normalize the `tools` block from workbook.config.mjs.
 *
 * Shape:
 *   tools: {
 *     forecast_revenue: {
 *       description: "Project Q3 revenue from Q1/Q2 actuals.",
 *       input_schema: { ... JSON Schema ... },
 *       output_schema: { ... JSON Schema ... },
 *     },
 *   }
 *
 * Tool names: lowercase + underscore (matches MCP tool naming
 * conventions). 1-64 chars. The author declares one entry per
 * function the workbook exposes for invocation; the runtime / agent
 * client looks them up by name.
 *
 * The tool's IMPLEMENTATION lives in workbook code — same author
 * writes the function and exports it; the build pipeline maps the
 * name from this declaration to an entry in the artifact. Today
 * we just bake the advertisement; #82 wires invocation.
 */
/** Returns { manifest, handlers } —
 *  - `manifest` is the public list baked into <script id="workbook-spec">
 *    (no handler paths — those are internal build-time data).
 *  - `handlers` maps tool name → file path so the build can locate
 *    the implementation and bundle it into the tools Worker. */
function extractToolDeclarations(raw) {
  const out = { manifest: [], handlers: {} };
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workbook.config: 'tools' must be an object keyed by tool name");
  }
  for (const [name, decl] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new Error(
        `workbook.config: tools[${JSON.stringify(name)}] must be snake_case [a-z][a-z0-9_]{0,63}`,
      );
    }
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      throw new Error(`workbook.config: tools[${name}] must be an object`);
    }
    const description =
      typeof decl.description === "string" ? decl.description.trim() : "";
    const input_schema = decl.input_schema ?? decl.input ?? null;
    const output_schema = decl.output_schema ?? decl.output ?? null;
    const handler = typeof decl.handler === "string" ? decl.handler : null;
    const runtime = decl.runtime === "browser" ? "browser" : "worker";

    out.manifest.push({
      name,
      ...(description ? { description } : {}),
      ...(input_schema ? { input_schema } : {}),
      ...(output_schema ? { output_schema } : {}),
      runtime,
    });
    if (handler && runtime === "worker") {
      // Only worker-runtime tools need a handler path — browser tools
      // are dispatched recipient-side via the workbook's own runtime.
      out.handlers[name] = handler;
    }
  }
  return out;
}

/** Validate the optional `package: { mcp, skill }` block. Keep this
 *  intentionally small — packaging just controls how we *announce*
 *  the workbook's tools, not what they are.
 *
 *   package: {
 *     mcp:   { enabled: true, name?: "my-workbook" },
 *     skill: { enabled: true, name?: "my-workbook", persona?: "..." },
 *   }
 *
 *  Defaults: mcp.enabled = true when any tool is declared; skill
 *  disabled by default (the author has to opt in because skill
 *  bundles ship persona text that should be intentional). */
function extractPackageDeclarations(raw) {
  const out = {
    mcp:   { enabled: false },
    skill: { enabled: false },
  };
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workbook.config: 'package' must be an object");
  }
  if (raw.mcp !== undefined) {
    if (raw.mcp === false) out.mcp = { enabled: false };
    else if (raw.mcp === true) out.mcp = { enabled: true };
    else if (typeof raw.mcp === "object" && !Array.isArray(raw.mcp)) {
      out.mcp = {
        enabled: raw.mcp.enabled !== false,
        ...(typeof raw.mcp.name === "string" ? { name: raw.mcp.name } : {}),
      };
    } else {
      throw new Error("workbook.config: package.mcp must be boolean or object");
    }
  }
  if (raw.skill !== undefined) {
    if (raw.skill === false) out.skill = { enabled: false };
    else if (raw.skill === true) out.skill = { enabled: true };
    else if (typeof raw.skill === "object" && !Array.isArray(raw.skill)) {
      out.skill = {
        enabled: raw.skill.enabled !== false,
        ...(typeof raw.skill.name === "string" ? { name: raw.skill.name } : {}),
        ...(typeof raw.skill.persona === "string"
          ? { persona: raw.skill.persona }
          : {}),
      };
    } else {
      throw new Error("workbook.config: package.skill must be boolean or object");
    }
  }
  return out;
}

function extractConnectDeclarations(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workbook.config: 'connect' must be an object keyed by env-var name");
  }
  const out = {};
  for (const [name, decl] of Object.entries(raw)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      throw new Error(
        `workbook.config: connect[${JSON.stringify(name)}] must be UPPER_SNAKE_CASE [A-Z][A-Z0-9_]{0,63}`,
      );
    }
    if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
      throw new Error(`workbook.config: connect[${name}] must be an object`);
    }
    const inject = decl.inject;
    if (typeof inject !== "string") {
      throw new Error(`workbook.config: connect[${name}].inject is required`);
    }
    if (
      inject !== "bearer" &&
      !/^header:[A-Za-z][A-Za-z0-9-]{0,64}$/.test(inject) &&
      !/^query:[A-Za-z][A-Za-z0-9_]{0,64}$/.test(inject)
    ) {
      throw new Error(
        `workbook.config: connect[${name}].inject must be 'bearer' | 'header:Name' | 'query:name'`,
      );
    }
    const domains = Array.isArray(decl.domains) ? decl.domains : [];
    if (
      domains.length === 0 ||
      !domains.every((d) => typeof d === "string" && d.length > 0)
    ) {
      throw new Error(
        `workbook.config: connect[${name}].domains must be a non-empty array of host patterns`,
      );
    }
    const template =
      typeof decl.template === "string" && decl.template.length > 0
        ? decl.template
        : "{value}";
    out[name] = { inject, domains, template };
  }
  return out;
}
