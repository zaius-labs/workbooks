// `workbook init <name>` — scaffold a new workbook project.
//
// Stamps a chosen template (default: spa) into ./<name>/, rewrites
// placeholder tokens for slug/name/cli-version, and prints next steps.
//
// Templates live at ../../templates/<shape>/. Each template is a real
// directory tree containing files that may include the placeholders:
//
//   %%NAME%%         human-readable display name (defaults to slug)
//   %%SLUG%%         kebab-case identifier (defaults to dir name)
//   %%CLI_VERSION%%  pinned semver of @work.books/cli
//
// The eighth-grader test:
//   $ npm install -g @work.books/cli
//   $ workbook init my-thing
//   $ cd my-thing && npm install && npm run dev
// Working in three commands.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_ROOT = path.resolve(HERE, "..", "..", "templates");
const CLI_VERSION = await readCliVersion();

const SHAPES = ["spa"]; // notebook + document forthcoming

/**
 * @param {{
 *   _: string[],
 *   template?: string,    // shape name (spa | notebook | document)
 *   force?: boolean,      // overwrite a non-empty target directory
 * }} flags
 */
export async function runInit(flags = {}) {
  const name = flags._?.[0];
  if (!name) {
    process.stderr.write("workbook init: project name required.\n");
    process.stderr.write("usage: workbook init <name> [--template=spa]\n");
    process.exit(2);
  }

  const slug = toSlug(name);
  if (!slug) {
    process.stderr.write(`workbook init: '${name}' isn't a valid project name (need at least one letter or digit)\n`);
    process.exit(2);
  }

  const shape = flags.template ?? "spa";
  if (!SHAPES.includes(shape)) {
    process.stderr.write(
      `workbook init: unknown template '${shape}'. ` +
      `available: ${SHAPES.join(", ")}\n`,
    );
    process.exit(2);
  }
  const templateDir = path.join(TEMPLATES_ROOT, shape);
  try {
    await fs.access(templateDir);
  } catch {
    process.stderr.write(
      `workbook init: template '${shape}' is missing on disk at ${templateDir} — packaging bug, please file an issue.\n`,
    );
    process.exit(2);
  }

  const target = path.resolve(name);
  const exists = await fs.stat(target).catch(() => null);
  if (exists) {
    if (!exists.isDirectory()) {
      process.stderr.write(`workbook init: '${target}' exists and is not a directory\n`);
      process.exit(2);
    }
    const entries = await fs.readdir(target);
    if (entries.length > 0 && !flags.force) {
      process.stderr.write(
        `workbook init: '${target}' is not empty (use --force to overwrite)\n`,
      );
      process.exit(2);
    }
  } else {
    await fs.mkdir(target, { recursive: true });
  }

  const replacements = new Map([
    ["%%NAME%%", name],
    ["%%SLUG%%", slug],
    ["%%CLI_VERSION%%", `^${CLI_VERSION}`],
  ]);

  const filesWritten = [];
  for await (const { abs, rel } of walk(templateDir)) {
    const dest = path.join(target, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      await fs.writeFile(dest, buf);
    } else {
      let text = buf.toString("utf8");
      for (const [token, value] of replacements) {
        text = text.split(token).join(value);
      }
      await fs.writeFile(dest, text);
    }
    filesWritten.push(rel);
  }

  process.stdout.write(`✓ created ${path.relative(process.cwd(), target) || target}/\n`);
  for (const f of filesWritten.sort()) {
    process.stdout.write(`    ${f}\n`);
  }
  process.stdout.write([
    "",
    "next steps:",
    `  cd ${name}`,
    "  npm install",
    "  npm run dev          # http://localhost:5173",
    "  npm run build        # produces dist/" + slug + ".html",
    "",
  ].join("\n"));
}

function toSlug(name) {
  const slug = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

async function readCliVersion() {
  const pkgPath = path.resolve(HERE, "..", "..", "package.json");
  try {
    const text = await fs.readFile(pkgPath, "utf8");
    const m = /"version"\s*:\s*"([^"]+)"/.exec(text);
    return m ? m[1] : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function* walk(root, prefix = "") {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(root, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      yield* walk(abs, rel);
    } else if (ent.isFile()) {
      yield { abs, rel };
    }
  }
}

// Guard the placeholder substitution against binary files (icons, etc.).
function looksBinary(buf) {
  const slice = buf.subarray(0, Math.min(buf.length, 8000));
  for (const b of slice) {
    if (b === 0) return true;
  }
  return false;
}
