// @work.books/auth-ui — public exports.
//
// v0.1.0 ships only the design tokens + logo asset. Components
// (SignInForm, MagicCodeInput) land in C7.2 / C7.3.

export const TOKENS_CSS_HREF = new URL("./tokens.css", import.meta.url).href;
export const LOGO_SVG_HREF = new URL("./logo.svg", import.meta.url).href;

/** Brand-locked palette as plain JS values. Useful for inline styles
 *  or generating ad-hoc <style> blocks. The CSS variables in
 *  tokens.css are the authoritative source for declarative styles. */
export const TOKENS = Object.freeze({
  bg: "#ffffff",
  fg: "#0a0a0a",
  fgMute: "#555",
  line: "#ececec",
  codeBg: "#f5f5f5",
  ok: "#0a7c45",
  warn: "#a35400",
  err: "#b3261e",
  fontSans:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontMono:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

export const TOKENS_DARK = Object.freeze({
  bg: "#0a0a0a",
  fg: "#f5f5f5",
  fgMute: "#9a9a9a",
  line: "#1c1c1c",
  codeBg: "#141414",
});
