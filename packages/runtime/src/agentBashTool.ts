/**
 * Single `bash` tool for in-workbook agents.
 *
 * Lifts the just-bash + virtual-FS pattern proven in
 * examples/hyperframes-studio (bashTool.svelte.js) into a framework-level
 * factory every workbook can use. The agent gets ONE tool — `bash` — that
 * runs shell scripts against a virtual filesystem auto-mounted with the
 * workbook's data primitives.
 *
 * VFS layout (auto-mounted from the parsed workbook spec + runtime client):
 *
 *   /workbook/
 *     data/<id>.<ext>     <wb-data> — extension picked by mime (text/csv→.csv,
 *                         application/json→.json, application/x-sqlite3→.sqlite,
 *                         application/parquet→.parquet, fallback→.bin)
 *     memory/<id>.arrow   <wb-memory> — Arrow IPC bytes via client.exportMemory()
 *     docs/<id>.json      <wb-doc> — JSON projection via client.readDoc() (the
 *                         agent-readable shape)
 *     docs/<id>.loro      <wb-doc> — raw snapshot bytes via client.exportDoc()
 *                         (advanced; usually agents want the .json projection)
 *     inputs/<name>       <wb-input> — stringified spec.inputs[name]
 *     skills/<key>.md     getSkillSource(key) — opt-in by passing a callback
 *
 * v1 contract: READ-ONLY. The bash tool re-syncs every file from the
 * runtime client BEFORE every exec (so a freshly-appended memory row or
 * mutated doc shows up); writes back through the script are silently
 * ignored. Mutations are app-specific tools the workbook author
 * registers separately — the framework provides the standard read
 * surface; mutation is per-app (see hyperframes-studio's wrapped
 * bashTool that round-trips composition.html into composition.set).
 *
 * just-bash is a real bash environment in JS — pipes, redirects,
 * heredocs, sed/grep/awk/cut/sort/uniq/wc/jq, if/while/for, functions,
 * glob — all work. Pulled in via dynamic import so workbooks without
 * agents (the vast majority today) never pay the ~4 MB cost.
 */

import type { AgentTool } from "./agentLoop";
import type { RuntimeClient } from "./wasmBridge";

/**
 * Lightweight shape — the subset of WorkbookHtmlSpec the bash tool reads.
 * Kept structural so mountHtmlWorkbook can pass its parsed spec directly,
 * and tests can hand-roll a spec without import gymnastics.
 */
export interface WorkbookBashSpecShape {
  inputs?: Record<string, unknown>;
  data?: Array<{ id: string; mime: string }>;
  memory?: Array<{ id: string }>;
  docs?: Array<{ id: string }>;
}

export interface CreateWorkbookBashToolOptions {
  client: RuntimeClient;
  spec: WorkbookBashSpecShape;
  /**
   * Optional callback yielding skill markdown by key. When provided, the
   * caller also passes a list of keys to mount via `skillKeys`. Skills
   * are surfaced under /workbook/skills/<key>.md so the agent can
   * `cat /workbook/skills/<key>.md` from inside its bash script.
   */
  getSkillSource?: (key: string) => string | null | Promise<string | null>;
  /** Skill keys to mount (paired with getSkillSource). */
  skillKeys?: string[];
}

const ROOT = "/workbook";
const DATA_DIR = `${ROOT}/data`;
const MEMORY_DIR = `${ROOT}/memory`;
const DOCS_DIR = `${ROOT}/docs`;
const INPUTS_DIR = `${ROOT}/inputs`;
const SKILLS_DIR = `${ROOT}/skills`;

const TOOL_DESCRIPTION =
  "Run a bash script against the workbook's virtual filesystem. " +
  "Files (read-only): " +
  "/workbook/data/<id>.<ext> (wb-data, ext from mime), " +
  "/workbook/memory/<id>.arrow (wb-memory, Arrow IPC bytes), " +
  "/workbook/docs/<id>.json (wb-doc, JSON projection), " +
  "/workbook/inputs/<name> (wb-input values), " +
  "/workbook/skills/<key>.md (skills, when configured). " +
  "Standard utilities: cat, sed, grep, awk, head, tail, cut, sort, uniq, " +
  "wc, tr, diff, find, ls, jq, echo, tee, xargs. Pipes, redirects, " +
  "heredocs, if/while/for, functions, glob — full bash. Multi-line " +
  "scripts work; run a small program if needed. v1 is READ-ONLY — " +
  "writes back to /workbook/* are not propagated to the runtime; " +
  "use a workbook-specific mutation tool for that.";

