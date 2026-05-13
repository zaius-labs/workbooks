// `workbook export pdf <html>` — render a built presentation workbook to PDF.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runExport(opts = {}) {
  const format = opts._?.[0];
  if (format !== "pdf") {
    throw new Error("usage: workbook export pdf <built-html> --out <file.pdf>");
  }
  const input = opts._?.[1];
  if (!input) {
    throw new Error("workbook export pdf: missing built HTML path");
  }
  const out = opts.out;
  if (!out || typeof out !== "string") {
    throw new Error("workbook export pdf: --out <file.pdf> is required");
  }

  await exportPdf({
    input: path.resolve(input),
    out: path.resolve(out),
  });
}

async function exportPdf({ input, out }) {
  await fs.access(input);
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({ headless: "new" });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(input).href, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");

    const meta = await page.evaluate(() => {
      const root = document.querySelector("[data-workbook-presentation]");
      if (!root) {
        return { ok: false, reason: "missing [data-workbook-presentation]" };
      }
      root.classList.add("print-mode");
      const stage = root.querySelector(".workbook-presentation-stage");
      const rawRatio = stage
        ? getComputedStyle(stage).getPropertyValue("--wbp-aspect").trim()
        : "16 / 9";
      const slideCount = root.querySelectorAll(".workbook-slide").length;
      return { ok: true, rawRatio, slideCount };
    });

    if (!meta.ok) {
      throw new Error(
        "workbook export pdf only supports presentation workbooks " +
          `(${meta.reason})`,
      );
    }
    if (meta.slideCount === 0) {
      throw new Error("workbook export pdf: presentation has no slides");
    }

    const { widthIn, heightIn } = pageSizeFromRatio(meta.rawRatio);
    await page.addStyleTag({
      content: `
        @page { size: ${widthIn}in ${heightIn}in; margin: 0; }
        html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      `,
    });

    await fs.mkdir(path.dirname(out), { recursive: true });
    await page.pdf({
      path: out,
      width: `${widthIn}in`,
      height: `${heightIn}in`,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    process.stdout.write(
      `[workbook] exported ${meta.slideCount} slide(s) → ${path.relative(process.cwd(), out)}\n`,
    );
  } finally {
    await browser.close();
  }
}

async function loadPuppeteer() {
  try {
    const mod = await import("puppeteer");
    return mod.default ?? mod;
  } catch {
    throw new Error(
      "workbook export pdf requires puppeteer. Install it in this workspace " +
        "before exporting presentations: npm install -D puppeteer",
    );
  }
}

function pageSizeFromRatio(rawRatio) {
  const match = String(rawRatio).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  const width = match ? Number(match[1]) : 16;
  const height = match ? Number(match[2]) : 9;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { widthIn: 16, heightIn: 9 };
  }
  const longEdge = 16;
  if (width >= height) {
    return { widthIn: longEdge, heightIn: longEdge * (height / width) };
  }
  return { widthIn: longEdge * (width / height), heightIn: longEdge };
}
