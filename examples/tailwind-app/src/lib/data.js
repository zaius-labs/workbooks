// Tiny in-memory dataset + reactive query helper. Substitute a real
// VFS (localStorage or OPFS) when the dataset gets larger.

export const CSV = `region,segment,revenue,churn,customers
us,enterprise,42000,0.03,12
us,smb,12000,0.04,84
us,starter,8400,0.11,210
eu,enterprise,38000,0.02,9
eu,smb,15600,0.02,67
eu,starter,3200,0.18,143
apac,enterprise,28000,0.04,7
apac,smb,21000,0.05,52
apac,starter,4400,0.22,180`;

let runtime = null;
async function getRuntime() {
  if (!runtime) {
    const { loadRuntime } = await import("virtual:workbook-runtime");
    runtime = await loadRuntime();
  }
  return runtime;
}

/** Run a Polars-SQL query against the inline CSV; returns parsed rows. */
export async function query(sql) {
  const { wasm } = await getRuntime();
  const outputs = wasm.runPolarsSql(sql, CSV);
  const csvOut = outputs.find((o) => o.kind === "text" && o.mime_type === "text/csv");
  if (!csvOut) {
    const err = outputs.find((o) => o.kind === "error");
    throw new Error(err?.message ?? "query produced no CSV output");
  }
  return parseCsv(csvOut.content);
}

function parseCsv(s) {
  const lines = s.trim().split("\n");
  const head = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseRow(line);
    const row = {};
    head.forEach((k, i) => {
      const v = cells[i];
      row[k] = isNumeric(v) ? Number(v) : v;
    });
    return row;
  });
}
function parseRow(s) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function isNumeric(s) { return s !== "" && !isNaN(Number(s)); }
