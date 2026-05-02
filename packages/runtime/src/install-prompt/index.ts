// Reusable "install workbooksd" prompt. Workbook authors mount this
// where a daemon-required feature is unavailable (ACP-backed agents,
// save-in-place, file association). Three sizes:
//
//   - "toast" — slim slide-in, fixed position, dismissable.
//                Use when the panel itself is functional but the daemon
//                would unlock more.
//   - "card"  — inline empty-state, ~400px tall.
//                Use inside a panel whose primary action is gated on
//                the daemon (e.g. chat panel when an ACP agent is
//                selected but the daemon isn't reachable).
//   - "hero"  — full-bleed takeover, fills the parent.
//                Use when the panel has nothing else to show.
//
// OS detection picks an icon (Apple / Windows / Linux) and a direct
// binary URL on workbooks.sh. Clicking the primary CTA triggers a
// direct download; a secondary line offers the curl install one-liner
// with a clipboard copy. No redirect to the workbooks.sh page.

export type InstallOS = "macos" | "windows" | "linux" | "unknown";
export type InstallVariant = "toast" | "card" | "hero";

export interface InstallTarget {
  os: InstallOS;
  /** Display label, e.g. "macOS", "Windows", "Linux". */
  label: string;
  /** Inline SVG markup for the OS icon. */
  iconSvg: string;
  /** Direct binary download URL, or null if unsupported (Windows today). */
  dlUrl: string | null;
  /** One-line shell install command, or null if unsupported. */
  installCmd: string | null;
  /** Canonical install landing page (fallback for unsupported OSes). */
  installUrl: string;
}

export interface InstallPromptOpts {
  variant?: InstallVariant;
  /** Override OS detection (e.g. for testing or forced display). */
  target?: InstallTarget;
  /** Defaults to "https://workbooks.sh". */
  baseUrl?: string;
  /** One-line headline override. */
  title?: string;
  /** Subhead — what daemon unlocks for the user. */
  reason?: string;
  /** Per-tab dismiss key. Toast only. Defaults to a per-variant key. */
  dismissKey?: string;
}

/** Mount the prompt into `parent`. Returns a cleanup function that
 * removes the element + any associated styles. */
export function mountInstallPrompt(
  parent: HTMLElement,
  opts: InstallPromptOpts = {},
): () => void {
  const variant = opts.variant ?? "card";
  const target = opts.target ?? detectInstallTarget(opts.baseUrl);
  injectStyles();
  const el = build(variant, target, opts);
  parent.appendChild(el);
  // Wire copy-to-clipboard for any element carrying data-cmd.
  // Feedback text is written into [data-feedback-text] if present
  // (so the icon next to the label survives), else into the element
  // itself (the small "copy" pill).
  el.querySelectorAll<HTMLElement>("[data-cmd]").forEach((node) => {
    node.addEventListener("click", (ev) => {
      ev.preventDefault();
      const cmd = node.getAttribute("data-cmd");
      if (!cmd || !navigator.clipboard) return;
      const target = node.querySelector<HTMLElement>("[data-feedback-text]") ?? node;
      navigator.clipboard.writeText(cmd).then(
        () => {
          const prev = target.textContent;
          target.textContent = target.dataset.feedbackText || "Copied to clipboard";
          setTimeout(() => (target.textContent = prev), 1400);
        },
        () => { /* clipboard blocked — silent */ },
      );
    });
  });
  if (variant === "toast") {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => el.classList.add("wb-ip-show")),
    );
  }
  return () => el.remove();
}

// ── OS detection ─────────────────────────────────────────────────

const APPLE_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516s1.52.087 2.475-1.258c.955-1.345.762-2.391.728-2.43m3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422.212-2.189 1.675-2.789 1.698-2.854s-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56s.625 1.924 1.273 2.796c.576.984 1.34 1.667 1.659 1.899s1.219.386 1.843.067c.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758.347-.79.505-1.217.473-1.282"/>' +
  "</svg>";

const WINDOWS_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M0 2.5l6.5-.9V7.4H0zM7.5 1.5L16 .3v7H7.5zM0 8.6h6.5V14L0 13.1zm7.5 0H16v7L7.5 14.4z"/>' +
  "</svg>";

