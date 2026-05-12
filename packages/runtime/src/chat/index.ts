/**
 * `@work.books/runtime/chat` — chat-app SDK (Phase W4).
 *
 * Three layers, all in this entrypoint:
 *
 *   1. **Headless engine** — `useChatSession()` returns a reactive
 *      session that owns thread state, tool dispatch, drop handling,
 *      and bring-your-own-key persistence. Framework-agnostic at the
 *      data level; uses Svelte 5 runes for reactivity.
 *
 *   2. **UI primitives** — `ChatPanel` renders the chat UI bound to a
 *      session; `ChatCanvas` renders the canvas + drop zone. Either
 *      one composes alone; together they form the full chat-app shell.
 *
 *   3. **High-level preset** — `<Chat>` (Phase W4.1b) wraps both with
 *      a layout preset (split / canvas / rail). Authors who want full
 *      control drop down to the primitives.
 *
 * Built-in drop handlers (CSV → table, JSON → code, image → image,
 * text → code) are exported via `dropHandlers.builtins` — spread into
 * your own map to keep defaults.
 */

export {
  useChatSession,
  type ChatSession,
  type ChatSessionOptions,
  type ChatThreadItem,
  type ChatAttachment,
  type DropHandler,
} from "./useChatSession.svelte";

export { default as Chat } from "./Chat.svelte";
export { default as ChatPanel } from "./ChatPanel.svelte";
export { default as ChatCanvas } from "./ChatCanvas.svelte";
export { default as Composer } from "./Composer.svelte";
export { default as KeyPrompt } from "./KeyPrompt.svelte";
export { default as ModelPicker } from "./ModelPicker.svelte";
export { default as ModelSearchModal } from "./ModelSearchModal.svelte";

export { dropHandlers, builtins as defaultDropHandlers } from "./dropHandlers";

export {
  createMlToolset,
  type MlToolset,
  type MlToolsetOptions,
  type StoredModel,
  type CsvLikeBlock,
} from "./mlTools";

export {
  openrouterCatalog,
  iconForModelId,
  RECOMMENDED_MODEL_IDS,
  type CatalogModel,
} from "./openrouterCatalog.svelte";
