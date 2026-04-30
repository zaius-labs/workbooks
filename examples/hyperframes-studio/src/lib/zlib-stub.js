// Stub for node:zlib in the browser. just-bash's optional gzip /
// gunzip / zcat commands import from "node:zlib" — we don't need
// them for editing HTML, so we point Vite's resolver here instead
// of pulling in a real polyfill (fflate / pako).
//
// Calling into these throws — agent gets a clear error message
// rather than silent incorrect behavior.

function unsupported() {
  throw new Error(
    "gzip / gunzip / zcat are not available in this workbook " +
    "(node:zlib is stubbed in the browser).",
  );
}

export const gzipSync = unsupported;
export const gunzipSync = unsupported;
export const constants = {
  Z_DEFAULT_COMPRESSION: -1,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
};
export default { gzipSync, gunzipSync, constants };
