<script>
  /**
   * Friendly install banner — used wherever the manager UI would
   * otherwise surface a "daemon not running" error. Matches the
   * file:// install toast aesthetic in workbook-cli's runtime-inject:
   * Workbooks logo, feature-forward copy ("get more from your
   * workbooks"), free CTA. Optionally takes a "retry" callback for
   * the case where the daemon SHOULD be running locally but the
   * Manager just lost contact (network probe failed, daemon crashed
   * but is being respawned by launchd). Retry triggers a re-probe
   * via the parent's daemon.boot().
   */
  let { onRetry = null } = $props();
</script>

<main>
  <div class="banner">
    <svg class="logo" viewBox="0 0 634 632" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="currentColor" d="M517.107 187.121C520.419 186.936 525.375 187.132 528.815 187.146L547.714 187.14C553.689 187.193 559.871 186.766 565.811 187.189C568.077 187.351 570.622 187.72 572.739 188.563C576.284 189.975 579.85 194.04 581.237 197.461C582.036 199.423 582.222 201.854 582.349 203.955C582.903 213.23 582.503 222.746 582.506 232.041C582.513 240.104 582.992 248.519 582.29 256.548C582.101 258.728 581.698 261.402 580.776 263.393C579.092 267.023 575.587 270.125 571.851 271.426C565.622 273.595 538.12 272.651 529.796 272.635C525.898 272.628 521.19 272.172 517.546 273.717C513.444 275.459 509.538 278.915 507.922 283.131C506.067 287.961 506.606 293.745 506.609 298.832L506.671 326.865C506.686 333.16 507.429 341.996 505.132 347.796C499.535 361.947 484.295 357.078 472.457 357.877C463.319 358.49 452.803 356.336 444.005 359.632C431.99 364.314 433.046 376.134 433.129 386.462L433.201 414.2C433.201 418.291 433.405 425.911 432.981 429.765C432.777 431.714 432.272 433.624 431.492 435.422C427.978 443.395 420.954 444.769 413.072 444.72C398.523 444.636 383.827 444.812 369.302 444.642C362.668 444.565 356.263 439.158 354.489 432.934C353.427 429.198 353.774 422.6 353.78 418.551L353.768 390.538C353.793 385.268 353.907 380.161 353.759 374.837C353.79 366.035 346.292 358.474 337.525 358.029C328.108 357.558 318.691 358.146 309.25 357.827C298.666 357.468 286.398 357.406 281.275 368.7C279.383 372.872 279.917 380.956 279.931 385.593L279.948 412.971C279.949 419.232 280.698 429.681 278.316 435.168C274.268 444.5 265.131 444.927 256.577 444.723C242.493 444.385 228.863 445.082 214.833 444.583C207.943 444.339 202.531 438.74 200.575 432.476C199.474 428.483 199.812 422.649 199.813 418.412L199.854 393.927C199.879 388.001 200.612 374.636 198.975 369.322C194.308 354.172 174.203 358.22 161.818 357.914C150.171 357.623 132.752 362.479 127.734 346.54C125.937 340.83 126.673 330.492 126.667 324.404C126.64 315.803 126.657 307.199 126.718 298.596C126.781 288.941 127.981 279.348 117.553 274.193L117.184 274.015C111.487 272.007 106.525 272.594 100.489 272.632L79.1934 272.67C70.1122 272.676 61.6083 274.101 55.2286 266.509C50.2285 260.559 51.1853 255.205 51.0764 247.967C50.9909 242.298 51.0368 236.718 51.029 231.104L51.0417 213.71C51.0668 206.866 50.3189 200.637 54.2371 194.642C59.4082 186.73 67.6396 187.785 75.9565 187.752L96.7835 187.81C103.937 187.821 111.614 187.489 118.744 187.979C121.36 188.292 123.989 189.231 126.124 190.735C134.236 196.453 133.113 206.751 133.06 215.421L132.926 243.173C132.905 248.525 132.641 254.969 133.403 260.17C133.897 265.327 139.62 271.652 145.003 272.679C154.839 274.33 165.256 273.354 175.332 273.537C187.279 273.755 201.923 270.954 205.953 286.31C207.068 290.557 206.623 296.695 206.612 301.216L206.552 328.351C206.543 332.699 206.332 340.548 206.93 344.661C207.539 349.019 209.869 352.953 213.398 355.583C215.302 356.989 217.742 358.279 220.085 358.573C227.561 359.511 236.427 359.056 244.022 359.115C248.259 359.149 258.843 359.325 262.416 358.728C268.556 357.648 273.615 353.299 275.609 347.394C277.045 343.064 276.542 336.094 276.485 331.331L276.398 304.096C276.404 298.675 276.217 292.831 276.919 287.455C277.804 280.674 283.993 274.298 290.95 273.765C298.969 273.15 307.239 273.616 315.292 273.537C324.25 273.592 333.485 273.149 342.404 273.952C349.189 274.746 354.7 279.509 356.17 286.253C357.266 291.279 356.91 297.104 356.876 302.265L356.765 328.394C356.731 337.577 355.13 349.653 363.529 355.655C370.77 360.829 382.543 358.824 391.13 359.124C398.194 358.793 405.754 359.712 412.75 358.737C428.966 356.481 427 340.359 426.957 329.449L426.904 303.014C426.895 295.859 425.858 285.781 430.452 279.887C432.777 276.94 436.018 274.85 439.661 273.947C444.317 272.751 448.93 273.559 453.673 273.467C464.362 273.258 475.491 274.041 486.106 273.189C491.83 272.729 497.864 268.034 499.563 262.586C500.993 258 500.625 252.065 500.603 247.192L500.576 218.175C500.56 204.088 498.628 189.691 517.107 187.121Z"/>
    </svg>
    <h1>Get more from your workbooks</h1>
    <p>
      Install Workbooks — <strong>free</strong> — to enable autosave,
      OS keychain-backed API key storage, and outbound calls to your
      configured services. The browser keeps rendering everything;
      Workbooks just unlocks the parts a browser can't do alone.
    </p>
    <div class="actions">
      <a class="primary" href="https://workbooks.sh" target="_blank" rel="noopener noreferrer">
        Install Workbooks (free)
      </a>
      {#if onRetry}
        <button class="secondary" onclick={onRetry}>Already installed — retry</button>
      {/if}
    </div>
  </div>
</main>

<style>
  main {
    flex: 1 1 auto;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg);
    padding: 32px;
  }
  .banner {
    max-width: 480px;
    padding: 36px 40px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
  }
  .logo {
    width: 48px;
    height: 48px;
    color: var(--fg);
    margin: 0 auto 18px;
    display: block;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--fg);
  }
  p {
    margin: 0 0 22px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--fg-muted);
  }
  p strong { color: var(--fg); font-weight: 600; }
  .actions {
    display: flex; flex-direction: column; gap: 8px; align-items: center;
  }
  a.primary {
    display: inline-block;
    background: var(--fg);
    color: var(--bg);
    text-decoration: none;
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    transition: opacity 100ms ease, transform 80ms ease;
  }
  a.primary:hover { opacity: 0.9; }
  a.primary:active { transform: translateY(0.5px); }
  button.secondary {
    background: transparent;
    border: 0;
    color: var(--fg-faint);
    font-size: 11.5px;
    cursor: pointer;
    padding: 6px 10px;
  }
  button.secondary:hover { color: var(--fg-muted); }
</style>
