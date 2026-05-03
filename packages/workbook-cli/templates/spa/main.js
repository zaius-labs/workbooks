// Welcome. This is the smallest possible workbook — one Arrow table
// built via the `workbook:data` virtual module, rendered into the page.
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

document.querySelector("#out").textContent =
  `built an Arrow table — ${t.numRows} rows, ${t.numCols} cols\n\n` +
  t.toString();
