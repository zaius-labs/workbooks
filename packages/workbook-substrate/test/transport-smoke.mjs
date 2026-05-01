#!/usr/bin/env node
// Smoke test for the transport negotiator + read-only transport.
// T2/T3/T4 require a real browser context — see browser-bench.html for
// full coverage.

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

const harness = `
import { negotiate, ReadOnlyTransport } from "${SRC_DIR}/index.ts";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(\`\${ok ? "✓" : "✗"} \${name}\${detail ? ": " + detail : ""}\`);
  if (ok) pass++; else fail++;
}

// In Node, none of the browser APIs exist → negotiate falls through to T5.
const r = await negotiate({ workbookId: "01J0NEGOTIATE_TEST" });
check("negotiate falls back to T5 in Node", r.transport instanceof ReadOnlyTransport);
check("T5 reasoning surfaced", r.reasoning.startsWith("T5"), r.reasoning);

const sem = r.transport.semantics();
check("T5 semantics tier=T5", sem.tier === "T5");
check("T5 semantics status=read-only", sem.status === "read-only");
check("T5 cannot true-append", sem.canTrueAppend === false);

const c = await r.transport.commitPatch({
  expectedFingerprint: "blake3-aaa",
  newImage: { html: "<html></html>", byteLength: 13, fingerprint: "blake3-bbb" },
  mode: "rewrite-required",
});
check("T5 commit returns queued (not error)", c.kind === "queued");
check("T5 reason mentions read-only", c.reason?.includes("read-only"));

console.log(\`\\n\${pass} passed, \${fail} failed\`);
process.exit(fail > 0 ? 1 : 0);
`;

const tmp = `/tmp/wb-substrate-transport-${process.pid}.mjs`;
writeFileSync(tmp, harness);
try {
  execSync(`tsx ${tmp}`, { stdio: "inherit", env: { ...process.env, PATH: `/tmp/wb-spike-deps/node_modules/.bin:${process.env.PATH}` } });
  unlinkSync(tmp);
} catch (e) {
  unlinkSync(tmp);
  process.exit(1);
}
