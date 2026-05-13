// Compile the workbook's `tools[].handler` modules into a single
// Worker module the broker uploads to WFP.
//
// Each handler file exports a default async function:
//
//   // src/tools/forecast.mjs
//   export default async function forecast(args, env) {
//     // pure JS, no DOM. fetch() works for hosts the workbook's
//     // connect: block whitelists (broker proxies on those).
//     return { revenue: args.q1 + args.q2 };
//   }
//
// We bundle every handler via esbuild + emit a router entry:
//
//   import h_forecast_revenue from "<resolved handler path>";
//   const TOOLS = { forecast_revenue: h_forecast_revenue };
//
//   export default {
//     async fetch(req, env) {
//       const url = new URL(req.url);
//       const name = decodeURIComponent(url.pathname.slice(1));
//       const fn = TOOLS[name];
//       if (!fn) return new Response(JSON.stringify({ error: "unknown_tool" }), { status: 404 });
//       const args = await req.json().catch(() => null);
//       try {
//         const result = await fn(args, env);
//         return new Response(JSON.stringify({ ok: true, result }),
//           { headers: { "content-type": "application/json" } });
//       } catch (e) {
//         return new Response(
//           JSON.stringify({ error: "tool_threw", message: e?.message ?? String(e) }),
//           { status: 500, headers: { "content-type": "application/json" } },
//         );
//       }
//     },
//   };
//
// The compiled output is one self-contained ES module ready for the
// CF dispatch namespace.

import path from "node:path";
import esbuild from "esbuild";

/** Build the tools-Worker module source given a workbook config.
 *  Returns `{ source, tools }` — source is the ES module text, tools
 *  is the canonical list with resolved handler paths. Returns null
 *  when the workbook declares no tools (caller skips upload). */
export async function buildToolsWorker(config) {
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const declared = tools.filter((t) => t && t.name);
  if (declared.length === 0) return null;

  // The tools array doesn't carry the handler path in the manifest —
  // the manifest is for the public spec. We need a side channel.
  // Convention: a "_handlers" property on the raw config, set by the
  // CLI loader when the author wrote `handler: "./src/foo.mjs"`.
  // (Added by config.mjs in this same change set.)
  const handlers = config._toolHandlers ?? {};

  // Resolve every declared tool to an absolute path. Tools without
  // a handler can't be bundled — we surface a clean error so the
  // author knows what to add.
  const entries = [];
  for (const t of declared) {
    const h = handlers[t.name];
    if (!h) {
      throw new Error(
        `workbook.config: tools.${t.name} has no handler. ` +
        `Add \`handler: "./src/tools/${t.name}.mjs"\` (default export of an async function).`,
      );
    }
    entries.push({ name: t.name, absPath: path.resolve(config.root, h) });
  }

  // Build a stub entry that imports every handler, then bundle.
  const stub = generateStubEntry(entries);
  const stubPath = path.join(config.root, ".workbook-tools-entry.mjs");

  const result = await esbuild.build({
    stdin: {
      contents: stub,
      resolveDir: config.root,
      sourcefile: stubPath,
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    treeShaking: true,
    minify: true,
    // Workers runtime — no node:* shims by default.
    conditions: ["workerd", "worker", "browser"],
    legalComments: "none",
  });

  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => e.text).join("\n");
    throw new Error(`workbook tools build failed:\n${msg}`);
  }

  const source = result.outputFiles[0].text;
  return { source, tools: declared };
}

function generateStubEntry(entries) {
  const imports = entries
    .map((e, i) => `import h_${i} from ${JSON.stringify(e.absPath)};`)
    .join("\n");
  const map = entries
    .map((e, i) => `  ${JSON.stringify(e.name)}: h_${i},`)
    .join("\n");
  return `${imports}

const TOOLS = {
${map}
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const name = decodeURIComponent(url.pathname.replace(/^\\//, ""));
    const fn = TOOLS[name];
    if (!fn) {
      return new Response(JSON.stringify({ error: "unknown_tool", name }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }
    let args = null;
    try { args = await req.json(); } catch {}
    try {
      const result = await fn(args, env);
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: "tool_threw",
        message: err && err.message ? err.message : String(err),
      }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
};
`;
}
