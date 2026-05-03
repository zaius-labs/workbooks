// Shared helper: discover the running daemon's URL from
// runtime.json. Used by every E2E test so they don't need to
// know the (now-randomized) port. Mirrors what daemon-side
// read_runtime_port() does.

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

function runtimeStateDir() {
  const home = homedir();
  return platform() === "darwin"
    ? join(home, "Library/Application Support/sh.workbooks.workbooksd")
    : join(home, ".local/share/workbooksd");
}

export function daemonUrl() {
  let port;
  try {
    const body = readFileSync(join(runtimeStateDir(), "runtime.json"), "utf8");
    port = JSON.parse(body).port;
  } catch {
    throw new Error(
      "could not read runtime.json — is workbooksd running? " +
      "(launchctl list | grep workbooks; or run ~/.local/bin/workbooksd)",
    );
  }
  if (typeof port !== "number") throw new Error(`runtime.json has no numeric port: ${JSON.stringify(port)}`);
  return `http://127.0.0.1:${port}`;
}
