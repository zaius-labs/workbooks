// wb.* — the plugin-facing SDK surface.
//
// Stable across plugin versions. Each namespace tracks every
// registration the plugin makes so onDeactivate (or remove) can
// auto-undo without the plugin author writing teardown logic.
//
// This file is the WIRE between plugin code and the studio's
// internal stores. Plugins should never reach past `wb.*` to
// import internals directly.
//
// P1 ships skeletons + storage + agent (the existing extension
// point). P2 fills in chat / panels / settings / timeline /
// composition / runtime.

import { registerExtraTool, unregisterExtraTool } from "./agent.svelte.js";

/**
 * @typedef {Object} PluginApi  the wb.* surface
 * @property {string} pluginId
 * @property {Storage} storage     plugin-scoped persistent state
 * @property {AgentApi} agent
 * @property {ChatApi} chat
 * @property {PanelsApi} panels
 * @property {SettingsApi} settings
 * @property {TimelineApi} timeline
 * @property {CompositionApi} composition
 * @property {(msg: string) => void} log
 *
 * @typedef {Object} Storage
 * @property {<T>(k: string) => T | undefined} get
 * @property {<T>(k: string, v: T) => Promise<void>} set
 * @property {(k: string) => Promise<void>} delete
 * @property {() => string[]} keys
 */

// ── per-instance teardown registry ─────────────────────────────────
// Each api instance has a Set of teardown closures; surfaces register
// theirs here at registration time. teardownPluginApi runs them all.

const teardowns = new WeakMap();

function track(api, fn) {
  let set = teardowns.get(api);
  if (!set) {
    set = new Set();
    teardowns.set(api, set);
  }
  set.add(fn);
  return () => set.delete(fn);
}

export function teardownPluginApi(api) {
  const set = teardowns.get(api);
  if (!set) return;
  for (const fn of set) {
    try { fn(); } catch (e) { console.warn("plugin teardown error:", e); }
  }
  set.clear();
  teardowns.delete(api);
}

// ── shared registries — surfaces feed into these stores ───────────
// P2 wires UI components against these reactive arrays. Components
// that own a runtime affordance (e.g. ChatPanel owns the textarea
// state) register a controller via the `controllers` map so the
// plugin API can drive them without each plugin holding direct refs.

export const chatInputActions = $state([]);
export const panelTabs = $state([]);
export const settingsSections = $state([]);
export const timelineClipActions = $state([]);
export const compositionDecorators = $state([]);
export const chatSendHooks = $state([]);

/**
 * Component-supplied controllers for runtime affordances.
 *
 *   chat: { setInput(text), getInput(), getThread() }
 *
 * Components register on mount, clear on unmount. Plugin API
 * reads the controllers when invoked. Module-level singletons
 * because there's only ever one of each (one chat, one timeline)
 * in a single mounted studio.
 */
const controllers = {
  chat: null,
};

export function registerChatController(c) {
  controllers.chat = c;
  return () => { if (controllers.chat === c) controllers.chat = null; };
}

function appendAndTrack(api, list, item) {
  list.push(item);
  track(api, () => {
    const idx = list.findIndex((x) => x === item);
    if (idx >= 0) list.splice(idx, 1);
  });
}

// ── per-plugin storage backed by the plugin record's `config` ──────
// Storage state lives in the workbook's wb-doc via plugins.setConfig
// (which is the same Loro list that holds installed plugins). So a
// plugin's storage round-trips through the file on Cmd+S, no IDB.

function makeStorage(pluginId, store) {
  return {
    get(key) {
      return store.getConfig(pluginId)?.[key];
    },
    async set(key, value) {
      const next = { ...store.getConfig(pluginId), [key]: value };
      await store.setConfig(pluginId, next);
    },
    async delete(key) {
      const cfg = { ...store.getConfig(pluginId) };
      delete cfg[key];
      await store.setConfig(pluginId, cfg);
    },
    keys() {
      return Object.keys(store.getConfig(pluginId) ?? {});
    },
  };
}

// ── factory — called once per plugin activation ───────────────────