function mimeToExt(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m === "text/csv") return "csv";
  if (m === "text/tab-separated-values") return "tsv";
  if (m === "application/json") return "json";
  if (m === "application/jsonl") return "jsonl";
  if (m === "application/x-sqlite3") return "sqlite";
  if (m === "application/parquet") return "parquet";
  if (m === "text/plain") return "txt";
  return "bin";
}

/** Convert Uint8Array → base64 → bash-safe string. just-bash's vfs takes
 *  utf-8 strings; for binary bytes we base64-encode and store under the
 *  matching extension. Agents that need raw bytes can `base64 -d` from
 *  inside the script.
 *
 *  Trade-off: a base64'd 10 MB sqlite db is 13 MB in the VFS string. For
 *  v1 read-only access this is fine — agents typically `head`/`grep`
 *  small slices. If this becomes a bottleneck we can teach just-bash
 *  about Uint8Array files.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is the standard browser path. In node-ish hosts (vitest/etc.)
  // Buffer.from(...).toString("base64") would be the fallback; the
  // runtime ships browser-only today so we don't bother.
  return btoa(binary);
}

interface SnapshotFile {
  path: string;
  content: string;
}

/**
 * Build the current set of VFS files from the runtime client + spec.
 * Called BEFORE every bash exec so each script sees the latest state of
 * inputs / memory / docs.
 */
async function buildSnapshot(opts: CreateWorkbookBashToolOptions): Promise<SnapshotFile[]> {
  const { client, spec, getSkillSource, skillKeys } = opts;
  const files: SnapshotFile[] = [];

  // Inputs — stringify scalar values. Object/array inputs flow as JSON.
  const inputs = spec.inputs ?? {};
  for (const [name, value] of Object.entries(inputs)) {
    let content: string;
    if (value === null || value === undefined) content = "";
    else if (typeof value === "string") content = value;
    else if (typeof value === "number" || typeof value === "boolean") content = String(value);
    else {
      try {
        content = JSON.stringify(value);
      } catch {
        content = String(value);
      }
    }
    files.push({ path: `${INPUTS_DIR}/${name}`, content });
  }

  // Data blocks. The runtime today doesn't expose a generic "export the
  // bytes for any data block" surface — the resolver merges materialized
  // values into the executor's input map keyed by id. We surface a
  // placeholder pointer file so the agent KNOWS the data block exists
  // and can route to specific tools (sql cell, polars cell) for query.
  // For text/csv + application/json + jsonl we DO have access via the
  // resolver's text path… but that's not on the client surface today.
  // V1 ships a manifest-only file; richer access lands when the runtime
  // exposes a generic data byte export.
  for (const d of spec.data ?? []) {
    const ext = mimeToExt(d.mime);
    const placeholder =
      `# wb-data id=${d.id} mime=${d.mime}\n` +
      `# bytes not directly accessible from bash in v1.\n` +
      `# Reference this id in a Polars/SQL/Rhai cell to query it.\n`;
    files.push({ path: `${DATA_DIR}/${d.id}.${ext}`, content: placeholder });
  }

  // Memory blocks — Arrow IPC bytes. exportMemory is optional on the
  // runtime client; skip silently when missing.
  if (client.exportMemory) {
    for (const m of spec.memory ?? []) {
      try {
        const bytes = await client.exportMemory(m.id);
        files.push({ path: `${MEMORY_DIR}/${m.id}.arrow`, content: bytesToBase64(bytes) });
      } catch {
        // Memory might not be registered yet; skip.
      }
    }
  }

  // Docs — JSON projection (the agent-readable shape) + raw snapshot.
  if (client.readDoc) {
    for (const d of spec.docs ?? []) {
      try {
        const json = await client.readDoc(d.id);
        files.push({
          path: `${DOCS_DIR}/${d.id}.json`,
          content: JSON.stringify(json, null, 2),
        });
      } catch {
        // Doc might not be registered yet; skip.
      }
    }
  }
  if (client.exportDoc) {
    for (const d of spec.docs ?? []) {
      try {
        const bytes = await client.exportDoc(d.id);
        files.push({ path: `${DOCS_DIR}/${d.id}.loro`, content: bytesToBase64(bytes) });
      } catch {
        // skip
      }
    }
  }

  // Skills — opt-in through getSkillSource + skillKeys.
  if (getSkillSource && skillKeys && skillKeys.length > 0) {
    for (const key of skillKeys) {
      try {
        const md = await getSkillSource(key);
        if (typeof md === "string" && md.length > 0) {
          files.push({ path: `${SKILLS_DIR}/${key}.md`, content: md });
        }
      } catch {
        // skip
      }
    }
  }

  return files;
}

