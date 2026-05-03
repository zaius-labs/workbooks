// Programmatic entrypoint — exports for embedding the build/dev
// flow in other tooling.

export { runDev } from "./commands/dev.mjs";
export { runBuild } from "./commands/build.mjs";
export { default as workbookPlugin } from "./plugins/workbookInline.mjs";
export { loadConfig } from "./util/config.mjs";
