// csv-chat — drop a CSV, chat with an analyst.
//
// The headline example for the chat-app SDK (Phase W4): a fully
// portable .html that ships a chat panel + drop-zone canvas. Recipients
// connect their OpenRouter key, drop a CSV, and the agent has tools to
// summarize, filter, and (W4.3+) train models on the data.
//
// NOTE on Tailwind: the runtime's chat components are written with
// Tailwind utility classes. For the showcase example we ship without a
// Tailwind plugin (keeps the build self-contained) — recipients see
// the structure but unstyled. In a real workbook, add @tailwindcss/vite
// to your config and import "tailwindcss" so the utility classes
// resolve.
export default {
  name: "CSV Chat",
  slug: "csv-chat",
  type: "spa",
  entry: "src/index.html",
  wasmVariant: "app",
  wasmVariantCheck: false,
};
