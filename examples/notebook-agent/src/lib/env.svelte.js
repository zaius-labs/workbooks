// Env contract — varlock-style. Reads manifest.env from the embedded
// workbook-spec script tag; resolves values from window.WORKBOOK_ENV,
// then localStorage. Exposes a Svelte-reactive view so the UI can
// gate on "key set?" and update LLM clients on change.

const SLUG = "notebook-agent";

function envStorageKey(key) {
  return `wb.env.${SLUG}.${key}`;
}

function readManifestEnv() {
  if (typeof document === "undefined") return {};
  const el = document.getElementById("workbook-spec");
  if (!el) return {};
  try {
    const spec = JSON.parse(el.textContent || "{}");
    return spec?.manifest?.env ?? {};
  } catch { return {}; }
}

function getStored(key) {
  const injected = (typeof window !== "undefined" && window.WORKBOOK_ENV) || null;
  if (injected && typeof injected[key] === "string" && injected[key]) return injected[key];
  return localStorage.getItem(envStorageKey(key)) ?? "";
}

class EnvStore {
  decls = readManifestEnv();
  values = $state({});

  constructor() {
    for (const k of Object.keys(this.decls)) this.values[k] = getStored(k);
  }

  set(key, value) {
    const v = (value ?? "").trim();
    if (v) localStorage.setItem(envStorageKey(key), v);
    else localStorage.removeItem(envStorageKey(key));
    this.values[key] = v;
  }

  /** True when every required key has a value. */
  get satisfied() {
    for (const [k, decl] of Object.entries(this.decls)) {
      if (decl.required && !this.values[k]?.trim()) return false;
    }
    return true;
  }

  get openrouterKey() {
    return this.values.OPENROUTER_API_KEY ?? "";
  }
}

export const env = new EnvStore();
