/**
 * `wb.acp` — browser-side client for the Agent Client Protocol.
 *
 * Lets a workbook talk to the user's locally-installed coding agent
 * (Anthropic Claude Code via `claude`, OpenAI Codex via `codex`)
 * over their **subscription**, not an API key. The daemon spawns
 * the matching ACP adapter shim as a subprocess, inheriting `HOME`
 * so the adapter reads `~/.claude` / `~/.codex/auth.json` — i.e.
 * whatever account the user has signed into for the CLI is the
 * account whose Pro/Max/Plus quota gets charged.
 *
 *   import { listAdapters, connect } from "@work.books/runtime/agent-acp";
 *
 *   const adapters = await listAdapters();
 *   // [{ id: "claude", cliInstalled: true, authPresent: true, ... }, ...]
 *
 *   const session = await connect({ adapter: "claude" });
 *   const init = await session.initialize();
 *   //   init.agentInfo.name = "@agentclientprotocol/claude-agent-acp"
 *   //   init.authMethods = []        ← empty == subscription is active
 *
 *   const { sessionId } = await session.newSession({ cwd: "/" });
 *   session.onUpdate((u) => console.log("agent:", u.update));
 *   await session.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
 *
 * Why daemon-side instead of in the browser:
 *   - The browser can't spawn processes, can't read `~/.claude`,
 *     can't even talk to a stdio JSON-RPC server.
 *   - The daemon already brokers the OS surface (filesystem,
 *     keychain, secrets); ACP is just the next layer.
 *
 * Phase 1 (this file): the browser SDK, daemon does a transparent
 * relay between WebSocket frames and the adapter's stdio. Each WS
 * frame is exactly one JSON-RPC message.
 *
 * Phase 2 (planned): the daemon will populate the per-session
 * scratch dir from the workbook's substrate (composition.html,
 * assets/, skills/) before spawning the adapter, and watch for
 * edits to sync back via /save.
 */

import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ContentBlock,
} from "@agentclientprotocol/sdk";

export type AcpAdapterId = "claude" | "codex";

export interface AcpAdapterStatus {
  id: AcpAdapterId | string;
  name: string;
  cliInstalled: boolean;
  cliVersion: string | null;
  authPresent: boolean;
  npxAvailable: boolean;
  spawnCommand: string[];
  hint: string | null;
}

export class AcpError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "AcpError";
  }
}

// Replaced ad-hoc binding resolver with the SDK's central
// `requireBinding("acp")` — that auto-mounts the install toast on
// unbound calls (so the user sees a friendly install prompt instead
// of a raw console error) and throws DaemonRequiredError, which
// authors can catch the same way they'd have caught AcpError.
import { requireBinding } from "../install-prompt";
function resolveBinding(): { origin: string; token: string } {
  if (typeof window === "undefined" || typeof location === "undefined") {
    throw new AcpError("wb.acp requires a browser context");
  }
  return requireBinding("acp");
}

/** Seed the daemon's per-session scratch dir with the workbook's
 *  logical files BEFORE opening the WebSocket. Required because
 *  the underlying CLIs (claude, codex) use their own native
 *  Read/Write/Bash tools — not ACP's fs/* methods — so the files
 *  have to actually exist as bytes on disk for the agent to find
 *  them.
 *
 *  Pair with `connect()` and an `onFileChanged` hook to mirror the
 *  agent's edits back into the workbook's substrate.
 *
 *   await seed({ files: {
 *     "composition.html": currentComposition,
 *     "skills/fal-ai/SKILL.md": skillBody,
 *   }});
 *   const session = await connect({ adapter, hooks: { onFileChanged } });
 */
