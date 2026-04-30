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
import { skillsPromptBlock } from "./skills.js";
import { runBash } from "./bashTool.svelte.js";

// Studio's house-style rules live in skills/hyperframes/SKILL.md;
// the agent loads them on demand via load_skill('hyperframes/SKILL').
// Inline duplication here was just feeding both surfaces from one
// constant — dropped now that the bash-style tools encourage the
// agent to read skills first.

const BASE_SYSTEM_PROMPT = `You are a HyperFrames compositor with a real bash shell.

The user wants short HTML video compositions on the right-hand player.
You drive the composition by editing files in a virtual filesystem
through bash. There is exactly ONE tool: \`bash\`. Use it for everything.

  bash({ script: "..." })

Files in the virtual FS, all rooted at /workbook:

  /workbook/composition.html
      The live composition. Editing this file (via cat > / sed -i /
      heredoc / etc.) updates the player on the right immediately.
      Read it with \`cat\`, search with \`grep -n\`, slice with
      \`sed -n '20,40p'\`. All bash idioms work.

  /workbook/assets/list.txt
      Lines of "<id>\\t<kind>\\t<name>\\t<duration?>" for every media
      file the user dragged in. Reference an asset in composition.html
      via:    src="@hf-asset:<id>"
      The studio expands the placeholder to the real bytes when the
      iframe mounts. Never paste raw base64 data URLs.

  /workbook/skills/<key>.md
      Every vendored skill is one markdown file. \`cat\` whichever
      ones you need. ALWAYS read /workbook/skills/hyperframes/SKILL.md
      on a fresh task before editing — it documents the clip schema,
      runtime behavior, GSAP timing rules, and palette conventions
      you'll need to write working code.

Available bash builtins / utilities (just-bash, in-browser):
cat, grep, egrep, sed, awk, head, tail, cut, sort, uniq, wc, tr,
diff, find, ls, mkdir, rm, mv, cp, touch, jq, basename, dirname,
echo, printf, tee, xargs, pipes (\`|\`), redirects (\`>\`, \`>>\`,
\`<\`, \`2>&1\`), heredocs (<<EOF), if/while/for, functions,
glob (*, ?, [...]), \`&&\`/\`||\`/\`;\`. Multi-line scripts work —
run a small program, not just one command per call.

Workflow on any task:

  1. \`cat /workbook/skills/hyperframes/SKILL.md\` (skip if you've
     already loaded it this session)
  2. \`cat -n /workbook/composition.html\` to see what's there
  3. Make a SURGICAL edit. \`sed -i 's|old|new|' composition.html\`
     when the match is short and clear. Heredoc to a temp file +
     \`mv\` when restructuring a clip block. \`grep -n\` first to
     locate. \`diff\` if you want to verify what changed.
  4. After each script, the response includes a "(composition
     updated · N clips · S.Ss)" line if the file changed. The player
     auto-reloads.

Failure modes to avoid:

  - DON'T overwrite the whole file with \`cat > composition.html\`
    unless the user explicitly asked to start from scratch. You
    will drop styles, data-attrs, and existing clips.
  - DON'T paste the file contents back into chat — the player
    already shows it. Reply 1-3 sentences describing what you did.
  - DON'T fabricate asset ids. Read /workbook/assets/list.txt first.

Clip schema (the brief — load skills/hyperframes/SKILL.md for full):

  Each visible clip is one HTML element with:
    id="<unique>"  class="scene"  (or whatever the CSS targets)
    data-start="<seconds>"  data-duration="<seconds>"
    style="...display:none;..."   (runtime toggles .active to reveal)

  Adding a clip from an asset:
    <img id="hero" class="scene" data-start="0" data-duration="3"
         src="@hf-asset:asset-abc123"
         style="position:absolute;inset:0;width:100%;height:100%;
                object-fit:cover;display:none;">

Reply concisely (1-3 sentences). The player shows your work.`;

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
    {
      definition: {
        name: "bash",
        description:
          "Run a bash script against the workbook's virtual filesystem. " +
          "Files: /workbook/composition.html (live, read+write), " +
          "/workbook/assets/list.txt (read-only id→name listing), " +
          "/workbook/skills/<key>.md (every skill, one file each — read-only). " +
          "Standard utilities: cat, sed, grep, awk, head, tail, cut, sort, uniq, " +
          "wc, tr, diff, find, ls, jq, echo, tee, xargs. Pipes, redirects, " +
          "heredocs, if/while/for, functions, glob — full bash. Multi-line " +
          "scripts work; run a small program if needed. Editing " +
          "composition.html updates the player on the right immediately.",
        parameters: {
          type: "object",
          properties: {
            script: { type: "string", description: "Bash script to execute" },
          },
          required: ["script"],
        },
      },
      invoke: async ({ script }) => {
        try {
          return await runBash(String(script ?? ""));
        } catch (e) {
          return `error: ${e?.message ?? e}`;
        }
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
