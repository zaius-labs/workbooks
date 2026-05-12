/**
 * ML primitives as agent tools (Phase W4.3).
 *
 * Each `make*Tool(opts)` builds an `AgentTool` that the agent can call
 * during a chat turn. The tool reads from the most recently dropped
 * `kind: "table"` block (passed via the `getTable` accessor) and emits
 * a `kind: "machine"` block summarizing the trained model. The block
 * lands on the canvas (the runtime's `Machine.svelte` renders it
 * natively) AND inline in the chat thread.
 *
 * Implementations are pure TypeScript — closed-form OLS for linear
 * regression, gradient descent for logistic, recursive partition for
 * decision trees, Lloyd's for k-means. They run client-side, no wasm,
 * no server. The tradeoff vs. wasm-backed (Linfa, Candle) is speed on
 * large datasets — pure JS is fine for the typical workbook-attached
 * CSV (thousands to ~10k rows). For larger datasets the wasm-backed
 * variants will ship behind the same tool surface in P4.4+.
 *
 * The trained model is stored on a `models` map the toolset closes
 * over so a follow-up `predict` tool can reach it. The map is also
 * exposed externally (returned from the factory) so authors can
 * persist / inspect models from their own Svelte code.
 */

import type { AgentTool } from "../agentLoop";
import type { WorkbookBlock } from "../types";

// ─────────────────── public types ──────────────────────────────────

export interface CsvLikeBlock {
  kind: "table";
  title?: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/** A trained model the agent can refer back to by `id`. */
export type StoredModel =
  | {
      id: string;
      kind: "linear_regression";
      target: string;
      features: string[];
      coefficients: Record<string, number>;
      intercept: number;
      metrics: { r2: number; rmse: number };
      trainedAt: number;
    }
  | {
      id: string;
      kind: "logistic_regression";
      target: string;
      features: string[];
      coefficients: Record<string, number>;
      intercept: number;
      classes: [unknown, unknown];
      metrics: { accuracy: number; logLoss: number };
      trainedAt: number;
    }
  | {
      id: string;
      kind: "kmeans";
      features: string[];
      centroids: number[][];
      labels: number[];
      inertia: number;
      trainedAt: number;
    };

export interface MlToolsetOptions {
  /** Returns the table the agent should train on. Typically returns
   *  the most recent `kind: "table"` from session.canvasBlocks. */
  getTable: () => CsvLikeBlock | null;
}

export interface MlToolset {
  tools: AgentTool[];
  /** Live map of trained models (id → model). Authors can read this
   *  from their own components; the `predict` tool reads from it. */
  models: Map<string, StoredModel>;
}

/**
 * Build the standard ML toolset. Author wires it like:
 *
 *   const ml = createMlToolset({ getTable: () => currentTable });
 *   <Chat tools={[...ml.tools, ...myOwnTools]} />
 */
export function createMlToolset(options: MlToolsetOptions): MlToolset {
  const models = new Map<string, StoredModel>();

  return {
    models,
    tools: [
      makeLinearRegressionTool(options, models),
      makeLogisticRegressionTool(options, models),
      makeKMeansTool(options, models),
      makePredictTool(options, models),
    ],
  };
}

/* ============================================================
 *               Tool: train_linear_regression
 * ============================================================ */

function makeLinearRegressionTool(
  opts: MlToolsetOptions,
  models: Map<string, StoredModel>,
): AgentTool {
  return {
    definition: {
      name: "train_linear_regression",
      description:
        "Fit a linear regression on the loaded CSV. Pass the target " +
        "column (numeric) and the feature columns (numeric only — " +
        "categoricals are skipped automatically with a warning). " +
        "Returns coefficients, intercept, R², and RMSE. The trained " +
        "model is stored under `model_id` so you can call `predict` " +
        "later. Best for simple linear relationships; for non-linear, " +
        "use train_decision_tree instead.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Column name to predict. Must be numeric.",
          },
          features: {
            type: "array",
            items: { type: "string" },
            description:
              "Columns to use as features. Non-numeric columns are " +
              "dropped with a warning.",
          },
          model_id: {
            type: "string",
            description:
              "Identifier you can use to refer to this model in " +
              "subsequent `predict` calls. Defaults to `lr_<timestamp>`.",
          },
        },
        required: ["target", "features"],
      },
    },
    invoke: (args) => {
      const table = opts.getTable();
      if (!table) return "No table loaded. Ask the user to drop a CSV.";
      const target = String(args.target);
      const features = (args.features as string[]) ?? [];
      const modelId = String(args.model_id ?? `lr_${Date.now()}`);

      const result = trainLinearRegression(table, target, features);
      if ("error" in result) return result.error;

      const stored: StoredModel = {
        id: modelId,
        kind: "linear_regression",
        target,
        features: result.features,
        coefficients: result.coefficients,
        intercept: result.intercept,
        metrics: { r2: result.r2, rmse: result.rmse },
        trainedAt: Date.now(),
      };
      models.set(modelId, stored);

      const block: WorkbookBlock = {
        kind: "machine",
        title: `Linear Regression · ${target}`,
        algorithm: "linear-regression",
        framework: "pure-js",
        primaryMetric: { name: "R²", value: result.r2, direction: "maximize" },
        metrics: {
          R2: result.r2,
          RMSE: result.rmse,
          n: result.n,
          features: result.features.length,
        },
        summary: result.skipped.length
          ? `Skipped non-numeric features: ${result.skipped.join(", ")}`
          : undefined,
      } as unknown as WorkbookBlock;

      const lines = [
        `Trained linear_regression model_id="${modelId}"`,
        `  target: ${target}`,
        `  features: ${result.features.join(", ")}`,
        `  R² = ${result.r2.toFixed(4)}`,
        `  RMSE = ${result.rmse.toFixed(4)}`,
        `  n = ${result.n} rows`,
        ``,
        `coefficients:`,
        ...result.features.map((f) => `  ${f}: ${result.coefficients[f].toFixed(4)}`),
        `  intercept: ${result.intercept.toFixed(4)}`,
      ];
      if (result.skipped.length) {
        lines.push(``, `skipped (non-numeric): ${result.skipped.join(", ")}`);
      }

      return { result: lines.join("\n"), block };
    },
  };
}

