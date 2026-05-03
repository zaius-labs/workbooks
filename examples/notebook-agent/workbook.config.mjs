// notebook-agent — Svelte authoring of a workbook with cells + an
// in-workbook agent that reads/writes those cells. Counterpart to
// chat-app (vanilla JS single-file): different authoring style,
// same .html output format.
export default {
  name: "notebook-agent · workbook",
  slug: "notebook-agent",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  env: {
    OPENROUTER_API_KEY: {
      label: "openrouter api key",
      prompt: "sk-or-…",
      required: true,
      secret: true,
    },
  },
  runtimeFeatures: ["polars", "rhai", "charts"],
};
