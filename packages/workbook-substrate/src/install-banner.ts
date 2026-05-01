// Workbook install banner.
//
// Embedded by the workbook CLI in every emitted .workbook.html file.
// Detects whether the workbook is running INSIDE the Workbooks PWA (T2
// path, silent autosave) vs. in a regular browser tab (T3/T4 — needs
// user action to enable saving). When running outside the PWA, surfaces
// a small toast with two CTAs:
//
//   - "Install Workbooks" → triggers beforeinstallprompt + on success
//     immediately invokes the workbook's "Save File" picker (for the
//     current file, since this Chrome tab still doesn't have the
//     PWA-routed handle).
//   - "Save File" → triggers showSaveFilePicker for the current file
//     (T3 path — works without install).
//
// Banner state (dismissed | not-dismissed) lives in localStorage. NOT
// user data; just UI preference. Keyed by workbook_id so dismissing
// for one workbook doesn't dismiss for another.

export interface InstallBannerOptions {
  workbookId: string;
  /** Called when user clicks "Save File" (T3 path). The host should
   *  call substrate.transport.prepare() then a first commitPatch with
   *  the current image. */
  onSaveFileClick: () => Promise<void> | void;
  /** Called when the PWA install completes. Host should optionally
   *  also call onSaveFileClick to make THIS file savable in the
   *  current tab (since the PWA only routes future opens). */
  onInstallSuccess?: () => Promise<void> | void;
  /** Override the toast wording. */
  copy?: {
    primary?: string;
    saveFileLabel?: string;
    installLabel?: string;
    dismissLabel?: string;
  };
}

export interface InstallBannerHandle {
  /** Force-show the banner (e.g. after the user dismisses, then
   *  changes their mind via a menu). */
  show(): void;
  /** Force-hide. */
  hide(): void;
  /** Tear down. */
  destroy(): void;
}

const DISMISS_KEY_PREFIX = "wb-install-dismissed:";

/** Mount the install banner on document.body. Returns a handle for
 *  programmatic control. Call from the workbook's bootstrap AFTER the
 *  substrate runtime has determined the active transport tier. */
export function mountInstallBanner(opts: InstallBannerOptions): InstallBannerHandle {
  if (typeof document === "undefined") {
    return { show() {}, hide() {}, destroy() {} };
  }
  const inStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches
    || (window.navigator as any).standalone === true
    || (window as any).__wbInbound != null; // PWA delivered us a handle

  if (inStandalone) {
    return { show() {}, hide() {}, destroy() {} };
  }

  const dismissKey = DISMISS_KEY_PREFIX + opts.workbookId;
  if (localStorage.getItem(dismissKey) === "1") {
    return makeApi(null, opts);
  }

  const root = renderBanner(opts);
  document.body.appendChild(root);
  return makeApi(root, opts);
}

function renderBanner(opts: InstallBannerOptions): HTMLElement {
  const copy = opts.copy ?? {};
  const root = document.createElement("aside");
  root.id = "wb-install-banner";
  root.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:2147483646",
    "max-width:520px",
    "width:calc(100% - 32px)",
    "background:#18181b",
    "color:#fafafa",
    "border:1px solid #27272a",
    "border-radius:10px",
    "padding:14px 16px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.4)",
    "font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif",
    "display:flex",
    "align-items:flex-start",
    "gap:12px",
  ].join(";");

  const primary = document.createElement("div");
  primary.style.flex = "1";
  primary.innerHTML = `
    <strong style="display:block;margin-bottom:4px">${copy.primary ?? "Save your work to this file"}</strong>
    <span style="color:#a1a1aa">Install Workbooks for silent autosave on every file you open, or click Save File for one-tap saving in this tab.</span>
  `;
  root.appendChild(primary);

  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;flex-direction:column;gap:6px;flex-shrink:0";

  const installBtn = button(copy.installLabel ?? "Install Workbooks", "primary");
  const saveBtn = button(copy.saveFileLabel ?? "Save File", "secondary");
  const dismissBtn = button(copy.dismissLabel ?? "Not now", "ghost");

  buttons.appendChild(installBtn);
  buttons.appendChild(saveBtn);
  buttons.appendChild(dismissBtn);
  root.appendChild(buttons);

  // beforeinstallprompt — store on first fire and replay on click.
  let installEvent: any = null;
  const cacheEvent = (e: any) => {
    e.preventDefault();
    installEvent = e;
    installBtn.style.opacity = "1";
    installBtn.style.cursor = "pointer";
  };
  window.addEventListener("beforeinstallprompt", cacheEvent);

  installBtn.style.opacity = "0.5";
  installBtn.style.cursor = "not-allowed";

  installBtn.addEventListener("click", async () => {
    if (!installEvent) {
      // Maybe already installed, or browser doesn't support PWA install.
      installBtn.textContent = "(unavailable)";
      return;
    }
    installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === "accepted") {
      installBtn.textContent = "Installed ✓";
      installBtn.style.background = "#16a34a";
      // After install, this Chrome tab still doesn't have a file
      // handle (PWA file_handlers only fire for FUTURE opens). Chain
      // onSaveFileClick so this very first file becomes savable now.
      try {
        await opts.onInstallSuccess?.();
        await opts.onSaveFileClick();
        hide(root);
      } catch (e) {
        console.warn("[wb-install] onInstallSuccess failed:", e);
      }
    }
  });

  saveBtn.addEventListener("click", async () => {
    try {
      await opts.onSaveFileClick();
      hide(root);
    } catch (e) {
      console.warn("[wb-install] onSaveFileClick failed:", e);
    }
  });

  dismissBtn.addEventListener("click", () => {
    localStorage.setItem(DISMISS_KEY_PREFIX + opts.workbookId, "1");
    hide(root);
  });

  return root;
}

function button(label: string, kind: "primary" | "secondary" | "ghost"): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  const base =
    "padding:8px 14px;border-radius:6px;font:inherit;font-weight:500;cursor:pointer;transition:opacity 120ms,background 120ms;border:1px solid;";
  if (kind === "primary") {
    b.style.cssText = base + "background:#fafafa;color:#09090b;border-color:#fafafa;";
  } else if (kind === "secondary") {
    b.style.cssText = base + "background:transparent;color:#fafafa;border-color:#3f3f46;";
  } else {
    b.style.cssText = base + "background:transparent;color:#71717a;border-color:transparent;";
  }
  return b;
}

function hide(el: HTMLElement | null): void {
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translate(-50%, 8px)";
  setTimeout(() => el.remove(), 200);
}

function makeApi(root: HTMLElement | null, opts: InstallBannerOptions): InstallBannerHandle {
  return {
    show() {
      // If already on the page, ignore. Otherwise re-mount.
      if (root && root.isConnected) return;
      const fresh = renderBanner(opts);
      document.body.appendChild(fresh);
    },
    hide() {
      hide(root);
    },
    destroy() {
      hide(root);
      // Remove the dismissed key so a new mount starts fresh.
      localStorage.removeItem(DISMISS_KEY_PREFIX + opts.workbookId);
    },
  };
}