/**
 * just-bash module type — minimal surface we rely on. Loaded via dynamic
 * import so workbooks that never run an agent never pay the bundle cost.
 */
interface JustBashModule {
  Bash: new (init?: { cwd?: string; files?: Record<string, string> }) => {
    fs: {
      writeFile(path: string, content: string): Promise<void>;
      mkdir?(path: string, opts?: { recursive?: boolean }): Promise<void>;
    };
    exec(script: string): Promise<{
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    }>;
  };
}

let _justBashModule: Promise<JustBashModule> | null = null;

function loadJustBash(): Promise<JustBashModule> {
  if (!_justBashModule) {
    // Dynamic import so esbuild splits this off the main runtime bundle.
    // For HTML-only workbooks with no bundler, just-bash needs to be
    // resolvable at runtime (importmap or a CDN like esm.sh). For
    // bundled workbooks (Vite + workbook-cli) this resolves through
    // node_modules normally.
    _justBashModule = import(/* @vite-ignore */ "just-bash") as Promise<JustBashModule>;
  }
  return _justBashModule;
}

/**
 * Build the framework-default `bash` AgentTool for a workbook.
 *
 * Returns the AgentTool definition + invoker. Pass it into runAgentLoop's
 * `tools` array. The factory captures the runtime client + spec; each
 * invoke() rebuilds the VFS snapshot then runs the script.
 */
export function createWorkbookBashTool(opts: CreateWorkbookBashToolOptions): AgentTool {
  // Single bash instance per tool — re-used across invocations. Files
  // are refreshed before every exec from the latest runtime state.
  let bashInstance: InstanceType<JustBashModule["Bash"]> | null = null;

  async function ensureBash(initialFiles: Record<string, string>) {
    if (bashInstance) return bashInstance;
    const mod = await loadJustBash();
    bashInstance = new mod.Bash({ cwd: ROOT, files: initialFiles });
    return bashInstance;
  }

  return {
    definition: {
      name: "bash",
      description: TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "Bash script to execute against the workbook VFS.",
          },
        },
        required: ["script"],
      },
    },
    invoke: async (args: Record<string, unknown>): Promise<string> => {
      const script = String(args.script ?? "");
      try {
        const snapshot = await buildSnapshot(opts);
        const filesMap: Record<string, string> = {};
        for (const f of snapshot) filesMap[f.path] = f.content;

        const bash = await ensureBash(filesMap);

        // Refresh BEFORE every exec — memory/docs/inputs may have changed
        // since last call. Write each file through bash.fs.writeFile so the
        // VFS overwrite path is deterministic regardless of the initial
        // ctor seed.
        for (const f of snapshot) {
          try {
            await bash.fs.writeFile(f.path, f.content);
          } catch {
            // Silent — directory might not exist yet on a fresh shell;
            // first writeFile creates parents in just-bash's vfs.
          }
        }

        const result = await bash.exec(script);
        const stdout = String(result.stdout ?? "").replace(/\n+$/, "");
        const stderr = String(result.stderr ?? "").replace(/\n+$/, "");
        const exit = Number(result.exitCode ?? 0);

        const lines: string[] = [];
        if (stdout) lines.push(stdout);
        if (stderr) lines.push(`stderr:\n${stderr}`);
        if (exit !== 0) lines.push(`exit ${exit}`);
        return lines.join("\n") || "(no output)";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The most common failure: just-bash isn't resolvable. Surface
        // an actionable message instead of the raw "Failed to fetch
        // dynamically imported module".
        if (/failed to fetch|cannot find|not found/i.test(msg)) {
          return (
            `error: 'just-bash' could not be loaded — the bash tool requires ` +
            `the just-bash package. Bundled workbooks add it via npm; ` +
            `HTML-only workbooks need an importmap entry pointing at a CDN ` +
            `build (e.g. https://esm.sh/just-bash@^2). Underlying error: ${msg}`
          );
        }
        return `error: ${msg}`;
      }
    },
  };
}
