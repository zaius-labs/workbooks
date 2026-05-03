<script>
  // The editor is a tiny demo of the workbook runtime callable from
  // a Svelte component. It lazy-imports virtual:workbook-runtime so
  // pages that don't need wasm don't pay for it.
  let sql = $state("SELECT region, SUM(revenue) AS total FROM data GROUP BY region ORDER BY total DESC");
  let csv = $state(`region,revenue,churn
us,12000,0.04
us,8400,0.11
eu,15600,0.02
eu,3200,0.18
apac,21000,0.05
apac,4400,0.22`);
  let result = $state("");
  let running = $state(false);
  let error = $state("");

  async function run() {
    running = true;
    error = "";
    result = "";
    try {
      const { loadRuntime } = await import("virtual:workbook-runtime");
      const { wasm } = await loadRuntime();
      const outputs = wasm.runPolarsSql(sql, csv);
      const csvOut = outputs.find((o) => o.kind === "text" && o.mime_type === "text/csv");
      result = csvOut ? csvOut.content : JSON.stringify(outputs, null, 2);
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      running = false;
    }
  }
</script>

<section>
  <h1>Editor</h1>
  <p>
    Polars-SQL against an in-memory CSV. The wasm runtime loads on
    first run; subsequent runs are warm.
  </p>

  <label>
    <span class="lbl">CSV</span>
    <textarea bind:value={csv} rows="8"></textarea>
  </label>

  <label>
    <span class="lbl">SQL</span>
    <textarea bind:value={sql} rows="3"></textarea>
  </label>

  <div class="controls">
    <button onclick={run} disabled={running}>{running ? "running…" : "run"}</button>
  </div>

  {#if error}
    <pre class="err">{error}</pre>
  {/if}
  {#if result}
    <pre class="result">{result}</pre>
  {/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  h1 { font-size: 24px; font-weight: 700; margin: 0; }
  p { font-size: 14px; color: #707070; margin: 0 0 8px; }
  label { display: grid; gap: 4px; }
  .lbl {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #707070;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  textarea {
    width: 100%; box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid #d6d6d6; border-radius: 4px;
    background: #ffffff; color: #000000;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; line-height: 1.5;
    resize: vertical;
  }
  textarea:focus { outline: 1px solid #000000; outline-offset: -1px; border-color: #000000; }
  .controls { display: flex; gap: 8px; }
  button {
    padding: 6px 14px;
    border: 1px solid #000000; border-radius: 4px;
    background: #000000; color: white;
    font-size: 13px; cursor: pointer;
  }
  button:hover:not(:disabled) { background: #2a2a2a; border-color: #2a2a2a; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  pre {
    margin: 8px 0 0;
    padding: 10px 12px;
    background: #f5f5f5; border: 1px solid #d6d6d6; border-radius: 4px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word;
    max-height: 360px; overflow: auto;
  }
  pre.err { color: #000000; background: #f5f5f5; border: 2px solid #000000; font-weight: 600; }
  pre.result { color: #000000; }
</style>
