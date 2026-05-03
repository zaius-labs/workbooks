<script>
  /**
   * Drag region + an optional Back affordance. Keeps the chrome
   * at one consistent height across views.
   */
  import { iconChevronLeft } from "../lib/icons.js";
  let { onBack = null } = $props();
</script>

<div class="titlebar">
  {#if onBack}
    <button class="back" onclick={onBack}>
      {@html iconChevronLeft}
      <span>All workbooks</span>
    </button>
  {/if}
</div>

<style>
  .titlebar {
    height: 36px;
    -webkit-app-region: drag;
    flex: 0 0 auto;
    background: var(--bg);
    display: flex;
    align-items: center;
    padding: 0 14px 0 80px;
  }
  .back {
    -webkit-app-region: no-drag;
    height: 24px; padding: 0 8px 0 6px;
    background: transparent;
    border: 0;
    color: var(--fg-muted);
    font-size: 12px;
    border-radius: 5px;
    display: inline-flex; align-items: center; gap: 4px;
    cursor: pointer;
    transition: background 80ms ease, color 80ms ease;
  }
  .back:hover { background: var(--surface-2); color: var(--fg); }
</style>
