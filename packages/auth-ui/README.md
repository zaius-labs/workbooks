# @work.books/auth-ui

Svelte 5 sign-in components + design tokens for the Workbooks Studio identity broker.

The package is the visual source-of-truth for every Workbooks-branded surface that asks the user to authenticate:

- **broker `/sign-in` route** (C7.4) — the page the broker redirects to from `/v1/auth/start`
- **pre-auth shell** inside sealed `.html` workbook files (C8) — visual continuity across the redirect
- **admin webapp** at `admin.workbooks.sh` (C5) — same tokens, same components

## v0.1.0 — tokens + logo only

This release ships:

- `@work.books/auth-ui/tokens.css` — strict-monochrome lander palette + graph-paper dashboard accent + status colors confined to verification badges
- `@work.books/auth-ui/logo.svg` — Workbooks mark, single-color via `currentColor`/`fill`
- JS `TOKENS` + `TOKENS_DARK` re-exports for places where CSS variables aren't reachable

Components (`SignInForm`, `MagicCodeInput`) land in C7.2 / C7.3.

## Usage

```html
<link rel="stylesheet" href="/path/to/@work.books/auth-ui/tokens.css" />
<body class="wb-app">
  <main>
    <p class="wb-kicker">workbooks · sealed</p>
    <h1 class="wb-h1">Sign in</h1>
    <p class="wb-lede">…</p>
    <button class="wb-cta">Continue</button>
  </main>
</body>
```

## Brand discipline

The tokens here are the only place we declare the Workbooks palette. Anywhere that hardcodes hex literally is **wrong** and should `import` or `@import` from this package — the pre-auth shell does this via build-time inject, the admin webapp via SvelteKit `+layout.svelte`, the broker route via `<link>`.
