# README banner — visual identity

Single-scene 8-second loopable banner explaining workbooks at a glance.
Sits at the top of the workbooks repo README.

## Style Prompt

Swiss-Pulse adapted to workbooks' brand: dark, monochrome, ONE green
accent reserved for the "saved" moment. Grid-locked, calm, precise.
Nothing decorative. Nothing flashy. Type does the work; motion stays
out of the way until it has something specific to say.

## Colors

| token            | hex       | use                                  |
| ---------------- | --------- | ------------------------------------ |
| `--bg`           | `#0a0a0a` | canvas (matches lander dark mode)    |
| `--fg`           | `#f5f5f5` | logo, wordmark, tagline              |
| `--muted`        | `#6b7280` | meta labels, chrome, file UI         |
| `--line`         | `#1f1f1f` | hairline borders on the file mock    |
| `--accent`       | `#34d399` | reserved — "saved" pulse only        |
| `--accent-glow`  | `#34d39922` | radial bloom behind save event    |

The accent is the brand promise (signed + saved + verified). Don't reach
for it for any other reason.

## Typography

- **Inter** — wordmark + tagline. 700 for the wordmark, 500 for tagline.
- **JetBrains Mono** — file label and the install URL. Tabular figures.
- No third typeface. No display font. The Inter+Mono pairing is the
  same one that ships in the lander; reuse cements the brand.

## What NOT to Do

- No gradient text. No `background-clip: text`. The logo and wordmark
  are flat white on flat black. That's the brand.
- No purple/cyan/neon accents. Only the single emerald green, and only
  on the save event.
- No glowing borders, drop shadows, or "techy" effects. Workbooks is
  about restraint; the visual identity has to feel restrained.
- No bouncy / elastic eases. Use `expo.out`, `power3.out`, `sine.inOut`.
  Things snap into place or glide. Nothing wobbles.
- No floating decoratives during type sequences. Whitespace is the
  decorative.
- Don't rotate, skew, or 3D-transform the logo. It's a simple square
  glyph; let it be one.
