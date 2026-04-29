// dependency-chain — demonstrates how the cell DAG propagates errors.
// Each cell explicitly declares dependsOn / provides so the executor
// builds a proper chain. Edit any cell to introduce an error and the
// downstream cells transition to "stale (upstream error)" rather
// than running with bad inputs.
export default {
  name: "Dependency chain — errors that propagate",
  slug: "dependency-chain",
  type: "notebook",
  version: "0.1",
  entry: "src/index.html",
  runtimeFeatures: ["polars", "rhai"],
};
