<script>
  // The headline csv-chat workbook — proof the SDK works end-to-end.
  //
  // Six lines of author code:
  //   - import the SDK + tools
  //   - declare a system prompt
  //   - declare two custom tools that reach into the loaded CSV
  //   - mount <Chat />
  //
  // Recipients open the .html, paste an OpenRouter key, drop a CSV.
  // The agent has tools to summarize columns, find rows that match a
  // query, and (W4.3+) train regression / GBDT models on the data.
  import { Chat, createMlToolset } from "@work.books/runtime/chat";

  // Live snapshot of the most recently dropped CSV (table block).
  // The custom tools below close over this; updating it re-binds the
  // agent's view of the data without re-mounting anything.
  let currentTable = $state(null);

  // Watch the session's canvas blocks; whenever a new table lands,
  // remember it as the "current" dataset for the agent's tools.
  let session = $state(null);
  $effect(() => {
    if (!session) return;
    const blocks = session.canvasBlocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === "table") {
        currentTable = blocks[i];
        return;
      }
    }
  });

  // ML toolset (W4.3): train_linear_regression, train_logistic_regression,
  // train_kmeans, predict. Each emits a kind:"machine" block so the canvas
  // renders the trained model natively (and the same block re-renders
  // inline in the chat thread).
  const ml = createMlToolset({ getTable: () => currentTable });

  // Custom analyst tools — summarize_columns + find_rows close over
  // `currentTable` so the agent always sees the freshest dropped CSV.
  const customTools = [
    {
      definition: {
        name: "summarize_columns",
        description:
          "Returns simple per-column summary statistics for the " +
          "most recently dropped CSV: type, count, min/max/mean for " +
          "numeric columns, top values for categorical. Use this " +
          "before more targeted analysis.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      invoke: () => {
        if (!currentTable) {
          return "No CSV loaded. Ask the user to drop one on the canvas.";
        }
        return summarize(currentTable);
      },
    },
    {
      definition: {
        name: "find_rows",
        description:
          "Search the loaded CSV for rows where a column matches a " +
          "value (string-equals or numeric range). Returns up to 20 " +
          "rows. Use for spot-checks; for aggregations, summarize_columns " +
          "first.",
        parameters: {
          type: "object",
          properties: {
            column: { type: "string" },
            equals: {},
            min: { type: "number" },
            max: { type: "number" },
          },
          required: ["column"],
        },
      },
      invoke: (args) => {
        if (!currentTable) return "No CSV loaded.";
        return findRows(
          currentTable,
          /** @type {string} */ (args.column),
          args.equals,
          /** @type {number | undefined} */ (args.min),
          /** @type {number | undefined} */ (args.max),
        );
      },
    },
  ];

  const tools = [...customTools, ...ml.tools];

  const systemPrompt = `You are a data analyst embedded in a workbook.

The user drops a CSV onto the canvas. You can then:

Discovery:
- summarize_columns — per-column stats; always start here
- find_rows — spot-check rows by column = value or range

Modeling:
- train_linear_regression — predict a numeric target from numeric features
- train_logistic_regression — binary classification (target has 2 values)
- train_kmeans — cluster rows into k groups
- predict — run a previously-trained model_id against the loaded rows

Be specific and concrete. Quote actual numbers and column names from
tool output. If a tool can't answer, say so directly. Models are
saved by model_id so you can refer back to them. Keep replies short.`;
</script>

<Chat
  {systemPrompt}
  {tools}
  preset="split"
  chatPosition="left"
  splitRatio={0.36}
  title="Analyst"
  bind:session
/>

<!-- ─────────────────── helpers ─────────────────── -->
<script module>
  /**
   * Build a per-column summary for a `kind: "table"` block.
   *
   * Treats columns as numeric if every non-empty cell parses; otherwise
   * categorical with up to 5 most-common values.
   */
  function summarize(block) {
    const cols = block.columns ?? [];
    const rows = block.rows ?? [];
    const lines = [`Loaded ${block.title || "table"} — ${rows.length} rows × ${cols.length} cols`];
    for (const c of cols) {
      const values = rows.map((r) => r[c]).filter((v) => v !== "" && v != null);
      const numericCount = values.filter((v) => typeof v === "number" && Number.isFinite(v)).length;
      if (values.length > 0 && numericCount === values.length) {
        const nums = values.map((v) => /** @type {number} */ (v));
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        lines.push(
          `  ${c}: numeric · n=${nums.length} · min=${trim(min)} · max=${trim(max)} · mean=${trim(mean)}`,
        );
      } else {
        const counts = new Map();
        for (const v of values) {
          const k = String(v);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const top = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, n]) => `${k} (${n})`)
          .join(", ");
        lines.push(
          `  ${c}: categorical · n=${values.length} · ${counts.size} distinct · top: ${top}`,
        );
      }
    }
    return lines.join("\n");
  }

  function findRows(block, column, equals, min, max) {
    const rows = block.rows ?? [];
    if (!block.columns?.includes(column)) {
      return `No column "${column}". Available: ${(block.columns ?? []).join(", ")}`;
    }
    const matches = rows.filter((r) => {
      const v = r[column];
      if (equals !== undefined && String(v) !== String(equals)) return false;
      if (min !== undefined && (typeof v !== "number" || v < min)) return false;
      if (max !== undefined && (typeof v !== "number" || v > max)) return false;
      return true;
    });
    if (matches.length === 0) return `No matches for ${column}.`;
    const head = matches.slice(0, 20);
    return (
      `${matches.length} matching row${matches.length === 1 ? "" : "s"} ` +
      `(showing ${head.length}):\n` +
      head.map((r) => JSON.stringify(r)).join("\n")
    );
  }

  function trim(n) {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  }
</script>