export async function seed(opts: { files: Record<string, string> }): Promise<void> {
  const b = resolveBinding();
  const res = await fetch(`${b.origin}/wb/${b.token}/agent/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new AcpError(`seed: ${res.status} ${res.statusText} ${txt}`.trim());
  }
}

/** Notification from the daemon's file watcher: a file in the
 *  scratch dir changed (because the agent edited it). The browser
 *  decides what to do with it — typically routes to a workbook-
 *  state setter so the change appears live in the running app.
 *
 *  Two shapes:
 *   - text: `{ path, content, binary: false }` — UTF-8 file content
 *   - binary: `{ path, content_b64, mime, size, binary: true }` —
 *     base64-encoded bytes plus a MIME hint, e.g. when the agent
 *     drops a generated PNG / WAV into the scratch dir. The browser
 *     can decode the base64 and route to its asset store. */
export interface FileChangedNotification {
  /** Relative path inside the scratch dir, e.g. "composition.html"
   *  or "skills/fal-ai/SKILL.md" or "out/render-001.png". */
  path: string;
  /** Whether this notification carries text or binary content.
   *  `false` → use `content`. `true` → use `content_b64` + `mime`. */
  binary: boolean;
  /** UTF-8 content. Present when `binary === false`. The daemon
   *  coalesces bursts (open-write-rename triplets) so each
   *  notification represents a logical "this is the current value." */
  content?: string;
  /** Base64-encoded bytes. Present when `binary === true`. */
  content_b64?: string;
  /** MIME guess from the file extension (e.g. "image/png").
   *  Falls back to "application/octet-stream" if unrecognized. */
  mime?: string;
  /** Decoded byte length (helps the consumer reject oversized
   *  files without first base64-decoding). */
  size?: number;
}

/** GET /wb/<token>/agent/adapters — list installed ACP adapters
 *  + auth status. Cheap; safe to poll on every Manage modal open. */
export async function listAdapters(): Promise<AcpAdapterStatus[]> {
  const b = resolveBinding();
  const res = await fetch(`${b.origin}/wb/${b.token}/agent/adapters`);
  if (!res.ok) {
    throw new AcpError(`adapters list: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as Array<{
    id: string;
    name: string;
    cli_installed: boolean;
    cli_version: string | null;
    auth_present: boolean;
    npx_available: boolean;
    spawn_command: string[];
    hint: string | null;
  }>;
  return json.map((a) => ({
    id: a.id,
    name: a.name,
    cliInstalled: a.cli_installed,
    cliVersion: a.cli_version,
    authPresent: a.auth_present,
    npxAvailable: a.npx_available,
    spawnCommand: a.spawn_command,
    hint: a.hint,
  }));
}

/** A virtual filesystem entry — the workbook's logical files
 *  (composition, skills, etc.) projected as paths the agent can
 *  read or write. ACP routes `fs/read_text_file` and
 *  `fs/write_text_file` requests through the client (us); we
 *  resolve them against this map instead of the daemon's scratch
 *  dir. The substrate stays the source of truth.
 *
 *   {
 *     "/workbook/composition.html": {
 *       read:  () => composition.html,
 *       write: (next) => composition.set(next),
 *     },
 *     "/workbook/skills/fal-ai/SKILL.md": {
 *       read: () => loadSkill("fal-ai"),  // read-only; no write
 *     },
 *   }
 *
 *  Path resolution is exact-match for static entries; supply a
 *  glob/prefix matcher via the optional `match` function for
 *  dynamic paths (e.g. "/workbook/assets/*"). */
export interface VirtualFsEntry {
  /** Read the current value for this path. Resolves with the file
   *  content, or rejects if the file no longer exists. */
  read?: () => Promise<string> | string;
  /** Apply a new value. Rejects if the entry is read-only. */
  write?: (content: string) => Promise<void> | void;
}

export interface VirtualFs {
  /** Static path → entry map. Checked before `match`. */
  entries?: Record<string, VirtualFsEntry>;
  /** Optional dynamic resolver. Called when a path isn't in
   *  `entries`. Return `null` to fall through to the real
   *  scratch dir. */
  match?(path: string): VirtualFsEntry | null;
}

/** Hooks the consumer can install for inbound (agent → us) requests
 *  and notifications. All optional with sensible defaults. */
export interface AcpClientHooks {
  /** Agent asks for user permission before a tool call. Default:
   *  auto-approve once. Override to surface a UI prompt. */
  onRequestPermission?(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Streaming session updates — text deltas, tool calls, plan
   *  updates, etc. Every visible thing the agent does. */
  onSessionUpdate?(n: SessionNotification): void;
  /** Custom read handler. Overrides `virtualFs`. Use this when you
   *  want full control (e.g. routing reads through the daemon for
   *  files in the scratch dir). */
  onReadTextFile?(req: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  /** Custom write handler. Overrides `virtualFs`. */
  onWriteTextFile?(req: WriteTextFileRequest): Promise<void>;
  /** Workbook's logical filesystem projected into the agent's view.
   *  When the agent calls `fs/read_text_file` or
   *  `fs/write_text_file`, the path is resolved against this map.
   *  Misses fall through to "not supported" — the agent will then
   *  use its own bash to read from the daemon's scratch dir. */
  virtualFs?: VirtualFs;
  /** Daemon-side file-watcher notification: a file in the session's
   *  scratch dir changed because the agent edited it via its own
   *  native Read/Write/Bash tools. Pair with `seed()` to mirror
   *  agent edits back into the workbook's state. */
  onFileChanged?(n: FileChangedNotification): void;
}

export interface AcpSession {
  /** ACP `initialize` — negotiate protocol version + capabilities.
   *  Call once after `connect`; result tells you what the agent
   *  supports and which auth methods are available (empty list =
   *  user is already signed in, subscription path is active). */
  initialize(params?: Partial<InitializeRequest>): Promise<InitializeResponse>;
  /** ACP `session/new` — start a conversation. Returns a session
   *  id you pass to subsequent `prompt` calls. */
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  /** ACP `session/prompt` — one turn. Resolves when the agent
   *  reports a stop reason. Streaming output flows through
   *  `hooks.onSessionUpdate` while this is awaiting. */
  prompt(params: PromptRequest): Promise<PromptResponse>;
  /** ACP `session/cancel` — interrupt the current turn. */
  cancel(sessionId: string): void;
  /** Replace or extend the inbound hooks at runtime. */
  setHooks(hooks: AcpClientHooks): void;
  /** Close the WebSocket; daemon kills the adapter subprocess. */
  close(): void;
  /** Resolves when the underlying WebSocket has closed for any
   *  reason (peer close, daemon kill, network drop). */
  closed: Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Open a WebSocket to /wb/<token>/agent/<adapter>, return a
 *  session-shaped client. The daemon spawns the adapter on
 *  upgrade; the first message you should send is `initialize`. */
export async function connect(opts: {
  adapter: AcpAdapterId | string;
  hooks?: AcpClientHooks;
}): Promise<AcpSession> {
  const b = resolveBinding();
  const url = `${b.origin.replace(/^http/, "ws")}/wb/${b.token}/agent/${encodeURIComponent(opts.adapter)}`;
  const ws = new WebSocket(url);

  // Wait for OPEN; surface failure cleanly.
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new AcpError(`websocket failed to open (adapter=${opts.adapter})`)); };
    const onClose = (ev: CloseEvent) => {
      cleanup();
      reject(new AcpError(`websocket closed before open (code=${ev.code}, reason=${ev.reason || "n/a"})`));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });

  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let hooks: AcpClientHooks = opts.hooks ?? {};

  let closedResolve: () => void;
  const closed = new Promise<void>((r) => { closedResolve = r; });

  ws.addEventListener("close", () => {
    // Reject all pending — the request can never complete now.
    for (const p of pending.values()) {
      p.reject(new AcpError("websocket closed"));
    }
    pending.clear();
    closedResolve();
  });

  function sendRaw(obj: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  async function call<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      sendRaw(message);
    });
  }

  function notify(method: string, params: unknown): void {
    sendRaw({ jsonrpc: "2.0", method, params });
  }

  ws.addEventListener("message", async (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : await blobToText(ev.data));
    } catch (e) {
      console.error("[wb.acp] non-JSON frame:", ev.data);
      return;
    }

    // Response to one of our requests
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new AcpError(msg.error.message || "unknown error", msg.error));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    // Inbound request (agent → us). Route to hooks; respond.
    if (msg.id != null && typeof msg.method === "string") {
      try {
        const result = await handleInbound(msg.method, msg.params, hooks);
        sendRaw({ jsonrpc: "2.0", id: msg.id, result });
      } catch (e) {
        sendRaw({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
        });
      }
      return;
    }

    // Notification (agent → us, no id)
    if (typeof msg.method === "string") {
      if (msg.method === "session/update") {
        hooks.onSessionUpdate?.(msg.params as SessionNotification);
      } else if (msg.method === "_relay/file-changed") {
        // Daemon-emitted, not from the ACP protocol. The leading
        // underscore is the protocol's reserved-namespace
        // convention so it can't collide with future spec methods.
        hooks.onFileChanged?.(msg.params as FileChangedNotification);
      } else if (msg.method === "_relay/error") {
        const m = (msg.params as { message?: string })?.message;
        console.error(`[wb.acp] daemon error: ${m ?? "unknown"}`);
      }
      return;
    }
  });

  return {
    initialize(params) {
      // Capability advertisement: read/write are TRUE if either an
      // explicit hook is provided OR a virtualFs entry can satisfy.
      // The agent uses these flags to decide when to call fs/* vs.
      // shell out to its own bash tools.
      const h = hooks;
      const hasReadable =
        !!h.onReadTextFile ||
        !!h.virtualFs?.match ||
        Object.values(h.virtualFs?.entries ?? {}).some((e) => !!e.read);
      const hasWritable =
        !!h.onWriteTextFile ||
        !!h.virtualFs?.match ||
        Object.values(h.virtualFs?.entries ?? {}).some((e) => !!e.write);
      const merged: InitializeRequest = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: hasReadable, writeTextFile: hasWritable },
          terminal: false,
        },
        ...(params as Partial<InitializeRequest>),
      };
      return call<InitializeResponse>("initialize", merged);
    },
    newSession(params) {
      return call<NewSessionResponse>("session/new", params);
    },
    prompt(params) {
      return call<PromptResponse>("session/prompt", params);
    },
    cancel(sessionId) {
      notify("session/cancel", { sessionId });
    },
    setHooks(h) {
      hooks = { ...hooks, ...h };
    },
    close() {
      try { ws.close(1000, "client closed"); } catch { /* ignore */ }
    },
    closed,
  };
}

