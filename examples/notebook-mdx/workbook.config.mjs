// notebook-mdx — interactive notebook authored in markdown +
// inline cells. type="notebook" instead of document; chrome makes
// the runnable cells slightly more prominent. Same .svx authoring
// path as document-mdx, different rendering profile.
export default {
  name: "Customer churn — notebook",
  slug: "notebook-mdx",
  type: "notebook",
  version: "0.1",
  entry: "src/index.html",
  runtimeFeatures: ["polars", "rhai"],
};
