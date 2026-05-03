// talk-to-csv — SPA showcase for #39.
//
// Demonstrates the full crypto stack on encrypted <wb-data>:
//   - age-format passphrase encryption (Phase A)
//   - Ed25519 author signature (Phase C, optional but wired)
//   - Rust+WASM decrypt with plaintext-handle isolation (Phase E)
//   - X25519 / WebAuthn unlock paths (Phase D, B — opt-in via UI)
//
// Operationally: a single .html file the user can open from
// disk. They unlock the embedded encrypted CSV, then ask natural-
// language questions about it. The LLM (if configured) sees only the
// schema; the actual rows never leave the user's machine.

import tailwindcss from "@tailwindcss/vite";

export default {
  name: "talk-to-csv · workbook",
  slug: "talk-to-csv",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  vite: {
    plugins: [tailwindcss()],
  },
  // Polars for SQL execution; the wasm module also exposes the age
  // decrypt + handle registry via the always-on `crypto` module.
  runtimeFeatures: ["polars"],
};
