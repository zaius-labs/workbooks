/**
 * Per-workbook permissions — the dialog the daemon-served workbook
 * surfaces on first open. Authors declare what the workbook needs
 * in `workbook.config.mjs`'s `permissions` block; the cli bakes it
 * into a `<meta name="wb-permissions">` tag in the workbook's outer
 * shell; the daemon parses on serve and stores user approvals in
 * `~/Library/Application Support/sh.workbooks.workbooksd/approvals.json`
 * keyed by the workbook's path-fingerprint so the dialog only
 * pops once per file.
 *
 *   import { listPermissions, approvePermissions } from "@work.books/runtime/storage";
 *
 *   const p = await listPermissions();
 *   if (p.needsApproval) showDialog(p.requested);
 *   ...
 *   await approvePermissions(["agents", "secrets"]);
 *
 * Workbooks that don't declare permissions get a transparent-pass:
 * `requested` is empty and `needsApproval` is false.
 */

export interface PermissionDecl {
  /** Stable id — one of "agents", "autosave", "secrets", "network". */
  id: string;
  /** Author-supplied "why" string. The dialog shows this verbatim. */
  reason: string;
}

export interface PermissionsList {
  requested: PermissionDecl[];
  granted: string[];
  needsApproval: boolean;
}

export class WbPermissionsError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "WbPermissionsError";
  }
}

// Daemon binding helpers come from install-prompt — single source
// of truth. listPermissions still uses the soft `resolveDaemonBinding`
// (returns null without side-effects, so we can render an empty
// dialog when there's no daemon). approve/revoke are user-initiated
// state changes — those use `requireBinding`, which auto-mounts the
// install toast and throws if the daemon's missing.
import { resolveDaemonBinding, requireBinding } from "../install-prompt";
const resolveBinding = resolveDaemonBinding;

export async function listPermissions(): Promise<PermissionsList> {
  const b = resolveBinding();
  if (!b) {
    // file://, no daemon — treat as "nothing to gate, nothing
    // declared." The dialog stays dismissed.
    return { requested: [], granted: [], needsApproval: false };
  }
  let res: Response;
  try {
    res = await fetch(`${b.origin}/wb/${b.token}/permissions`);
  } catch (e) {
    throw new WbPermissionsError("daemon unreachable", e);
  }
  if (!res.ok) {
    throw new WbPermissionsError(
      `permissions list: ${res.status} ${res.statusText}`,
    );
  }
  const j = (await res.json()) as {
    requested?: PermissionDecl[];
    granted?: string[];
    needs_approval?: boolean;
  };
  return {
    requested: j.requested ?? [],
    granted: j.granted ?? [],
    needsApproval: !!j.needs_approval,
  };
}

export async function approvePermissions(ids: string[]): Promise<PermissionsList> {
  const b = requireBinding("daemon");
  let res: Response;
  try {
    res = await fetch(`${b.origin}/wb/${b.token}/permissions/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch (e) {
    throw new WbPermissionsError("daemon unreachable", e);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new WbPermissionsError(
      `permissions approve: ${res.status} ${res.statusText} ${txt}`.trim(),
    );
  }
  const j = (await res.json()) as {
    requested?: PermissionDecl[];
    granted?: string[];
    needs_approval?: boolean;
  };
  return {
    requested: j.requested ?? [],
    granted: j.granted ?? [],
    needsApproval: !!j.needs_approval,
  };
}

/** Remove the given ids from this workbook's granted list.
 *  Idempotent. Use this when the user un-checks a permission they
 *  previously approved — the next /secret/* or /proxy call from
 *  this session will start refusing again. */
export async function revokePermissions(ids: string[]): Promise<PermissionsList> {
  const b = requireBinding("daemon");
  let res: Response;
  try {
    res = await fetch(`${b.origin}/wb/${b.token}/permissions/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch (e) {
    throw new WbPermissionsError("daemon unreachable", e);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new WbPermissionsError(
      `permissions revoke: ${res.status} ${res.statusText} ${txt}`.trim(),
    );
  }
  const j = (await res.json()) as {
    requested?: PermissionDecl[];
    granted?: string[];
    needs_approval?: boolean;
  };
  return {
    requested: j.requested ?? [],
    granted: j.granted ?? [],
    needsApproval: !!j.needs_approval,
  };
}

/** Convenience for icon URLs — daemon-served, baked-in adapter
 *  glyphs. The browser keeps them out of the workbook bundle so
 *  every workbook stays light. Returns null when not bound to a
 *  daemon (file:// or external host). */
export function iconUrl(id: "claude" | "codex" | "native"): string | null {
  const b = resolveBinding();
  if (!b) return null;
  return `${b.origin}/icons/${encodeURIComponent(id)}.svg`;
}