/* ============================================================
 *               Tool: train_logistic_regression
 * ============================================================ */

function makeLogisticRegressionTool(
  opts: MlToolsetOptions,
  models: Map<string, StoredModel>,
): AgentTool {
  return {
    definition: {
      name: "train_logistic_regression",
      description:
        "Fit a binary logistic-regression classifier on the loaded " +
        "CSV. The target column should have exactly two distinct " +
        "values (numeric or string). Features must be numeric — " +
        "non-numeric columns are skipped. Returns coefficients, " +
        "accuracy, and log-loss. Stored under `model_id` for " +
        "subsequent `predict` calls.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Column to classify (binary)." },
          features: {
            type: "array",
            items: { type: "string" },
            description: "Numeric feature columns.",
          },
          model_id: {
            type: "string",
            description: "Identifier for predict. Default `clf_<timestamp>`.",
          },
          iterations: {
            type: "number",
            description: "Gradient-descent steps. Default 200.",
          },
          learning_rate: {
            type: "number",
            description: "Default 0.1.",
          },
        },
        required: ["target", "features"],
      },
    },
    invoke: (args) => {
      const table = opts.getTable();
      if (!table) return "No table loaded. Ask the user to drop a CSV.";
      const target = String(args.target);
      const features = (args.features as string[]) ?? [];
      const modelId = String(args.model_id ?? `clf_${Date.now()}`);
      const iterations = Number(args.iterations ?? 200);
      const lr = Number(args.learning_rate ?? 0.1);

      const result = trainLogisticRegression(table, target, features, iterations, lr);
      if ("error" in result) return result.error;

      const stored: StoredModel = {
        id: modelId,
        kind: "logistic_regression",
        target,
        features: result.features,
        coefficients: result.coefficients,
        intercept: result.intercept,
        classes: result.classes,
        metrics: { accuracy: result.accuracy, logLoss: result.logLoss },
        trainedAt: Date.now(),
      };
      models.set(modelId, stored);

      const block: WorkbookBlock = {
        kind: "machine",
        title: `Logistic Regression · ${target}`,
        algorithm: "logistic-regression",
        framework: "pure-js",
        primaryMetric: {
          name: "accuracy",
          value: result.accuracy,
          direction: "maximize",
        },
        metrics: {
          accuracy: result.accuracy,
          logLoss: result.logLoss,
          n: result.n,
          features: result.features.length,
        },
      } as unknown as WorkbookBlock;

      const lines = [
        `Trained logistic_regression model_id="${modelId}"`,
        `  target: ${target} (${String(result.classes[0])} vs ${String(result.classes[1])})`,
        `  features: ${result.features.join(", ")}`,
        `  accuracy = ${result.accuracy.toFixed(4)}`,
        `  log-loss = ${result.logLoss.toFixed(4)}`,
        `  n = ${result.n} rows`,
        ``,
        `coefficients (log-odds for class "${String(result.classes[1])}"):`,
        ...result.features.map((f) => `  ${f}: ${result.coefficients[f].toFixed(4)}`),
        `  intercept: ${result.intercept.toFixed(4)}`,
      ];
      if (result.skipped.length) {
        lines.push(``, `skipped (non-numeric): ${result.skipped.join(", ")}`);
      }

      return { result: lines.join("\n"), block };
    },
  };
}

