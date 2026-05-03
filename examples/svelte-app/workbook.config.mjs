// Workbook config for the Svelte navigation example.
// `workbook build` reads this to learn the slug + entry + env contract.
export default {
  name: "svelte-app · workbook",
  slug: "svelte-app",
  version: "0.1",
  entry: "src/index.html",
  env: {
    OPENROUTER_API_KEY: {
      label: "openrouter api key",
      prompt: "sk-or-…",
      required: false,
      secret: true,
    },
  },
  runtimeFeatures: ["polars", "rhai", "charts"],
};
