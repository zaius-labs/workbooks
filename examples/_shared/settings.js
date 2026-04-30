/**
 * Reusable settings + API-key panel for showcase workbooks.
 *
 * Mount it once at boot with a list of keys the workbook needs:
 *
 *   import { mountSettings } from "../_shared/settings.js";
 *
 *   const settings = mountSettings({
 *     keys: [
 *       {
 *         id: "twelvedata",
 *         label: "Twelve Data API key",
 *         storageKey: "wb_stocks_td_apikey",
 *         signupUrl: "https://twelvedata.com/register",
 *         hint: "Free tier: 800 requests/day.",
 *         required: true,
 *       },
 *     ],
 *   });
 *
 *   const key = settings.get("twelvedata");
 *   settings.onChange((id, value) => { ... });
 *   settings.showBanner("API key needed.");
 *   settings.hideBanner();
 *   settings.flash("✓ saved");
 *
 * Renders a floating ⚙ button bottom-right + a panel above it. Banner
 * lives at a `data-settings-banner` mount the host can place anywhere
 * (or auto-mounts above <main> if not provided).
 */

import "./settings.css";

const DEFAULT_BANNER_MSG = "Set the API key to unlock live data.";

export function mountSettings({ keys = [] } = {}) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("mountSettings: provide at least one key descriptor");
  }
  for (const k of keys) {
    if (!k.id || !k.storageKey) {
      throw new Error(`mountSettings: each key needs { id, storageKey } (got ${JSON.stringify(k)})`);
    }
  }

  const listeners = new Set();
  const fire = (id, value) => {
    for (const fn of listeners) {
      try { fn(id, value); } catch (err) { console.error("settings listener", err); }
    }
  };

  function get(id) {
    const k = keys.find((x) => x.id === id);
    if (!k) return "";
    try { return localStorage.getItem(k.storageKey) || ""; } catch { return ""; }
  }
  function set(id, value) {
    const k = keys.find((x) => x.id === id);
    if (!k) return;
    try {
      if (value) localStorage.setItem(k.storageKey, value);
      else localStorage.removeItem(k.storageKey);
    } catch { /* ignore */ }
    fire(id, value);
  }
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function hasAllRequired() {
    return keys.filter((k) => k.required).every((k) => !!get(k.id));
  }

  /* ------------------------------- DOM -------------------------------- */

  const btn = document.createElement("button");
  btn.className = "wb-settings-btn";
  btn.setAttribute("aria-label", "Settings");
  btn.title = "Settings";
  btn.textContent = "⚙";
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.className = "wb-settings-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="wb-settings-head">
      <span class="wb-settings-title">Settings</span>
      <button class="wb-settings-close" aria-label="Close">×</button>
    </div>
    <div class="wb-settings-body"></div>
  `;
  document.body.appendChild(panel);

  const body = panel.querySelector(".wb-settings-body");
  const inputs = new Map();

  for (const k of keys) {
    const wrap = document.createElement("div");
    wrap.className = "wb-settings-field";
    wrap.innerHTML = `
      <div class="wb-settings-label">
        <span>${escapeHtml(k.label || k.id)}${k.required ? ` <em class="wb-settings-required">required</em>` : ""}</span>
        ${k.signupUrl ? `<a href="${escapeAttr(k.signupUrl)}" target="_blank" rel="noreferrer">get one free →</a>` : ""}
      </div>
      <div class="wb-settings-row">
        <input
          class="wb-settings-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="paste key">
        <button class="wb-settings-save">Save</button>
        <button class="wb-settings-clear-btn" title="clear stored key">×</button>
      </div>
      ${k.hint ? `<p class="wb-settings-hint">${escapeHtml(k.hint)}</p>` : ""}
      <p class="wb-settings-status"></p>
    `;
    body.appendChild(wrap);

    const input = wrap.querySelector(".wb-settings-input");
    const save = wrap.querySelector(".wb-settings-save");
    const clear = wrap.querySelector(".wb-settings-clear-btn");
    const status = wrap.querySelector(".wb-settings-status");
    input.value = get(k.id);
    inputs.set(k.id, { input, status });

    save.addEventListener("click", () => {
      const v = input.value.trim();
      set(k.id, v);
      flashStatus(status, v ? "✓ saved" : "key cleared", v ? false : true);
      if (hasAllRequired()) hideBanner();
    });

    clear.addEventListener("click", () => {
      input.value = "";
      set(k.id, "");
      flashStatus(status, "cleared", true);
      if (keys.find((x) => x.id === k.id)?.required) {
        showBanner(`${k.label || k.id} cleared.`);
      }
    });

    input.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") save.click();
    });
  }

  panel.querySelector(".wb-settings-close").addEventListener("click", () => {
    panel.hidden = true;
  });
  btn.addEventListener("click", open);

  /* ------------------------------ banner ------------------------------ */

  let banner = document.querySelector("[data-settings-banner]");
  if (!banner) {
    banner = document.createElement("div");
    banner.dataset.settingsBanner = "auto";
    banner.className = "wb-settings-banner";
    banner.hidden = true;
    const main = document.querySelector("main") ?? document.body.firstElementChild;
    if (main && main.parentNode) main.parentNode.insertBefore(banner, main);
    else document.body.prepend(banner);
  } else {
    banner.classList.add("wb-settings-banner");
    banner.hidden = true;
  }

  function showBanner(msg = DEFAULT_BANNER_MSG) {
    banner.innerHTML = `
      <strong>${escapeHtml(msg.split(".")[0] + (msg.includes(".") ? "." : ""))}</strong>
      <span>${escapeHtml(msg.split(".").slice(1).join(".").trim() || "Click ⚙ to set it.")}</span>
      <button class="wb-link-btn" data-banner-open>Open settings</button>
    `;
    banner.hidden = false;
    banner.querySelector("[data-banner-open]")?.addEventListener("click", open);
  }
  function hideBanner() {
    banner.hidden = true;
  }

  if (!hasAllRequired()) {
    showBanner(`${keys.find((k) => k.required && !get(k.id))?.label ?? "API key"} needed. Click ⚙ to set it.`);
  }

  function open(initialId) {
    panel.hidden = false;
    const target = initialId
      ? inputs.get(initialId)
      : inputs.get(keys.find((k) => k.required && !get(k.id))?.id) ?? inputs.values().next().value;
    target?.input?.focus();
  }

  function flashStatus(node, msg, isErr) {
    node.textContent = msg;
    node.classList.toggle("is-err", !!isErr);
    setTimeout(() => {
      if (node.textContent === msg) node.textContent = "";
    }, 2400);
  }

  function flash(id, msg, isErr) {
    const ref = inputs.get(id);
    if (!ref) return;
    flashStatus(ref.status, msg, isErr);
  }

  return { get, set, onChange, hasAllRequired, showBanner, hideBanner, open, flash };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
