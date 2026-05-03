# Contributing to Workbooks

Thanks for your interest. This repo holds the canonical **workbook** format
spec and its reference implementations.

## Repo layout

This is a pnpm + Cargo monorepo:

- `packages/runtime/` — Svelte 5 UI runtime (npm: `@workbook/runtime`)
- `packages/runtime-wasm/` — Rust crate compiled to WASM (cargo: `workbook-runtime`)
- `proto/workbook/v1/` — canonical Protobuf schemas
- `docs/` — spec + operations docs

## Development

```bash
# Svelte runtime
cd packages/runtime
pnpm install
pnpm typecheck
pnpm build

# Rust runtime
cd packages/runtime-wasm
cargo check
cargo test
```

## Spec changes

Workbook is a format spec. Changes that touch `docs/SPEC.md`,
`proto/workbook/v1/workbook.proto`, or the wire encoding need an issue first
so we can talk through versioning impact. Backwards-compatible field additions
stay in `v1`; breaking changes increment the major version.

## Pull requests

- One concern per PR.
- Include a clear motivation in the description.
- Update docs and tests in the same PR.
- New block kinds need: a Svelte component, a registry entry, a proto message,
  and a doc paragraph.

## License

By contributing, you agree your contributions are licensed under
[Apache-2.0](LICENSE).
