// Chat thread + send loop. Wires runAgentLoop with hyperframes-
// specific tools that read and rewrite the composition store.

import { loadRuntime } from "virtual:workbook-runtime";
import { env } from "./env.svelte.js";
import {
  composition,
  redactDataUrlsForAgent,
  expandAssetPlaceholders,
} from "./composition.svelte.js";
// Static imports replace the prior `import("./memoryBackend.svelte.js")`
// dynamic-import dance. The original comment claimed it broke a cycle,
// but no cycle exists — memoryBackend imports persistence + runtime +
// historyBackend, none of which import agent. With vite-plugin-singlefile
// flattening modules into one inline <script>, Vite's transform of
// dynamic imports leaves forward-ref `() => moduleNs` callbacks that
// trip TDZ when the bundle order puts the dynamically-imported module
// AFTER its caller. Static imports get the order right.
import { readAllTurns, appendTurn, clearTurns } from "./memoryBackend.svelte.js";
import { assets } from "./assets.svelte.js";
import { loadSkill, skillsPromptBlock } from "./skills.js";

// Studio's house-style rules live in skills/hyperframes/SKILL.md;
// the agent loads them on demand via load_skill('hyperframes/SKILL').
// Inline duplication here was just feeding both surfaces from one
// constant — dropped now that the bash-style tools encourage the
// agent to read skills first.

const BASE_SYSTEM_PROMPT = `You are a HyperFrames compositor working on a single HTML file
that the user previews as a short video composition in the player on the right.

The composition is one HTML document. You have FIVE bash-style tools:

  read_composition({line_start?, line_end?})
      Print the file with line numbers (cat -n style). Read first.
      Always.

  edit_composition({old_string, new_string, replace_all?})
      Surgical find-and-replace. The DEFAULT tool for any change.
      old_string MUST appear exactly once unless replace_all=true.
      Add surrounding context until your old_string is unique.
      new_string may be empty to delete.

  write_composition({html})
      Escape hatch: replace the entire file. Use ONLY when starting
      from scratch (a brand-new composition). NEVER use this for
      incremental changes — it's how you forget styles, lose data
      attributes, and break clips. Default to edit_composition.

  list_assets()
      Names + ids of media the user dragged in (images, videos,
      audio, svg). Reference them in HTML via
        src="@hf-asset:<id>"
      The studio expands the placeholder to the real bytes when it
      mounts the iframe. Don't paste base64 data URLs.

  load_skill({path})
      Read a markdown skill file. ALWAYS load 'hyperframes/SKILL'
      on any non-trivial task — it documents the file conventions
      (clip schema, .scene class, data-start/data-duration,
      runtime behavior, transition library, palettes). Skip it
      and you'll write code that doesn't run.

How to work:

  1. read_composition (whole file or a range you suspect).
  2. load_skill('hyperframes/SKILL') if you don't already know
     the conventions for this task.
  3. Plan the smallest edit that achieves the goal. Almost always
     a single edit_composition call. Sometimes a few in sequence.
  4. After each edit_composition, the player auto-reloads. The
     edit's response tells you the new clip count + total
     duration. Read again if you need to verify.

Conventions (also documented more fully in 'hyperframes/SKILL'):

  - Every clip is one HTML element with: a unique id, class="scene"
    (or whatever the existing CSS targets), data-start="<seconds>",
    data-duration="<seconds>". Display: none by default; runtime
    adds .active to reveal.
  - Add a clip by edit_composition: find the closing </body> (or
    a sentinel comment) and insert the new clip before it.
  - Remove a clip: edit_composition with old_string = the clip's
    full element (open tag through </tag>) and new_string = "".
  - Retime a clip: edit_composition that finds the data-start and
    data-duration attributes for the matching id, replaces with
    new values.
  - Add an imported asset to the timeline: list_assets to get its
    id, then edit_composition to insert
      <video id="clip-x" class="scene" data-start="..." data-duration="..."
             src="@hf-asset:<id>" muted playsinline
             style="position:absolute;inset:0;width:100%;height:100%;
                    object-fit:cover;display:none;"></video>
    (or <img>/<audio> as appropriate).

Failure mode to avoid: write_composition. It loses styles, drops
data-attrs, mangles existing clips. Reach for edit_composition
99% of the time.

Reply concisely (1-3 sentences). Don't paste HTML back into chat —
the player shows it.`;

