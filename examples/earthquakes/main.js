// Earthquakes — bundled USGS snapshot + reactive Polars SQL via the workbook runtime.
//
// All deps inline (vite-plugin-singlefile), data snapshot embedded
// (scripts/snapshot-feed.mjs prepares events.ipc.json before build).
// The artifact is fully self-contained — no live network calls — so it
// works offline and renders under the workbook Worker's strict CSP
// (script-src 'self', no external connect except an explicit allowlist).

import { loadRuntime } from "virtual:workbook-runtime";
import * as d3 from "d3";
import * as topojson from "topojson-client";
import worldAtlas from "world-atlas/countries-110m.json";
import { tableFromIPC } from "workbook:data";
import eventsSnapshot from "./events.ipc.json";

const els = {
  magInput: document.getElementById("mag-min"),
  magOut: document.getElementById("mag-min-out"),
  hoursInput: document.getElementById("hours"),
  hoursOut: document.getElementById("hours-out"),
  count: document.getElementById("m-count"),
  largest: document.getElementById("m-largest"),
  deepest: document.getElementById("m-deepest"),
  felt: document.getElementById("m-felt"),
  map: document.getElementById("map"),
  hist: document.getElementById("hist"),
  hour: document.getElementById("hour"),
};

function showError(msg) {
  const banner = document.createElement("div");
  banner.className = "error-banner";
  banner.textContent = msg;
  document.querySelector(".doc").prepend(banner);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function bootstrap() {
  els.count.textContent = "…";

  const { wasm } = await loadRuntime();
  const ipcBytes = base64ToBytes(eventsSnapshot.b64);
  const fetchedAt = new Date(eventsSnapshot.fetchedAt);

  // Surface the snapshot date in the lede so the reader knows the data
  // freshness without us re-fetching at render time.
  const lede = document.querySelector(".lede");
  if (lede) {
    const stamp = document.createElement("span");
    stamp.style.cssText = "display:block;margin-top:8px;font-size:13px;color:var(--fg-mute);font-family:var(--sans)";
    stamp.textContent = `Snapshot taken ${fetchedAt.toUTCString()} · ${eventsSnapshot.rows.toLocaleString()} events.`;
    lede.appendChild(stamp);
  }

  const magScale = d3.scaleSequential(d3.interpolateInferno).domain([7, 0]);
  const mapState = setupMap(els.map, worldAtlas);

  function recompute() {
    const magMin = parseFloat(els.magInput.value);
    const hours = parseInt(els.hoursInput.value, 10);
    els.magOut.textContent = magMin.toFixed(1);
    els.hoursOut.textContent = `${hours}h`;

    const sinceMs = fetchedAt.getTime() - hours * 3600 * 1000;

    let pointsResult, histResult, hourResult;
    try {
      pointsResult = wasm.runPolarsSqlIpc(
        `SELECT ts, mag, depth, lat, lon, felt
           FROM events
           WHERE mag >= ${magMin} AND ts >= ${sinceMs}
           ORDER BY mag DESC
           LIMIT 600`,
        { events: ipcBytes },
      );
      // Polars SQL is strict about column scope: the GROUP BY phase
      // can only see columns that the SELECT projects. Wrap in a
      // derived table so the bin/hour expression is the only column
      // visible to the outer aggregation.
      histResult = wasm.runPolarsSqlIpc(
        `SELECT mag_bin, COUNT(*) AS n FROM (
           SELECT FLOOR(mag * 2) / 2 AS mag_bin
           FROM events
           WHERE mag >= ${magMin} AND ts >= ${sinceMs}
         ) AS sub
         GROUP BY mag_bin
         ORDER BY mag_bin`,
        { events: ipcBytes },
      );
      hourResult = wasm.runPolarsSqlIpc(
        `SELECT hour, COUNT(*) AS n FROM (
           SELECT (CAST(ts AS BIGINT) / 3600000) % 24 AS hour
           FROM events
           WHERE mag >= ${magMin} AND ts >= ${sinceMs}
         ) AS sub
         GROUP BY hour
         ORDER BY hour`,
        { events: ipcBytes },
      );
    } catch (err) {
      console.error("polars sql failed:", err);
      showError(`Polars SQL failed: ${err.message ?? err}`);
      return;
    }

    const points = toRows(pointsResult);
    const hist = toRows(histResult);
    const hour = toRows(hourResult);

    renderMetrics(points);
    renderMap(mapState, points, magScale);
    renderHistogram(hist);
    renderHour(hour);
  }

  function renderMetrics(rows) {
    els.count.textContent = rows.length.toLocaleString();
    els.largest.textContent = rows.length
      ? Math.max(...rows.map((r) => r.mag)).toFixed(1)
      : "—";
    els.deepest.textContent = rows.length
      ? Math.max(...rows.map((r) => r.depth)).toFixed(0)
      : "—";
    const feltSum = rows.reduce((a, r) => a + Number(r.felt || 0), 0);
    els.felt.textContent = feltSum.toLocaleString();
  }

  function renderMap(state, rows, color) {
    state.dotLayer
      .selectAll("circle")
      .data(rows, (r) => `${r.lat}_${r.lon}_${r.ts}`)
      .join(
        (enter) =>
          enter
            .append("circle")
            .attr("cx", (r) => state.projection([r.lon, r.lat])?.[0] ?? -10)
            .attr("cy", (r) => state.projection([r.lon, r.lat])?.[1] ?? -10)
            .attr("r", (r) => 2 + Math.pow(Math.max(0, r.mag), 1.6))
            .attr("fill", (r) => color(r.mag))
            .attr("fill-opacity", 0.55)
            .attr("stroke", (r) => color(r.mag))
            .attr("stroke-width", 1.2)
            .on("mousemove", (event, r) => {
              state.tooltip
                .style("visibility", "visible")
                .style("left", `${event.clientX + 12}px`)
                .style("top", `${event.clientY + 12}px`)
                .html(
                  `<strong>M ${r.mag.toFixed(1)}</strong> · ${r.depth.toFixed(0)} km depth<br>` +
                    `<span class="tip-coord">${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}°</span><br>` +
                    `<span class="tip-coord">${new Date(Number(r.ts)).toUTCString()}</span>` +
                    (r.felt > 0 ? `<br>${r.felt} felt reports` : ""),
                );
            })
            .on("mouseleave", () => {
              state.tooltip.style("visibility", "hidden");
            }),
        (update) =>
          update
            .attr("cx", (r) => state.projection([r.lon, r.lat])?.[0] ?? -10)
            .attr("cy", (r) => state.projection([r.lon, r.lat])?.[1] ?? -10)
            .attr("r", (r) => 2 + Math.pow(Math.max(0, r.mag), 1.6))
            .attr("fill", (r) => color(r.mag))
            .attr("stroke", (r) => color(r.mag)),
        (exit) => exit.remove(),
      );
  }

  function renderHistogram(rows) {
    const svg = ensureSvg(els.hist);
    svg.selectAll("*").remove();
    if (rows.length === 0) return;
    const w = els.hist.clientWidth;
    const h = els.hist.clientHeight;
    const m = { top: 16, right: 24, bottom: 30, left: 48 };

    const x = d3
      .scaleBand()
      .domain(rows.map((r) => r.mag_bin))
      .range([m.left, w - m.right])
      .padding(0.15);
    const yMax = Math.max(2, ...rows.map((r) => Number(r.n)));
    const y = d3.scaleLog().domain([1, yMax]).range([h - m.bottom, m.top]).clamp(true);

    svg
      .append("g")
      .attr("transform", `translate(0,${h - m.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues(x.domain().filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 8)) === 0))
          .tickFormat((d) => Number(d).toFixed(1)),
      );
    svg
      .append("g")
      .attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4, "~s"));

    svg
      .append("g")
      .attr("fill", "#c8443d")
      .attr("opacity", 0.85)
      .selectAll("rect")
      .data(rows)
      .join("rect")
      .attr("x", (r) => x(r.mag_bin))
      .attr("y", (r) => y(Number(r.n)))
      .attr("width", x.bandwidth())
      .attr("height", (r) => h - m.bottom - y(Number(r.n)));

    // Best-fit line on log-counts → b-value.
    const fitData = rows.filter((r) => Number(r.n) > 1).map((r) => ({ x: Number(r.mag_bin), y: Math.log10(Number(r.n)) }));
    if (fitData.length >= 3) {
      const meanX = d3.mean(fitData, (d) => d.x);
      const meanY = d3.mean(fitData, (d) => d.y);
      const num = d3.sum(fitData, (d) => (d.x - meanX) * (d.y - meanY));
      const den = d3.sum(fitData, (d) => (d.x - meanX) ** 2);
      const slope = den === 0 ? 0 : num / den;
      const intercept = meanY - slope * meanX;
      const xs = d3.extent(fitData, (d) => d.x);
      const lineFn = (xv) => Math.pow(10, intercept + slope * xv);
      const xScale = d3
        .scaleLinear()
        .domain(xs)
        .range([
          x(rows[0].mag_bin) + x.bandwidth() / 2,
          x(rows[rows.length - 1].mag_bin) + x.bandwidth() / 2,
        ]);
      svg
        .append("line")
        .attr("x1", xScale(xs[0]))
        .attr("y1", y(Math.max(1, lineFn(xs[0]))))
        .attr("x2", xScale(xs[1]))
        .attr("y2", y(Math.max(1, lineFn(xs[1]))))
        .attr("stroke", "#0f1115")
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "4 3");
      svg
        .append("text")
        .attr("x", w - m.right)
        .attr("y", m.top + 12)
        .attr("text-anchor", "end")
        .attr("font-family", "ui-monospace, Menlo, monospace")
        .attr("font-size", "11px")
        .attr("fill", "#4b5160")
        .text(`b ≈ ${(-slope).toFixed(2)}`);
    }
  }

  function renderHour(rows) {
    const svg = ensureSvg(els.hour);
    svg.selectAll("*").remove();
    if (rows.length === 0) return;
    const w = els.hour.clientWidth;
    const h = els.hour.clientHeight;
    const m = { top: 16, right: 24, bottom: 30, left: 48 };

    const byHour = new Map(rows.map((r) => [Number(r.hour), Number(r.n)]));
    const filled = d3.range(0, 24).map((hr) => ({ hour: hr, n: byHour.get(hr) ?? 0 }));

    const x = d3.scaleBand().domain(filled.map((r) => r.hour)).range([m.left, w - m.right]).padding(0.1);
    const yMax = Math.max(...filled.map((r) => r.n)) || 1;
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([h - m.bottom, m.top]);

    svg
      .append("g")
      .attr("transform", `translate(0,${h - m.bottom})`)
      .call(d3.axisBottom(x).tickValues(x.domain().filter((_, i) => i % 3 === 0)).tickFormat((d) => `${d}h`));
    svg
      .append("g")
      .attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4));

    svg
      .append("g")
      .attr("fill", "#0f1115")
      .attr("opacity", 0.75)
      .selectAll("rect")
      .data(filled)
      .join("rect")
      .attr("x", (r) => x(r.hour))
      .attr("y", (r) => y(r.n))
      .attr("width", x.bandwidth())
      .attr("height", (r) => h - m.bottom - y(r.n));
  }

  function ensureSvg(host) {
    let svg = d3.select(host).select("svg");
    if (svg.empty()) svg = d3.select(host).append("svg");
    return svg;
  }

  recompute();
  els.magInput.addEventListener("input", recompute);
  els.hoursInput.addEventListener("input", recompute);

  // Re-project on window resize so the map stays at the right size.
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      mapState.resize();
      recompute();
    }, 120);
  });
}

/**
 * Set up an SVG world map using d3-geo + a topojson world atlas. Uses
 * Equirectangular projection — clean, fast, low-distortion at low
 * latitudes (which is where most seismic activity happens). Adds simple
 * d3-zoom for pan + zoom; the tooltip on each dot is a native <title>
 * for ergonomics.
 *
 * Returns an object the caller uses to render dots into a dedicated
 * `<g>` layer, plus a `resize()` callback for window resize events.
 */
function setupMap(host, atlas) {
  // Tooltip — fixed-positioned div that follows the cursor on hover.
  const tooltip = d3
    .select(host)
    .append("div")
    .attr("class", "map-tooltip");

  // Zoom controls — positioned over the map, wired via d3-zoom transitions.
  const controls = d3
    .select(host)
    .append("div")
    .attr("class", "map-controls");
  controls
    .append("button")
    .attr("class", "map-btn")
    .attr("aria-label", "Zoom in")
    .attr("title", "Zoom in")
    .text("+")
    .on("click", () => zoomBy(1.6));
  controls
    .append("button")
    .attr("class", "map-btn")
    .attr("aria-label", "Zoom out")
    .attr("title", "Zoom out")
    .text("−")
    .on("click", () => zoomBy(1 / 1.6));
  controls
    .append("button")
    .attr("class", "map-btn")
    .attr("aria-label", "Reset")
    .attr("title", "Reset")
    .style("font-size", "14px")
    .text("⟲")
    .on("click", () => resetZoom());

  const svg = d3.select(host).append("svg").style("width", "100%").style("height", "100%");
  const w = host.clientWidth;
  const h = host.clientHeight;

  const projection = d3
    .geoEquirectangular()
    .fitSize([w, h], topojson.feature(atlas, atlas.objects.countries));
  const path = d3.geoPath(projection);

  const root = svg.append("g");

  // Ocean background.
  root
    .append("rect")
    .attr("width", w)
    .attr("height", h)
    .attr("fill", "#eef2f5");

  // Country fills.
  root
    .append("path")
    .datum(topojson.feature(atlas, atlas.objects.countries))
    .attr("fill", "#dde2e6")
    .attr("d", path);

  // Country borders.
  root
    .append("path")
    .datum(topojson.mesh(atlas, atlas.objects.countries, (a, b) => a !== b))
    .attr("fill", "none")
    .attr("stroke", "#c5cad0")
    .attr("stroke-width", 0.5)
    .attr("d", path);

  // Plate-boundary friendly graticule (every 30°).
  const graticule = d3.geoGraticule().step([30, 30]);
  root
    .append("path")
    .datum(graticule())
    .attr("fill", "none")
    .attr("stroke", "#c5cad0")
    .attr("stroke-opacity", 0.4)
    .attr("stroke-width", 0.4)
    .attr("d", path);

  // Dot layer — sits on top so circles draw over country fills.
  const dotLayer = root.append("g").attr("class", "dot-layer");

  // Pan + zoom.
  const zoom = d3
    .zoom()
    .scaleExtent([1, 8])
    .translateExtent([[0, 0], [w, h]])
    .on("zoom", (event) => {
      root.attr("transform", event.transform);
      // Keep dot strokes/sizes constant in screen-space as we zoom.
      dotLayer
        .selectAll("circle")
        .attr("vector-effect", "non-scaling-stroke")
        .attr("r", function (r) {
          const baseR = 2 + Math.pow(Math.max(0, r.mag), 1.6);
          return baseR / event.transform.k;
        });
    });
  svg.call(zoom);

  function zoomBy(factor) {
    svg.transition().duration(220).call(zoom.scaleBy, factor);
  }
  function resetZoom() {
    svg.transition().duration(280).call(zoom.transform, d3.zoomIdentity);
  }

  function resize() {
    const wNow = host.clientWidth;
    const hNow = host.clientHeight;
    svg.attr("viewBox", `0 0 ${wNow} ${hNow}`);
    projection.fitSize([wNow, hNow], topojson.feature(atlas, atlas.objects.countries));
  }

  return { svg, projection, path, dotLayer, tooltip, resize };
}

/**
 * Decode whatever shape `runPolarsSqlIpc` returns into row objects.
 * The runtime returns Arrow IPC stream bytes (Uint8Array). We decode
 * via apache-arrow.tableFromIPC and toArray() into plain row objects.
 *
 * Defensive fallbacks for other shapes (array, rows-array,
 * record-of-columns) are kept in case the runtime returns a
 * pre-decoded form on some code paths.
 */
function toRows(result) {
  if (!result) return [];
  // Polars's runPolarsSqlIpc returns a tuple-shaped array of "outputs":
  //   [ { kind: "text", mime_type: "text/csv", content: "csv string" },
  //     { kind: "table", row_count: N, sql_table: "result" } ]
  // The "text" entry's content is the CSV-serialized result. Parse it
  // with d3.csvParse + autoType so numeric columns come back as Numbers
  // (and BigInts for very-large integers don't poison downstream math).
  if (Array.isArray(result)) {
    const csvOut = result.find(
      (o) =>
        o &&
        typeof o === "object" &&
        o.kind === "text" &&
        typeof o.content === "string" &&
        (o.mime_type === "text/csv" || o.mime_type?.startsWith("text/csv")),
    );
    if (csvOut?.content) {
      return d3.csvParse(csvOut.content, d3.autoType);
    }
    // Plain row array — return as-is.
    if (result.every((r) => r && typeof r === "object" && !("kind" in r))) {
      return result;
    }
  }
  // Defensive fallbacks for other shapes.
  if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
    try {
      const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
      if (bytes.byteLength === 0) return [];
      const table = tableFromIPC(bytes);
      // toArray() returns Proxy objects backed by the columnar data;
      // unwrap to plain row objects so downstream code can spread/clone
      // freely.
      return table.toArray().map((row) => {
        const out = {};
        for (const f of table.schema.fields) {
          let v = row[f.name];
          // Arrow returns BigInt for i64 columns. Convert to Number for
          // anything that fits — easier to feed into d3/leaflet.
          if (typeof v === "bigint") {
            const n = Number(v);
            v = Number.isSafeInteger(n) ? n : v;
          }
          out[f.name] = v;
        }
        return out;
      });
    } catch (err) {
      console.warn("[earthquakes] arrow decode failed:", err);
      return [];
    }
  }
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    if (Array.isArray(result.rows)) return result.rows;
    const cols = Object.keys(result);
    if (cols.length > 0 && Array.isArray(result[cols[0]])) {
      const n = result[cols[0]].length;
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const row = {};
        for (const c of cols) row[c] = result[c][i];
        out[i] = row;
      }
      return out;
    }
  }
  return [];
}

bootstrap().catch((err) => {
  console.error("bootstrap failed:", err);
  showError(`Could not load: ${err.message ?? err}`);
});