async function handleInbound(
  method: string,
  params: unknown,
  hooks: AcpClientHooks,
): Promise<unknown> {
  switch (method) {
    case "session/request_permission": {
      const req = params as RequestPermissionRequest;
      if (hooks.onRequestPermission) return hooks.onRequestPermission(req);
      // Default: auto-approve the first option (typically allow_once).
      const optId = req.options?.[0]?.optionId ?? "allow";
      return { outcome: { outcome: "selected", optionId: optId } } satisfies RequestPermissionResponse;
    }
    case "fs/read_text_file": {
      const req = params as ReadTextFileRequest;
      if (hooks.onReadTextFile) return hooks.onReadTextFile(req);
      const entry = resolveVirtualFs(req.path, hooks.virtualFs);
      if (entry?.read) {
        const content = await entry.read();
        return { content } satisfies ReadTextFileResponse;
      }
      throw new AcpError(`fs/read_text_file: no virtual entry for ${req.path}`);
    }
    case "fs/write_text_file": {
      const req = params as WriteTextFileRequest;
      if (hooks.onWriteTextFile) {
        await hooks.onWriteTextFile(req);
        return null;
      }
      const entry = resolveVirtualFs(req.path, hooks.virtualFs);
      if (entry?.write) {
        await entry.write(req.content);
        return null;
      }
      throw new AcpError(`fs/write_text_file: no writable virtual entry for ${req.path}`);
    }
    default:
      throw new AcpError(`unknown inbound method: ${method}`);
  }
}

function resolveVirtualFs(path: string, vfs: VirtualFs | undefined): VirtualFsEntry | null {
  if (!vfs) return null;
  const exact = vfs.entries?.[path];
  if (exact) return exact;
  if (vfs.match) return vfs.match(path);
  return null;
}

async function blobToText(b: Blob): Promise<string> {
  return await b.text();
}

// Re-export a curated slice of upstream types so consumers can build
// strongly-typed prompts without importing the SDK directly.
export type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ContentBlock,
};
