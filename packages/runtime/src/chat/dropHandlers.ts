/**
 * Built-in drop handlers (Phase W4.2).
 *
 * Each handler takes a File, returns a WorkbookBlock that lands on the
 * canvas + becomes the dropped-file's representation in the chat
 * thread. The agent sees the file via the synthetic user message
 * `[filename · mime · bytes — rendered as <kind>]`, and can act on
 * it via the canvas blocks (which carry the actual data).
 *
 * Patterns:
 *   - mime exact match wins ("text/csv")
 *   - mime family fallback ("text/*", "application/*")
 *   - "*" fallback for anything not matched
 *
 * Authors compose like:
 *   const handlers = {
 *     ...dropHandlers.builtins,
 *     "application/x-my-format": myCustomHandler,
 *     "*": myCatchAllHandler,
 *   };
 */

import type { WorkbookBlock } from "../types";
import type { DropHandler } from "./useChatSession.svelte";

// ─────────────────── CSV → Table ────────────────────────────────────

/**
 * Naive RFC-4180-ish CSV parser. Handles:
 *   - quoted fields with embedded commas + escaped quotes ("a,""b""")
 *   - CRLF / LF line endings
 *   - trailing blank line
 *
 * Skips: type inference, header detection (always treats row 0 as the
 * header), large files (truncates at 5,000 rows so the table block
 * doesn't choke). Authors who need more shape control should preprocess
 * the file before dropping it.
 */
function parseCsv(text: string, maxRows = 5000): { columns: string[]; rows: Record<string, unknown>[] } {
  const out: { columns: string[]; rows: Record<string, unknown>[] } = {
    columns: [],
    rows: [],
  };
  if (!text) return out;

  const lines: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ",") {
        row.push(cur);
        cur = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur);
        if (row.length === 1 && row[0] === "") {
          // skip blank line
        } else {
          lines.push(row);
        }
        row = [];
        cur = "";
        if (lines.length > maxRows) break;
      } else {
        cur += c;
      }
    }
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    lines.push(row);
  }

  if (lines.length === 0) return out;
  out.columns = lines[0].map((s) => s.trim());
  for (let i = 1; i < lines.length; i++) {
    const r: Record<string, unknown> = {};
    const arr = lines[i];
    for (let c = 0; c < out.columns.length; c++) {
      r[out.columns[c]] = c < arr.length ? coerce(arr[c]) : "";
    }
    out.rows.push(r);
  }
  return out;
}

/** Lightweight type coercion: number-shaped strings → numbers. */
function coerce(s: string): unknown {
  if (s === "") return "";
  const n = Number(s);
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s.trim())) {
    return n;
  }
  return s;
}

const csvHandler: DropHandler = async (file: File) => {
  const text = await file.text();
  const { columns, rows } = parseCsv(text);
  return {
    kind: "table",
    title: file.name,
    columns,
    rows,
  } as unknown as WorkbookBlock;
};

// ─────────────────── JSON → Code ────────────────────────────────────

const jsonHandler: DropHandler = async (file: File) => {
  const text = await file.text();
  // Pretty-print so it reads as a tree-shaped artifact.
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* leave raw */
  }
  return {
    kind: "code",
    language: "json",
    source: pretty,
  } as unknown as WorkbookBlock;
};

// ─────────────────── Image → Image block ────────────────────────────

const imageHandler: DropHandler = async (file: File) => {
  const dataUrl = await readDataUrl(file);
  return {
    kind: "image",
    src: dataUrl,
    alt: file.name,
  } as unknown as WorkbookBlock;
};

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ─────────────────── Plain text → Code ──────────────────────────────

const textHandler: DropHandler = async (file: File) => {
  const text = await file.text();
  return {
    kind: "code",
    language: guessLanguage(file.name),
    source: text,
  } as unknown as WorkbookBlock;
};

function guessLanguage(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "text";
}

// ─────────────────── Catch-all ──────────────────────────────────────

const fallbackHandler: DropHandler = (file: File) => {
  return {
    kind: "code",
    language: "text",
    source:
      `Dropped file: ${file.name}\n` +
      `Type: ${file.type || "(unknown)"}\n` +
      `Size: ${file.size} bytes\n\n` +
      `(No built-in handler for this mime type. Author can register one ` +
      `via dropHandlers["${file.type || "*"}"] = …)`,
  } as unknown as WorkbookBlock;
};

// ─────────────────── Builtins map ───────────────────────────────────

/**
 * Built-in mime → handler map. Spread into your own handlers to keep
 * defaults; override individual entries by setting them after.
 */
export const builtins: Record<string, DropHandler> = {
  "text/csv": csvHandler,
  "text/tab-separated-values": csvHandler,
  "application/json": jsonHandler,
  "application/x-ndjson": jsonHandler,
  "image/*": imageHandler,
  "text/*": textHandler,
  "*": fallbackHandler,
};

/** Re-export individual handlers so authors can compose à la carte. */
export const dropHandlers = {
  builtins,
  csv: csvHandler,
  json: jsonHandler,
  image: imageHandler,
  text: textHandler,
  fallback: fallbackHandler,
};
