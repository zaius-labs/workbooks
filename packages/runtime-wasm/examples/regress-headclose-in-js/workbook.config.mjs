// Regression fixture for core-bii.
//
// The user JS bundle below contains a literal "</head>" inside a
// template literal — a legitimate pattern for iframe srcdoc helpers
// that produce a full HTML document. Before the slot-marker fix, the
// CLI's regex-based head-close injector would land ~16 MB of base64
// wasm INSIDE that template literal, severing the JS expression.
//
// The fix anchors injection on SLOT_PORTABLE — a unique sentinel
// emitted in <head> at order: "pre" (before vite-plugin-singlefile
// inlines user JS into <body>). The slot is by construction outside
// any user code, so this fixture's </head> string is harmless.
//
// Verification: build this fixture, then `node --check` on the
// extracted user-module body to confirm it's still valid JS.
export default {
  name: "core-bii regression — </head> in user JS",
  slug: "regress-headclose-in-js",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  // Default icon (the workbook glyph) is fine; we're testing
  // injection mechanics, not aesthetics.
  inlineRuntime: true,
};
