// Chat thread + send loop. Wires runAgentLoop with hyperframes-
// specific tools that read and rewrite the composition store.

import { loadRuntime } from "virtual:workbook-runtime";
import { env } from "./env.svelte.js";
import {
  composition,
  redactDataUrlsForAgent,
  expandAssetPlaceholders,
} from "./composition.svelte.js";
import { assets } from "./assets.svelte.js";
import { loadSkill, skillsPromptBlock } from "./skills.js";

const HOUSE_STYLE = `HyperFrames composition rules:
- Each visible clip is a top-level element with id, data-start (seconds), data-duration (seconds).
- The runtime toggles class 'active' on a clip when data-start <= t < data-start + data-duration.
- Hide clips by default in CSS (e.g. .scene { display: none }) and reveal with .scene.active { display: flex }.
- Build the hero frame layout first; only then add motion.
- Default canvas is 16:9. Use vw/vh, vmin, or %; do not hardcode 1920x1080.
- 3-5 hex values in the palette; one display font + one mono is plenty.

Animation timing — IMPORTANT:
- Position GSAP tweens RELATIVE TO THE CLIP, never as absolute timestamps.
- The runtime adds a label per clip id at its start time. Use:
    tl.from("#intro .title", {...}, "intro+=0.25")     // clip-relative
  or the functional form:
    tl.from("#intro .title", {...}, hf.at("intro", 0.25))
- Absolute positions like \`tl.from(..., 0.25)\` will desynchronize when the user
  drags the clip on the timeline editor. Always use clip labels.`;

