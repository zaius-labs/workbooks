<script>
  import Router, { link } from "svelte-spa-router";
  import Home from "./routes/Home.svelte";
  import Editor from "./routes/Editor.svelte";
  import Settings from "./routes/Settings.svelte";

  const routes = {
    "/": Home,
    "/editor": Editor,
    "/settings": Settings,
  };
</script>

<div class="app">
  <header>
    <span class="brand">workbook<span class="accent">/</span>svelte</span>
    <nav>
      <a use:link href="/">home</a>
      <a use:link href="/editor">editor</a>
      <a use:link href="/settings">settings</a>
    </nav>
  </header>

  <main>
    <Router {routes} />
  </main>

  <footer>
    <span>Svelte 5 · hash routing · runs from file://</span>
  </footer>
</div>

<style>
  :global(html, body) {
    margin: 0;
    background: #ffffff;
    color: #000000;
    font-family: -apple-system, "SF Pro Text", "Inter", system-ui, sans-serif;
    line-height: 1.55;
  }
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  header {
    display: flex; align-items: center; gap: 24px;
    padding: 12px 24px; border-bottom: 1px solid #d6d6d6;
  }
  .brand {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
  }
  .accent { color: #000000; }
  nav { display: flex; gap: 16px; flex: 1; }
  nav :global(a) {
    color: #2a2a2a; text-decoration: none;
    font-size: 14px; padding: 4px 8px; border-radius: 4px;
  }
  nav :global(a:hover) { background: #f5f5f5; color: #000000; }
  nav :global(a[aria-current="page"]) { color: #000000; font-weight: 600; }
  main { flex: 1; padding: 32px 24px; max-width: 880px; margin: 0 auto; width: 100%; box-sizing: border-box; }
  footer {
    padding: 12px 24px; border-top: 1px solid #d6d6d6;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px; color: #707070; text-align: center;
  }
</style>