const LINUX_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M8 1c-1.7 0-3 1.5-3 3.5 0 .7.2 1.3.4 1.8-.5.4-1.4 1.3-1.7 2.6-.3 1.4-.5 2.7-1.1 3.6-.4.6-.4 1.1-.1 1.4.3.2.8.1 1.2 0 .4-.1.8-.1 1.1.1.4.3.6.7.6 1.1 0 .3.2.6.6.6h3.5c.4 0 .6-.3.6-.6 0-.4.2-.8.6-1.1.3-.2.7-.2 1.1-.1.4.1.9.2 1.2 0 .3-.3.3-.8-.1-1.4-.6-.9-.8-2.2-1.1-3.6-.3-1.3-1.2-2.2-1.7-2.6.2-.5.4-1.1.4-1.8C11 2.5 9.7 1 8 1m-1 3c.3 0 .5.2.5.5S7.3 5 7 5s-.5-.2-.5-.5S6.7 4 7 4m2 0c.3 0 .5.2.5.5S9.3 5 9 5s-.5-.2-.5-.5S8.7 4 9 4m-1 2c.6 0 1 .4 1 .8s-.4.6-1 .6-1-.2-1-.6.4-.8 1-.8"/>' +
  "</svg>";

const WB_LOGO =
  '<svg viewBox="0 0 634 632" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M517.107 187.121C520.419 186.936 525.375 187.132 528.815 187.146L547.714 187.14C553.689 187.193 559.871 186.766 565.811 187.189C568.077 187.351 570.622 187.72 572.739 188.563C576.284 189.975 579.85 194.04 581.237 197.461C582.036 199.423 582.222 201.854 582.349 203.955C582.903 213.23 582.503 222.746 582.506 232.041C582.513 240.104 582.992 248.519 582.29 256.548C582.101 258.728 581.698 261.402 580.776 263.393C579.092 267.023 575.587 270.125 571.851 271.426C565.622 273.595 538.12 272.651 529.796 272.635C525.898 272.628 521.19 272.172 517.546 273.717C513.444 275.459 509.538 278.915 507.922 283.131C506.067 287.961 506.606 293.745 506.609 298.832L506.671 326.865C506.686 333.16 507.429 341.996 505.132 347.796C499.535 361.947 484.295 357.078 472.457 357.877C463.319 358.49 452.803 356.336 444.005 359.632C431.99 364.314 433.046 376.134 433.129 386.462L433.201 414.2C433.201 418.291 433.405 425.911 432.981 429.765C432.777 431.714 432.272 433.624 431.492 435.422C427.978 443.395 420.954 444.769 413.072 444.72C398.523 444.636 383.827 444.812 369.302 444.642C362.668 444.565 356.263 439.158 354.489 432.934C353.427 429.198 353.774 422.6 353.78 418.551L353.768 390.538C353.793 385.268 353.907 380.161 353.759 374.837C353.79 366.035 346.292 358.474 337.525 358.029C328.108 357.558 318.691 358.146 309.25 357.827C298.666 357.468 286.398 357.406 281.275 368.7C279.383 372.872 279.917 380.956 279.931 385.593L279.948 412.971C279.949 419.232 280.698 429.681 278.316 435.168C274.268 444.5 265.131 444.927 256.577 444.723C242.493 444.385 228.863 445.082 214.833 444.583C207.943 444.339 202.531 438.74 200.575 432.476C199.474 428.483 199.812 422.649 199.813 418.412L199.854 393.927C199.879 388.001 200.612 374.636 198.975 369.322C194.308 354.172 174.203 358.22 161.818 357.914C150.171 357.623 132.752 362.479 127.734 346.54C125.937 340.83 126.673 330.492 126.667 324.404C126.64 315.803 126.657 307.199 126.718 298.596C126.781 288.941 127.981 279.348 117.553 274.193L117.184 274.015C111.487 272.007 106.525 272.594 100.489 272.632L79.1934 272.67C70.1122 272.676 61.6083 274.101 55.2286 266.509C50.2285 260.559 51.1853 255.205 51.0764 247.967C50.9909 242.298 51.0368 236.718 51.029 231.104L51.0417 213.71C51.0668 206.866 50.3189 200.637 54.2371 194.642C59.4082 186.73 67.6396 187.785 75.9565 187.752L96.7835 187.81C103.937 187.821 111.614 187.489 118.744 187.979C121.36 188.292 123.989 189.231 126.124 190.735C134.236 196.453 133.113 206.751 133.06 215.421L132.926 243.173C132.905 248.525 132.641 254.969 133.403 260.17C133.897 265.327 139.62 271.652 145.003 272.679C154.839 274.33 165.256 273.354 175.332 273.537C187.279 273.755 201.923 270.954 205.953 286.31C207.068 290.557 206.623 296.695 206.612 301.216L206.552 328.351C206.543 332.699 206.332 340.548 206.93 344.661C207.539 349.019 209.869 352.953 213.398 355.583C215.302 356.989 217.742 358.279 220.085 358.573C227.561 359.511 236.427 359.056 244.022 359.115C248.259 359.149 258.843 359.325 262.416 358.728C268.556 357.648 273.615 353.299 275.609 347.394C277.045 343.064 276.542 336.094 276.485 331.331L276.398 304.096C276.404 298.675 276.217 292.831 276.919 287.455C277.804 280.674 283.993 274.298 290.95 273.765C298.969 273.15 307.239 273.616 315.292 273.537C324.25 273.592 333.485 273.149 342.404 273.952C349.189 274.746 354.7 279.509 356.17 286.253C357.266 291.279 356.91 297.104 356.876 302.265L356.765 328.394C356.731 337.577 355.13 349.653 363.529 355.655C370.77 360.829 382.543 358.824 391.13 359.124C398.194 358.793 405.754 359.712 412.75 358.737C428.966 356.481 427 340.359 426.957 329.449L426.904 303.014C426.895 295.859 425.858 285.781 430.452 279.887C432.777 276.94 436.018 274.85 439.661 273.947C444.317 272.751 448.93 273.559 453.673 273.467C464.362 273.258 475.491 274.041 486.106 273.189C491.83 272.729 497.864 268.034 499.563 262.586C500.993 258 500.625 252.065 500.603 247.192L500.576 218.175C500.56 204.088 498.628 189.691 517.107 187.121Z"/>' +
  "</svg>";

