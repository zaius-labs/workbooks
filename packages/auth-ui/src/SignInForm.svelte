<!--
  SignInForm — the canonical Workbooks sign-in entry point.

  Renders an email field + Continue button. On submit, calls the
  caller-supplied `onSubmit({email})` handler which decides what to
  do next:

    { kind: 'workos_redirect', url }
      The form sets `location.href = url` and the page navigates
      out to the WorkOS-side flow. (Today this is the default for
      enterprise email domains the broker recognizes via WorkOS
      Connection mapping.)

    { kind: 'magic_link_request_id', request_id }
      The form swaps the email field for the MagicCodeInput
      component, scoped to that request_id. Caller's onVerify({
      request_id, code }) is fired when the user enters six digits.
      Returns same shape as workos_redirect, plus a third option
      below.

    { kind: 'authenticated', bearer, sub, email, expires_at }
      Successful magic-link verify. Form fires onAuthenticated()
      and renders nothing further; the caller (broker /sign-in
      route) is expected to redirect to the originating return_to.

  Visual: lander tokens. Form takes the full column width of its
  container; inputs use code-bg shading without borders. Errors
  render inline below the field with err-color text and the same
  weight as everything else — no toasts.

  Props:
    onSubmit:        async ({email}) => SubmitResult
    onVerify:        async ({request_id, code}) => SubmitResult
    onAuthenticated: ({bearer, sub, email, expires_at}) => void
    initialEmail:    string  (optional pre-fill, e.g. from URL hint)
    title:           string  (optional, default "Sign in")
    lede:            string  (optional)
-->

<script>
  import MagicCodeInput from "./MagicCodeInput.svelte";

  /** @typedef {{kind:'workos_redirect', url:string}
   *           | {kind:'magic_link_request_id', request_id:string}
   *           | {kind:'authenticated', bearer:string, sub:string, email:string, expires_at:number}
   *           | {kind:'error', message:string}} SubmitResult */

  let {
    onSubmit,
    onVerify,
    onAuthenticated = () => {},
    initialEmail = "",
    title = "Sign in",
    lede = "",
  } = $props();

  // State machine: enter-email → magic-code (only for the magic-link
  // branch) → authenticated. The workos_redirect branch never
  // returns control to this component (browser navigates away).
  let state = $state(/** @type {'email'|'magic'|'authenticated'} */ ("email"));
  let email = $state(initialEmail);
  let requestId = $state("");
  let busy = $state(false);
  let error = $state("");

  async function handleEmailSubmit(e) {
    e.preventDefault();
    if (busy) return;
    error = "";
    if (!email || !email.includes("@")) {
      error = "Enter a valid email address.";
      return;
    }
    busy = true;
    try {
      const r = /** @type {SubmitResult} */ (await onSubmit({ email }));
      if (r.kind === "workos_redirect") {
        location.href = r.url;
      } else if (r.kind === "magic_link_request_id") {
        requestId = r.request_id;
        state = "magic";
      } else if (r.kind === "authenticated") {
        state = "authenticated";
        onAuthenticated(r);
      } else if (r.kind === "error") {
        error = r.message;
      }
    } catch (e) {
      error = (e && e.message) || "Sign-in failed. Try again.";
    } finally {
      busy = false;
    }
  }

  async function handleCodeComplete(code) {
    if (busy) return;
    error = "";
    busy = true;
    try {
      const r = /** @type {SubmitResult} */ (
        await onVerify({ request_id: requestId, code })
      );
      if (r.kind === "authenticated") {
        state = "authenticated";
        onAuthenticated(r);
      } else if (r.kind === "error") {
        error = r.message;
      }
    } catch (e) {
      error = (e && e.message) || "Code verification failed.";
    } finally {
      busy = false;
    }
  }

  function backToEmail() {
    state = "email";
    requestId = "";
    error = "";
  }
</script>

<section class="wb-signin-form">
  <p class="wb-kicker">workbooks · sign in</p>
  <h1 class="wb-h1">{title}</h1>
  {#if lede}<p class="wb-lede">{lede}</p>{/if}

  {#if state === "email"}
    <form onsubmit={handleEmailSubmit}>
      <label for="wb-signin-email">Email</label>
      <input
        id="wb-signin-email"
        type="email"
        autocomplete="email"
        inputmode="email"
        autocapitalize="off"
        spellcheck="false"
        required
        bind:value={email}
        disabled={busy}
        placeholder="you@example.com"
      />
      {#if error}
        <p class="wb-err" role="alert">{error}</p>
      {/if}
      <button class="wb-cta" type="submit" disabled={busy}>
        {busy ? "Continuing…" : "Continue"}
      </button>
    </form>
  {:else if state === "magic"}
    <p class="wb-lede">
      Enter the 6-digit code we just sent to <strong>{email}</strong>.
    </p>
    <MagicCodeInput onComplete={handleCodeComplete} disabled={busy} />
    {#if error}
      <p class="wb-err" role="alert">{error}</p>
    {/if}
    <button class="wb-cta secondary" type="button" onclick={backToEmail}>
      Use a different email
    </button>
  {:else if state === "authenticated"}
    <p class="wb-lede">Signed in. Redirecting…</p>
  {/if}
</section>

<style>
  .wb-signin-form {
    max-width: 380px;
    width: 100%;
  }
  form label {
    display: block;
    font-family: var(--wb-mono);
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    color: var(--wb-fg-mute);
    margin-bottom: 0.4rem;
  }
  form input {
    width: 100%;
    padding: 0.7rem 0.85rem;
    background: var(--wb-code-bg);
    color: var(--wb-fg);
    border: 0;
    border-radius: var(--wb-radius-md);
    font-family: inherit;
    font-size: 1rem;
    margin-bottom: 1rem;
  }
  form input:focus {
    outline: 1px solid var(--wb-fg-mute);
    outline-offset: 1px;
  }
  form input:disabled {
    opacity: 0.55;
  }
  .wb-err {
    margin: -0.5rem 0 1rem;
    color: var(--wb-err);
    font-size: 0.85rem;
  }
  button[type="button"] {
    margin-top: 0.6rem;
  }
</style>
