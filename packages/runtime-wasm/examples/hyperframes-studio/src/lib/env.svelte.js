// Env contract — varlock-style. Reads manifest.env from the embedded
// workbook-spec script tag; resolves values from window.WORKBOOK_ENV,
// then localStorage. Exposes a Svelte-reactive view so the UI can
// gate on "key set?" and update LLM clients on change.

const SLUG = "hyperframes-studio";

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

// Suggestions in the model field — surfaced via <datalist>.
// The field is free-text; users can type any OpenRouter model id
// (e.g. `mistralai/mistral-large-2412` or anything else routed
// through openrouter.ai) and the agent loop just forwards it.
export const MODEL_PRESETS = [
  { id: "anthropic/claude-haiku-4.5",  label: "Claude Haiku 4.5 (default)" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "anthropic/claude-opus-4.7",   label: "Claude Opus 4.7" },
  { id: "openai/gpt-5.1",              label: "GPT-5.1" },
  { id: "google/gemini-3.5-pro",       label: "Gemini 3.5 Pro" },
  { id: "minimax/minimax-m2.7",        label: "MiniMax M2.7" },
];
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

class EnvStore {
  decls = readManifestEnv();
  values = $state({});
  model  = $state(DEFAULT_MODEL);

  constructor() {
    // Default declaration if the manifest didn't provide one (dev mode).
    if (!this.decls.OPENROUTER_API_KEY) {
      this.decls.OPENROUTER_API_KEY = { required: true, secret: true };
    }
    for (const k of Object.keys(this.decls)) this.values[k] = getStored(k);
    const stored = localStorage.getItem(envStorageKey("MODEL"));
    if (stored) this.model = stored;
  }

  set(key, value) {
    const v = (value ?? "").trim();
    if (v) localStorage.setItem(envStorageKey(key), v);
    else localStorage.removeItem(envStorageKey(key));
    this.values[key] = v;
  }

  setModel(id) {
    const v = (id ?? "").trim() || DEFAULT_MODEL;
    this.model = v;
    localStorage.setItem(envStorageKey("MODEL"), v);
  }

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