export function detectInstallTarget(baseUrl = "https://workbooks.sh"): InstallTarget {
  const os = detectOS();
  const installUrl = baseUrl;
  if (os === "macos") {
    // Workbooks.pkg is universal (aarch64 + x86_64), signed and
    // notarized, double-clickable in Finder, and registers launchd +
    // the .workbook.html file association during install. The stable
    // URL is maintained by the release pipeline (see
    // packages/workbooksd/release/release.sh).
    return {
      os,
      label: "macOS",
      iconSvg: APPLE_ICON,
      dlUrl: `${baseUrl}/dl/Workbooks.pkg`,
      installCmd: `curl -fsSL ${baseUrl}/install | sh`,
      installUrl,
    };
  }
  if (os === "linux") {
    // No packaged Linux artifact yet (.deb/.rpm/AppImage TODO). The
    // install script handles arch detection + ~/.local/bin install +
    // future systemd unit.
    return {
      os,
      label: "Linux",
      iconSvg: LINUX_ICON,
      dlUrl: null,
      installCmd: `curl -fsSL ${baseUrl}/install | sh`,
      installUrl,
    };
  }
  if (os === "windows") {
    // .msi/.exe TODO — release pipeline doesn't build a Windows
    // artifact yet. Falls back to the install page.
    return {
      os,
      label: "Windows",
      iconSvg: WINDOWS_ICON,
      dlUrl: null,
      installCmd: null,
      installUrl,
    };
  }
  return {
    os: "unknown",
    label: "Install",
    iconSvg: WB_LOGO,
    dlUrl: null,
    installCmd: null,
    installUrl,
  };
}

function detectOS(): InstallOS {
  const nav: any = typeof navigator === "undefined" ? null : navigator;
  if (!nav) return "unknown";
  // Modern: User-Agent Client Hints. Chromium-based + Safari 17.4+.
  const platform = nav.userAgentData?.platform;
  if (typeof platform === "string") {
    const p = platform.toLowerCase();
    if (p.includes("mac")) return "macos";
    if (p.includes("win")) return "windows";
    if (p.includes("linux")) return "linux";
  }
  // Fallback: parse the UA string.
  const ua = (nav.userAgent || "").toLowerCase();
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

// ── DOM builders ─────────────────────────────────────────────────

const STYLE_ID = "wb-install-prompt-style";

function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = STYLES;
  document.head.appendChild(el);
}

function build(
  variant: InstallVariant,
  target: InstallTarget,
  opts: InstallPromptOpts,
): HTMLElement {
  if (variant === "toast") return buildToast(target, opts);
  if (variant === "hero") return buildHero(target, opts);
  return buildCard(target, opts);
}

function defaultTitle(target: InstallTarget) {
  return target.os === "windows"
    ? "Workbooks daemon (Windows soon)"
    : `Install Workbooks for ${target.label}`;
}

function defaultReason() {
  return "Connects this workbook to your local agents and saves your work back into the file.";
}

