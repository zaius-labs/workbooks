// @work.books/substrate — public API.
//
// Workbook substrate v0: file-as-database persistence layer.
// File format: vendor/workbooks/docs/SUBSTRATE_FORMAT_V0.md.

export * from "./types";
export { cidOf, opCid, opCidSync, cidOfSync } from "./cid";
export { parseSubstrateFromHtml, parseSubstrateFromDocument } from "./parse";
export {
  hydrateYjsTarget,
  hydrateSqliteTarget,
  DEFAULT_SQLITE_CONFLICT_POLICY,
} from "./hydrate";
export type { YjsLike, YDocLike, SqliteLike, HydrateSqliteOptions } from "./hydrate";
export {
  createMutator,
  bindYjsAutoEmit,
  bindSqliteSessionAutoEmit,
} from "./mutate";
export type {
  SubstrateMutator,
  CommitListener,
  YjsBindOptions,
  SqliteSessionBindOptions,
  SqliteSessionBinding,
} from "./mutate";
