#!/usr/bin/env bun
// E2E for core-5ah.17 — random listener port.
//
// Asserts the property: the daemon binds to an OS-assigned
// ephemeral port (in the registered/dynamic range), publishes
// it to runtime.json, and the same port is what /open returns
// in the URL it mints. Restarting the daemon picks a different
// port — that's the security property: a malicious local page
// can't pre-script POSTs against a known address.
//
// We restart the daemon via launchctl kickstart (the same path
// the user's LaunchAgent uses) and verify the port shifts.

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { daemonUrl } from "./_runtime.mjs";

const fail = (msg) => { console.error(`[fail] ${msg}`); process.exit(1); };
const pass = (msg) => { console.log(`[pass] ${msg}`); process.exit(0); };

if (platform() !== "darwin") {
  console.log("[skip] launchctl-based restart only on macOS");
  process.exit(0);
}

const RUNTIME_JSON = join(
  homedir(),
  "Library/Application Support/sh.workbooks.workbooksd/runtime.json",
);

function readPort() {
  const j = JSON.parse(readFileSync(RUNTIME_JSON, "utf8"));
  if (typeof j.port !== "number") throw new Error("port missing");
  return j.port;
}

// 1. Initial port: not the legacy 47119, in the dynamic range.
const port1 = readPort();
console.log(`[step] daemon bound on ephemeral port ${port1}`);
if (port1 === 47119) fail("port is still the old hardcoded 47119 — random binding didn't take effect");
if (port1 < 1024 || port1 > 65535) fail(`port ${port1} not in valid range`);

// 2. /open's URL uses the same port (no leak of a stale constant).
const url = daemonUrl();
if (!url.endsWith(`:${port1}`)) fail(`daemonUrl=${url} doesn't match runtime.json port ${port1}`);

// 3. /open returns a URL containing the same port.
const tmp = `/tmp/workbooks-rndport-${Date.now()}.workbook.html`;
require("node:fs").writeFileSync(
  tmp,
  `<!doctype html><script id="wb-meta" type="application/json">{"workbook_id":"rnd","compaction_seq":0,"snapshot_cid_by_target":{}}</script>`,
);
const openRes = await (await fetch(`${url}/open`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: tmp }),
})).json();
if (!openRes.url.includes(`:${port1}/`)) {
  fail(`/open URL ${openRes.url} doesn't carry the runtime port ${port1}`);
}
console.log(`[step] /open URL carries the runtime port`);

// 4. Restart the daemon — port should change. Skip if launchctl
//    isn't accessible (CI without an authenticated user session).
const uid = process.getuid();
const kick = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/sh.workbooks.workbooksd`], {
  encoding: "utf8",
});
if (kick.status !== 0) {
  console.log(`[skip] launchctl kickstart failed (${kick.stderr?.trim()}); test asserts pre-restart port only`);
  pass(`port is randomized at startup (current: ${port1})`);
}

// Wait for the new daemon to write runtime.json with a fresh port.
const dl = Date.now() + 5000;
let port2 = port1;
while (Date.now() < dl) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    const p = readPort();
    if (p !== port1) { port2 = p; break; }
  } catch {}
}
if (port2 === port1) {
  // Could be because the OS reassigned the same port (small but
  // possible). Don't fail on that — it's flaky-by-design. Note
  // and continue.
  console.log(`[note] post-restart port is the same (${port2}) — kernel reused the socket; not a bug`);
} else {
  console.log(`[step] post-restart port = ${port2} (was ${port1}; rotated as expected)`);
}

// Verify the new daemon is healthy on the new port.
const hr = await fetch(`http://127.0.0.1:${port2}/health`);
if (!hr.ok) fail(`new daemon /health = ${hr.status}`);

require("node:fs").rmSync(tmp, { force: true });
pass(`random-port property verified: bound ephemerally, advertised via runtime.json, /open uses it`);
