<script>
  import { passkeyAvailable } from "../lib/vault.js";
  import { hasPasskeyEnrolled, forgetPasskey } from "../lib/secure-csv.js";

  let { onPassphrase, onPasskey, onForgetPasskey } = $props();

  let passphrase = $state("");
  let busy = $state("");
  let error = $state("");
  let showPassphraseFallback = $state(false);

  const passkeyOk = passkeyAvailable();
  const enrolled = hasPasskeyEnrolled();

  // Default to the passkey button when one's enrolled — otherwise
  // show the passphrase form straight away.
  const passkeyPrimary = enrolled && passkeyOk;

  async function tryPasskey() {
    busy = "passkey";
    error = "";
    try {
      await onPasskey();
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      busy = "";
    }
  }

  async function tryPassphrase(e) {
    e?.preventDefault();
    if (!passphrase) return;
    busy = "passphrase";
    error = "";
    try {
      await onPassphrase(passphrase);
    } catch (err) {
      error = err?.message ?? String(err);
      passphrase = "";
    } finally {
      busy = "";
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center p-6">
  <div class="w-full max-w-md">
    <div class="border border-border bg-surface p-8">
      <div class="flex items-center gap-2 mb-1">
        <span class="inline-block w-2 h-2 bg-locked rounded-full"></span>
        <span class="text-[11px] uppercase tracking-wider text-fg-muted font-mono">
          encrypted document
        </span>
      </div>
      <h1 class="text-xl font-semibold mb-1">talk to your CSV</h1>
      <p class="text-sm text-fg-muted mb-6">
        Sign in to read this document.
      </p>

      {#if passkeyPrimary}
        <button
          type="button"
          onclick={tryPasskey}
          disabled={!!busy}
          class="w-full bg-fg text-page py-3 text-sm uppercase tracking-wider font-mono hover:bg-fg/90 disabled:opacity-40"
        >
          {busy === "passkey" ? "waiting for authenticator…" : "sign in with passkey"}
        </button>
        {#if !showPassphraseFallback}
          <button
            type="button"
            onclick={() => (showPassphraseFallback = true)}
            class="w-full mt-3 text-[11px] uppercase tracking-wider font-mono text-fg-muted hover:text-fg"
          >
            use passphrase instead
          </button>
        {/if}
      {/if}

      {#if !passkeyPrimary || showPassphraseFallback}
        <form onsubmit={tryPassphrase} class={passkeyPrimary ? "mt-4 pt-4 border-t border-border" : ""}>
          <label class="block text-[11px] uppercase tracking-wider text-fg-muted font-mono mb-2">
            passphrase
          </label>
          <input
            type="password"
            bind:value={passphrase}
            autocomplete="current-password"
            autofocus
            class="input-mono w-full border border-border bg-page px-3 py-2 mb-3 focus:outline-none focus:border-fg"
          />
          <button
            type="submit"
            disabled={!!busy || !passphrase}
            class="w-full {passkeyPrimary ? 'border border-border hover:border-fg' : 'bg-fg text-page hover:bg-fg/90'} py-2 text-sm uppercase tracking-wider font-mono disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === "passphrase" ? "decrypting…" : "sign in"}
          </button>
        </form>
      {/if}

      {#if error}
        <div class="border-2 border-fg p-3 mt-4 text-sm font-mono whitespace-pre-wrap">
          {error}
        </div>
      {/if}

      <div class="mt-6 pt-4 border-t border-border space-y-1.5">
        <p class="text-[11px] text-fg-muted font-mono">
          age-v1 · scrypt N=2^18 · ChaCha20-Poly1305
        </p>
        {#if !enrolled && !passkeyOk}
          <p class="text-[11px] text-fg-faint">
            Passkey sign-in needs an HTTPS or localhost origin. This file is on
            <span class="font-mono">{location.protocol}</span>.
          </p>
        {/if}
        {#if enrolled}
          <p class="text-[11px] text-fg-faint">
            <button
              type="button"
              onclick={() => { forgetPasskey(); location.reload(); }}
              class="underline hover:text-fg-muted"
            >forget this passkey on this device</button>
          </p>
        {/if}
        <p class="text-[11px] text-fg-faint font-mono">
          demo passphrase: <span class="text-fg-muted">correct-horse-battery-staple</span>
        </p>
      </div>
    </div>
  </div>
</div>
