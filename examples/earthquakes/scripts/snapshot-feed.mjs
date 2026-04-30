#!/usr/bin/env node
// Fetch the USGS all-week feed and emit a base64-encoded Arrow IPC stream
// that the workbook embeds as <wb-memory id="events">. Run before
// `workbook build` so the artifact ships fully self-contained — no
// `connect-src` allowance to USGS needed at render time.

import { writeFileSync } from "node:fs";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { createHash } from "node:crypto";

const URL_USGS =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
const out = process.argv[2] ?? "events.ipc.json";

console.log(`fetching ${URL_USGS}…`);
const geo = await fetch(URL_USGS).then((r) => r.json());
const rows = (geo.features ?? [])
  .map((f) => {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates ?? [0, 0, 0];
    return {
      ts: Number(p.time) || 0,
      mag: Number(p.mag) || 0,
      depth: Number(c[2]) || 0,
      lat: Number(c[1]) || 0,
      lon: Number(c[0]) || 0,
      felt: Number(p.felt) || 0,
    };
  })
  .filter((r) => r.ts > 0 && Number.isFinite(r.mag));

console.log(`  rows: ${rows.length}`);

const table = tableFromArrays({
  ts: BigInt64Array.from(rows.map((r) => BigInt(r.ts))),
  mag: Float64Array.from(rows.map((r) => r.mag)),
  depth: Float64Array.from(rows.map((r) => r.depth)),
  lat: Float64Array.from(rows.map((r) => r.lat)),
  lon: Float64Array.from(rows.map((r) => r.lon)),
  felt: BigInt64Array.from(rows.map((r) => BigInt(r.felt ?? 0))),
});
const ipc = tableToIPC(table, "stream");
const sha256 = createHash("sha256").update(ipc).digest("hex");
const b64 = Buffer.from(ipc).toString("base64");
writeFileSync(
  out,
  JSON.stringify(
    {
      b64,
      sha256,
      rows: rows.length,
      bytes: ipc.byteLength,
      fetchedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(
  `wrote ${out} — ${ipc.byteLength} bytes IPC, sha256=${sha256.slice(0, 16)}…`,
);
