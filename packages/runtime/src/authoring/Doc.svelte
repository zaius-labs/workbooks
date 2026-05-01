<script lang="ts">
  /**
   * <Doc> — declarative CRDT document. The canonical persistent-state
   * primitive: state lives in the .workbook.html file, round-trips
   * through Cmd+S, no browser cache layer.
   *
   * Internally renders a <wb-doc> custom element. Once mounted, the
   * runtime parses the element and registers a Yjs handle (the only
   * backend since Phase 2 of core-0or). On Cmd+S, the save handler
   * calls exportDoc(id) and writes the current state back into the
   * element before snapshotting.
   *
   *   <WorkbookApp>
   *     <Doc id="composition" />
   *     ...
   *   </WorkbookApp>
   *
   *   // Read the registered handle:
   *   const composition = useDoc("composition");
   *
   * Optional `initial` is base64-encoded Yjs update bytes to seed the
   * doc; most authors omit this.
   */

  import { requireAuthoringContext } from "./context";

  type Props = {
    /** Stable doc id. Cells + other components reference it by id. */
    id: string;
    /** CRDT format. Only "yjs" is supported. */
    format?: "yjs";
    /** Base64-encoded initial bytes (rare; usually omitted). */
    initial?: string;
    /** sha256 hex of `initial` — runtime verifies. */
    sha256?: string;
  };
  let { id, format = "yjs", initial, sha256 }: Props = $props();

  // Pull the context only to fail fast if <Doc> is used outside
  // <WorkbookApp>. We don't need anything from it — registration
  // happens via the runtime's parse of <wb-doc> at mount.
  requireAuthoringContext("Doc");
</script>

<wb-doc
  id={id}
  format={format}
  encoding={initial ? "base64" : undefined}
  sha256={sha256}
>{initial ?? ""}</wb-doc>

<style>
  wb-doc { display: none; }
</style>
