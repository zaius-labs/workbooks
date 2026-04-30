// Plugin runtime — extensions for the studio.
//
// Distribution model: URL is how a plugin is INSTALLED and UPDATED;
// the bytes are EMBEDDED inline in the workbook on install. At runtime
// the plugin executes from the embedded bytes — no network required.
// Hitting "Update" re-fetches the URL and replaces the bytes.
//
// Trust: plugins run with full studio context — no sandboxing.
// Manifest declares permissions which we surface at install (visible
// to the user) but don't enforce yet.
//
// State persists in the workbook's <wb-doc> via a top-level Loro
// list "plugins". Share the .workbook.html file → recipient gets
// your plugins (code + config + on/off toggles).

import {
  bootstrapLoro,
  getDoc,
} from "./loroBackend.svelte.js";
import { createPluginApi, teardownPluginApi } from "./pluginApi.svelte.js";

const PLUGINS_LIST = "plugins";
const MAX_PLUGIN_BYTES = 5 * 1024 * 1024; // 5 MB single-plugin source cap

/**
 * Plugin record shape (JSON in the Loro list):
 *
 *   {
 *     id: "moonshine-stt",                 // from manifest.id
 *     name: "Moonshine STT",
 *     version: "0.1.0",
 *     description: "...",
 *     icon: "🎤",
 *     surfaces: ["chat-input"],
 *     permissions: ["network:huggingface.co"],
 *     source: { kind: "url-cached", url, code },  // bytes embedded
 *     installedAt: 1730404815000,
 *     updatedAt:   1730404815000,
 *     enabled: true,
 *     config: {},                          // author-stored settings
 *   }
 */

class PluginsStore {
  items = $state([]);
  hydrated = $state(false);
  busy = $state(false);
  // Active plugin instances keyed by id — { api, deactivate }.
  // Not persisted; rebuilt on every load from the list.
  _instances = new Map();

  constructor() {
    if (getDoc()) this._hydrateFromDoc();
    else {
      bootstrapLoro()
        .then(() => this._hydrateFromDoc())
        .catch(() => { this.hydrated = true; });
    }
  }

  _hydrateFromDoc() {
    const doc = getDoc();
    if (!doc) return;
    const list = doc.getList(PLUGINS_LIST);
    const out = [];
    for (const v of list.toArray()) {
      if (typeof v !== "string") continue;
      try { out.push(JSON.parse(v)); } catch { /* skip */ }
    }
    this.items = out;
    this.hydrated = true;

    // Auto-activate every enabled plugin on mount. Errors are
    // recorded on the record so the UI can surface them.
    for (const p of out) {
      if (p.enabled) this._activate(p).catch((e) => {
        console.warn(`plugin '${p.id}' failed to activate:`, e?.message ?? e);
      });
    }
  }

  // ── installation ────────────────────────────────────────────────

