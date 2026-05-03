import { describe, expect, it } from "vitest";
import { buildCitationContext } from "./citationContext";
import type { WorkbookDocument } from "./types";

const sampleDoc: WorkbookDocument = {
  blocks: [],
  references: [
    { id: "ref_a", title: "A", url: "https://a.com" },
    { id: "ref_b", title: "B", url: "https://b.com" },
  ],
  claims: [
    { id: "c1", text: "claim one", references: ["ref_a"] },
    { id: "c2", text: "claim two", references: ["ref_a", "ref_b"] },
  ],
};

describe("buildCitationContext", () => {
  it("assigns numbers in first-appearance order", () => {
    const ctx = buildCitationContext(sampleDoc);
    expect(ctx.resolve("c2")?.number).toBe(1);
    expect(ctx.resolve("c1")?.number).toBe(2);
    /* ordered() reflects the order of first resolution. */
    expect(ctx.ordered().map((o) => o.claimId)).toEqual(["c2", "c1"]);
  });

  it("returns the same number on repeated resolves", () => {
    const ctx = buildCitationContext(sampleDoc);
    expect(ctx.resolve("c1")?.number).toBe(1);
    expect(ctx.resolve("c1")?.number).toBe(1);
    expect(ctx.resolve("c1")?.number).toBe(1);
  });

  it("resolves references via the claim's ref ids", () => {
    const ctx = buildCitationContext(sampleDoc);
    const r = ctx.resolve("c2");
    expect(r?.references).toHaveLength(2);
    expect(r?.references[0].id).toBe("ref_a");
    expect(r?.references[1].id).toBe("ref_b");
  });

  it("returns a number even for unknown claim ids (anchor still gets a slot)", () => {
    /* Behavior choice: unknown ids get a number so the rendered
     * superscript stays stable; the resolved claim/refs are empty so
     * the bibliography won't add a row. */
    const ctx = buildCitationContext(sampleDoc);
    const r = ctx.resolve("not_a_real_id");
    expect(r).not.toBeNull();
    expect(r?.claim).toBeUndefined();
    expect(r?.references).toEqual([]);
  });

  it("ordered() only includes ids that were actually resolved", () => {
    const ctx = buildCitationContext(sampleDoc);
    /* Don't resolve anything. */
    expect(ctx.ordered()).toEqual([]);
  });

  it("handles a doc without claims/references", () => {
    const ctx = buildCitationContext({ blocks: [] });
    expect(ctx.resolve("anything")?.references).toEqual([]);
    expect(ctx.ordered()).toHaveLength(1); // numbering still happens
  });
});

describe("resolveEntity", () => {
  it("returns the entity by id", () => {
    const ctx = buildCitationContext({
      blocks: [],
      entities: [
        {
          id: "row_a23",
          kind: "row",
          label: "A23",
          data: { client: "Cheech", roas: 0.04 },
          source: { ref: "A23", row: 23 },
        },
      ],
    });
    const e = ctx.resolveEntity("row_a23");
    expect(e?.label).toBe("A23");
    expect(e?.data.roas).toBe(0.04);
  });

  it("returns null for unknown ids", () => {
    const ctx = buildCitationContext({ blocks: [] });
    expect(ctx.resolveEntity("missing")).toBeNull();
  });
});

describe("resolveBrand", () => {
  it("returns brand + auto-derived favicon URL", () => {
    const ctx = buildCitationContext({
      blocks: [],
      brands: [
        { id: "tesla", name: "Tesla", url: "https://tesla.com" },
      ],
    });
    const r = ctx.resolveBrand("tesla");
    expect(r?.brand.name).toBe("Tesla");
    expect(r?.faviconUrl).toContain("favicons");
    expect(r?.faviconUrl).toContain("tesla.com");
  });

  it("respects an explicit faviconUrl override", () => {
    const ctx = buildCitationContext({
      blocks: [],
      brands: [
        {
          id: "openai",
          name: "OpenAI",
          url: "https://openai.com",
          faviconUrl: "https://cdn.example.com/openai-512.png",
        },
      ],
    });
    const r = ctx.resolveBrand("openai");
    expect(r?.faviconUrl).toBe("https://cdn.example.com/openai-512.png");
  });

  it("falls back to the default briefcase icon when the URL is malformed", () => {
    const ctx = buildCitationContext({
      blocks: [],
      brands: [{ id: "broken", name: "Broken", url: "not a url" }],
    });
    const r = ctx.resolveBrand("broken");
    expect(r?.faviconUrl).toMatch(/^data:image\/svg\+xml/);
    /* The briefcase glyph is the canonical fallback — the rect+rx
     * marks the case body. */
    expect(decodeURIComponent(r?.faviconUrl ?? "")).toContain("rect");
  });

  it("returns null for unknown brand ids", () => {
    const ctx = buildCitationContext({ blocks: [] });
    expect(ctx.resolveBrand("missing")).toBeNull();
  });
});
