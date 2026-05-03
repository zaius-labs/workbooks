import { describe, expect, it } from "vitest";
import { color, colorForSeries, PALETTE } from "./palette";

describe("color", () => {
  it("returns palette[i mod len] for the bare case", () => {
    expect(color(0)).toBe(PALETTE[0]);
    expect(color(1)).toBe(PALETTE[1]);
    expect(color(PALETTE.length)).toBe(PALETTE[0]); // wraps
  });
  it("respects an explicit override", () => {
    expect(color(0, "#abc123")).toBe("#abc123");
  });
});

describe("colorForSeries", () => {
  it("returns explicit series.color when present", () => {
    expect(colorForSeries({ color: "#deadbe" }, 0)).toBe("#deadbe");
  });

  it("falls back to palette when no override", () => {
    expect(colorForSeries({}, 0)).toBe(PALETTE[0]);
    expect(colorForSeries({}, 5)).toBe(PALETTE[5]);
  });

  it("uses brand.color when series has brand and resolver returns one", () => {
    const resolver = (id: string) =>
      id === "tesla"
        ? {
            name: "Tesla",
            color: "#cc0000",
            faviconUrl: "https://example.com/tesla.png",
          }
        : null;
    expect(colorForSeries({ brand: "tesla" }, 0, resolver)).toBe("#cc0000");
  });

  it("explicit color wins over brand.color", () => {
    const resolver = () => ({
      name: "Brand",
      color: "#cc0000",
      faviconUrl: "https://example.com/x.png",
    });
    expect(colorForSeries({ color: "#abc123", brand: "x" }, 0, resolver)).toBe(
      "#abc123",
    );
  });

  it("falls back to palette when brand has no color", () => {
    const resolver = () => ({ name: "Brand", faviconUrl: "https://x" });
    expect(colorForSeries({ brand: "x" }, 2, resolver)).toBe(PALETTE[2]);
  });

  it("falls back to palette when resolver returns null", () => {
    const resolver = () => null;
    expect(colorForSeries({ brand: "missing" }, 3, resolver)).toBe(PALETTE[3]);
  });

  it("falls back to palette when no resolver passed", () => {
    expect(colorForSeries({ brand: "tesla" }, 1)).toBe(PALETTE[1]);
  });
});
