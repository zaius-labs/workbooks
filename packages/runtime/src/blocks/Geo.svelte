<script lang="ts">
  /** Geospatial block — deck.gl on top of a maplibre-gl base map.
   *  WebGL-only; renders a placeholder when WebGL is unavailable.
   *
   *  All five subtypes (points, hex, choropleth, arc, path) share one
   *  Deck instance; the layer set differs by subtype. The base map style
   *  is the OSM tile JSON shipped by maplibre-gl-demo (no API key
   *  required). Future: switch to a host-managed Mapbox token (env
   *  SIGNAL_MAPBOX_TOKEN) for richer styling.
   */
  import type { GeoBlock } from "../types";
  import { onMount } from "svelte";
  import { PALETTE } from "./chart/palette";

  let { block }: { block: GeoBlock } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);

  /* OSM-via-MapLibre demo style. Free, no token. Reasonable for share
   * exports; we may swap to a styled vector tileset later. */
  const BASE_STYLE_URL =
    "https://demotiles.maplibre.org/style.json";

  function hexToRgb(hex: string): [number, number, number] {
    const v = hex.replace("#", "");
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ];
  }

  function fitView(d: GeoBlock["data"]): {
    longitude: number;
    latitude: number;
    zoom: number;
  } {
    const lonLats: [number, number][] = [];
    if (d.subtype === "points" || d.subtype === "hex") {
      for (const p of d.points) lonLats.push([p.lon, p.lat]);
    } else if (d.subtype === "arc") {
      for (const a of d.arcs) {
        lonLats.push([a.from.lon, a.from.lat]);
        lonLats.push([a.to.lon, a.to.lat]);
      }
    } else if (d.subtype === "path") {
      for (const p of d.paths) {
        for (const pt of p.points) lonLats.push([pt.lon, pt.lat]);
      }
    }
    if (lonLats.length === 0) return { longitude: 0, latitude: 20, zoom: 1 };
    const lons = lonLats.map((l) => l[0]);
    const lats = lonLats.map((l) => l[1]);
    const minLon = Math.min(...lons),
      maxLon = Math.max(...lons);
    const minLat = Math.min(...lats),
      maxLat = Math.max(...lats);
    /* Crude zoom heuristic; deck.gl's fitBounds is preferred but adds
     * a viewport-state dance. This is "good enough" for a default
     * view and the user can pan/zoom. */
    const span = Math.max(maxLon - minLon, maxLat - minLat) || 0.01;
    const zoom = Math.max(1, Math.min(14, Math.log2(360 / span) - 1));
    return {
      longitude: (minLon + maxLon) / 2,
      latitude: (minLat + maxLat) / 2,
      zoom,
    };
  }

  onMount(() => {
    if (!host) return;
    const node = host;
    let cancelled = false;
    let deckInstance: { finalize?: () => void } | null = null;
    let mapInstance: { remove?: () => void } | null = null;

    (async () => {
      try {
        const deckMod = await import("@deck.gl/core");
        const layersMod = await import("@deck.gl/layers");
        const aggMod = await import("@deck.gl/aggregation-layers");
        const maplibreMod = await import("maplibre-gl");
        await import("maplibre-gl/dist/maplibre-gl.css");
        if (cancelled) return;

        const Deck = (deckMod as unknown as { Deck: new (opts: unknown) => unknown }).Deck;
        const ScatterplotLayer = (layersMod as unknown as { ScatterplotLayer: unknown })
          .ScatterplotLayer;
        const ArcLayer = (layersMod as unknown as { ArcLayer: unknown }).ArcLayer;
        const PathLayer = (layersMod as unknown as { PathLayer: unknown }).PathLayer;
        const GeoJsonLayer = (layersMod as unknown as { GeoJsonLayer: unknown })
          .GeoJsonLayer;
        const HexagonLayer = (aggMod as unknown as { HexagonLayer: unknown })
          .HexagonLayer;
        const Maplibre = (maplibreMod as unknown as { default: { Map: new (opts: unknown) => unknown } })
          .default.Map ?? (maplibreMod as unknown as { Map: new (opts: unknown) => unknown }).Map;

        const initialView = block.view?.center
          ? {
              longitude: block.view.center[0],
              latitude: block.view.center[1],
              zoom: block.view.zoom ?? 4,
            }
          : fitView(block.data);

        /* Base map. */
        mapInstance = new Maplibre({
          container: node,
          style: BASE_STYLE_URL,
          center: [initialView.longitude, initialView.latitude],
          zoom: initialView.zoom,
          interactive: true,
        }) as { remove?: () => void };

        /* Build deck.gl layers from the subtype. */
        const data = block.data;
        const layers: unknown[] = [];
        const baseColor = hexToRgb(PALETTE[0]);

        if (data.subtype === "points") {
          const groups = Array.from(
            new Set(data.points.map((p) => p.group ?? "")),
          );
          layers.push(
            new (ScatterplotLayer as new (o: unknown) => unknown)({
              id: "points",
              data: data.points,
              getPosition: (p: { lon: number; lat: number }) => [p.lon, p.lat],
              getRadius: (p: { weight?: number }) => Math.max(80, (p.weight ?? 1) * 200),
              getFillColor: (p: { group?: string }) => {
                const gi = groups.indexOf(p.group ?? "");
                return [...hexToRgb(PALETTE[gi % PALETTE.length]), 200];
              },
              radiusMinPixels: 3,
              radiusMaxPixels: 30,
              pickable: true,
            }),
          );
        } else if (data.subtype === "hex") {
          layers.push(
            new (HexagonLayer as new (o: unknown) => unknown)({
              id: "hex",
              data: data.points,
              getPosition: (p: { lon: number; lat: number }) => [p.lon, p.lat],
              getElevationWeight: (p: { weight?: number }) => p.weight ?? 1,
              radius: data.radius ?? 1000,
              elevationScale: 50,
              extruded: true,
              colorRange: [
                [240, 247, 252],
                [191, 221, 242],
                [118, 184, 224],
                [29, 140, 216],
                [90, 78, 192],
                [60, 30, 110],
              ],
            }),
          );
        } else if (data.subtype === "choropleth") {
          const values = data.values;
          const allVals = Object.values(values);
          const min = Math.min(...allVals);
          const max = Math.max(...allVals);
          const range = max - min || 1;
          layers.push(
            new (GeoJsonLayer as new (o: unknown) => unknown)({
              id: "choropleth",
              data: data.geojson,
              filled: true,
              stroked: true,
              getFillColor: (f: { id?: string | number; properties?: Record<string, unknown> }) => {
                const key =
                  data.joinKey && f.properties
                    ? String(f.properties[data.joinKey])
                    : String(f.id ?? "");
                const v = values[key];
                if (v === undefined) return [240, 240, 245, 60];
                const t = (v - min) / range;
                /* Brand sequential ramp lerp between azure and violet. */
                const a = hexToRgb(PALETTE[0]);
                const b = hexToRgb(PALETTE[3]);
                return [
                  Math.round(a[0] + (b[0] - a[0]) * t),
                  Math.round(a[1] + (b[1] - a[1]) * t),
                  Math.round(a[2] + (b[2] - a[2]) * t),
                  200,
                ];
              },
              getLineColor: [15, 15, 15, 60],
              lineWidthMinPixels: 0.5,
              pickable: true,
            }),
          );
        } else if (data.subtype === "arc") {
          layers.push(
            new (ArcLayer as new (o: unknown) => unknown)({
              id: "arcs",
              data: data.arcs,
              getSourcePosition: (a: { from: { lon: number; lat: number } }) => [
                a.from.lon,
                a.from.lat,
              ],
              getTargetPosition: (a: { to: { lon: number; lat: number } }) => [
                a.to.lon,
                a.to.lat,
              ],
              getSourceColor: [...baseColor, 220],
              getTargetColor: [...hexToRgb(PALETTE[1]), 220],
              getWidth: (a: { weight?: number }) =>
                Math.max(1, Math.min(8, (a.weight ?? 1))),
              greatCircle: true,
            }),
          );
        } else if (data.subtype === "path") {
          const groups = Array.from(
            new Set(data.paths.map((p) => p.group ?? "")),
          );
          layers.push(
            new (PathLayer as new (o: unknown) => unknown)({
              id: "paths",
              data: data.paths,
              getPath: (p: { points: { lon: number; lat: number }[] }) =>
                p.points.map((pt) => [pt.lon, pt.lat]),
              getColor: (p: { group?: string }) => {
                const gi = groups.indexOf(p.group ?? "");
                return [...hexToRgb(PALETTE[gi % PALETTE.length]), 220];
              },
              getWidth: 4,
              widthMinPixels: 2,
            }),
          );
        }

        /* Make hovered features pickable + render a small tooltip via
         * deck.gl's built-in `getTooltip` callback. Returns null when
         * nothing is under the cursor; otherwise an object with HTML
         * content + inline styling that matches the rest of the host. */
        for (const layer of layers as Array<Record<string, unknown>>) {
          (layer as Record<string, unknown>).pickable = true;
        }
        const tipStyle =
          "background:" +
          (window.getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim() || "#fff") +
          ";color:" +
          (window.getComputedStyle(document.documentElement).getPropertyValue("--color-fg").trim() || "#0f0f0f") +
          ";border:1px solid " +
          (window.getComputedStyle(document.documentElement).getPropertyValue("--color-border").trim() || "rgba(0,0,0,0.08)") +
          ";border-radius:10px;padding:8px 10px;font-size:11px;line-height:1.4;box-shadow:0 12px 36px rgba(0,0,0,0.12);font-family:ui-sans-serif,system-ui,sans-serif;";
        const escTip = (s: string) =>
          s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        deckInstance = new Deck({
          parent: node,
          initialViewState: { ...initialView, pitch: 0, bearing: 0 },
          controller: true,
          layers,
          getTooltip: ({ object }: { object?: Record<string, unknown> }) => {
            if (!object) return null;
            /* Pick the most informative fields per subtype. We don't
             * know which layer fired, so render whatever scalar fields
             * we find. */
            const rows: string[] = [];
            for (const [k, v] of Object.entries(object)) {
              if (typeof v === "string" || typeof v === "number") {
                rows.push(
                  `<div><span style="color:#888">${escTip(k)}</span> <code>${escTip(String(v))}</code></div>`,
                );
                if (rows.length >= 6) break;
              }
            }
            return {
              html: `<div>${rows.join("")}</div>`,
              style: { /* override browser defaults via cssText */ } as Record<string, string>,
              className: "workbook-deck-tip",
            };
          },
          /* Sync deck.gl view with maplibre when user pans/zooms. */
          onViewStateChange: ({ viewState }: { viewState: { longitude: number; latitude: number; zoom: number; bearing: number; pitch: number } }) => {
            (mapInstance as unknown as {
              jumpTo: (o: unknown) => void;
            } | null)?.jumpTo({
              center: [viewState.longitude, viewState.latitude],
              zoom: viewState.zoom,
              bearing: viewState.bearing,
              pitch: viewState.pitch,
            });
          },
        }) as { finalize?: () => void };
        /* Apply our themed tooltip style globally — deck.gl uses a
         * class on the tooltip element. */
        const styleEl = document.createElement("style");
        styleEl.textContent = `.workbook-deck-tip{ ${tipStyle} pointer-events:none; }`;
        document.head.appendChild(styleEl);
      } catch (e) {
        error = e instanceof Error ? e.message : "Geo render failed";
      }
    })();

    return () => {
      cancelled = true;
      deckInstance?.finalize?.();
      mapInstance?.remove?.();
    };
  });
</script>

<figure
  class="flex flex-col gap-3 rounded-[18px] border border-border bg-surface p-4"
>
  {#if block.title}
    <figcaption class="flex items-center gap-2">
      <span
        class="rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted"
      >
        geo · {block.data.subtype}
      </span>
      <h3 class="text-[14px] font-semibold tracking-tight">{block.title}</h3>
    </figcaption>
  {/if}

  <div bind:this={host} class="relative h-[480px] w-full overflow-hidden rounded-lg"></div>

  {#if error}
    <p class="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
  {/if}

  {#if block.caption}
    <p class="text-[12.5px] text-fg-muted">{block.caption}</p>
  {/if}
</figure>
