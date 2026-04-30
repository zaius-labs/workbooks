// workbook/portability/no-external-fetch
//
// Warn on hardcoded `fetch("https://...")` calls in workbook source.
// External network requests at runtime break two of the workbook
// promises:
//
//   1. Single-file portability — the artifact opens from file://, where
//      browsers strip the Referer header. Tile servers (OSM), some
//      CDNs, and signed-URL endpoints reject those requests.
//
//   2. CSP/Worker hosting — when hosted under workbook-edge (or any
//      sandbox with strict connect-src), arbitrary external origins
//      are blocked unless explicitly allowlisted.
//
// The fix is to snapshot the data at build time (a scripts/snapshot-*.mjs
// that runs before `workbook build`, like earthquakes does) and embed
// the result. The artifact then has zero network dependencies.

const RULE_ID = "workbook/portability/no-external-fetch";

// fetch("https://...") in JS — the most common shape and the one that
// actually triggers the failure modes above. Other patterns (import(),
// XMLHttpRequest, WebSocket, EventSource) are deliberately not flagged
// here; if they become a real problem we'll add narrower rules rather
// than one fuzzy mega-rule.
const FETCH_PATTERN = /\bfetch\s*\(\s*([`"'])(https?:\/\/[^`"'\s]+)\1/g;

// Allowlist domains that are demonstrably safe — public APIs we ship
// examples around that work cross-origin, on file://, and through CSP.
// Adding to this list is a deliberate decision; don't append casually.
const ALLOWLIST = new Set([
  // Public APIs with permissive CORS used in showcase examples.
  // Empty for now — the rule fires on all external fetches and the
  // user opts in per call-site via the inline disable comment.
]);

export default {
  id: RULE_ID,
  severity: "warn",
  fixable: false, // can't auto-rewrite — needs a build-time snapshot
  description: "external fetch — snapshot the data at build time so the artifact stays portable",
  rationale: `
A workbook's pitch is "just an HTML file with everything in it." The
moment your code calls \`fetch("https://example.com/...")\` at runtime,
that pitch is half-true:

  - Open the artifact from file:// → the browser strips the Referer
    header. Tile servers, signed URLs, and several public APIs reject
    requests with no Origin/Referer.
  - Host it under workbook-edge (or any CSP-locked sandbox) →
    \`connect-src 'self'\` blocks the request unless the origin is
    explicitly allowlisted.

The fix is to fetch the data once, at build time, and embed it. See
\`examples/earthquakes/scripts/snapshot-feed.mjs\` for the pattern:

  1. A node script fetches the live data and writes Arrow IPC bytes.
  2. Your workbook imports that file with Vite's \`?raw\` (or directly
     as JSON).
  3. The artifact has zero runtime network dependencies and works
     identically from file://, S3, GitHub Pages, or workbook-edge.

If the fetch is *intentionally* runtime (e.g., user pastes an API key
into a settings panel and the call is opt-in), suppress this warning
on the call site:

    // workbook-disable-next-line workbook/portability/no-external-fetch
    const r = await fetch(\`https://api.example.com/...?key=\${apiKey}\`);
`.trim(),
  exampleBefore: `// runtime fetch — fails on file://, blocked by Worker CSP
const r = await fetch("https://earthquake.usgs.gov/...");
const events = await r.json();`,
  exampleAfter: `// scripts/snapshot-feed.mjs (run before \`workbook build\`):
const r = await fetch("https://earthquake.usgs.gov/...");
writeFileSync("events.json", JSON.stringify(await r.json()));

// main.js:
import events from "./events.json";`,
  extensions: ["js", "mjs", "ts", "mts", "svelte"],

  check({ filePath, content }) {
    const diagnostics = [];
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "\n") lineStarts.push(i + 1);
    }
    const lines = content.split("\n");
    const indexToLineCol = (idx) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, col: idx - lineStarts[lo] + 1 };
    };

    FETCH_PATTERN.lastIndex = 0;
    let m;
    while ((m = FETCH_PATTERN.exec(content)) !== null) {
      const url = m[2];
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (ALLOWLIST.has(host)) continue;
      } catch {
        continue;
      }
      const literalStart = m.index + m[0].indexOf(url);
      const { line, col } = indexToLineCol(literalStart);

      const suppressed =
        (lines[line - 1] && lines[line - 1].includes(`workbook-disable ${RULE_ID}`)) ||
        (lines[line - 1] && lines[line - 1].includes(`workbook-disable-line ${RULE_ID}`)) ||
        (lines[line - 2] && lines[line - 2].includes(`workbook-disable-next-line ${RULE_ID}`));
      if (suppressed) continue;

      diagnostics.push({
        ruleId: RULE_ID,
        severity: "warn",
        filePath,
        line,
        col,
        endLine: line,
        endCol: col + url.length,
        message: `runtime fetch to '${url}' — snapshot at build time for portability`,
        advice: "see scripts/snapshot-*.mjs in examples/earthquakes for the pattern",
      });
    }
    return diagnostics;
  },
};
