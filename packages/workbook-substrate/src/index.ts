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
export type {
  SubstrateTransport,
  CommitRequest,
  CommitResult,
  WriteSemantics,
  FileImage,
} from "./transport";
export { LocalhostRunnerTransport } from "./transports/t1-localhost-runner";
export { PwaFsaTransport } from "./transports/t2-pwa-fsa";
export { FsaSessionTransport } from "./transports/t3-fsa-session";
export type { T3Options } from "./transports/t3-fsa-session";
export { OpfsDownloadTransport } from "./transports/t4-opfs-download";
export type { T4Options } from "./transports/t4-opfs-download";
export { ReadOnlyTransport } from "./transports/t5-readonly";
export { negotiate } from "./transports/negotiator";
export type { NegotiateOptions, NegotiateResult } from "./transports/negotiator";

export { mountInstallBanner } from "./install-banner";
export type { InstallBannerOptions, InstallBannerHandle } from "./install-banner";

export { compact, shouldCompact } from "./compact";
export type { TargetEncoder, CompactOptions } from "./compact";
export {
  identityKeyOf,
  keyString,
  MemoryIdentityStore,
  migrateIdentity,
  gcOrphans,
} from "./identity";
export type { IdentityKey, IdentityStore } from "./identity";