/** Compose the system prompt at send time. Appends the dynamic
 *  skills frontmatter block (Pi-core / Anthropic Skills convention:
 *  every skill's name + description always in context, body
 *  loaded on demand). When the workbook framework grows native
 *  skills support, this composition moves into runAgentLoop and
 *  this function disappears. */
function buildSystemPrompt() {
  return BASE_SYSTEM_PROMPT + "\n\n" + skillsPromptBlock();
}

let runtimePromise = null;
function getRuntime() {
  if (!runtimePromise) runtimePromise = loadRuntime();
  return runtimePromise;
}

/** Construct the agent's tool surface. Exported so the MCP bridge
 *  can register the same tools onto window.__workbook_mcp without
 *  duplication — the in-app chat agent and an external MCP client
 *  invoke the exact same closures over composition + assets. */

// Plugin-registered extra tools. plugins.svelte.js calls
// registerExtraTool when a third-party module installs; buildTools
// concats these onto the built-in list so the agent sees them.
const extraTools = [];

/** Add a tool to the agent's surface. Used by plugins. Idempotent
 *  by definition.name — re-registering with the same name replaces. */
export function registerExtraTool(tool) {
  if (!tool?.definition?.name) {
    throw new Error("registerExtraTool: tool.definition.name is required");
  }
  const idx = extraTools.findIndex((t) => t.definition.name === tool.definition.name);
  if (idx >= 0) extraTools[idx] = tool;
  else extraTools.push(tool);
}

/** Remove a registered extra tool by name. Used by plugin teardown. */
export function unregisterExtraTool(name) {
  const idx = extraTools.findIndex((t) => t.definition.name === name);
  if (idx >= 0) extraTools.splice(idx, 1);
}

