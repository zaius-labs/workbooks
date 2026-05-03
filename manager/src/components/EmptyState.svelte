<script>
  let { title, body = [], action = null } = $props();
</script>

<main>
  <div class="card">
    <h1>{title}</h1>
    {#each body as paragraph}
      <p>{paragraph}</p>
    {/each}
    {#if action}
      <div class="actions">
        <button class="primary" onclick={action.onClick}>{action.label}</button>
      </div>
    {/if}
  </div>
</main>

<style>
  main {
    flex: 1 1 auto;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg);
    padding: 24px;
  }
  .card {
    max-width: 440px;
    padding: 28px 32px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  h1 {
    font-size: 16px; font-weight: 500;
    margin: 0 0 12px;
    color: var(--fg);
    letter-spacing: -0.01em;
  }
  p {
    margin: 0 0 10px;
    color: var(--fg-muted);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .actions {
    margin-top: 16px;
    display: flex; gap: 8px;
  }
</style>
