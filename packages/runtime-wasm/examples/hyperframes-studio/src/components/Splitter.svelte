<script>
  // Generic drag handle. Doesn't own size state — the parent does. We
  // emit a delta (in px) on each pointermove and the parent applies
  // it to whatever dimension it's tracking. axis="vertical" means the
  // handle is a vertical bar that drags horizontally (between columns);
  // axis="horizontal" means a horizontal bar that drags vertically
  // (between rows).
  let {
    axis = "vertical",
    onDrag,
    label = "Resize",
  } = $props();

  let dragging = $state(false);
  let last = 0;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    last = axis === "vertical" ? e.clientX : e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Apply a global cursor + disable selection for the duration of
    // the drag — otherwise fast moves outside the handle drop the
    // cursor back to default and start selecting page text.
    document.body.style.cursor = axis === "vertical" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const cur = axis === "vertical" ? e.clientX : e.clientY;
    const delta = cur - last;
    last = cur;
    if (delta !== 0) onDrag?.(delta);
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
</script>

<div
  role="separator"
  aria-orientation={axis === "vertical" ? "vertical" : "horizontal"}
  aria-label={label}
  tabindex="0"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  class="splitter group relative"
  class:vertical={axis === "vertical"}
  class:horizontal={axis === "horizontal"}
  class:dragging
>
  <div class="grip"></div>
</div>

<style>
  .splitter {
    flex-shrink: 0;
    background: transparent;
    z-index: 5;
    transition: background 120ms ease;
  }
  .splitter.vertical {
    width: 6px;
    cursor: col-resize;
    align-self: stretch;
  }
  .splitter.horizontal {
    height: 6px;
    cursor: row-resize;
    width: 100%;
  }
  .splitter:hover, .splitter.dragging {
    background: color-mix(in srgb, var(--color-accent) 35%, transparent);
  }
  /* Visible grip bar — subtle until hovered, then accent-tinted.
     Sits centered along the handle's perpendicular axis. */
  .grip {
    position: absolute;
    background: var(--color-border);
    border-radius: 2px;
    transition: background 120ms ease;
    pointer-events: none;
  }
  .splitter.vertical .grip {
    top: 50%;
    left: 50%;
    width: 2px;
    height: 28px;
    transform: translate(-50%, -50%);
  }
  .splitter.horizontal .grip {
    top: 50%;
    left: 50%;
    width: 28px;
    height: 2px;
    transform: translate(-50%, -50%);
  }
  .splitter:hover .grip, .splitter.dragging .grip {
    background: var(--color-accent);
  }
</style>