function buildToast(target: InstallTarget, opts: InstallPromptOpts): HTMLElement {
  const root = document.createElement("div");
  root.className = "wb-ip wb-ip-toast";
  root.setAttribute("role", "status");
  const dismissKey = opts.dismissKey ?? "wb.installPrompt.toast.dismissed";
  try {
    if (sessionStorage.getItem(dismissKey)) {
      root.style.display = "none";
    }
  } catch {
    /* private mode */
  }
  root.innerHTML = `
    <div class="wb-ip-os">${target.iconSvg}</div>
    <div class="wb-ip-text">
      <div class="wb-ip-title">${escapeHtml(opts.title ?? defaultTitle(target))}</div>
      <div class="wb-ip-sub">${escapeHtml(opts.reason ?? defaultReason())}</div>
      ${primaryActionHtml(target, "wb-ip-cta-sm")}
    </div>
    <button class="wb-ip-close" aria-label="Dismiss">×</button>
  `;
  root.querySelector(".wb-ip-close")?.addEventListener("click", () => {
    root.classList.remove("wb-ip-show");
    try {
      sessionStorage.setItem(dismissKey, "1");
    } catch {
      /* ignore */
    }
    setTimeout(() => root.remove(), 200);
  });
  return root;
}

function buildCard(target: InstallTarget, opts: InstallPromptOpts): HTMLElement {
  const root = document.createElement("div");
  root.className = "wb-ip wb-ip-card";
  root.innerHTML = `
    <div class="wb-ip-row">
      <div class="wb-ip-logo">${WB_LOGO}</div>
      <div class="wb-ip-row-text">
        <div class="wb-ip-title">${escapeHtml(opts.title ?? "Install Workbooks to continue")}</div>
        <div class="wb-ip-sub">${escapeHtml(opts.reason ?? defaultReason())}</div>
      </div>
    </div>
    <div class="wb-ip-actions">
      ${primaryActionHtml(target, "wb-ip-cta")}
      ${secondaryHtml(target)}
    </div>
  `;
  return root;
}

function buildHero(target: InstallTarget, opts: InstallPromptOpts): HTMLElement {
  const root = document.createElement("div");
  root.className = "wb-ip wb-ip-hero";
  root.innerHTML = `
    <div class="wb-ip-logo wb-ip-logo-lg">${WB_LOGO}</div>
    <div class="wb-ip-title wb-ip-title-lg">${escapeHtml(opts.title ?? "Install Workbooks")}</div>
    <div class="wb-ip-sub wb-ip-sub-lg">${escapeHtml(opts.reason ?? defaultReason())}</div>
    <div class="wb-ip-actions wb-ip-actions-lg">
      ${primaryActionHtml(target, "wb-ip-cta wb-ip-cta-lg")}
    </div>
    ${secondaryHtml(target)}
  `;
  return root;
}

function primaryActionHtml(target: InstallTarget, cls: string): string {
  if (target.dlUrl) {
    // Real installer asset — download attribute hints "save the file"
    // rather than "navigate". Currently macOS only (Workbooks.pkg).
    const filename = target.dlUrl.split("/").pop() || "Workbooks.pkg";
    return `<a class="${cls}" href="${target.dlUrl}" download>${target.iconSvg}<span>Download ${escapeHtml(filename)}</span></a>`;
  }
  if (target.installCmd) {
    // No packaged installer for this OS yet (Linux today). Lead with
    // the curl one-liner — a click copies it; the user pastes into
    // their terminal. Concrete and accurate, no broken downloads.
    return `<button type="button" class="${cls}" data-cmd="${escapeAttr(target.installCmd)}" aria-label="Copy install command for ${escapeHtml(target.label)}">${target.iconSvg}<span data-feedback-text="Copied to clipboard">Copy ${escapeHtml(target.label)} install command</span></button>`;
  }
  // Windows / unknown — link to the install page so the user can read
  // platform-specific instructions when there's no asset to ship.
  return `<a class="${cls}" href="${target.installUrl}" target="_blank" rel="noopener noreferrer">${target.iconSvg}<span>Install for ${escapeHtml(target.label)}</span></a>`;
}

function secondaryHtml(target: InstallTarget): string {
  // Skip the secondary command row when the primary CTA is already
  // the command-copy button — duplicate would just be noise.
  if (!target.installCmd || !target.dlUrl) return "";
  return `<div class="wb-ip-cmd"><span class="wb-ip-cmd-label">or run</span><code class="wb-ip-cmd-code">${escapeHtml(target.installCmd)}</code><button type="button" class="wb-ip-copy" data-cmd="${escapeAttr(target.installCmd)}" aria-label="Copy install command">copy</button></div>`;
}

// ── styles ───────────────────────────────────────────────────────