const BASE_SYSTEM_PROMPT = `You are a HyperFrames compositor embedded in a workbook.
The user wants short HTML video compositions on the right-hand player.

You have these tools:
- get_composition: read the current HTML (data URLs redacted to placeholders)
- set_composition: replace it (provide the FULL HTML body, not a diff)
- patch_clip: retime / move a single clip without rewriting the whole HTML
- list_clips: list parsed clips with id / start / duration
- list_assets: list user-imported media (image / video / audio / svg) with stable ids
- add_asset_clip: insert an asset by id onto the timeline as an <img|video|audio> clip
- load_skill: read any vendored skill file by path (see "Available skills" below)
- house_style: shortcut for load_skill('hyperframes/house-style') — read once on first task

Skills are progressive-disclosure: the descriptions below stay in your context;
the bodies are loaded on demand via load_skill. For non-trivial work — captions,
transitions, audio-reactive visuals, palettes, GSAP techniques — pick the
relevant skill from the list and load it before writing HTML. Don't reinvent
patterns the bundle already documents.

Workflow: when the user asks for a change, FIRST get_composition, THEN set_composition with the
full updated HTML. Each visible clip needs a unique id, data-start, and data-duration. Hide clips
in CSS by default; reveal with the .active class added by the runtime.

When the user references an asset they imported (a logo, a clip, a song): call list_assets to get
its id, then add_asset_clip to drop it onto the timeline. Never try to embed a base64 data URL via
set_composition — your context can't hold it.

Asset placeholders: get_composition redacts every embedded data URL to a stable
src="@hf-asset:<asset-id>" placeholder. Pass these placeholders through unchanged in
set_composition; the studio expands them back to real data URLs on submit. If you see
src="@hf-redacted-data-url:<size>", that's a data URL not tracked by the assets registry —
you cannot round-trip it via set_composition (the call will fail). Use add_asset_clip to
add new media; use patch_clip to retime an existing clip without rewriting the whole HTML.

Reply concisely (1-3 sentences). Do not paste the full HTML back into chat — the player shows it.`;

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
export function buildTools() {
  return [
    {
      definition: {
        name: "get_composition",
        description:
          "Read the current HyperFrames composition HTML. Embedded data URLs " +
          "(images / video / audio bytes) are redacted to placeholders of the " +
          "form `src=\"@hf-asset:<asset-id>\"` to keep your context small. " +
          "Pass those placeholders through unchanged in set_composition; the " +
          "studio expands them back to real data URLs on submit.",
        parameters: { type: "object", properties: {} },
      },
      invoke: () => redactDataUrlsForAgent(composition.html),
    },
    {
      definition: {
        name: "set_composition",
        description:
          "Replace the entire HyperFrames composition with new HTML. " +
          "Provide the FULL HTML body (style + scenes), not a diff. " +
          "Asset references must use the `src=\"@hf-asset:<id>\"` placeholder " +
          "form (never paste raw base64 data URLs — your context can't hold them). " +
          "The player reloads on success.",
        parameters: {
          type: "object",
          properties: {
            html: { type: "string", description: "Full composition HTML body" },
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
        const total = composition.totalDuration;
        const n = composition.clips.length;
        return `composition updated · ${n} clip${n === 1 ? "" : "s"} · ${total.toFixed(1)}s total`;
      },
    },
    {
      definition: {
        name: "patch_clip",
        description:
          "Update a single clip's timing or lane in place — fast local edit " +
          "that doesn't require rewriting the full HTML. Use this for retime " +
          "(start, duration), lane moves (trackIndex), or media in-points " +
          "(playbackStart on video/audio). Other content changes still go " +
          "through set_composition.",
        parameters: {
          type: "object",
          properties: {
            id:            { type: "string", description: "Clip element id" },
            start:         { type: "number" },
            duration:      { type: "number" },
            trackIndex:    { type: "number" },
            playbackStart: { type: "number", description: "Media in-point (video/audio only)" },
          },
          required: ["id"],
        },
      },
      invoke: (patch) => {
        if (!patch?.id) return "error: id is required";
        const ok = composition.patchClip(patch.id, patch);
        return ok
          ? `patched ${patch.id}`
          : `error: clip with id=${patch.id} not found`;
      },
    },
    {
      definition: {
        name: "list_clips",
        description: "List clips in the current composition with their timing.",
        parameters: { type: "object", properties: {} },
      },
      invoke: () => {
        const cs = composition.clips;
        if (!cs.length) return "(no clips)";
        return cs.map((c) =>
          `${c.id}\tstart=${c.start}s\tdur=${c.duration}s\t${c.label}`,
        ).join("\n");
      },
    },
    {
      definition: {
        name: "house_style",
        description:
          "Get the canonical HyperFrames house style guide. This is " +
          "load_skill('hyperframes/house-style') — kept as a separate tool " +
          "for discoverability since the agent always wants this on first read.",
        parameters: { type: "object", properties: {} },
      },
      invoke: () => loadSkill("hyperframes/house-style") ?? HOUSE_STYLE,
    },
    {
      definition: {
        name: "load_skill",
        description:
          "Load a vendored skill markdown file. Accepts a skill key alone " +
          "(loads its SKILL.md, e.g. 'hyperframes' → 'hyperframes/SKILL'), " +
          "an explicit /SKILL path, or any sub-document path " +
          "(e.g. 'hyperframes/references/captions', " +
          "'hyperframes/palettes/warm-editorial'). Returns the raw markdown.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Skill file path (no .md suffix)" },
          },
          required: ["path"],
        },
      },
      invoke: ({ path }) => {
        const md = loadSkill(String(path ?? ""));
        return md ?? `error: no skill file at path=${path}`;
      },
    },
    {
      definition: {
        name: "list_assets",
        description:
          "List media files the user has imported into this session. Returns id, name, kind " +
          "(image|video|audio|svg), size, and natural duration if known. Data URLs are NOT " +
          "included to keep your context small — reference assets by id via add_asset_clip.",
        parameters: { type: "object", properties: {} },
      },
      invoke: () => {
        if (!assets.items.length) return "(no assets imported · ask the user to drop files into the Assets panel)";
        return assets.items.map((a) =>
          `${a.id}\t${a.kind}\t${a.name}\tsize=${a.size}B${a.duration ? `\tdur=${a.duration}s` : ""}`,
        ).join("\n");
      },
    },
    {
      definition: {
        name: "add_asset_clip",
        description:
          "Insert a previously-imported asset onto the timeline. Pass the asset's id (from " +
          "list_assets). Optional: start (seconds, default = end of current composition), " +
          "duration (seconds, default = asset's natural duration or 3s for stills), " +
          "trackIndex (default = 1 for visuals, 2 for audio), label.",
        parameters: {
          type: "object",
          properties: {
            id:         { type: "string", description: "Asset id" },
            start:      { type: "number" },
            duration:   { type: "number" },
            trackIndex: { type: "number" },
            label:      { type: "string" },
          },
          required: ["id"],
        },
      },
      invoke: ({ id, start, duration, trackIndex, label }) => {
        const a = assets.get(id);
        if (!a) return `error: no asset with id=${id}`;
        const dur = Number.isFinite(duration) ? duration : (a.duration ?? 3);
        const startVal = Number.isFinite(start) ? start : composition.totalDuration;
        const idx = Number.isFinite(trackIndex)
          ? trackIndex
          : (a.kind === "audio" ? 2 : 1);
        composition.addMediaClip({
          kind: a.kind === "image" || a.kind === "svg" ? "img" : a.kind,
          src: a.dataUrl,
          start: startVal,
          duration: dur,
          trackIndex: idx,
          label: label ?? a.name,
        });
        return `inserted ${a.name} at ${startVal.toFixed(2)}s for ${dur.toFixed(2)}s on lane ${idx}`;
      },
    },
  ];
}

class AgentStore {
  thread = $state([]);            // [{ role, segments }]
  streaming = $state(null);       // { segments } during a turn, else null
  busy = $state(false);

  /** Reset the thread — useful after a context-overflow error or
   *  when the user wants a clean slate. Does not touch the
   *  composition or assets. */
  clearThread() {
    if (this.busy) return;
    this.thread = [];
    this.streaming = null;
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