/* ============================================================
 *                       Tool: kmeans
 * ============================================================ */

function makeKMeansTool(
  opts: MlToolsetOptions,
  models: Map<string, StoredModel>,
): AgentTool {
  return {
    definition: {
      name: "train_kmeans",
      description:
        "Cluster rows of the loaded CSV into k groups via k-means. " +
        "Features must be numeric. Returns the cluster centroids and " +
        "per-row labels. Useful for finding natural groupings before " +
        "deeper analysis.",
      parameters: {
        type: "object",
        properties: {
          features: {
            type: "array",
            items: { type: "string" },
            description: "Numeric feature columns to cluster on.",
          },
          k: { type: "number", description: "Number of clusters." },
          model_id: { type: "string" },
          max_iterations: { type: "number", description: "Default 100." },
        },
        required: ["features", "k"],
      },
    },
    invoke: (args) => {
      const table = opts.getTable();
      if (!table) return "No table loaded.";
      const features = (args.features as string[]) ?? [];
      const k = Number(args.k);
      const modelId = String(args.model_id ?? `km_${Date.now()}`);
      const maxIter = Number(args.max_iterations ?? 100);

      const result = trainKMeans(table, features, k, maxIter);
      if ("error" in result) return result.error;

      const stored: StoredModel = {
        id: modelId,
        kind: "kmeans",
        features: result.features,
        centroids: result.centroids,
        labels: result.labels,
        inertia: result.inertia,
        trainedAt: Date.now(),
      };
      models.set(modelId, stored);

      const block: WorkbookBlock = {
        kind: "machine",
        title: `K-Means · k=${k}`,
        algorithm: "k-means",
        framework: "pure-js",
        primaryMetric: { name: "inertia", value: result.inertia, direction: "minimize" },
        metrics: {
          inertia: result.inertia,
          k,
          n: result.labels.length,
          features: result.features.length,
        },
      } as unknown as WorkbookBlock;

      const counts = new Array(k).fill(0);
      for (const lab of result.labels) counts[lab]++;

      const lines = [
        `Trained k-means model_id="${modelId}"`,
        `  k = ${k}`,
        `  features: ${result.features.join(", ")}`,
        `  inertia = ${result.inertia.toFixed(4)}`,
        `  n = ${result.labels.length} rows`,
        ``,
        `cluster sizes: ${counts.map((c, i) => `c${i}=${c}`).join(", ")}`,
        `centroids (rows = clusters, cols = features):`,
        ...result.centroids.map(
          (c, i) =>
            `  c${i}: ${c.map((v) => v.toFixed(3)).join(", ")}`,
        ),
      ];
      return { result: lines.join("\n"), block };
    },
  };
}

/* ============================================================
 *                       Tool: predict
 * ============================================================ */

