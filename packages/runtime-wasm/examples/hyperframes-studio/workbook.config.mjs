// hyperframes-studio — chat-on-left, player+timeline-on-right.
// An LLM agent edits an HTML video composition; a sandboxed iframe
// renders it; a parsed timeline shows clips with their data-start /
// data-duration. Same SPA workbook shape as svelte-app & tailwind-app.
import tailwindcss from "@tailwindcss/vite";

export default {
  name: "hyperframes-studio · workbook",
  slug: "hyperframes-studio",
  type: "spa",
  version: "0.1",
  entry: "src/index.html",
  vite: {
    plugins: [tailwindcss()],
  },
  env: {
    OPENROUTER_API_KEY: {
      label: "openrouter api key",
      prompt: "sk-or-…",
      required: true,
      secret: true,
    },
  },
};