const STYLES = `
.wb-ip {
  --wb-ip-bg: #15171d;
  --wb-ip-fg: #f5f5f5;
  --wb-ip-fg-muted: #a8acb8;
  --wb-ip-border: #2a2d35;
  --wb-ip-accent-bg: #f5f5f5;
  --wb-ip-accent-fg: #15171d;
  font: 13px/1.4 ui-sans-serif, -apple-system, system-ui, sans-serif;
  color: var(--wb-ip-fg);
  box-sizing: border-box;
}
.wb-ip * { box-sizing: border-box; }

.wb-ip-toast {
  position: fixed; bottom: 1.5rem; left: 1.5rem; z-index: 2147483646;
  max-width: 360px;
  padding: 14px 36px 14px 14px;
  background: var(--wb-ip-bg); border: 1px solid var(--wb-ip-border);
  border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  display: flex; gap: 12px; align-items: flex-start;
  transform: translateY(8px); opacity: 0;
  transition: opacity .2s ease, transform .2s ease;
}
.wb-ip-toast.wb-ip-show { transform: translateY(0); opacity: 1; }

.wb-ip-card {
  padding: 20px; max-width: 480px; width: 100%;
  background: var(--wb-ip-bg); border: 1px solid var(--wb-ip-border);
  border-radius: 10px;
  display: flex; flex-direction: column; gap: 16px;
}

.wb-ip-hero {
  padding: 40px 28px; min-height: 100%;
  background: var(--wb-ip-bg);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; gap: 14px;
}

.wb-ip-row { display: flex; gap: 14px; align-items: flex-start; }
.wb-ip-row-text { flex: 1; min-width: 0; }

.wb-ip-os, .wb-ip-logo { flex: 0 0 auto; color: var(--wb-ip-fg); }
.wb-ip-os svg, .wb-ip-logo svg { width: 28px; height: 28px; display: block; }
.wb-ip-logo-lg svg { width: 56px; height: 56px; }

.wb-ip-title { font-weight: 600; margin-bottom: 4px; }
.wb-ip-title-lg { font-size: 16px; margin-bottom: 6px; }
.wb-ip-sub { color: var(--wb-ip-fg-muted); font-size: 12px; line-height: 1.5; }
.wb-ip-sub-lg { font-size: 13px; max-width: 36ch; }

.wb-ip-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.wb-ip .wb-ip-cta, .wb-ip .wb-ip-cta-sm {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 6px;
  background: var(--wb-ip-accent-bg); color: var(--wb-ip-accent-fg);
  text-decoration: none; font-weight: 600; font-size: 13px;
  border: 1px solid var(--wb-ip-accent-bg);
  cursor: pointer;
  font-family: inherit;
  transition: opacity .12s ease;
}
.wb-ip .wb-ip-cta:hover, .wb-ip .wb-ip-cta-sm:hover { opacity: 0.92; }
.wb-ip .wb-ip-cta-sm { padding: 4px 10px; font-size: 12px; margin-top: 4px; }
.wb-ip .wb-ip-cta svg, .wb-ip .wb-ip-cta-sm svg { width: 14px; height: 14px; }
.wb-ip .wb-ip-cta-lg { padding: 10px 18px; font-size: 14px; }
.wb-ip .wb-ip-cta-lg svg { width: 16px; height: 16px; }

.wb-ip-cmd {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  font-size: 12px; color: var(--wb-ip-fg-muted);
}
.wb-ip-cmd-label { white-space: nowrap; }
.wb-ip-cmd-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(255,255,255,0.06);
  padding: 4px 8px; border-radius: 4px;
  color: var(--wb-ip-fg);
  user-select: all;
  font-size: 11.5px;
}
.wb-ip-copy {
  background: transparent; border: 1px solid var(--wb-ip-border);
  color: var(--wb-ip-fg-muted); cursor: pointer;
  padding: 4px 8px; border-radius: 4px; font: inherit; font-size: 11px;
  transition: border-color .12s ease, color .12s ease;
}
.wb-ip-copy:hover { color: var(--wb-ip-fg); border-color: var(--wb-ip-fg-muted); }

.wb-ip-text { flex: 1; min-width: 0; }

.wb-ip-close {
  position: absolute; top: 6px; right: 6px;
  background: none; border: 0; color: var(--wb-ip-fg-muted);
  font-size: 18px; line-height: 1; cursor: pointer;
  padding: 4px 8px; border-radius: 4px;
}
.wb-ip-close:hover { color: var(--wb-ip-fg); background: rgba(255,255,255,0.06); }

@media (prefers-reduced-motion: reduce) {
  .wb-ip-toast { transition: none; }
}
`;

// ── helpers ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" :
    "&#39;",
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
