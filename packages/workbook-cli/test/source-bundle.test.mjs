#!/usr/bin/env node
// W1 — source bundle round-trip test.
//
// Verifies:
//   - createSourceBundle walks a project tree, respects DEFAULT_IGNORES
//   - includeGit:true brings .git/ in; default leaves it out
//   - Files larger than maxFileBytes are marked truncated, not embedded
//   - additionalIgnore patterns elide the matching files
//   - embedBundle inserts a <script> block before </body>
//   - extractBundle pulls the same buffer back out
//   - decodeBundle parses the manifest cleanly
//   - readBundleMeta returns the data-* attrs
//   - re-embed replaces the existing block (idempotent)
//   - unbundle command writes a working tree with correct contents
//   - path-traversal entries are silently skipped at unbundle time
//
// No daemon, no Vite — pure tests of the bundle modules.

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  createSourceBundle,
} from "../src/bundle/sourceBundle.mjs";
import {
  embedBundle,
  extractBundle,
  decodeBundle,
  readBundleMeta,
} from "../src/bundle/embedSource.mjs";

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (ok) pass++;
  else fail++;
}

async function makeTempProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-source-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.mkdir(path.join(root, ".git", "refs"), { recursive: true });
  await fs.mkdir(path.join(root, "secret"), { recursive: true });
  await fs.writeFile(path.join(root, "workbook.config.mjs"), 'export default { slug: "x", entry: "src/index.html" };\n');
  await fs.writeFile(path.join(root, "src", "index.html"), "<!doctype html><html></html>");
  await fs.writeFile(path.join(root, "src", "main.js"), "console.log(1);\n");
  await fs.writeFile(path.join(root, "src", "styles.css"), ".x { color: red }\n");
  await fs.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = (s,n)=>s;\n");
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(root, "secret", "creds.json"), '{"key":"redacted"}');
  await fs.writeFile(path.join(root, ".env"), "API_KEY=lol\n");
  return root;
}

