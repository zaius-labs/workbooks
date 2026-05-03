<!--
  MagicCodeInput — six single-character boxes that render as one
  logical OTP entry.

  Behavior:
    - Each box accepts one digit. Typing advances focus to the next
      box automatically.
    - Backspace on an empty box moves focus to the previous box and
      clears it.
    - ArrowLeft / ArrowRight nudge focus without changing values.
    - Pasting a 6-digit string into any box fills all six and fires
      onComplete(code) immediately.
    - When all six boxes are filled by typing, fires onComplete(code)
      automatically — caller doesn't need a separate "verify" button.
    - inputmode="numeric" + pattern triggers the iOS / Android
      number pad. autocomplete="one-time-code" lets the OS surface
      the most recent SMS/email code.

  Props:
    onComplete: (code: string) => void | Promise<void>
    disabled:   boolean (greys out the boxes during verify)
-->

<script>
  let { onComplete, disabled = false } = $props();

  const N = 6;
  let digits = $state(["", "", "", "", "", ""]);
  /** @type {(HTMLInputElement | null)[]} */
  let inputs = $state(Array(N).fill(null));

  function isAllFilled(arr) {
    return arr.every((d) => /^\d$/.test(d));
  }

  function fireIfComplete() {
    if (isAllFilled(digits)) {
      onComplete(digits.join(""));
    }
  }

  function handleInput(i, e) {
    const v = e.target.value;
    // Strip non-digits so an autofilled "123" lands cleanly when
    // the OS pastes through one box.
    const cleaned = v.replace(/\D/g, "");
    if (cleaned.length === 0) {
      digits[i] = "";
      return;
    }
    if (cleaned.length === 1) {
      digits[i] = cleaned;
      if (i < N - 1) inputs[i + 1]?.focus();
      fireIfComplete();
      return;
    }
    // Multi-char input (paste landed on one box, or autofill). Spread
    // across boxes from the current index.
    const chars = cleaned.split("");
    for (let k = 0; k < N - i && k < chars.length; k++) {
      digits[i + k] = chars[k];
    }
    const next = Math.min(i + chars.length, N - 1);
    inputs[next]?.focus();
    fireIfComplete();
  }

  function handleKeydown(i, e) {
    if (e.key === "Backspace") {
      if (digits[i] === "" && i > 0) {
        e.preventDefault();
        inputs[i - 1]?.focus();
        digits[i - 1] = "";
      }
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      inputs[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < N - 1) {
      e.preventDefault();
      inputs[i + 1]?.focus();
    }
  }

  function handlePaste(e) {
    const text = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
    if (text.length === 0) return;
    e.preventDefault();
    const chars = text.split("").slice(0, N);
    for (let k = 0; k < chars.length; k++) {
      digits[k] = chars[k];
    }
    inputs[Math.min(chars.length, N - 1)]?.focus();
    fireIfComplete();
  }
</script>

<div class="wb-otp" role="group" aria-label="One-time code">
  {#each digits as digit, i}
    <input
      bind:this={inputs[i]}
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      maxlength="1"
      autocomplete={i === 0 ? "one-time-code" : "off"}
      value={digit}
      {disabled}
      aria-label={`Digit ${i + 1} of ${N}`}
      oninput={(e) => handleInput(i, e)}
      onkeydown={(e) => handleKeydown(i, e)}
      onpaste={handlePaste}
    />
  {/each}
</div>

<style>
  .wb-otp {
    display: flex;
    gap: 0.4rem;
    margin: 0 0 1rem;
  }
  .wb-otp input {
    flex: 1;
    min-width: 0;
    padding: 0.7rem 0;
    background: var(--wb-code-bg);
    color: var(--wb-fg);
    border: 0;
    border-radius: var(--wb-radius-sm);
    font-family: var(--wb-mono);
    font-size: 1.4rem;
    text-align: center;
    -moz-appearance: textfield;
  }
  .wb-otp input::-webkit-outer-spin-button,
  .wb-otp input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .wb-otp input:focus {
    outline: 1px solid var(--wb-fg-mute);
    outline-offset: 1px;
  }
  .wb-otp input:disabled {
    opacity: 0.55;
  }
</style>