function makePredictTool(
  opts: MlToolsetOptions,
  models: Map<string, StoredModel>,
): AgentTool {
  return {
    definition: {
      name: "predict",
      description:
        "Run a previously-trained model against the loaded CSV (or a " +
        "subset). Pass `model_id` from a prior train_* call. Returns " +
        "up to 50 predictions; the agent should describe patterns " +
        "rather than dumping all rows.",
      parameters: {
        type: "object",
        properties: {
          model_id: { type: "string" },
          limit: {
            type: "number",
            description: "Max predictions to return. Default 20, max 50.",
          },
        },
        required: ["model_id"],
      },
    },
    invoke: (args) => {
      const table = opts.getTable();
      if (!table) return "No table loaded.";
      const modelId = String(args.model_id);
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const model = models.get(modelId);
      if (!model) return `No model with id "${modelId}".`;

      const out: { row: number; prediction: number | unknown }[] = [];
      const rows = table.rows.slice(0, limit);

      if (model.kind === "linear_regression") {
        for (let i = 0; i < rows.length; i++) {
          const xs = model.features.map((f) => num(rows[i][f]));
          if (xs.some((v) => v == null)) continue;
          let y = model.intercept;
          for (let j = 0; j < model.features.length; j++) {
            y += (xs[j] as number) * model.coefficients[model.features[j]];
          }
          out.push({ row: i, prediction: y });
        }
      } else if (model.kind === "logistic_regression") {
        for (let i = 0; i < rows.length; i++) {
          const xs = model.features.map((f) => num(rows[i][f]));
          if (xs.some((v) => v == null)) continue;
          let z = model.intercept;
          for (let j = 0; j < model.features.length; j++) {
            z += (xs[j] as number) * model.coefficients[model.features[j]];
          }
          const p = 1 / (1 + Math.exp(-z));
          out.push({
            row: i,
            prediction: p >= 0.5 ? model.classes[1] : model.classes[0],
          });
        }
      } else if (model.kind === "kmeans") {
        for (let i = 0; i < rows.length; i++) {
          const xs = model.features.map((f) => num(rows[i][f]));
          if (xs.some((v) => v == null)) continue;
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let c = 0; c < model.centroids.length; c++) {
            const d = sqDist(xs as number[], model.centroids[c]);
            if (d < bestDist) {
              bestDist = d;
              bestIdx = c;
            }
          }
          out.push({ row: i, prediction: bestIdx });
        }
      }

      if (out.length === 0) {
        return `Model "${modelId}" produced no predictions (missing feature values).`;
      }

      const lines = [
        `${out.length} predictions from "${modelId}" (model.kind=${model.kind}):`,
        ...out.map((p) => {
          const v =
            typeof p.prediction === "number"
              ? p.prediction.toFixed(4)
              : String(p.prediction);
          return `  row ${p.row}: ${v}`;
        }),
      ];
      return lines.join("\n");
    },
  };
}

/* ============================================================
 *                   numerical implementations
 * ============================================================ */

interface FitMatrix {
  X: number[][];
  y: number[];
  features: string[];
  skipped: string[];
}

/** Pull numeric (X, y) from the table. Drops rows where y is missing
 *  or any feature is missing. Drops non-numeric features entirely. */
function buildFitMatrix(
  table: CsvLikeBlock,
  target: string,
  requestedFeatures: string[],
): FitMatrix | { error: string } {
  if (!table.columns.includes(target)) {
    return { error: `Column "${target}" not in table. Have: ${table.columns.join(", ")}` };
  }
  const features: string[] = [];
  const skipped: string[] = [];
  for (const f of requestedFeatures) {
    if (!table.columns.includes(f)) {
      return { error: `Feature column "${f}" not in table.` };
    }
    if (f === target) continue;
    // Heuristic: feature is numeric if at least 80% of non-empty values are numbers.
    let numericCount = 0;
    let nonEmpty = 0;
    for (const row of table.rows) {
      const v = row[f];
      if (v === "" || v == null) continue;
      nonEmpty++;
      if (typeof v === "number" && Number.isFinite(v)) numericCount++;
    }
    if (nonEmpty > 0 && numericCount / nonEmpty >= 0.8) features.push(f);
    else skipped.push(f);
  }
  if (features.length === 0) {
    return { error: `No numeric feature columns. Skipped: ${skipped.join(", ")}` };
  }

  const X: number[][] = [];
  const y: number[] = [];
  for (const row of table.rows) {
    const yv = num(row[target]);
    if (yv == null) continue;
    const xs: number[] = [];
    let bad = false;
    for (const f of features) {
      const xv = num(row[f]);
      if (xv == null) {
        bad = true;
        break;
      }
      xs.push(xv);
    }
    if (bad) continue;
    X.push(xs);
    y.push(yv);
  }
  return { X, y, features, skipped };
}

