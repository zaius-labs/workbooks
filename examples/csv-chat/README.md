# csv-chat

The headline example for the chat-app SDK (Phase W4 of the workbooks
pivot). Drop a CSV onto the canvas, the agent has tools to summarize
the columns and find specific rows. Recipients connect their own
OpenRouter key and chat — the workbook author isn't on the hook for
inference costs.

## Run it

```sh
bun install                      # from the monorepo root
cd vendor/workbooks/examples/csv-chat
bun run dev                      # Vite dev server with HMR
# or
bun run build                    # → dist/csv-chat.html
```

## What's in it

`src/App.svelte` is six lines of meaningful code — everything else is
the two custom tools (`summarize_columns`, `find_rows`) that reach
into the dropped CSV:

```svelte
<script>
  import { Chat } from "@work.books/runtime/chat";

  let session = $state(null);
  // …declare custom tools that close over session.canvasBlocks…
</script>

<Chat
  systemPrompt="You're a data analyst…"
  tools={[summarizeColumnsTool, findRowsTool]}
  preset="split"
  bind:session
/>
```

`session.canvasBlocks` is the live list of blocks the agent has seen.
The tools read from it; when a CSV gets dropped, `useChatSession`
routes it through the built-in CSV → table handler, which produces a
`kind: "table"` block. The agent sees the drop in its context, the
canvas materializes the table, the custom tools query it.

## Add Tailwind for proper styling

The runtime's chat components use Tailwind utility classes. This
example ships without a Tailwind plugin to keep the build
self-contained — the structure works but classes are inert. For a
real workbook:

```sh
bun add -D @tailwindcss/vite
```

```js
// workbook.config.mjs
import tailwindcss from "@tailwindcss/vite";
export default {
  // …
  vite: { plugins: [tailwindcss()] },
};
```

```css
/* app.css */
@import "tailwindcss";
@theme {
  --color-fg: rgb(10 10 10);
  --color-fg-muted: rgb(100 100 100);
  --color-bg: rgb(250 250 250);
  --color-surface: rgb(255 255 255);
  --color-surface-soft: rgb(245 245 245);
  --color-border: rgb(230 230 230);
}
```

## What's next

This example is W4.1 + W4.2 (chat shell + drop-zone). W4.3 layers
Candle-backed ML primitives as agent tools (`train_regression`,
`train_gbdt`, `train_classifier`, `predict`) — once those land, the
agent can actually train a model on the CSV without leaving the
workbook. Today, the agent reasons about the data; tomorrow, it can
run predictive models against it inline.
