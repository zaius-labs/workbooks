<script>
  import LockScreen from "./components/LockScreen.svelte";
  import SchemaPanel from "./components/SchemaPanel.svelte";
  import LlmConfig from "./components/LlmConfig.svelte";
  import QuestionInput from "./components/QuestionInput.svelte";
  import Chat from "./components/Chat.svelte";
  import Spreadsheet from "./components/Spreadsheet.svelte";
  import {
    signInWithPassphrase,
    signInWithPasskey,
    enablePasskey,
    signOut,
    hasPasskeyEnrolled,
    query,
    getAllRows,
    getSampleRows,
  } from "./lib/secure-csv.js";
  import { tryCanned, askLlm } from "./lib/nl2sql.js";
  import { passkeyAvailable } from "./lib/vault.js";

  let unlocked = $state(false);
  let schema = $state([]);
  let rowCount = $state(0);
  let sampleRows = $state([]);
  let allRows = $state([]);
  let activeId = $state(null);
  let signedInVia = $state("");

  let turns = $state([]);
  let busy = $state(false);
  let schemaExpanded = $state(false);
  let llm = $state({
    apiKey: "",
    model: "anthropic/claude-haiku-4-5",
    includeSampleRows: false,
  });

  let enrollNotice = $state("");
  let enrollBusy = $state(false);

  async function unlockPassphrase(p) {
    const info = await signInWithPassphrase(p);
    afterUnlock(info, "passphrase");
  }
  async function unlockPasskey() {
    const info = await signInWithPasskey();
    afterUnlock(info, "passkey");
  }
  async function afterUnlock(info, via) {
    schema = info.schema;
    rowCount = info.rows;
    signedInVia = via;
    sampleRows = await getSampleRows(5);
    allRows = await getAllRows();
    unlocked = true;
  }

  async function ask(question) {
    const id = crypto.randomUUID?.() ?? String(Date.now());
    let turn = {
      id,
      question,
      sql: "",
      source: "canned",
      busy: true,
      rows: null,
      error: "",
    };
    turns = [turn, ...turns];
    activeId = id;
    busy = true;
    try {
      let sql = tryCanned(question);
      let source = "canned";
      if (!sql && llm.apiKey) {
        source = "llm";
        sql = await askLlm({
          apiKey: llm.apiKey,
          model: llm.model,
          question,
          schema,
          sampleRows: llm.includeSampleRows ? sampleRows : [],
        });
      }
      if (!sql) {
        throw new Error(
          "I don't recognize that question and the LLM panel is off. " +
            "Try a chip or paste an OpenRouter key.",
        );
      }
      turn.sql = sql;
      turn.source = source;
      turn.rows = await query(sql);
    } catch (e) {
      turn.error = e?.message ?? String(e);
    } finally {
      turn.busy = false;
      turns = [...turns];
      busy = false;
    }
  }

  function pickTurn(id) { activeId = id; }
  function showFullTable() { activeId = null; }

  function lock() {
    signOut();
    unlocked = false;
    turns = [];
    activeId = null;
    sampleRows = [];
    allRows = [];
    schema = [];
    rowCount = 0;
    signedInVia = "";
    enrollNotice = "";
  }

  async function onEnablePasskey() {
    enrollBusy = true;
    enrollNotice = "";
    try {
      await enablePasskey({ label: "talk-to-csv · this device" });
      enrollNotice = "Passkey enrolled — next time you open this document, sign in with Touch ID.";
    } catch (e) {
      enrollNotice = "Passkey enrollment failed: " + (e?.message ?? String(e));
    } finally {
      enrollBusy = false;
    }
  }

  let canOfferEnroll = $derived(
    unlocked && passkeyAvailable() && !hasPasskeyEnrolled() && signedInVia === "passphrase",
  );

  let activeTurn = $derived(activeId ? turns.find((t) => t.id === activeId) : null);
  let displayRows = $derived(activeTurn?.rows ?? allRows);
  let displayTitle = $derived(activeTurn ? "result" : "data");
  let displaySubtitle = $derived(
    activeTurn ? activeTurn.question : `${rowCount.toLocaleString()} rows`,
  );
</script>

{#if !unlocked}
  <LockScreen
    onPassphrase={unlockPassphrase}
    onPasskey={unlockPasskey}
  />
{:else}
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-border bg-surface px-6 py-3 flex items-baseline justify-between flex-shrink-0">
      <div class="flex items-baseline gap-3">
        <span class="inline-block w-2 h-2 bg-secure rounded-full self-center"></span>
        <h1 class="text-base font-semibold">talk to your CSV</h1>
        <span class="text-[11px] text-fg-muted font-mono">
          {rowCount.toLocaleString()} rows · signed in via {signedInVia}
        </span>
      </div>
      <div class="flex items-center gap-2">
        {#if canOfferEnroll}
          <button
            type="button"
            onclick={onEnablePasskey}
            disabled={enrollBusy}
            class="text-[11px] uppercase tracking-wider font-mono border border-border px-3 py-1 hover:border-fg disabled:opacity-40"
          >
            {enrollBusy ? "registering…" : "enable touch id for next time"}
          </button>
        {/if}
        <button
          type="button"
          onclick={lock}
          class="text-[11px] uppercase tracking-wider font-mono border border-border px-3 py-1 hover:border-fg"
        >sign out</button>
      </div>
    </header>

    {#if enrollNotice}
      <div class="border-b border-border bg-page px-6 py-2 text-[11px] font-mono text-fg-muted">
        {enrollNotice}
      </div>
    {/if}

    <div class="grid grid-cols-[minmax(360px,40%)_1fr] flex-1 overflow-hidden">
      <!-- LEFT: chat -->
      <aside class="flex flex-col border-r border-border bg-page overflow-hidden">
        <div class="px-4 py-3 border-b border-border bg-surface flex-shrink-0 space-y-3">
          <SchemaPanel
            {schema}
            {rowCount}
            sample={sampleRows}
            bind:expanded={schemaExpanded}
          />
          <LlmConfig bind:config={llm} />
        </div>

        <div class="px-4 py-3 border-b border-border bg-surface flex-shrink-0">
          <QuestionInput onAsk={ask} {busy} />
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-3">
          {#if turns.length}
            {#if activeId !== null}
              <button
                type="button"
                onclick={showFullTable}
                class="w-full text-left text-[11px] font-mono px-3 py-1.5 border border-border bg-surface hover:border-fg"
              >
                ← back to full table
              </button>
            {/if}
            <Chat {turns} {activeId} onPick={pickTurn} />
          {:else}
            <div class="text-center py-12 text-fg-muted text-sm">
              ask anything about the data —
              <span class="text-fg-faint">spreadsheet on the right updates with each answer</span>
            </div>
          {/if}
        </div>
      </aside>

      <!-- RIGHT: spreadsheet -->
      <main class="overflow-hidden p-4">
        <Spreadsheet
          rows={displayRows}
          title={displayTitle}
          subtitle={displaySubtitle}
          {busy}
        />
      </main>
    </div>
  </div>
{/if}
