// Welcome. This is the smallest possible workbook — one Arrow table
// built via the `workbook:data` virtual module and rendered as HTML.
// Three things to know:
//
//   1. `workbook:data` is the SDK. Always import from there, not from
//      apache-arrow directly. `workbook check` will tell you if you slip.
//
//   2. The build (`workbook build`) produces ONE .html file
//      that contains everything — your code, your data, the Polars/
//      Candle/Plotters runtime. Open it in any browser, anywhere.
//
//   3. There's no server. There's no install. There's just a file.

import { fromArrays } from "workbook:data";

const t = fromArrays({
  greeting: ["hello", "world", "from", "your", "workbook"],
  count: [1, 2, 3, 4, 5],
});

renderTable(t, document.querySelector("#out"));

function renderTable(table, mount) {
  const fields = table.schema.fields.map((f) => f.name);
  const rows = table.toArray();

  const thead =
    "<thead><tr>" +
    fields.map((f) => `<th>${escape(f)}</th>`).join("") +
    "</tr></thead>";

  const tbody =
    "<tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          fields.map((f) => `<td>${escape(row[f])}</td>`).join("") +
          "</tr>",
      )
      .join("") +
    "</tbody>";

  mount.innerHTML = `<table>${thead}${tbody}</table>`;

  const caption = document.querySelector("#out-caption");
  if (caption) {
    caption.textContent = `${table.numRows} rows · ${table.numCols} columns · built in WASM`;
  }
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
