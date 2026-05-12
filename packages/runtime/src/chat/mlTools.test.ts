/**
 * mlTools — math correctness checks. Pure-JS algorithms, deterministic
 * inputs (k-means seeds an RNG, but we re-run until convergent).
 *
 * Run:  bun test src/chat/mlTools.test.ts
 *       (or via `node --test` once node has TS support — for now bun.)
 */
import { describe, it, expect } from "bun:test";
import { createMlToolset, type CsvLikeBlock } from "./mlTools";

/** Helper — build a kind:"table" block from { columns, rows-as-arrays }. */
function table(columns: string[], rows: (number | string)[][]): CsvLikeBlock {
  return {
    kind: "table",
    columns,
    rows: rows.map((r) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((c, i) => (obj[c] = r[i]));
      return obj;
    }),
  };
}

function callTool(toolset: ReturnType<typeof createMlToolset>, name: string, args: Record<string, unknown>) {
  const tool = toolset.tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`no tool: ${name}`);
  return tool.invoke(args);
}

describe("train_linear_regression", () => {
  it("recovers slope=2 intercept=1 on y = 2x + 1", async () => {
    const t = table(
      ["x", "y"],
      [[1, 3], [2, 5], [3, 7], [4, 9], [5, 11]],
    );
    const ml = createMlToolset({ getTable: () => t });
    const r = await callTool(ml, "train_linear_regression", {
      target: "y",
      features: ["x"],
      model_id: "test_lr",
    });
    expect(typeof r === "object" && r !== null).toBe(true);
    expect(typeof r === "object" && "block" in r).toBe(true);
    const stored = ml.models.get("test_lr");
    expect(stored?.kind).toBe("linear_regression");
    if (stored?.kind !== "linear_regression") throw new Error("kind");
    expect(Math.abs(stored.coefficients.x - 2)).toBeLessThan(1e-9);
    expect(Math.abs(stored.intercept - 1)).toBeLessThan(1e-9);
    expect(stored.metrics.r2).toBeGreaterThan(0.9999);
    expect(stored.metrics.rmse).toBeLessThan(1e-9);
  });

  it("handles multiple features (y = 2x + 3z + 5)", async () => {
    const t = table(
      ["x", "z", "y"],
      [
        [1, 1, 10],
        [2, 1, 12],
        [3, 2, 17],
        [4, 2, 19],
        [5, 3, 24],
        [6, 4, 29],
      ],
    );
    const ml = createMlToolset({ getTable: () => t });
    await callTool(ml, "train_linear_regression", {
      target: "y",
      features: ["x", "z"],
      model_id: "multi",
    });
    const stored = ml.models.get("multi");
    if (stored?.kind !== "linear_regression") throw new Error("kind");
    expect(Math.abs(stored.coefficients.x - 2)).toBeLessThan(1e-6);
    expect(Math.abs(stored.coefficients.z - 3)).toBeLessThan(1e-6);
    expect(Math.abs(stored.intercept - 5)).toBeLessThan(1e-6);
  });

  it("skips non-numeric features with a warning", async () => {
    const t = table(
      ["x", "label", "y"],
      [
        [1, "a", 3],
        [2, "b", 5],
        [3, "c", 7],
        [4, "a", 9],
      ],
    );
    const ml = createMlToolset({ getTable: () => t });
    const r = await callTool(ml, "train_linear_regression", {
      target: "y",
      features: ["x", "label"],
      model_id: "skip",
    });
    expect(typeof r === "object" && r !== null && "result" in r).toBe(true);
    if (typeof r !== "object" || !("result" in r)) throw new Error("shape");
    expect(r.result).toContain("skipped");
    expect(r.result).toContain("label");
  });

  it("returns an error string when no table is loaded", async () => {
    const ml = createMlToolset({ getTable: () => null });
    const r = await callTool(ml, "train_linear_regression", {
      target: "y",
      features: ["x"],
    });
    expect(typeof r).toBe("string");
    expect(String(r)).toContain("No table");
  });
});

describe("train_logistic_regression", () => {
  it("learns a separable binary classification", async () => {
    // y = 1 when x1 + x2 > 5, else 0
    const rows: (number | string)[][] = [];
    for (let x1 = 0; x1 <= 4; x1++) {
      for (let x2 = 0; x2 <= 4; x2++) {
        rows.push([x1, x2, x1 + x2 > 5 ? 1 : 0]);
      }
    }
    const t = table(["x1", "x2", "y"], rows);
    const ml = createMlToolset({ getTable: () => t });
    await callTool(ml, "train_logistic_regression", {
      target: "y",
      features: ["x1", "x2"],
      iterations: 800,
      learning_rate: 0.5,
      model_id: "binclf",
    });
    const stored = ml.models.get("binclf");
    if (stored?.kind !== "logistic_regression") throw new Error("kind");
    expect(stored.metrics.accuracy).toBeGreaterThan(0.95);
    // x1 and x2 should have positive coefficients (both push y higher).
    expect(stored.coefficients.x1).toBeGreaterThan(0);
    expect(stored.coefficients.x2).toBeGreaterThan(0);
  });

  it("rejects targets with >2 distinct values", async () => {
    const t = table(
      ["x", "y"],
      [[1, "a"], [2, "b"], [3, "c"]],
    );
    const ml = createMlToolset({ getTable: () => t });
    const r = await callTool(ml, "train_logistic_regression", {
      target: "y",
      features: ["x"],
    });
    expect(typeof r).toBe("string");
    expect(String(r)).toContain("distinct values");
  });
});

describe("train_kmeans", () => {
  it("partitions two well-separated blobs into 2 clusters", async () => {
    const rows: (number | string)[][] = [];
    for (let i = 0; i < 20; i++) rows.push([Math.random() + 0, Math.random() + 0]);
    for (let i = 0; i < 20; i++) rows.push([Math.random() + 10, Math.random() + 10]);
    const t = table(["x", "y"], rows);
    const ml = createMlToolset({ getTable: () => t });
    await callTool(ml, "train_kmeans", {
      features: ["x", "y"],
      k: 2,
      model_id: "km",
    });
    const stored = ml.models.get("km");
    if (stored?.kind !== "kmeans") throw new Error("kind");
    // The first 20 rows should all share a label, and the next 20
    // should share the OTHER label.
    const firstHalfLabels = new Set(stored.labels.slice(0, 20));
    const secondHalfLabels = new Set(stored.labels.slice(20));
    expect(firstHalfLabels.size).toBe(1);
    expect(secondHalfLabels.size).toBe(1);
    expect([...firstHalfLabels][0]).not.toBe([...secondHalfLabels][0]);
  });
});

describe("predict", () => {
  it("uses a trained linear model to score rows", async () => {
    const t = table(
      ["x", "y"],
      [[1, 3], [2, 5], [3, 7], [4, 9]],
    );
    const ml = createMlToolset({ getTable: () => t });
    await callTool(ml, "train_linear_regression", {
      target: "y",
      features: ["x"],
      model_id: "pm",
    });
    const r = await callTool(ml, "predict", { model_id: "pm", limit: 4 });
    expect(typeof r).toBe("string");
    const text = String(r);
    expect(text).toContain("4 predictions");
    expect(text).toContain("3.0000");
    expect(text).toContain("5.0000");
    expect(text).toContain("7.0000");
    expect(text).toContain("9.0000");
  });

  it("errors on unknown model_id", async () => {
    const t = table(["x"], [[1]]);
    const ml = createMlToolset({ getTable: () => t });
    const r = await callTool(ml, "predict", { model_id: "nope" });
    expect(String(r)).toContain("No model");
  });
});
