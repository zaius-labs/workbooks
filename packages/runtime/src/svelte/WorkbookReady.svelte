<!--
  WorkbookReady — suspend children until the Y.Doc backing the workbook
  is registered.

  All synchronous SDK APIs (wb.app, wb.undo, …) require a bound Y.Doc
  at the moment they're called. The runtime registers it
  asynchronously after parsing the workbook spec + mounting <wb-doc>.
  This component is the bridge: it `await`s the resolution and only
  then mounts its children.

      <script>
        import { WorkbookReady } from "@work.books/runtime/svelte";
        import App from "./App.svelte";
      </script>

      <WorkbookReady>
        {#snippet fallback()}
          <div class="loading">Loading…</div>
        {/snippet}

        <App />
      </WorkbookReady>

  Why a component (not a hook): suspense-style mounting in Svelte is
  cleanest with {#await}, which can only appear in template scope.
  Wrapping it in a component lets authors use it the way they'd use
  any other host component. The async dance lives here, the children
  stay synchronous.

  Cost on cold load: ~50–200 ms (the Y.Doc registration window). For
  hot reloads after first registration, this resolves immediately
  because the doc cache hits.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { resolveDoc } from "../storage/bootstrap";

  interface Props {
    /** Optional snippet shown during the bind window. */
    fallback?: Snippet;
    /** Children — anything that depends on a bound Y.Doc. */
    children?: Snippet;
    /** Override the doc id; defaults to the first registered. */
    doc?: string;
  }

  let { fallback, children, doc }: Props = $props();

  // resolveDoc caches its promise, so this stays cheap if the prop
  // changes. $derived re-runs only when `doc` actually changes; in
  // typical app-root usage it's stable for the component lifetime.
  const ready = $derived(resolveDoc(doc ?? null));
</script>

{#await ready}
  {#if fallback}{@render fallback()}{/if}
{:then}
  {#if children}{@render children()}{/if}
{:catch e}
  <div role="alert" style="padding: 1rem; color: #b91c1c; background: #fee2e2; border-radius: 6px; font-family: ui-sans-serif, system-ui, sans-serif;">
    <strong>Workbook runtime failed to initialize:</strong>
    <pre style="margin-top: 0.5rem; font-size: 0.85em;">{e?.message ?? String(e)}</pre>
  </div>
{/await}