export function buildTools() {
  return [
    // ── read ──────────────────────────────────────────────────────
    {
      definition: {
        name: "read_composition",
        description:
          "Read the composition HTML with line numbers (cat -n style). " +
          "Use this BEFORE any edit so you can craft a unique old_string. " +
          "Returns the full file by default; pass line_start / line_end " +
          "to see a slice. Embedded data URLs are redacted to short " +
          "`src=\"@hf-asset:<asset-id>\"` placeholders to keep your context " +
          "small — those placeholders survive edit_composition and the " +
          "studio expands them at submit.",
        parameters: {
          type: "object",
          properties: {
            line_start: { type: "number", description: "First line (1-indexed). Optional." },
            line_end:   { type: "number", description: "Last line (inclusive). Optional." },
          },
        },
      },
      invoke: ({ line_start, line_end } = {}) => {
        const redacted = redactDataUrlsForAgent(composition.html);
        const lines = redacted.split("\n");
        const total = lines.length;
        const start = Math.max(1, Math.floor(line_start ?? 1));
        const end = Math.min(total, Math.floor(line_end ?? total));
        if (start > end) return `(empty range — file has ${total} lines)`;
        const width = String(end).length;
        const out = lines.slice(start - 1, end).map((line, i) => {
          const n = String(start + i).padStart(width, " ");
          return `${n}  ${line}`;
        });
        return out.join("\n") +
          (end < total ? `\n… ${total - end} more lines` : "");
      },
    },
    // ── edit ──────────────────────────────────────────────────────
    {
      definition: {
        name: "edit_composition",
        description:
          "Surgical find-and-replace on the composition HTML. The default " +
          "tool for ANY change. `old_string` MUST appear exactly once in " +
          "the source (add surrounding context until it's unique) unless " +
          "you pass replace_all=true. `new_string` may be empty to delete. " +
          "Errors instead of overwriting if old_string isn't unique. " +
          "ALWAYS read_composition first so your old_string is exact.",
        parameters: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to find. Include enough surrounding context to be unique." },
            new_string: { type: "string", description: "Replacement text. May be empty to delete the match." },
            replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
          },
          required: ["old_string", "new_string"],
        },
      },
      invoke: ({ old_string, new_string, replace_all }) => {
        const expandedOld = expandAssetPlaceholders(String(old_string ?? ""));
        const expandedNew = expandAssetPlaceholders(String(new_string ?? ""));
        const r = composition.editHtml(expandedOld, expandedNew, {
          replaceAll: Boolean(replace_all),
        });
        if (!r.ok) return `error: ${r.error}`;
        const total = composition.totalDuration;
        const n = composition.clips.length;
        return `edit applied · ${r.count} replacement${r.count === 1 ? "" : "s"} · ${n} clip${n === 1 ? "" : "s"} · ${total.toFixed(1)}s`;
      },
    },
    // ── write (escape hatch — for restructure-from-scratch) ───────
    {
      definition: {
        name: "write_composition",
        description:
          "Replace the ENTIRE composition with new HTML. ESCAPE HATCH — " +
          "use this ONLY when restructuring from scratch (e.g. starting " +
          "a totally new piece). For every other change, use " +
          "edit_composition. Asset references stay as " +
          "`src=\"@hf-asset:<id>\"` placeholders.",
        parameters: {
          type: "object",
          properties: {
            html: { type: "string", description: "Full composition HTML" },
          },
          required: ["html"],
        },
      },
      invoke: ({ html }) => {
        try {
          composition.set(expandAssetPlaceholders(String(html ?? "")));
        } catch (e) {
          return `error: ${e?.message ?? e}`;
        }
        const n = composition.clips.length;
        return `composition replaced · ${n} clip${n === 1 ? "" : "s"} · ${composition.totalDuration.toFixed(1)}s`;
      },
    },
    // ── assets (read-only listing) ────────────────────────────────
    {
      definition: {
        name: "list_assets",
        description:
          "List media files the user has imported. Returns id, kind " +
          "(image|video|audio|svg), name, and natural duration. " +
          "Reference assets in HTML via `src=\"@hf-asset:<id>\"` " +
          "(never raw base64 — the studio expands placeholders at submit).",
        parameters: { type: "object", properties: {} },
      },
      invoke: () => {
        if (!assets.items.length) {
          return "(no assets imported · ask the user to drop files in the Assets panel, " +
                 "or use the URL input to link an external image/video/audio)";
        }
        return assets.items.map((a) =>
          `${a.id}\t${a.kind}\t${a.name}${a.duration ? `\t${a.duration}s` : ""}`,
        ).join("\n");
      },
    },
    // ── skills (load on demand) ───────────────────────────────────
    {
      definition: {
        name: "load_skill",
        description:
          "Load a skill markdown file. Skill keys come from the " +
          "'Available skills' list at the bottom of the system prompt. " +
          "Read 'hyperframes/SKILL' first on any non-trivial task — it's " +
          "the house-style + cell conventions you'll need for HTML edits.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Skill key (e.g. 'hyperframes' or 'hyperframes/references/captions')" },
          },
          required: ["path"],
        },
      },
      invoke: ({ path }) => {
        const md = loadSkill(String(path ?? ""));
        return md ?? `error: no skill at path=${path}`;
      },
    },
    // Plugin-registered tools last (built-ins win on name collision).
    ...extraTools,
  ];
}

class AgentStore {
  thread = $state([]);            // [{ role, segments }]
  streaming = $state(null);       // { segments } during a turn, else null
  busy = $state(false);
  hydrated = $state(false);

  // Track which turns have already been persisted so we only append
  // newly-completed ones rather than re-encoding the whole thread on
  // every mutation. A monotonically-increasing index into thread[].
  _persistedThrough = 0;

  constructor() {
    // memoryBackend lazy-loads the runtime wasm internally, so this
    // doesn't trigger heavy work eagerly — first turn append is what
    // actually pulls runtime-wasm in.
    readAllTurns().then((turns) => {
      if (turns.length > 0) {
        this.thread = turns;
        this._persistedThrough = turns.length;
      }
      this.hydrated = true;
    });
  }

  /** Append every turn at index >= _persistedThrough into the
   *  Arrow IPC memory stream. Tracks how far we've persisted so a
   *  burst of turns becomes a sequence of appends, not a full rewrite. */
  async _persistNewTurns() {
    if (this._persistedThrough >= this.thread.length) return;
    const pending = this.thread.slice(this._persistedThrough);
    const baseline = this._persistedThrough;
    this._persistedThrough = this.thread.length;
    for (const t of pending) {
      try {
        await appendTurn(t);
      } catch (e) {
        // On failure, rewind the pointer so the next call retries.
        this._persistedThrough = Math.min(this._persistedThrough, baseline);
        console.warn("hf agent: turn persist failed:", e?.message ?? e);
        return;
      }
    }
  }

