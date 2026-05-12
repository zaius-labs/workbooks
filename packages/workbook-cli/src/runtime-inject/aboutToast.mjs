// In-workbook "about" toast — fixed bottom-right chip showing who
// published the workbook. Reads the manifest from the workbook-spec
// JSON that `workbook build` bakes into <head>.
//
// What this gives every workbook for free:
//
//   1. When the file is opened from any context (file://, USB, email,
//      a static host, anything), recipients see a small chip with the
//      author's name + a link to workbooks.sh. Identity travels with
//      the bytes.
//
//   2. When the workbook is rendered INSIDE the workbooks.sh splash
//      iframe, the chip suppresses itself — the parent splash page
//      already shows full identity (with the verified ✓ badge that
//      can only exist there). Showing it twice is noise.
//
//   3. NO verified claim. The chip says "by X" not "verified by X".
//      Bytes can't self-verify; the verified badge is only legitimate
//      on the workbooks.sh splash where the chain of custody to
//      WorkOS auth actually exists.
//
// Self-suppression conditions:
//   - manifest.author missing or empty → no toast (config-driven opt-in)
//   - inside an iframe (window !== window.top) → no toast
//   - user dismissed previously this session → no toast
//
// Authors can disable per-tab via:
//   window.__wbAboutToastDisabled = true;     // suppress entirely (set before this runs)
//
// Disable per-workbook via workbook.config.mjs by simply omitting the
// `author` field — there's no separate enabled toggle.

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__wbAboutToast) return;
  window.__wbAboutToast = true;

  // Iframes are hosted somewhere else — the parent owns identity.
  if (window !== window.top) return;

  if (window.__wbAboutToastDisabled) return;

  // Read manifest baked at build time. If the page isn't a workbook
  // (no spec script) or the JSON is malformed, bail silently.
  let manifest;
  try {
    const specEl = document.getElementById("workbook-spec");
    if (!specEl) return;
    const spec = JSON.parse(specEl.textContent || "{}");
    manifest = spec.manifest || {};
  } catch {
    return;
  }

  const author = typeof manifest.author === "string" ? manifest.author.trim() : "";
  const description =
    typeof manifest.description === "string" ? manifest.description.trim() : "";

  // No author → don't render. The field's presence is the toggle.
  if (!author) return;

  const KEY = "wb.aboutToast.dismissed";
  try { if (sessionStorage.getItem(KEY)) return; } catch { /* private mode */ }

  // Initials from author name: take first letter of first + last word,
  // cap at 2 chars. "Shane Murphy" → "SM"; "Cher" → "C"; "Mary Jo Smith" → "MS".
  function initialsOf(name) {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0][0].toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  const CSS = `
    .wb-about-toast {
      position: fixed; bottom: 1.25rem; right: 1.25rem; z-index: 2147483645;
      display: flex; align-items: center; gap: 10px;
      max-width: 320px; box-sizing: border-box;
      padding: 8px 14px 8px 8px;
      background: rgba(21, 23, 29, 0.92); color: #f5f5f5;
      border: 1px solid #2a2d35; border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.12);
      font: 12.5px/1.3 ui-sans-serif, -apple-system, system-ui, sans-serif;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      transform: translateY(8px); opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .wb-about-toast.wb-at-show { transform: translateY(0); opacity: 1; }
    .wb-about-toast .wb-at-avatar {
      flex: 0 0 auto;
      width: 28px; height: 28px; border-radius: 50%;
      background: linear-gradient(135deg, #4a5568, #2d3748);
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-weight: 600; font-size: 11px; letter-spacing: 0.02em;
    }
    .wb-about-toast .wb-at-text {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; gap: 1px;
    }
    .wb-about-toast .wb-at-name {
      font-weight: 600; font-size: 12.5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .wb-about-toast .wb-at-link {
      color: #a8acb8; font-size: 11px; text-decoration: none;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .wb-about-toast .wb-at-link:hover { color: #f5f5f5; }
    .wb-about-toast .wb-at-close {
      flex: 0 0 auto;
      background: none; border: 0; color: #6b7280;
      font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
      padding: 2px 6px; border-radius: 4px; margin-left: 2px;
    }
    .wb-about-toast .wb-at-close:hover { color: #f5f5f5; background: rgba(255,255,255,0.06); }
    @media (prefers-reduced-motion: reduce) {
      .wb-about-toast { transition: none; }
    }
    @media (max-width: 480px) {
      .wb-about-toast {
        right: 0.75rem; bottom: 0.75rem; max-width: calc(100vw - 1.5rem);
      }
    }
  `;

  function inject() {
    const styleEl = document.createElement("style");
    styleEl.id = "wb-about-toast-style";
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    const root = document.createElement("div");
    root.className = "wb-about-toast";
    root.setAttribute("role", "complementary");
    root.setAttribute("aria-label", "Workbook author");
    root.innerHTML =
      '<div class="wb-at-avatar"></div>' +
      '<div class="wb-at-text">' +
      '<div class="wb-at-name"></div>' +
      '<a class="wb-at-link" target="_blank" rel="noopener noreferrer">view on workbooks.sh →</a>' +
      "</div>" +
      '<button class="wb-at-close" aria-label="Dismiss">×</button>';

    // Set text via DOM (not innerHTML) — author name may contain quotes
    // or markup-like characters; this keeps the chip safe.
    root.querySelector(".wb-at-avatar").textContent = initialsOf(author);
    const nameEl = root.querySelector(".wb-at-name");
    nameEl.textContent = "by " + author;
    if (description) {
      // Tooltip surfaces the full description on hover; the chip itself
      // stays single-line so it doesn't dominate the page.
      nameEl.title = description;
    }
    const linkEl = root.querySelector(".wb-at-link");
    linkEl.href = "https://workbooks.sh";

    document.body.appendChild(root);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.classList.add("wb-at-show")),
    );

    root.querySelector(".wb-at-close").addEventListener("click", () => {
      root.classList.remove("wb-at-show");
      try { sessionStorage.setItem(KEY, "1"); } catch { /* ignore */ }
      setTimeout(() => root.remove(), 250);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  } else {
    setTimeout(inject, 250);
  }
})();
