/**
 * OpenRouter model catalog (Phase W4 enhancement).
 *
 * Fetches `https://openrouter.ai/api/v1/models` (no auth required) and
 * exposes a reactive `OpenRouterCatalog` instance. Cached in
 * localStorage for 24h so a returning user sees the model list
 * instantly while we refresh in the background.
 *
 * The ModelPicker uses this when no explicit `models` prop is passed —
 * authors get the live OpenRouter catalog by default, with the
 * STARTER_MODELS hardcoded list as the offline fallback.
 *
 * Lifted from colorwave (`showcase/color.wave/src/lib/modelCatalog.svelte.js`)
 * with the daemon-proxy path removed since the workbooks pivot retired
 * the daemon as primary. Direct fetch only — when the workbook lives
 * behind a CSP that blocks openrouter.ai, the picker quietly degrades
 * to the offline list.
 */

const CACHE_KEY = "wb.openrouterModels.v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000; // 5min — prevents re-render retry loops
const ENDPOINT = "https://openrouter.ai/api/v1/models";

export interface CatalogModel {
  /** Full OpenRouter id, e.g. "anthropic/claude-3.5-sonnet". */
  id: string;
  /** Display name (provider + family). */
  name: string;
  /** Slash-prefix of the id ("anthropic", "openai", …). */
  provider: string;
  contextLength: number | null;
  /** OpenRouter's pricing object, opaque shape. Useful for sorting / display. */
  pricing: Record<string, unknown> | null;
  /** Derived icon URL — favicon of the lab's homepage via Google's S2
   *  service, so we get a recognizable provider mark without bundling
   *  icon assets. null for providers we don't know about. */
  iconUrl: string | null;
}

/**
 * Recommended models surfaced when the search modal opens with no
 * query. A focused cross-section: the labs most users reach for, at
 * sane price points across the latency/quality spectrum. The picker
 * still searches everything once the user types.
 */
export const RECOMMENDED_MODEL_IDS: readonly string[] = [
  "anthropic/claude-sonnet-4",
  "anthropic/claude-3.5-haiku",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
  "google/gemini-1.5-pro",
  "deepseek/deepseek-chat",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-large",
  "x-ai/grok-2-latest",
];

/** Prefix → favicon source. Domain choice prioritises the lab's
 *  canonical homepage so favicons stay recognizable. */
const PROVIDER_DOMAIN: Record<string, string> = {
  anthropic: "anthropic.com",
  openai: "openai.com",
  google: "google.com",
  "google-vertex": "google.com",
  mistralai: "mistral.ai",
  "meta-llama": "meta.com",
  meta: "meta.com",
  microsoft: "microsoft.com",
  qwen: "qwen.ai",
  minimax: "minimax.io",
  deepseek: "deepseek.com",
  cohere: "cohere.com",
  nvidia: "nvidia.com",
  "x-ai": "x.ai",
  xai: "x.ai",
  amazon: "amazon.com",
  "01-ai": "01.ai",
  perplexity: "perplexity.ai",
  "perplexity-ai": "perplexity.ai",
  togetherai: "together.ai",
  inflection: "inflection.ai",
  databricks: "databricks.com",
  ai21: "ai21.com",
  liquid: "liquid.ai",
  reka: "reka.ai",
  thudm: "tsinghua.edu.cn",
  cognitivecomputations: "cognitivecomputations.com",
  nousresearch: "nousresearch.com",
  openchat: "openchat.team",
  neversleep: "huggingface.co",
  moonshotai: "moonshot.cn",
  baidu: "baidu.com",
  alibaba: "alibaba.com",
};

/** Icon URL for a given OpenRouter model id. Uses Google's S2 favicon
 *  service — the most reliable cross-origin anonymous source. Returns
 *  null when the provider prefix isn't in the known map. */
export function iconForModelId(id: string): string | null {
  const prefix = (id ?? "").split("/")[0]?.toLowerCase();
  if (!prefix) return null;
  const host = PROVIDER_DOMAIN[prefix];
  if (!host) return null;
  return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
}

interface CachedShape {
  fetchedAt: number;
  models: CatalogModel[];
}

function readCache(): CachedShape | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedShape;
    if (!parsed?.fetchedAt || !Array.isArray(parsed?.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(models: CatalogModel[]): void {
  try {
    globalThis.localStorage?.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), models } satisfies CachedShape),
    );
  } catch {
    /* localStorage unavailable */
  }
}

function normalize(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    id?: string;
    name?: string;
    description?: string;
    context_length?: number;
    top_provider?: { context_length?: number };
    pricing?: Record<string, unknown>;
  };
  if (!r.id) return null;
  const provider = r.id.split("/")[0] ?? "";
  return {
    id: r.id,
    name: r.name ?? r.id,
    provider,
    contextLength: r.context_length ?? r.top_provider?.context_length ?? null,
    pricing: r.pricing ?? null,
    iconUrl: iconForModelId(r.id),
  };
}

/**
 * Reactive OpenRouter model catalog. Singleton — every chat session
 * shares the same cache so the OpenRouter request only runs once per
 * page load (and only every 24h across reloads).
 */
class OpenRouterCatalog {
  models = $state<CatalogModel[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  fetchedAt = $state<number | null>(null);
  lastTriedAt = $state<number | null>(null);

  constructor() {
    const cached = readCache();
    if (cached) {
      this.models = cached.models;
      this.fetchedAt = cached.fetchedAt;
    }
  }

  /** Fetch only when cache is stale or empty AND not recently failed. */
  async ensure(): Promise<void> {
    const fresh = this.fetchedAt && Date.now() - this.fetchedAt < CACHE_TTL_MS;
    if (fresh && this.models.length > 0) return;
    const recentlyFailed =
      this.lastTriedAt && Date.now() - this.lastTriedAt < RETRY_AFTER_FAILURE_MS;
    if (recentlyFailed) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.lastTriedAt = Date.now();
    try {
      const r = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`OpenRouter /models: HTTP ${r.status}`);
      const j = (await r.json()) as { data?: unknown[] };
      const arr = Array.isArray(j?.data) ? j.data : [];
      const normalized = arr
        .map(normalize)
        .filter((m): m is CatalogModel => m !== null);

      // Pin Anthropic / OpenAI / Google to the top — the labs most
      // users reach for first. Everything else stays in OpenRouter's
      // returned order (rough popularity).
      const PIN = ["anthropic", "openai", "google"];
      normalized.sort((a, b) => {
        const ai = PIN.indexOf(a.provider);
        const bi = PIN.indexOf(b.provider);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });

      this.models = normalized;
      this.fetchedAt = Date.now();
      writeCache(normalized);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  get(id: string): CatalogModel | null {
    return this.models.find((m) => m.id === id) ?? null;
  }
}

export const openrouterCatalog = new OpenRouterCatalog();
