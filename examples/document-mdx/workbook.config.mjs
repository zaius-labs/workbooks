// document-mdx — quarterly-report workbook authored in markdown +
// inline Svelte components (mdsvex). Demonstrates the document
// rendering profile: prose + auto-rendered blocks.
//
// The CLI auto-loads mdsvex when it's a project dep. Workbook-flavor
// fenced code (```polars, ```rhai, etc.) compiles to <wb-cell> HTML
// the runtime executes; <wb-output for="..."> shows the result.
export default {
  name: "Q4 Customer Revenue Report",
  slug: "document-mdx",
  type: "document",
  version: "0.1",
  entry: "src/index.html",
  runtimeFeatures: ["polars"],
};