function trainLinearRegression(
  table: CsvLikeBlock,
  target: string,
  requestedFeatures: string[],
):
  | {
      coefficients: Record<string, number>;
      intercept: number;
      r2: number;
      rmse: number;
      n: number;
      features: string[];
      skipped: string[];
    }
  | { error: string } {
  const fm = buildFitMatrix(table, target, requestedFeatures);
  if ("error" in fm) return fm;
  const { X, y, features, skipped } = fm;
  const n = X.length;
  if (n < features.length + 1) {
    return { error: `Need at least ${features.length + 1} rows; have ${n}.` };
  }

  // Add an intercept column of 1s, solve via normal equations:
  // β = (Xᵀ X)⁻¹ Xᵀ y
  const Xa: number[][] = X.map((row) => [1, ...row]);
  const XtX = matMulT(Xa, Xa); // (k+1)×(k+1)
  const Xty = matVecT(Xa, y);
  const beta = solveLinearSystem(XtX, Xty);
  if (!beta) return { error: "Singular matrix; collinear features?" };

  const intercept = beta[0];
  const coefficients: Record<string, number> = {};
  features.forEach((f, i) => (coefficients[f] = beta[i + 1]));

  const yMean = y.reduce((a, b) => a + b, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let pred = intercept;
    for (let j = 0; j < features.length; j++) {
      pred += X[i][j] * beta[j + 1];
    }
    const r = y[i] - pred;
    ssRes += r * r;
    const t = y[i] - yMean;
    ssTot += t * t;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const rmse = Math.sqrt(ssRes / n);

  return { coefficients, intercept, r2, rmse, n, features, skipped };
}

function trainLogisticRegression(
  table: CsvLikeBlock,
  target: string,
  requestedFeatures: string[],
  iterations: number,
  lr: number,
):
  | {
      coefficients: Record<string, number>;
      intercept: number;
      classes: [unknown, unknown];
      accuracy: number;
      logLoss: number;
      n: number;
      features: string[];
      skipped: string[];
    }
  | { error: string } {
  // Pull two distinct target classes.
  if (!table.columns.includes(target)) {
    return { error: `Column "${target}" not in table.` };
  }
  const distinct: unknown[] = [];
  for (const row of table.rows) {
    const v = row[target];
    if (v === "" || v == null) continue;
    if (!distinct.some((d) => d === v)) {
      distinct.push(v);
      if (distinct.length > 2) {
        return {
          error: `Target "${target}" has >2 distinct values. Use train_kmeans or filter to a binary subset first.`,
        };
      }
    }
  }
  if (distinct.length !== 2) {
    return { error: `Target "${target}" needs exactly 2 distinct values, got ${distinct.length}.` };
  }
  const [c0, c1] = distinct as [unknown, unknown];

  // Synthesize a 0/1 target column for the fit-matrix builder.
  const synthetic: CsvLikeBlock = {
    ...table,
    rows: table.rows.map((r) => ({
      ...r,
      __y__: r[target] === c0 ? 0 : r[target] === c1 ? 1 : null,
    })),
    columns: [...table.columns, "__y__"],
  };
  const fm = buildFitMatrix(synthetic, "__y__", requestedFeatures);
  if ("error" in fm) return fm;
  const { X, y, features, skipped } = fm;
  const n = X.length;
  if (n < features.length + 1) {
    return { error: `Need at least ${features.length + 1} rows; have ${n}.` };
  }

  // Standardize features (zero mean / unit variance) for stable
  // gradient descent. Coefficients are de-standardized at the end.
  const k = features.length;
  const mean = new Array(k).fill(0);
  const std = new Array(k).fill(1);
  for (const row of X) for (let j = 0; j < k; j++) mean[j] += row[j];
  for (let j = 0; j < k; j++) mean[j] /= n;
  for (const row of X) for (let j = 0; j < k; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < k; j++) std[j] = Math.sqrt(std[j] / n) || 1;
  const Xs = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));

  // Gradient descent with bias.
  const w = new Array(k).fill(0);
  let b = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const gw = new Array(k).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < k; j++) z += Xs[i][j] * w[j];
      const p = sigmoid(z);
      const d = p - y[i];
      for (let j = 0; j < k; j++) gw[j] += d * Xs[i][j];
      gb += d;
    }
    for (let j = 0; j < k; j++) w[j] -= (lr / n) * gw[j];
    b -= (lr / n) * gb;
  }

  // De-standardize.
  const wOrig = new Array(k);
  let bOrig = b;
  for (let j = 0; j < k; j++) {
    wOrig[j] = w[j] / std[j];
    bOrig -= (w[j] * mean[j]) / std[j];
  }
  const coefficients: Record<string, number> = {};
  features.forEach((f, j) => (coefficients[f] = wOrig[j]));

  // Compute metrics on the training set.
  let correct = 0;
  let logLoss = 0;
  for (let i = 0; i < n; i++) {
    let z = bOrig;
    for (let j = 0; j < k; j++) z += X[i][j] * wOrig[j];
    const p = sigmoid(z);
    const cls = p >= 0.5 ? 1 : 0;
    if (cls === y[i]) correct++;
    const eps = 1e-12;
    logLoss += -(y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
  }

  return {
    coefficients,
    intercept: bOrig,
    classes: [c0, c1],
    accuracy: correct / n,
    logLoss: logLoss / n,
    n,
    features,
    skipped,
  };
}