async function main() {
  const root = await makeTempProject();
  console.log(`# project: ${root}`);

  /* 1. default bundle */
  const def = await createSourceBundle(root);
  const decoded = decodeBundle(def.buffer);
  check("default bundle: returns gzip buffer", Buffer.isBuffer(def.buffer));
  check("default bundle: file count > 0", def.fileCount > 0);
  check("default bundle: rootName === basename", decoded.rootName === path.basename(root));
  const paths = new Set(decoded.files.map((f) => f.path));
  check(
    "default bundle: includes src/index.html",
    paths.has("src/index.html"),
  );
  check(
    "default bundle: includes src/main.js",
    paths.has("src/main.js"),
  );
  check(
    "default bundle: skips node_modules/",
    ![...paths].some((p) => p.startsWith("node_modules/")),
    [...paths].filter((p) => p.startsWith("node_modules")),
  );
  check(
    "default bundle: skips .git/",
    ![...paths].some((p) => p.startsWith(".git/")),
    [...paths].filter((p) => p.startsWith(".git")),
  );
  check(
    "default bundle: skips .env",
    !paths.has(".env"),
  );

  /* 2. includeGit */
  const withGit = await createSourceBundle(root, { includeGit: true });
  const withGitDecoded = decodeBundle(withGit.buffer);
  const gitPaths = withGitDecoded.files.map((f) => f.path);
  check(
    "includeGit: ships .git/ contents",
    gitPaths.some((p) => p.startsWith(".git/")),
  );

  /* 3. additionalIgnore */
  const noSecret = await createSourceBundle(root, {
    additionalIgnore: ["secret/"],
  });
  const noSecretDecoded = decodeBundle(noSecret.buffer);
  const noSecretPaths = noSecretDecoded.files.map((f) => f.path);
  check(
    "additionalIgnore: secret/ pattern elides creds",
    !noSecretPaths.some((p) => p.startsWith("secret/")),
    noSecretPaths,
  );

  /* 4. truncation */
  await fs.writeFile(
    path.join(root, "src", "huge.bin"),
    Buffer.alloc(2048, 0x42),
  );
  const truncBundle = await createSourceBundle(root, {
    maxFileBytes: 1024,
  });
  const truncDecoded = decodeBundle(truncBundle.buffer);
  const huge = truncDecoded.files.find((f) => f.path === "src/huge.bin");
  check("truncation: oversized file is marked truncated", huge?.truncated === true);
  check(
    "truncation: oversized file has no content",
    huge?.content == null,
  );
  check(
    "truncation: oversized file records originalSize",
    typeof huge?.originalSize === "number" && huge.originalSize === 2048,
  );

  /* 5. round-trip embed → extract */
  const html = "<!doctype html><html><body>hello</body></html>";
  const withBundle = embedBundle(html, def.buffer, {
    rootName: decoded.rootName,
    fileCount: def.fileCount,
    bundleSize: def.buffer.length,
    uncompressedSize: def.uncompressedSize,
  });
  check("embed: contains the script tag", withBundle.includes("wb-source-bundle"));
  check(
    "embed: inserts before </body>",
    withBundle.indexOf("</body>") > withBundle.indexOf("wb-source-bundle"),
  );
  const extracted = extractBundle(withBundle);
  check(
    "extract: round-trips bytes exactly",
    extracted && extracted.equals(def.buffer),
  );
  const meta = readBundleMeta(withBundle);
  check("readBundleMeta: rootName matches", meta?.rootName === decoded.rootName);
  check(
    "readBundleMeta: fileCount matches",
    meta?.fileCount === def.fileCount,
  );
  check("readBundleMeta: format = json+gzip+base64", meta?.format === "json+gzip+base64");
  check("readBundleMeta: version = 1", meta?.version === "1");

  /* 6. idempotent re-embed */
  const reEmbed = embedBundle(withBundle, def.buffer, {
    rootName: decoded.rootName,
    fileCount: def.fileCount,
  });
  const reExtracted = extractBundle(reEmbed);
  check(
    "re-embed: still extracts to original buffer",
    reExtracted && reExtracted.equals(def.buffer),
  );
  // Should be only one wb-source-bundle script in the html
  const occurrences = reEmbed.match(/wb-source-bundle/g)?.length ?? 0;
  check("re-embed: only one bundle block in html", occurrences === 1, occurrences);

  /* 7. fallback insertion when no </body> */
  const noBody = "<!doctype html><html></html>";
  const embedded = embedBundle(noBody, def.buffer);
  check(
    "embed: falls back to </html> when no </body>",
    embedded.indexOf("</html>") > embedded.indexOf("wb-source-bundle"),
  );
  // … and pure tail-append when neither tag exists
  const bare = "<!doctype html>just text";
  const embeddedBare = embedBundle(bare, def.buffer);
  check(
    "embed: appends to tail when no closing tags",
    embeddedBare.endsWith("</script>"),
  );

  /* 8. extractBundle returns null for unembedded artifact */
  check("extractBundle: returns null for plain html", extractBundle(html) === null);

  /* 9. unbundle command — full project round-trip */
  const { runUnbundle } = await import(
    "../src/commands/unbundle.mjs"
  );
  // Write the embedded html to disk and unbundle into a sibling dir.
  const wrappedPath = path.join(root, "compiled.html");
  await fs.writeFile(wrappedPath, withBundle);
  const outDir = path.join(root, "extracted");
  await runUnbundle({ _: [wrappedPath, outDir] });
  const extractedIndex = await fs.readFile(
    path.join(outDir, "src", "index.html"),
    "utf8",
  );
  check(
    "unbundle: src/index.html roundtrips byte-equal",
    extractedIndex === "<!doctype html><html></html>",
  );
  const extractedMain = await fs.readFile(
    path.join(outDir, "src", "main.js"),
    "utf8",
  );
  check(
    "unbundle: src/main.js roundtrips byte-equal",
    extractedMain === "console.log(1);\n",
  );
  // node_modules / .git / .env should NOT exist in the unbundle output
  await assertMissing(path.join(outDir, "node_modules"), "node_modules");
  await assertMissing(path.join(outDir, ".git"), ".git");
  await assertMissing(path.join(outDir, ".env"), ".env");

  /* 10. unbundle: refuses non-empty existing dir */
  const blockedDir = path.join(root, "blocked");
  await fs.mkdir(blockedDir, { recursive: true });
  await fs.writeFile(path.join(blockedDir, "existing"), "x");
  let threw = false;
  try {
    await runUnbundle({ _: [wrappedPath, blockedDir] });
  } catch (err) {
    threw = /not empty/.test(String(err.message));
  }
  check("unbundle: refuses non-empty dir without --force", threw);

  /* 11. unbundle --force overwrites */
  await runUnbundle({ _: [wrappedPath, blockedDir], force: true });
  check(
    "unbundle --force: succeeds and writes files",
    (await fs.stat(path.join(blockedDir, "src", "main.js"))).size > 0,
  );

  /* 12. path-traversal defense */
  // Hand-craft a manifest with a malicious path and re-embed
  const { gzipSync } = await import("node:zlib");
  const badManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    rootName: "evil",
    files: [
      { path: "../escape.txt", content: Buffer.from("nope").toString("base64"), mode: 0o644 },
      { path: "/etc/absolute", content: Buffer.from("nope").toString("base64"), mode: 0o644 },
      { path: "ok/safe.txt", content: Buffer.from("ok").toString("base64"), mode: 0o644 },
    ],
  };
  const badBuf = gzipSync(Buffer.from(JSON.stringify(badManifest), "utf8"));
  const evilHtml = embedBundle(html, badBuf, { rootName: "evil", fileCount: 3 });
  const evilPath = path.join(root, "evil.html");
  await fs.writeFile(evilPath, evilHtml);
  const evilOut = path.join(root, "evil-out");
  await runUnbundle({ _: [evilPath, evilOut] });
  await assertMissing(path.join(root, "escape.txt"), "../escape.txt");
  check(
    "path-traversal: only safe paths landed",
    (await fs.stat(path.join(evilOut, "ok", "safe.txt"))).size > 0,
  );

  /* cleanup */
  await fs.rm(root, { recursive: true, force: true });

  console.log("\n──────────────────────────────────────────────");
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

async function assertMissing(absPath, label) {
  let exists = true;
  try {
    await fs.access(absPath);
  } catch {
    exists = false;
  }
  check(`unbundle: ${label} is NOT present in output`, !exists);
}

main().catch((err) => {
  console.error("uncaught:", err);
  process.exit(2);
});