/**
 * Build a `wb` instance for a given plugin id. Every registration
 * the plugin makes through this api is tracked so teardownPluginApi
 * can undo them on deactivate.
 */
export function createPluginApi(pluginId, store) {
  const api = { pluginId };

  // ── wb.log ─────────────────────────────────────────────────────
  api.log = (msg) => {
    console.log(`[plugin ${pluginId}]`, msg);
  };

  // ── wb.storage ─────────────────────────────────────────────────
  api.storage = makeStorage(pluginId, store);

  // ── wb.agent ───────────────────────────────────────────────────
  api.agent = {
    registerTool(tool) {
      if (!tool?.definition?.name) {
        throw new Error("wb.agent.registerTool: tool.definition.name is required");
      }
      registerExtraTool(tool);
      track(api, () => unregisterExtraTool(tool.definition.name));
    },
  };

  // ── wb.chat ────────────────────────────────────────────────────
  api.chat = {
    /** Add a button next to the chat textarea. */
    addInputAction({ icon, label, shortcut, onClick }) {
      if (typeof onClick !== "function") {
        throw new Error("wb.chat.addInputAction: onClick is required");
      }
      const item = { pluginId, icon, label, shortcut, onClick };
      appendAndTrack(api, chatInputActions, item);
    },
    /** Fired before a user message is sent — return a (possibly
     *  modified) string, or null to abort. */
    onSend(fn) {
      if (typeof fn !== "function") return;
      const hook = { pluginId, fn };
      appendAndTrack(api, chatSendHooks, hook);
    },
    /** Programmatically set the chat textarea value. */
    setInput(text) {
      controllers.chat?.setInput(String(text ?? ""));
    },
    /** Read the current input value. */
    getInput() {
      return controllers.chat?.getInput() ?? "";
    },
    /** Read the current thread (read-only snapshot). */
    getThread() {
      return controllers.chat?.getThread() ?? [];
    },
  };

  // ── wb.panels ──────────────────────────────────────────────────
  api.panels = {
    /** Add a tab to the left panel. component is a Svelte component. */
    addTab({ id, label, icon, component }) {
      if (!id || !component) {
        throw new Error("wb.panels.addTab: id + component are required");
      }
      const item = { pluginId, id, label: label ?? id, icon, component };
      appendAndTrack(api, panelTabs, item);
    },
  };

  // ── wb.settings ────────────────────────────────────────────────
  api.settings = {
    /** Add a section to the Settings modal. */
    addSection({ label, component }) {
      if (!component) {
        throw new Error("wb.settings.addSection: component is required");
      }
      const item = { pluginId, label: label ?? pluginId, component };
      appendAndTrack(api, settingsSections, item);
    },
  };

  // ── wb.timeline ────────────────────────────────────────────────
  api.timeline = {
    addClipAction({ icon, label, when, onClick }) {
      if (typeof onClick !== "function") {
        throw new Error("wb.timeline.addClipAction: onClick is required");
      }
      const item = { pluginId, icon, label, when, onClick };
      appendAndTrack(api, timelineClipActions, item);
    },
    onClipSelect(_fn) {
      // TODO P2.
      console.warn("wb.timeline.onClipSelect: stub (P2)");
    },
  };

  // ── wb.composition ─────────────────────────────────────────────
  api.composition = {
    /** Read the current composition HTML. */
    read() {
      // TODO P2: import composition store; return current html.
      return "";
    },
    /** Subscribe to composition changes. */
    subscribe(_fn) {
      // TODO P2.
      console.warn("wb.composition.subscribe: stub (P2)");
    },
    /** Register a decorator that transforms composition HTML before
     *  the iframe renders it. Decorators run in registration order. */
    addRenderDecorator({ priority, transform }) {
      if (typeof transform !== "function") {
        throw new Error("wb.composition.addRenderDecorator: transform is required");
      }
      const item = { pluginId, priority: priority ?? 0, transform };
      appendAndTrack(api, compositionDecorators, item);
      compositionDecorators.sort((a, b) => a.priority - b.priority);
    },
  };

  return api;
}