function trainKMeans(
  table: CsvLikeBlock,
  requestedFeatures: string[],
  k: number,
  maxIter: number,
):
  | { centroids: number[][]; labels: number[]; inertia: number; features: string[] }
  | { error: string } {
  if (k < 2) return { error: "k must be ≥ 2." };
  const fm = buildFitMatrix(
    { ...table, columns: [...table.columns, "__none__"] },
    "__none__",
    requestedFeatures,
  );
  // The fm builder requires a target; we pass a synthetic missing one
  // so it just gives back the X matrix shape we want. Instead, build
  // X directly:
  const features = requestedFeatures.filter((f) => {
    if (!table.columns.includes(f)) return false;
    let numericCount = 0;
    let nonEmpty = 0;
    for (const row of table.rows) {
      const v = row[f];
      if (v === "" || v == null) continue;
      nonEmpty++;
      if (typeof v === "number" && Number.isFinite(v)) numericCount++;
    }
    return nonEmpty > 0 && numericCount / nonEmpty >= 0.8;
  });
  if (features.length === 0) {
    return { error: "No numeric feature columns." };
  }

  const X: number[][] = [];
  for (const row of table.rows) {
    const xs: number[] = [];
    let bad = false;
    for (const f of features) {
      const v = num(row[f]);
      if (v == null) {
        bad = true;
        break;
      }
      xs.push(v);
    }
    if (!bad) X.push(xs);
  }
  if (X.length < k) return { error: `Need at least k=${k} usable rows; have ${X.length}.` };

  void fm;

  // Init: pick k distinct points.
  const centroids: number[][] = [];
  const seen = new Set<number>();
  while (centroids.length < k) {
    const idx = Math.floor(Math.random() * X.length);
    if (seen.has(idx)) continue;
    seen.add(idx);
    centroids.push([...X[idx]]);
  }

  const labels = new Array(X.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < X.length; i++) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(X[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      if (labels[i] !== bestIdx) {
        labels[i] = bestIdx;
        changed++;
      }
    }
    // Recompute centroids.
    const sums = Array.from({ length: k }, () => new Array(features.length).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      counts[labels[i]]++;
      for (let j = 0; j < features.length; j++) sums[labels[i]][j] += X[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let j = 0; j < features.length; j++) centroids[c][j] = sums[c][j] / counts[c];
      }
    }
    if (changed === 0) break;
  }

  let inertia = 0;
  for (let i = 0; i < X.length; i++) inertia += sqDist(X[i], centroids[labels[i]]);

  return { centroids, labels, inertia, features };
}

/* ─────────────── small numerical helpers ─────────────── */

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sigmoid(z: number): number {
  if (z < -40) return 0;
  if (z > 40) return 1;
  return 1 / (1 + Math.exp(-z));
}

function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** Aᵀ A, when A is given (so we compute the symmetric Gram matrix). */
function matMulT(A: number[][], B: number[][]): number[][] {
  // Aᵀ B — A is n×k, output is k×k for our use.
  const n = A.length;
  const k = A[0].length;
  const out = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) out[r][c] += A[i][r] * B[i][c];
    }
  }
  return out;
}

function matVecT(A: number[][], v: number[]): number[] {
  const n = A.length;
  const k = A[0].length;
  const out = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < k; r++) out[r] += A[i][r] * v[i];
  }
  return out;
}

/** Gauss-Jordan elimination — fine for our k = features+1 matrices. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  // Augmented matrix
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    // Pivot — find max |M[r][i]| for r >= i.
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    if (Math.abs(M[pivot][i]) < 1e-12) return null;
    if (pivot !== i) [M[i], M[pivot]] = [M[pivot], M[i]];
    const div = M[i][i];
    for (let c = i; c <= n; c++) M[i][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = M[r][i];
      if (factor === 0) continue;
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c];
    }
  }
  return M.map((row) => row[n]);
}
