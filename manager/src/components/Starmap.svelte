<script>
  /**
   * Starmap — pannable / zoomable SVG of a workbook's saves.
   *
   * Layout: each unique file_path is a horizontal "track" (a row).
   * Saves are nodes spaced along the track in chronological order
   * (with even spacing — wall-clock times can be too clustered).
   * Edges connect consecutive saves in time, curving smoothly when
   * the workbook jumps from one path/track to another (the macOS
   * "(1) copy and edit" pattern).
   *
   * Pan: click-and-drag.
   * Zoom: scroll wheel / pinch.
   * Click node: selects it; bound up to parent for the left-pane
   * info display.
   */
  import { agentShort, basename, ago } from "../lib/format.js";
  import { onMount } from "svelte";

  let { history, selectedIdx = $bindable() } = $props();

  // Tracks = unique paths in time-order of first save. Track 0 is
  // the path of the FIRST save (top), then any new path added gets
  // a new track below.
  let tracks = $derived.by(() => {
    const seen = [];
    for (const s of history.saves) {
      if (!seen.includes(s.file_path)) seen.push(s.file_path);
    }
    return seen;
  });

  // Each save → { x, y, ... }
  const NODE_R = 7;
  const COL_W = 100;
  const ROW_H = 70;
  const PAD_X = 80;
  const PAD_Y = 60;

  let nodes = $derived.by(() => {
    return history.saves.map((s, i) => ({
      idx: i,
      save: s,
      x: PAD_X + i * COL_W,
      y: PAD_Y + tracks.indexOf(s.file_path) * ROW_H,
    }));
  });

  let totalW = $derived(PAD_X * 2 + Math.max(1, nodes.length) * COL_W);
  let totalH = $derived(PAD_Y * 2 + Math.max(1, tracks.length) * ROW_H);

  // Pan + zoom state. We transform the inner <g> rather than
  // mutate viewBox — feels smoother and pinch-zoom is cheap.
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);

  let dragging = $state(false);
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Pinch-zoom: WebKit synthesizes wheel events with ctrl held.
      const delta = -e.deltaY * 0.01;
      const next = Math.min(2.5, Math.max(0.4, zoom * (1 + delta)));
      zoom = next;
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
    }
  }
  function onMouseDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, panX, panY };
  }
  function onMouseMove(e) {
    if (!dragging) return;
    panX = dragStart.panX + (e.clientX - dragStart.x);
    panY = dragStart.panY + (e.clientY - dragStart.y);
  }
  function onMouseUp() { dragging = false; }

  function fit(svgRef) {
    if (!svgRef) return;
    const r = svgRef.getBoundingClientRect();
    const zx = (r.width  - 40) / totalW;
    const zy = (r.height - 40) / totalH;
    zoom = Math.min(1, Math.max(0.4, Math.min(zx, zy)));
    panX = (r.width  - totalW * zoom) / 2;
    panY = (r.height - totalH * zoom) / 2;
  }

  let svgRef = $state(null);
  onMount(() => {
    requestAnimationFrame(() => fit(svgRef));
  });
  // Refit when history changes.
  $effect(() => {
    void history.workbook_id;
    requestAnimationFrame(() => fit(svgRef));
  });

  function basenameShort(p) {
    const b = basename(p);
    return b.length > 24 ? b.slice(0, 22) + "…" : b;
  }
</script>

