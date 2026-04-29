<script lang="ts">
  /** Network graph block — Cytoscape default. The 'sigma' engine is
   *  reserved on the schema for >1K nodes but not yet wired; falls
   *  back to Cytoscape for now with a warning. */
  import type { NetworkBlock } from "../types";
  import { onMount } from "svelte";
  import { PALETTE } from "./chart/palette";

  let { block }: { block: NetworkBlock } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let error = $state<string | null>(null);

  onMount(() => {
    if (!host) return;
    const node = host;
    let cancelled = false;
    let cy: { destroy?: () => void } | null = null;

    (async () => {
      try {
        const cytoscape = (await import("cytoscape")).default;
        if (block.layout === "dagre") {
          // Side-effect import — registers the dagre layout.
          // cytoscape-dagre ships no .d.ts; treat as opaque.
          const dagreMod = (await import(
            // @ts-expect-error — no type declarations for cytoscape-dagre
            "cytoscape-dagre"
          )) as { default: unknown };
          (cytoscape as unknown as { use: (ext: unknown) => void }).use(
            dagreMod.default,
          );
        }
        if (cancelled) return;

        /* Build Cytoscape elements from the typed schema. */
        const groups = Array.from(
          new Set(block.nodes.map((n) => n.group ?? "")),
        );
        const groupColor = Object.fromEntries(
          groups.map((g, i) => [g, PALETTE[i % PALETTE.length]]),
        );

        const elements = [
          ...block.nodes.map((n) => ({
            data: {
              id: n.id,
              label: n.label ?? n.id,
              group: n.group ?? "",
              weight: n.weight ?? 1,
              color: groupColor[n.group ?? ""] ?? PALETTE[0],
            },
          })),
          ...block.edges.map((e) => ({
            data: {
              id: `${e.source}->${e.target}`,
              source: e.source,
              target: e.target,
              weight: e.weight ?? 1,
              directed: e.directed === true,
              label: e.label ?? "",
            },
          })),
        ];

        /* Resolve theme tokens at render time so labels and edges
         * stay legible across light/dark mode. */
        const readVar = (name: string, fallback: string): string => {
          const v = getComputedStyle(document.documentElement)
            .getPropertyValue(name)
            .trim();
          return v || fallback;
        };
        const fg = readVar("--color-fg", "#0f0f0f");
        const fgMuted = readVar("--color-fg-muted", "rgba(15,15,15,0.6)");
        const border = readVar("--color-border-strong", "rgba(15,15,15,0.2)");
        const guide = readVar("--color-fg-subtle", "rgba(15,15,15,0.36)");

        /* Floating tooltip element — one per chart, shared across all
         * nodes/edges. Positioned with the cursor; z-indexed above the
         * cytoscape canvas. */
        const tip = document.createElement("div");
        tip.className = "sdoc-net-tip";
        tip.setAttribute("role", "tooltip");
        tip.style.cssText =
          "position:absolute; pointer-events:none; opacity:0; transform:translateY(2px); transition:opacity 120ms,transform 120ms; z-index:50;" +
          "background:" + readVar("--color-surface", "#fff") +
          ";color:" + readVar("--color-fg", "#0f0f0f") +
          ";border:1px solid " + readVar("--color-border", "rgba(0,0,0,0.08)") +
          ";border-radius:10px; padding:8px 10px; font-size:11px; line-height:1.4; box-shadow:0 12px 36px rgba(0,0,0,0.12);" +
          "font-family:ui-sans-serif,system-ui,sans-serif; max-width:240px;";
        node.style.position = node.style.position || "relative";
        node.appendChild(tip);
        const escTip = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        cy = cytoscape({
          container: node,
          elements,
          style: [
            {
              selector: "node",
              style: {
                "background-color": "data(color)",
                label: "data(label)",
                "font-size": 10,
                "font-family": "ui-sans-serif, system-ui, sans-serif",
                color: fg,
                "text-valign": "bottom",
                "text-margin-y": 4,
                width: "mapData(weight, 1, 20, 14, 36)",
                height: "mapData(weight, 1, 20, 14, 36)",
                "border-width": 1,
                "border-color": border,
              },
            },
            {
              selector: "edge",
              style: {
                width: "mapData(weight, 1, 10, 1, 4)",
                "line-color": guide,
                "curve-style": "bezier",
              },
            },
            {
              selector: "edge[?directed]",
              style: {
                "target-arrow-shape": "triangle",
                "target-arrow-color": fgMuted,
                "arrow-scale": 0.8,
              },
            },
            {
              selector: "edge[label]",
              style: {
                label: "data(label)",
                "font-size": 9,
                color: fgMuted,
                "text-rotation": "autorotate",
                "text-margin-y": -4,
              },
            },
          ],
          /* Cytoscape's LayoutOptions is a discriminated union per
           * layout name; cast through unknown so we don't have to
           * enumerate every variant just to set { name, animate }. */
          layout: { name: block.layout, animate: false } as unknown as {
            name: string;
          },
        });

        /* Hover bindings — show node + edge details in the floating
         * tooltip. Cytoscape returns the original data object via
         * `target.data()`, which carries the fields we set above. */
        const nodeById = new Map(block.nodes.map((n) => [n.id, n] as const));
        const showTip = (html: string, ev: { renderedPosition: { x: number; y: number } }) => {
          tip.innerHTML = html;
          tip.style.left = `${ev.renderedPosition.x + 12}px`;
          tip.style.top = `${ev.renderedPosition.y + 12}px`;
          tip.style.opacity = "1";
          tip.style.transform = "translateY(0)";
        };
        const hideTip = () => {
          tip.style.opacity = "0";
          tip.style.transform = "translateY(2px)";
        };
        const cyAny = cy as unknown as {
          on: (
            ev: string,
            selector: string,
            cb: (e: {
              target: { data: () => Record<string, unknown> };
              renderedPosition: { x: number; y: number };
            }) => void,
          ) => void;
        };
        cyAny.on("mouseover", "node", (e) => {
          const data = e.target.data();
          const id = String(data.id);
          const original = nodeById.get(id);
          const rows: string[] = [];
          rows.push(
            `<div style="font-weight:600;margin-bottom:4px">${escTip(String(data.label ?? id))}</div>`,
          );
          if (original?.group) rows.push(`<div><span style="color:${fgMuted}">group</span> <code>${escTip(original.group)}</code></div>`);
          if (original?.weight != null) rows.push(`<div><span style="color:${fgMuted}">weight</span> <code>${original.weight}</code></div>`);
          rows.push(`<div><span style="color:${fgMuted}">id</span> <code>${escTip(id)}</code></div>`);
          showTip(rows.join(""), e);
        });
        cyAny.on("mouseover", "edge", (e) => {
          const data = e.target.data();
          const html = `<div><strong>${escTip(String(data.source ?? ""))}</strong> → <strong>${escTip(String(data.target ?? ""))}</strong>${data.label ? `<div style="color:${fgMuted};margin-top:2px">${escTip(String(data.label))}</div>` : ""}${data.weight != null ? `<div style="color:${fgMuted};margin-top:2px">weight: <code>${data.weight}</code></div>` : ""}</div>`;
          showTip(html, e);
        });
        cyAny.on("mouseout", "node", hideTip);
        cyAny.on("mouseout", "edge", hideTip);
      } catch (e) {
        error = e instanceof Error ? e.message : "Network render failed";
      }
    })();

    return () => {
      cancelled = true;
      cy?.destroy?.();
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
        network · {block.layout}
      </span>
      <h3 class="text-[14px] font-semibold tracking-tight">{block.title}</h3>
    </figcaption>
  {/if}

  <div bind:this={host} class="h-[420px] w-full"></div>

  {#if error}
    <p class="text-[12px] text-rose-700 dark:text-rose-300">{error}</p>
  {/if}

  {#if block.caption}
    <p class="text-[12.5px] text-fg-muted">{block.caption}</p>
  {/if}
</figure>
