<script lang="ts">
  /**
   * <Memory> — append-shaped tabular memory backed by Apache Arrow IPC.
   *
   * Where <Doc> is for hierarchical CRDT state, <Memory> is for
   * append-only timeseries / event-stream data: chat threads, agent
   * traces, telemetry rows. Cells read it via `reads="<id>"`; the
   * runtime materializes an Arrow table at execution time.
   *
   * Same file-as-database lifecycle as <Doc>: mutations stay in
   * memory during the session, the save handler exports current
   * state back into the file on Cmd+S, recipients see whatever the
   * sender Cmd+S'd.
   *
   *   <WorkbookApp>
   *     <Memory id="chat-thread" />
   *     <Cell id="recent-msgs" language="polars" reads="chat-thread">
   *       SELECT * FROM data ORDER BY ts DESC LIMIT 50
   *     </Cell>
   *     <Output for="recent-msgs" />
   *   </WorkbookApp>
   *
   *   // Append imperatively:
   *   const memory = useMemory("chat-thread");
   *   await memory.append([{ ts: Date.now(), role: "user", text: "hi" }]);
   */

  import { requireAuthoringContext } from "./context";

  type Props = {
    id: string;
    /** Base64-encoded initial Arrow IPC bytes (optional). */
    initial?: string;
    sha256?: string;
  };
  let { id, initial, sha256 }: Props = $props();

  requireAuthoringContext("Memory");
</script>

<wb-memory
  id={id}
  encoding={initial ? "base64" : undefined}
  sha256={sha256}
>{initial ?? ""}</wb-memory>

<style>
  wb-memory { display: none; }
</style>
