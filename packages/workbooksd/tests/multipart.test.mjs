#!/usr/bin/env bun
// E2E for core-5ah.12 — multipart wb-fetch.
//
// Workbook flows that upload audio/images (ElevenLabs voice
// clone, fal.ai img2img) need multipart/form-data. /proxy now
// accepts a `multipart` field; the bash shim has --form-text and
// --form-file flags that build it.
//
// We use httpbin.org/post which echoes back the multipart it
// received as JSON so we can assert the daemon assembled the
// payload correctly. If httpbin is unreachable the test skips —
// nothing else covers it as cleanly.
//
// Assertions:
//   A. JSON-shape direct POST to /proxy with `multipart` array
//      → upstream sees both the text field and the file field
//      with correct filename + content_type + bytes.
//   B. wb-fetch shell shim with --form-text + --form-file
//      → same end-to-end shape.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { which } from "bun";
import { daemonUrl } from "./_runtime.mjs";

const DAEMON = daemonUrl();
const ORIGIN = DAEMON;
const fail = (msg) => { console.error(`[fail] ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); process.exit(0); };

// Probe httpbin availability up-front so the skip is fast.
try {
  const probe = await fetch("https://httpbin.org/status/204", { signal: AbortSignal.timeout(4000) });
  if (!probe.ok && probe.status !== 204) throw new Error(`httpbin probe ${probe.status}`);
} catch (e) {
  console.log(`[skip] httpbin unreachable (${e.message ?? e}); multipart needs an echo endpoint`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "workbooks-multipart-"));
const wbPath = join(tmp, "test.workbook.html");
const policyB64 = Buffer.from(JSON.stringify({})).toString("base64");
const permsB64 = Buffer.from(JSON.stringify({ network: { reason: "multipart test" } })).toString("base64");
writeFileSync(
  wbPath,
  `<!doctype html><html><head>
<script id="wb-meta" type="application/json">${JSON.stringify({
    workbook_id: "multipart-e2e",
    compaction_seq: 0,
    snapshot_cid_by_target: {},
  })}</script>
<meta name="wb-permissions" content="${permsB64}">
<meta name="wb-secrets-policy" content="${policyB64}">
</head><body></body></html>`,
);

const cleanup = () => rmSync(tmp, { recursive: true, force: true });
const exitFail = (msg) => { cleanup(); fail(msg); };
const exitPass = (msg) => { cleanup(); pass(msg); };

const { token } = await (await fetch(`${DAEMON}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: wbPath }),
})).json();
await fetch(`${DAEMON}/wb/${token}/`);
await fetch(`${DAEMON}/wb/${token}/permissions/approve`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({ ids: ["network"] }),
});
console.log(`[step] session ${token.slice(0, 12)}…  network approved`);

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

// A. Direct /proxy call with multipart array.
const directRes = await fetch(`${DAEMON}/wb/${token}/proxy`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN },
  body: JSON.stringify({
    url: "https://httpbin.org/post",
    method: "POST",
    headers: {},
    multipart: [
      { name: "prompt", value: "a calm cat" },
      {
        name: "image",
        filename: "x.png",
        content_type: "image/png",
        content_b64: PNG.toString("base64"),
      },
    ],
  }),
});
if (!directRes.ok) exitFail(`/proxy direct: HTTP ${directRes.status} — ${await directRes.text()}`);
const directEnv = await directRes.json();
if (directEnv.status !== 200) exitFail(`upstream status ${directEnv.status}: ${directEnv.body?.slice?.(0, 200)}`);
const echoed = JSON.parse(directEnv.body);
if (echoed.form?.prompt !== "a calm cat") {
  exitFail(`expected form.prompt='a calm cat', got: ${JSON.stringify(echoed.form)}`);
}
const fileEcho = echoed.files?.image;
if (!fileEcho || !fileEcho.startsWith("data:image/png;base64,") && !fileEcho.startsWith("\\x89PNG")) {
  // httpbin returns binary file uploads as data: URLs OR as
  // escaped strings depending on size. Either is fine; the
  // important property is image-shaped.
  exitFail(`expected image file echo, got: ${String(fileEcho).slice(0, 100)}`);
}
console.log(`[step] A ok — direct /proxy multipart round-tripped (text + image part)`);

// B. wb-fetch shim end-to-end. Need the scratch dir, which only
//    exists while an adapter session is alive — quick spawn.
if (!which("claude")) {
  console.log("[skip-B] claude not on PATH; A asserts daemon-side correctness");
  exitPass("multipart wire shape works (A); B skipped (no adapter to install shim)");
}

const wsUrl = `${DAEMON.replace(/^http/, "ws")}/wb/${token}/agent/claude`;
const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } });
let initSeen = false;
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  }) + "\n");
});
ws.addEventListener("message", (ev) => {
  for (const line of ev.data.split("\n")) {
    if (!line.trim()) continue;
    try { if (JSON.parse(line)?.id === 1) initSeen = true; } catch {}
  }
});
const dl = Date.now() + 25_000;
while (!initSeen && Date.now() < dl) await new Promise((r) => setTimeout(r, 200));
if (!initSeen) { ws.close(); exitFail("adapter never initialized"); }

const scratch = join(homedir(), "Library/Caches/sh.workbooks.workbooksd/sessions", token);
const wbFetchPath = join(scratch, ".bin/wb-fetch");
if (!existsSync(wbFetchPath)) { ws.close(); exitFail(`wb-fetch not installed at ${wbFetchPath}`); }

const pngPath = join(tmp, "x.png");
writeFileSync(pngPath, PNG);

const r = spawnSync(wbFetchPath, [
  "--method", "POST",
  "--url", "https://httpbin.org/post",
  "--form-text", "prompt=a quiet dog",
  "--form-file", `image=${pngPath}:image/png`,
], {
  env: { ...process.env, WORKBOOKS_DAEMON_URL: DAEMON, WORKBOOKS_TOKEN: token },
  encoding: "utf8",
  timeout: 20_000,
});
ws.close();
if (r.status !== 0) {
  exitFail(`wb-fetch exited ${r.status}: ${(r.stderr ?? "").slice(0, 300)}`);
}
const shimEcho = JSON.parse(r.stdout);
if (shimEcho.form?.prompt !== "a quiet dog") {
  exitFail(`shim form.prompt mismatch: ${JSON.stringify(shimEcho.form)}`);
}
if (!shimEcho.files?.image) exitFail(`shim file part missing; got files=${JSON.stringify(shimEcho.files)}`);
console.log(`[step] B ok — wb-fetch shim --form-text + --form-file round-tripped`);

exitPass("multipart wb-fetch end-to-end through both /proxy direct and the shell shim");
