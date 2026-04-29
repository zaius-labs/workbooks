<script>
  // Read the env contract from the embedded workbook-spec script.
  // Mirrors chat-app's varlock pattern: the manifest declares what
  // env keys are required + which are secret; values resolve from
  // window.WORKBOOK_ENV → namespaced localStorage. Secrets never
  // serialize back into the file.
  const SLUG = "svelte-app";
  const specEl = typeof document !== "undefined"
    ? document.getElementById("workbook-spec")
    : null;
  const spec = specEl ? JSON.parse(specEl.textContent || "{}") : {};
  const envDecls = spec?.manifest?.env ?? {};

  function envStorageKey(key) { return `wb.env.${SLUG}.${key}`; }
  function getEnv(key) {
    const injected = (typeof window !== "undefined" && window.WORKBOOK_ENV) || null;
    if (injected && typeof injected[key] === "string" && injected[key]) return injected[key];
    return localStorage.getItem(envStorageKey(key)) ?? "";
  }
  function setEnv(key, value) {
    const v = (value ?? "").trim();
    if (v) localStorage.setItem(envStorageKey(key), v);
    else localStorage.removeItem(envStorageKey(key));
  }

  // Reactive map of key → value.
  let values = $state(Object.fromEntries(
    Object.keys(envDecls).map((k) => [k, getEnv(k)]),
  ));

  function update(key, v) {
    values[key] = v;
    setEnv(key, v);
  }
</script>

<section>
  <h1>Env settings</h1>
  <p>
    Values flagged <code>secret: true</code> are stored in localStorage
    namespaced to this workbook (<code>wb.env.{SLUG}.*</code>) and
    never serialize back into a saved <code>.workbook.html</code>.
  </p>

  {#if Object.keys(envDecls).length === 0}
    <div class="empty">No env declared in workbook.config.mjs.</div>
  {:else}
    <div class="rows">
      {#each Object.entries(envDecls) as [key, decl]}
        <label>
          <div class="row-head">
            <span class="key">{key}</span>
            <span class="flags">
              {decl.required ? "required" : "optional"}
              {#if decl.secret} · secret{/if}
            </span>
          </div>
          {#if decl.label}<div class="label">{decl.label}</div>{/if}
          <input
            type={decl.secret ? "password" : "text"}
            placeholder={decl.prompt ?? ""}
            value={values[key]}
            oninput={(e) => update(key, e.currentTarget.value)}
            autocomplete="off"
          />
        </label>
      {/each}
    </div>
  {/if}
</section>

<style>
  section { display: grid; gap: 16px; max-width: 600px; }
  h1 { font-size: 24px; font-weight: 700; margin: 0; }
  p { font-size: 14px; color: #707070; margin: 0; }
  code {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.92em; background: #f5f5f5;
    padding: 1px 6px; border-radius: 3px;
  }
  .empty {
    padding: 24px; text-align: center; color: #a8a8a8;
    border: 1px solid #d6d6d6; border-radius: 4px;
    font-size: 14px;
  }
  .rows { display: grid; gap: 16px; }
  label { display: grid; gap: 6px; }
  .row-head { display: flex; gap: 12px; align-items: baseline; }
  .key {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; color: #000000; font-weight: 600;
  }
  .flags {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px; color: #707070;
  }
  .label { font-size: 13px; color: #2a2a2a; }
  input {
    padding: 8px 10px;
    border: 1px solid #d6d6d6; border-radius: 4px;
    background: #ffffff; color: #000000;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px;
  }
  input:focus { outline: 1px solid #000000; outline-offset: -1px; border-color: #000000; }
</style>