<div class="map-shell">
  <div class="hud">
    <button class="hud-btn" onclick={() => fit(svgRef)} title="Fit to view">
      reset view
    </button>
    <span class="hud-meta">{history.saves.length} saves · {tracks.length} tracks</span>
  </div>

  <svg
    bind:this={svgRef}
    class="map"
    class:dragging
    onwheel={onWheel}
    onmousedown={onMouseDown}
    onmousemove={onMouseMove}
    onmouseup={onMouseUp}
    onmouseleave={onMouseUp}
  >
    <defs>
      <radialGradient id="node-glow-human"   cx="50%" cy="50%"><stop offset="0%" stop-color="var(--c-human)"   stop-opacity="0.5"/><stop offset="100%" stop-color="var(--c-human)"   stop-opacity="0"/></radialGradient>
      <radialGradient id="node-glow-claude"  cx="50%" cy="50%"><stop offset="0%" stop-color="var(--c-claude)"  stop-opacity="0.5"/><stop offset="100%" stop-color="var(--c-claude)"  stop-opacity="0"/></radialGradient>
      <radialGradient id="node-glow-codex"   cx="50%" cy="50%"><stop offset="0%" stop-color="var(--c-codex)"   stop-opacity="0.5"/><stop offset="100%" stop-color="var(--c-codex)"   stop-opacity="0"/></radialGradient>
      <radialGradient id="node-glow-native"  cx="50%" cy="50%"><stop offset="0%" stop-color="var(--c-native)"  stop-opacity="0.5"/><stop offset="100%" stop-color="var(--c-native)"  stop-opacity="0"/></radialGradient>
      <radialGradient id="node-glow-unknown" cx="50%" cy="50%"><stop offset="0%" stop-color="var(--c-unknown)" stop-opacity="0.45"/><stop offset="100%" stop-color="var(--c-unknown)" stop-opacity="0"/></radialGradient>
    </defs>

    <g transform="translate({panX} {panY}) scale({zoom})">
      <!-- Background starfield: very faint dots tiled across the
           plane to give a sense of motion when panning. Cheap,
           static. -->
      <g class="starfield" opacity="0.18">
        {#each Array.from({ length: 60 }) as _, i}
          {@const sx = ((i * 137) % Math.floor(totalW / 1)) }
          {@const sy = (((i * 89) % Math.floor(totalH / 1)) ) }
          <circle cx={sx} cy={sy} r="0.6" fill="#6e7681" />
        {/each}
      </g>

      <!-- Track labels (one per row) -->
      {#each tracks as p, ti (p)}
        <text
          x={PAD_X - 16}
          y={PAD_Y + ti * ROW_H + 4}
          text-anchor="end"
          class="track-label"
        >{basenameShort(p)}</text>
      {/each}

      <!-- Edges: connect each save to the next chronologically.
           If they're on the same track, straight line. Different
           track, smooth cubic bezier. -->
      {#each nodes as n, i (i)}
        {#if i + 1 < nodes.length}
          {@const m = nodes[i + 1]}
          {#if n.y === m.y}
            <line
              x1={n.x + NODE_R} y1={n.y}
              x2={m.x - NODE_R} y2={m.y}
              stroke="rgba(255,255,255,0.18)"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          {:else}
            {@const xMid = (n.x + m.x) / 2}
            <path
              d={`M ${n.x + NODE_R} ${n.y} C ${xMid} ${n.y}, ${xMid} ${m.y}, ${m.x - NODE_R} ${m.y}`}
              stroke="rgba(255,255,255,0.18)"
              stroke-width="1.2"
              stroke-dasharray="2 4"
              fill="none"
              stroke-linecap="round"
            />
          {/if}
        {/if}
      {/each}

      <!-- Nodes -->
      {#each nodes as n (n.idx)}
        {@const a = agentShort(n.save.agent)}
        {@const isActive = selectedIdx === n.idx}
        <g
          class="node"
          class:active={isActive}
          transform="translate({n.x} {n.y})"
          onclick={(e) => { e.stopPropagation(); selectedIdx = n.idx; }}
          role="button"
          tabindex="0"
        >
          <!-- glow -->
          <circle r={NODE_R * 2.2} fill="url(#node-glow-{a})" class="glow" />
          <!-- core -->
          <circle r={NODE_R} class="core core-agent-{a}" />
          {#if isActive}
            <circle r={NODE_R + 4} class="ring" />
          {/if}
          <!-- save index for big maps; suppressed when zoomed out -->
          <text y={NODE_R + 16} text-anchor="middle" class="ts" opacity={zoom > 0.7 ? 1 : 0}>
            {ago(n.save.ts)}
          </text>
        </g>
      {/each}
    </g>
  </svg>

  <div class="legend">
    <span class="lg-item"><span class="dot agent-human"></span>human</span>
    <span class="lg-item"><span class="dot agent-claude"></span>claude</span>
    <span class="lg-item"><span class="dot agent-codex"></span>codex</span>
    <span class="lg-item"><span class="dot agent-native"></span>native</span>
    <span class="lg-item hint">drag to pan · pinch to zoom</span>
  </div>
</div>

<style>
  .map-shell {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .map {
    width: 100%;
    height: 100%;
    cursor: grab;
    background: var(--bg);
    user-select: none;
  }
  .map.dragging { cursor: grabbing; }

  .hud {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    gap: 10px;
    align-items: center;
    z-index: 2;
  }
  .hud-btn {
    height: 22px;
    padding: 0 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--fg-muted);
    font-size: 10.5px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background 100ms ease, color 100ms ease;
  }
  .hud-btn:hover { background: var(--surface-3); color: var(--fg); }
  .hud-meta {
    color: var(--fg-faint);
    font-size: 10.5px;
  }

  .legend {
    position: absolute;
    bottom: 12px; left: 12px;
    display: flex; align-items: center; gap: 12px;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    padding: 6px 10px;
    border-radius: 6px;
    z-index: 2;
  }
  .lg-item {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10.5px;
    color: var(--fg-muted);
    text-transform: lowercase;
  }
  .lg-item.hint { color: var(--fg-faint); margin-left: 4px; }

  .track-label {
    fill: var(--fg-faint);
    font-size: 11px;
    font-family: var(--font-mono);
    font-feature-settings: "tnum";
  }
  .ts {
    fill: var(--fg-faint);
    font-size: 10px;
    font-family: var(--font-mono);
    transition: opacity 120ms ease;
  }
  .node { cursor: pointer; }
  .node .core { stroke: var(--bg); stroke-width: 2; transition: r 100ms ease; }
  .node:hover .core { stroke: rgba(255, 255, 255, 0.4); }
  .node .core-agent-human   { fill: var(--c-human); }
  .node .core-agent-claude  { fill: var(--c-claude); }
  .node .core-agent-codex   { fill: var(--c-codex); }
  .node .core-agent-native  { fill: var(--c-native); }
  .node .core-agent-unknown { fill: var(--c-unknown); }
  .node .ring {
    fill: rgba(255, 255, 255, 0.06);
    stroke: rgba(255, 255, 255, 0.4);
    stroke-width: 1;
  }
  .node .glow { pointer-events: none; }
</style>
