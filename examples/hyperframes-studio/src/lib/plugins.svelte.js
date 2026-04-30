// Plugin runtime — third-party extensions for the studio.
//
// A plugin is a JavaScript module with a default export that's
// a function taking the studio's plugin API:
//
//   export default function ({ registerAgentTool, log }) {
//     registerAgentTool({
//       definition: {
//         name: "weather",
//         description: "Get the weather for a city",
//         parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
//       },
//       invoke: async ({ city }) => `It's sunny in ${city}.`,
//     });
//     log("weather plugin ready");
//   }
//
// Distribution: any URL the user pastes — typically
// https://raw.githubusercontent.com/<org>/<repo>/<ref>/<path>.js,
// but anything reachable via fetch works. The studio fetches the
// JS, blob-imports it, calls the default export with the plugin API.
//
// Trust model: plugins run in the studio's context. Installing one
// is opt-in (user pastes a URL deliberately). v1 doesn't sandbox
// — caveat emptor. Future: a signed-plugins registry under
// zaius-labs/hyperframes-plugins with sha256-pinned manifests.
//
// Persistence: ephemeral for v1. Plugins re-install per session.
// Future: persist URLs in a Loro list so installed plugins
// auto-load when the .workbook.html opens elsewhere.

import { registerExtraTool } from "./agent.svelte.js";

class PluginsStore {
  // [{ url, name, description, version, installedAt }]
  installed = $state([]);
  busy = $state(false);

  /**
   * Install a plugin from a URL. Fetches, blob-imports, calls the
   * default export with the plugin API. The plugin's onLoad return
   * value (or its named exports) supplies metadata.
   */
  async install(url) {
    const trimmed = String(url ?? "").trim();
    if (!trimmed) throw new Error("URL is empty");
    let parsed;
    try { parsed = new URL(trimmed); } catch { throw new Error(`'${trimmed}' isn't a valid URL`); }
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error(`URL protocol '${parsed.protocol}' isn't supported — use http(s).`);
    }
    if (this.installed.some((p) => p.url === trimmed)) {
      throw new Error(`Already installed: ${trimmed}`);
    }

    this.busy = true;
    try {
      const r = await fetch(trimmed);
      if (!r.ok) throw new Error(`fetch failed: ${r.status} ${r.statusText}`);
      const code = await r.text();
      const blob = new Blob([code], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      let mod;
      try {
        mod = await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      const onLoad = mod.default;
      if (typeof onLoad !== "function") {
        throw new Error("plugin must have a default export (function)");
      }

      const meta = {};
      const api = {
        registerAgentTool: (tool) => registerExtraTool(tool),
        log: (msg) => console.log(`[plugin ${parsed.pathname}]`, msg),
        setMetadata: (m) => {
          if (m && typeof m === "object") Object.assign(meta, m);
        },
      };

      await onLoad(api);

      const entry = {
        url: trimmed,
        name: meta.name || parsed.pathname.split("/").pop() || "plugin",
        description: meta.description || "",
        version: meta.version || "0",
        installedAt: Date.now(),
      };
      this.installed = [...this.installed, entry];
      return entry;
    } finally {
      this.busy = false;
    }
  }

  /** Remove from the installed list. Doesn't unregister the plugin's
   *  side effects (agent tools etc.) — those live until reload.
   *  Reload to truly uninstall. */
  remove(url) {
    this.installed = this.installed.filter((p) => p.url !== url);
  }
}

export const plugins = new PluginsStore();