  /**
   * Install (or update) a plugin from a URL. Fetches, parses the
   * manifest from its default export, embeds the bytes in the
   * workbook, activates if the plugin is to be enabled.
   */
  async install(url, { enable = true } = {}) {
    const trimmed = String(url ?? "").trim();
    if (!trimmed) throw new Error("URL is empty");
    let parsed;
    try { parsed = new URL(trimmed); } catch { throw new Error(`'${trimmed}' isn't a valid URL`); }
    if (!/^https?:$/i.test(parsed.protocol)) {
      throw new Error(`URL protocol '${parsed.protocol}' isn't supported — use http(s).`);
    }

    this.busy = true;
    try {
      const r = await fetch(trimmed, { cache: "no-store" });
      if (!r.ok) throw new Error(`fetch failed: ${r.status} ${r.statusText}`);
      const code = await r.text();
      if (code.length > MAX_PLUGIN_BYTES) {
        throw new Error(
          `plugin source ${(code.length / 1024 / 1024).toFixed(1)} MB exceeds ` +
          `limit ${MAX_PLUGIN_BYTES / 1024 / 1024} MB`,
        );
      }

      // Probe the manifest by importing once. We need the manifest
      // BEFORE we commit to the install so we can dedupe by id and
      // surface permissions in the UI.
      const probe = await loadModuleFromCode(code);
      const manifest = probe?.manifest;
      if (!manifest || typeof manifest !== "object") {
        throw new Error("plugin must export a manifest object");
      }
      if (typeof manifest.id !== "string" || !manifest.id) {
        throw new Error("plugin manifest.id is required (string)");
      }
      if (typeof probe.onActivate !== "function") {
        throw new Error("plugin must export an onActivate(wb) function");
      }

      // If the same id is already installed, treat this as an UPDATE
      // — deactivate the running instance first, replace the record.
      const now = Date.now();
      const existingIdx = this.items.findIndex((p) => p.id === manifest.id);
      const enabled = existingIdx >= 0 ? this.items[existingIdx].enabled : enable;
      const config  = existingIdx >= 0 ? this.items[existingIdx].config  : {};
      const installedAt = existingIdx >= 0 ? this.items[existingIdx].installedAt : now;

      if (existingIdx >= 0) await this._deactivate(this.items[existingIdx].id);

      const record = {
        id: manifest.id,
        name: manifest.name ?? manifest.id,
        version: manifest.version ?? "0",
        description: manifest.description ?? "",
        icon: manifest.icon ?? null,
        surfaces: Array.isArray(manifest.surfaces) ? manifest.surfaces : [],
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        source: { kind: "url-cached", url: trimmed, code },
        installedAt,
        updatedAt: now,
        enabled,
        config,
      };

      const next = this.items.slice();
      if (existingIdx >= 0) next[existingIdx] = record;
      else next.push(record);
      this.items = next;
      await this._persist();

      if (enabled) await this._activate(record);
      return record;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Install (or update) a plugin from a code string. Same shape as
   * install(url) but the source is embedded directly — there's no
   * URL to update from later. Useful for dev iteration (paste a
   * local .js file) and for plugins that ship as part of a workbook
   * itself (the file already contains the code; no network needed).
   */
  async installFromCode(code, { sourceLabel, enable = true } = {}) {
    const text = String(code ?? "");
    if (!text.trim()) throw new Error("plugin source is empty");
    if (text.length > MAX_PLUGIN_BYTES) {
      throw new Error(
        `plugin source ${(text.length / 1024 / 1024).toFixed(1)} MB exceeds ` +
        `limit ${MAX_PLUGIN_BYTES / 1024 / 1024} MB`,
      );
    }

    this.busy = true;
    try {
      const probe = await loadModuleFromCode(text);
      const manifest = probe?.manifest;
      if (!manifest || typeof manifest !== "object") {
        throw new Error("plugin must export a manifest object");
      }
      if (typeof manifest.id !== "string" || !manifest.id) {
        throw new Error("plugin manifest.id is required (string)");
      }
      if (typeof probe.onActivate !== "function") {
        throw new Error("plugin must export an onActivate(wb) function");
      }

      const now = Date.now();
      const existingIdx = this.items.findIndex((p) => p.id === manifest.id);
      const enabled = existingIdx >= 0 ? this.items[existingIdx].enabled : enable;
      const config  = existingIdx >= 0 ? this.items[existingIdx].config  : {};
      const installedAt = existingIdx >= 0 ? this.items[existingIdx].installedAt : now;

      if (existingIdx >= 0) await this._deactivate(this.items[existingIdx].id);

      const record = {
        id: manifest.id,
        name: manifest.name ?? manifest.id,
        version: manifest.version ?? "0",
        description: manifest.description ?? "",
        icon: manifest.icon ?? null,
        surfaces: Array.isArray(manifest.surfaces) ? manifest.surfaces : [],
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        // Inline-installed plugins have no update URL — re-install
        // by uploading a fresh source file.
        source: { kind: "inline", code: text, label: sourceLabel ?? null },
        installedAt,
        updatedAt: now,
        enabled,
        config,
      };

      const next = this.items.slice();
      if (existingIdx >= 0) next[existingIdx] = record;
      else next.push(record);
      this.items = next;
      await this._persist();

      if (enabled) await this._activate(record);
      return record;
    } finally {
      this.busy = false;
    }
  }

  /** Re-fetch a plugin's source URL and replace the embedded bytes. */
  async update(id) {
    const record = this.items.find((p) => p.id === id);
    if (!record) throw new Error(`plugin not installed: ${id}`);
    if (record.source?.kind !== "url-cached" || !record.source.url) {
      throw new Error(`plugin '${id}' has no update URL (was installed inline?)`);
    }
    return this.install(record.source.url, { enable: record.enabled });
  }

  /** Remove a plugin. Deactivates first; persists the empty slot. */
  async remove(id) {
    await this._deactivate(id);
    this.items = this.items.filter((p) => p.id !== id);
    await this._persist();
  }

  /** Toggle enabled state. Activates / deactivates accordingly. */
  async setEnabled(id, enabled) {
    const idx = this.items.findIndex((p) => p.id === id);
    if (idx < 0) return;
    if (this.items[idx].enabled === enabled) return;
    const next = this.items.slice();
    next[idx] = { ...next[idx], enabled };
    this.items = next;
    await this._persist();
    if (enabled) await this._activate(next[idx]).catch((e) => {
      console.warn(`plugin '${id}' failed to activate:`, e?.message ?? e);
    });
    else await this._deactivate(id);
  }

  // ── activation ──────────────────────────────────────────────────

  async _activate(record) {
    if (this._instances.has(record.id)) return;
    if (!record.source?.code) throw new Error(`plugin '${record.id}' has no source code`);
    const mod = await loadModuleFromCode(record.source.code);
    if (typeof mod?.onActivate !== "function") {
      throw new Error(`plugin '${record.id}' has no onActivate function`);
    }
    const api = createPluginApi(record.id, this);
    await mod.onActivate(api);
    this._instances.set(record.id, { api, deactivate: mod.onDeactivate });
  }

  async _deactivate(id) {
    const inst = this._instances.get(id);
    if (!inst) return;
    try {
      if (typeof inst.deactivate === "function") {
        await inst.deactivate(inst.api);
      }
    } catch (e) {
      console.warn(`plugin '${id}' onDeactivate threw:`, e?.message ?? e);
    }
    teardownPluginApi(inst.api);
    this._instances.delete(id);
  }

  // ── plugin-scoped config ────────────────────────────────────────

  /** Get the per-plugin `config` blob (used by wb.storage). */
  getConfig(id) {
    return this.items.find((p) => p.id === id)?.config ?? {};
  }

  async setConfig(id, config) {
    const idx = this.items.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const next = this.items.slice();
    next[idx] = { ...next[idx], config };
    this.items = next;
    await this._persist();
  }

  // ── persistence ─────────────────────────────────────────────────

  async _persist() {
    await bootstrapLoro();
    const doc = getDoc();
    if (!doc) return;
    const list = doc.getList(PLUGINS_LIST);
    if (list.length > 0) list.delete(0, list.length);
    for (const p of this.items) list.push(JSON.stringify(p));
    doc.commit();
  }
}

// ── module loader ──────────────────────────────────────────────────
//
// Plugins are JS modules; we evaluate them in the studio's context
// via a Blob URL + dynamic import. The blob is revoked synchronously
// after import resolves (the module reference holds the lifetime).

async function loadModuleFromCode(code) {
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    return mod.default ?? mod;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const plugins = new PluginsStore();
