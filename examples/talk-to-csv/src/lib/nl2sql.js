// Natural-language → SQL.
//
// Two paths:
//   1. CANNED — local lookup against a list of (regex, sql) pairs.
//      Zero network calls; covers the demo's stock questions.
//   2. LLM — POST to OpenRouter or Anthropic with schema + sample
//      rows; returns a SQL string. Only triggered if the user supplies
//      an API key. The encrypted bytes never leave the page; what
//      goes over the wire is column names + types + a tiny sample
//      and the user's question.
//
// Both paths produce a single SQL string that runs against `data`.

const CANNED = [
  {
    re: /(top|highest|biggest)\s+(\d+\s+)?(rev|revenue|earner)/i,
    build: (m) => {
      const n = m[2] ? parseInt(m[2], 10) : 5;
      return `SELECT region, segment, product, revenue FROM data ORDER BY revenue DESC LIMIT ${n}`;
    },
  },
  {
    re: /by\s+region/i,
    build: () =>
      `SELECT region, SUM(revenue) AS revenue, AVG(churn) AS avg_churn, COUNT(*) AS orders FROM data GROUP BY region ORDER BY revenue DESC`,
  },
  {
    re: /by\s+segment/i,
    build: () =>
      `SELECT segment, SUM(revenue) AS revenue, AVG(churn) AS avg_churn, COUNT(*) AS orders FROM data GROUP BY segment ORDER BY revenue DESC`,
  },
  {
    re: /by\s+product/i,
    build: () =>
      `SELECT product, SUM(units) AS units, SUM(revenue) AS revenue FROM data GROUP BY product ORDER BY revenue DESC`,
  },
  {
    re: /(churn|churning).*(highest|worst)/i,
    build: () =>
      `SELECT region, segment, AVG(churn) AS avg_churn, COUNT(*) AS orders FROM data GROUP BY region, segment ORDER BY avg_churn DESC LIMIT 10`,
  },
  {
    re: /(total|sum).*(revenue)/i,
    build: () => `SELECT SUM(revenue) AS total_revenue FROM data`,
  },
  {
    re: /(how many|count).*(order)/i,
    build: () => `SELECT COUNT(*) AS orders FROM data`,
  },
  {
    re: /(not\s+renew|cancelled|lost)/i,
    build: () =>
      `SELECT region, segment, product, revenue, churn FROM data WHERE renewed = 0 ORDER BY revenue DESC`,
  },
];

/**
 * Try the canned set first. Returns `null` on no match — caller can
 * decide whether to fall back to the LLM path.
 */
export function tryCanned(question) {
  for (const c of CANNED) {
    const m = c.re.exec(question);
    if (m) return c.build(m);
  }
  return null;
}

/** Schema preview for the trust panel — what the LLM would see. */
export function schemaPreview(schema, sampleRows) {
  const cols = schema.map((c) => `${c.name}: ${c.type}`).join(", ");
  const sample = sampleRows
    .slice(0, 3)
    .map((r) => "  " + JSON.stringify(r))
    .join(",\n");
  return `columns: { ${cols} }\n\nsample rows (first 3):\n${sample}`;
}

/**
 * LLM path — POST to OpenRouter (any model that handles SQL well).
 * The user supplies the API key + model in the UI; nothing is hardcoded.
 *
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.model — e.g. "anthropic/claude-haiku-4-5"
 * @param {string} params.question
 * @param {Array<{name:string,type:string}>} params.schema
 * @param {Array<object>} [params.sampleRows] — optional first N rows
 *                                              (LLM gets to see these)
 * @returns {Promise<string>} A single SQL statement.
 */
export async function askLlm({
  apiKey,
  model,
  question,
  schema,
  sampleRows = [],
}) {
  if (!apiKey) throw new Error("askLlm: missing API key");
  const schemaText = schema
    .map((c) => `  ${c.name}: ${c.type}`)
    .join(",\n");
  const sampleText = sampleRows.length
    ? `\nSample rows (5 of N):\n${sampleRows
        .slice(0, 5)
        .map((r) => JSON.stringify(r))
        .join("\n")}`
    : "";

  const system = [
    "You translate natural-language questions into a single SQL statement.",
    "The dataset is a single table named `data`. Use only the columns in the",
    "schema. Output ONLY the SQL; no commentary, no markdown fences, no",
    "trailing semicolon. The SQL dialect is Polars-SQL — standard SELECT /",
    "WHERE / GROUP BY / ORDER BY / LIMIT works; no DDL, no joins to other",
    "tables. Use AS to alias aggregates so the column names are readable.",
  ].join(" ");

  const user = `Schema:\n${schemaText}${sampleText}\n\nQuestion: ${question}`;

  // Intentional runtime call — the user pastes their OpenRouter key in
  // the LLM panel; this is the entire point of the talk-to-csv example.
  // workbook-disable-next-line workbook/portability/no-external-fetch
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://workbooks.dev/talk-to-csv",
      "X-Title": "talk-to-csv showcase",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("LLM returned empty content");
  // Strip accidental code fences just in case.
  return text.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/, "").trim();
}
