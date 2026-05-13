<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { setPresentationContext } from "./context";

  let {
    aspectRatio = "16:9",
    title = null,
    showControls = true,
    children,
  }: {
    aspectRatio?: string | number;
    title?: string | null;
    showControls?: boolean;
    children?: import("svelte").Snippet;
  } = $props();

  let current = $state(0);
  let slides = $state<symbol[]>([]);
  let printMode = $state(false);

  const ratio = $derived(parseAspectRatio(aspectRatio));
  const ratioCss = $derived(`${ratio.width} / ${ratio.height}`);
  const ratioValue = $derived(String(ratio.width / ratio.height));
  const progress = $derived(slides.length === 0 ? "0 / 0" : `${current + 1} / ${slides.length}`);

  function clamp(index: number): number {
    if (slides.length === 0) return 0;
    return Math.max(0, Math.min(slides.length - 1, index));
  }

  function goTo(index: number): void {
    current = clamp(index);
  }

  function next(): void {
    goTo(current + 1);
  }

  function previous(): void {
    goTo(current - 1);
  }

  function register(id: symbol): number {
    const existing = slides.indexOf(id);
    if (existing !== -1) return existing;
    slides = [...slides, id];
    return slides.length - 1;
  }

  function unregister(id: symbol): void {
    const index = slides.indexOf(id);
    if (index === -1) return;
    slides = slides.filter((slide) => slide !== id);
    if (current >= slides.length) current = clamp(slides.length - 1);
  }

  function indexOf(id: symbol): number {
    return slides.indexOf(id);
  }

  setPresentationContext({
    register,
    unregister,
    goTo,
    next,
    previous,
    indexOf,
    get current() { return current; },
    get count() { return slides.length; },
    get printMode() { return printMode; },
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;

    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      next();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      previous();
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(slides.length - 1);
    }
  }

  onMount(() => {
    printMode = window.matchMedia?.("print").matches ?? false;
    const media = window.matchMedia?.("print");
    const onPrint = (event: MediaQueryListEvent) => {
      printMode = event.matches;
    };
    media?.addEventListener?.("change", onPrint);
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("beforeprint", () => (printMode = true));
    window.addEventListener("afterprint", () => (printMode = false));

    return () => {
      media?.removeEventListener?.("change", onPrint);
      window.removeEventListener("keydown", onKeydown);
    };
  });

  onDestroy(() => {
    slides = [];
  });

  function parseAspectRatio(value: string | number): { width: number; height: number } {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return { width: value, height: 1 };
    }
    const raw = String(value).trim();
    const match = raw.match(/^(\d+(?:\.\d+)?)(?::|\/)(\d+(?:\.\d+)?)$/);
    if (!match) return { width: 16, height: 9 };
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { width: 16, height: 9 };
    }
    return { width, height };
  }
</script>

<div
  class="workbook-presentation"
  class:print-mode={printMode}
  style:--wbp-aspect={ratioCss}
  style:--wbp-ratio={ratioValue}
  data-workbook-presentation
>
  {#if showControls}
    <div class="workbook-presentation-controls" data-print-hidden>
      <div class="workbook-presentation-title">{title ?? ""}</div>
      <div class="workbook-presentation-actions">
        <button type="button" onclick={previous} disabled={current === 0} aria-label="Previous slide">‹</button>
        <span>{progress}</span>
        <button type="button" onclick={next} disabled={current >= slides.length - 1} aria-label="Next slide">›</button>
      </div>
    </div>
  {/if}

  <div class="workbook-presentation-viewport">
    <div class="workbook-presentation-stage">
      {@render children?.()}
    </div>
  </div>
</div>

<style>
  :global(.workbook-presentation) {
    --wbp-bg: #101014;
    --wbp-panel: rgba(255, 255, 255, 0.08);
    --wbp-panel-border: rgba(255, 255, 255, 0.16);
    --wbp-fg: #f7f7f7;
    --wbp-muted: rgba(247, 247, 247, 0.68);
    min-height: 100vh;
    background: var(--wbp-bg);
    color: var(--wbp-fg);
    display: grid;
    grid-template-rows: auto 1fr;
  }

  :global(.workbook-presentation-controls) {
    min-height: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 12px;
    font: 500 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--wbp-muted);
  }

  :global(.workbook-presentation-title) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.workbook-presentation-actions) {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
  }

  :global(.workbook-presentation-actions button) {
    width: 32px;
    height: 32px;
    border: 1px solid var(--wbp-panel-border);
    border-radius: 999px;
    background: var(--wbp-panel);
    color: var(--wbp-fg);
    font: inherit;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }

  :global(.workbook-presentation-actions button:disabled) {
    opacity: 0.35;
    cursor: default;
  }

  :global(.workbook-presentation-viewport) {
    width: 100%;
    min-width: 0;
    min-height: 0;
    height: calc(100vh - 48px);
    display: grid;
    place-items: center;
    padding: 16px;
    box-sizing: border-box;
    overflow: hidden;
  }

  :global(.workbook-presentation-stage) {
    position: relative;
    width: min(100%, calc((100vh - 80px) * var(--wbp-ratio)));
    height: auto;
    max-height: 100%;
    aspect-ratio: var(--wbp-aspect);
    overflow: hidden;
    background: #fff;
    color: #111;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
  }

  :global(.workbook-slide) {
    position: absolute;
    inset: 0;
    display: none;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    overflow: hidden;
  }

  :global(.workbook-slide.active) {
    display: block;
  }

  :global(.workbook-slide-inner) {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }

  :global(.workbook-presentation.print-mode) {
    display: block;
    min-height: auto;
    background: #fff;
    color: #111;
  }

  :global(.workbook-presentation.print-mode [data-print-hidden]) {
    display: none;
  }

  :global(.workbook-presentation.print-mode .workbook-presentation-viewport) {
    display: block;
    height: auto;
    padding: 0;
    overflow: visible;
  }

  :global(.workbook-presentation.print-mode .workbook-presentation-stage) {
    width: 100%;
    height: auto;
    max-height: none;
    overflow: visible;
    box-shadow: none;
  }

  :global(.workbook-presentation.print-mode .workbook-slide) {
    position: relative;
    display: block;
    aspect-ratio: var(--wbp-aspect);
    break-after: page;
    page-break-after: always;
  }

  @media print {
    :global(.workbook-presentation) {
      display: block;
      min-height: auto;
      background: #fff;
      color: #111;
    }

    :global(.workbook-presentation [data-print-hidden]) {
      display: none;
    }

    :global(.workbook-presentation-viewport) {
      display: block;
      height: auto;
      padding: 0;
      overflow: visible;
    }

    :global(.workbook-presentation-stage) {
      width: 100%;
      height: auto;
      max-height: none;
      overflow: visible;
      box-shadow: none;
    }

    :global(.workbook-slide) {
      position: relative;
      display: block;
      aspect-ratio: var(--wbp-aspect);
      break-after: page;
      page-break-after: always;
    }
  }
</style>
