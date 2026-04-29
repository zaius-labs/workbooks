<script>
  let { entry } = $props();   // { cell, state }

  function csvToTable(csv) {
    const rows = csv.trim().split("\n").map(parseCsvRow);
    return { head: rows[0], body: rows.slice(1) };
  }
  function parseCsvRow(row) {
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function isNumeric(s) { return s !== "" && !isNaN(Number(s)); }
</script>

<div class="cell {entry.state.status}">
  <div class="head">
    <span class="lhs">
      <span class="dot"></span>
      <span class="id">{entry.cell.id}</span>
    </span>
    <span class="lang">{entry.cell.language}</span>
    <span class="status">
      {#if entry.state.status === "running"}running…{:else if entry.state.status === "ok"}{entry.state.lastRunMs ?? "ok"} ms{:else if entry.state.status === "error"}error{/if}
    </span>
  </div>
  <pre class="source">{entry.cell.source ?? "(no source)"}</pre>
  <div class="out">
    {#if entry.state.status === "error"}
      <div class="err">{entry.state.error ?? "error"}</div>
    {:else if !entry.state.outputs || !entry.state.outputs.length}
      <div class="empty">—</div>
    {:else}
      {#each entry.state.outputs as o}
        {#if o.kind === "text" && o.mime_type === "text/csv"}
          {@const t = csvToTable(o.content)}
          <table>
            <thead>
              <tr>{#each t.head as c}<th>{c}</th>{/each}</tr>
            </thead>
            <tbody>
              {#each t.body as row}
                <tr>{#each row as c}<td class:num={isNumeric(c)}>{c}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        {:else if o.kind === "text"}
          <div class="text-out">{o.content}</div>
        {:else if o.kind === "image" && o.mime_type === "image/svg+xml"}
          {@html o.content}
        {:else if o.kind === "error"}
          <div class="err">ERROR: {o.message}</div>
        {:else}
          <div class="text-out">{JSON.stringify(o)}</div>
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .cell {
    border: 1px solid #d6d6d6;
    border-radius: 4px;
    background: #fff;
    transition: border-color 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .cell.running { border-color: #707070; }
  .cell.ok { border-color: #707070; }
  .cell.error { border: 2px solid #000; }
  .head {
    display: flex; align-items: baseline; gap: 12px;
    padding: 6px 12px; border-bottom: 1px solid #d6d6d6;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #707070;
  }
  .lhs { display: inline-flex; align-items: center; gap: 6px; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #a8a8a8; }
  .cell.running .dot { background: #000; animation: pulse 1.4s cubic-bezier(0.16, 1, 0.3, 1) infinite; }
  .cell.ok .dot { background: #000; }
  .cell.error .dot { background: #000; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #000; }
  .id { color: #000; font-weight: 600; }
  .lang { color: #2a2a2a; }
  .status { margin-left: auto; }
  .source {
    margin: 0; padding: 8px 12px;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
    color: #2a2a2a; background: #f5f5f5;
    white-space: pre-wrap;
  }
  .out {
    padding: 8px 12px; min-height: 16px;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px;
  }
  .empty { color: #a8a8a8; font-style: italic; }
  .text-out { white-space: pre-wrap; }
  .err { color: #000; font-weight: 600; white-space: pre-wrap; }
  table { border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #d6d6d6; padding: 2px 8px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  td.num { text-align: right; font-feature-settings: "tnum"; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
</style>