  _persist() {
    // Only persist completed turns — `streaming` is in-flight UI state
    // and is intentionally not saved (a partial turn would rehydrate
    // confusingly on reload mid-flight).
    this._persistNewTurns();
  }

  /** Reset the thread — useful after a context-overflow error or
   *  when the user wants a clean slate. Does not touch the
   *  composition or assets. */
  clearThread() {
    if (this.busy) return;
    this.thread = [];
    this.streaming = null;
    this._persistedThrough = 0;
    clearTurns();
  }

  async send(text) {
    if (!text.trim() || this.busy) return;
    if (!env.openrouterKey) return;

    const { bundle } = await getRuntime();
    const llm = bundle.createBrowserLlmClient({ apiKey: env.openrouterKey });
    const tools = buildTools();

    this.busy = true;
    this.streaming = { segments: [] };
    this.thread = [...this.thread, {
      role: "user",
      segments: [{ kind: "text", text }],
    }];
    // Persist the user turn early so a crash mid-stream doesn't lose
    // what they typed. The assistant turn lands in finally{} below.
    this._persist();

    let currentTextSeg = null;
    const onDelta = (delta) => {
      if (!currentTextSeg) {
        currentTextSeg = { kind: "text", text: "" };
        this.streaming.segments.push(currentTextSeg);
      }
      currentTextSeg.text += delta;
      this.streaming = { segments: [...this.streaming.segments] };
    };
    const onToolCall = (call, result) => {
      currentTextSeg = null;
      this.streaming.segments.push({
        kind: "tool",
        name: call.name,
        argumentsJson: call.argumentsJson,
        result,
      });
      this.streaming = { segments: [...this.streaming.segments] };
    };

    try {
      const result = await bundle.runAgentLoop({
        llmClient: llm,
        model: env.model,
        systemPrompt: buildSystemPrompt(),
        initialUserMessage: this.flattenForPrompt(text),
        tools,
        maxIterations: 12,
        onDelta,
        onToolCall,
      });

      // Reconcile streamed text with runAgentLoop's authoritative
      // result.text. The streaming buffer can drop tail tokens — most
      // commonly when the loop ends while the SSE stream is still
      // flushing — leaving us with a partial like "The" when the
      // model actually produced "The video has been updated…". Always
      // overwrite the final text segment with result.text so the
      // chat shows the full final synthesis.
      if (result?.text) {
        const segs = this.streaming.segments;
        const last = segs[segs.length - 1];
        if (!last || last.kind !== "text") {
          segs.push({ kind: "text", text: result.text });
        } else if (last.text !== result.text) {
          last.text = result.text;
        }
        this.streaming = { segments: [...segs] };
      }

      this.thread = [...this.thread, {
        role: "assistant",
        segments: this.streaming.segments,
      }];
    } catch (err) {
      onDelta(`\n[error] ${err?.message ?? err}`);
      this.thread = [...this.thread, {
        role: "assistant",
        segments: this.streaming.segments,
      }];
    } finally {
      this.streaming = null;
      this.busy = false;
      // Persist after every completed turn (success OR error path).
      // The catch above appended an error-flavored assistant entry so
      // the thread shape is consistent at this point.
      this._persist();
    }
  }

  flattenForPrompt(currentMessage) {
    if (!this.thread.length) return currentMessage;
    const flatten = (m) => m.role === "user"
      ? `User: ${m.segments[0]?.text ?? ""}`
      : "Assistant: " + m.segments
          .map((s) => s.kind === "text" ? s.text : `[used tool ${s.name}]`)
          .join("").trim();
    const prior = this.thread.slice(0, -1).map(flatten).join("\n\n");
    return prior
      ? `Earlier conversation:\n\n${prior}\n\nCurrent message:\n\n${currentMessage}`
      : currentMessage;
  }
}

export const agent = new AgentStore();
