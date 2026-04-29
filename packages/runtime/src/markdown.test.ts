/**
 * Smoke tests for the markdown renderer. Run with:
 *
 *   npx tsx packages/runtime/src/markdown.test.ts
 *
 * Each test asserts that `renderMarkdown(input).includes(expectedFragment)`.
 * We don't pin the exact HTML byte-for-byte so the renderer can evolve
 * implementation details without churn here.
 */

import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.ts";

interface Case { name: string; input: string; includes: string[]; excludes?: string[]; }

const cases: Case[] = [
  { name: "plain paragraph", input: "hello world", includes: ["<p>hello world</p>"] },
  { name: "heading", input: "# Title\n\ntext", includes: ["<h1>Title</h1>", "<p>text</p>"] },
  { name: "bold + italic", input: "this is **bold** and *italic*",
    includes: ["<strong>bold</strong>", "<em>italic</em>"] },
  { name: "inline code", input: "use the `query_data` tool",
    includes: ["<code>query_data</code>"] },
  { name: "code fence with language", input: "```sql\nSELECT 1\n```",
    includes: [`<pre><code class="language-sql">SELECT 1\n</code></pre>`] },
  { name: "code fence without language", input: "```\nplain\n```",
    includes: ["<pre><code>plain\n</code></pre>"] },
  { name: "code fence partial (streaming)", input: "```js\nconst x = 1",
    includes: [`<pre><code class="language-js">const x = 1</code></pre>`] },
  { name: "unordered list", input: "- one\n- two\n- three",
    includes: ["<ul>", "<li>one</li>", "<li>two</li>", "<li>three</li>", "</ul>"] },
  { name: "ordered list", input: "1. first\n2. second",
    includes: ["<ol>", "<li>first</li>", "<li>second</li>", "</ol>"] },
  { name: "http link", input: "see [docs](https://example.com)",
    includes: [`<a href="https://example.com" target="_blank" rel="noreferrer noopener">docs</a>`] },
  { name: "anchor link", input: "[top](#top)",
    includes: [`href="#top"`] },
  { name: "javascript URL — must NOT render link", input: "[click](javascript:alert(1))",
    includes: ["[click](javascript:alert(1))"], excludes: ["<a href"] },
  { name: "data URL — must NOT render link", input: "[exfil](data:text/html,<script>)",
    includes: ["data:text"], excludes: ["<a href"] },
  { name: "raw HTML escaped", input: "<img src=x onerror=alert(1)>",
    includes: ["&lt;img"], excludes: ["<img"] },
  { name: "blockquote", input: "> a quote\n> with two lines",
    includes: ["<blockquote>", "a quote<br/>with two lines", "</blockquote>"] },
  { name: "horizontal rule", input: "---", includes: ["<hr/>"] },
  { name: "mixed content",
    input: "Here's a result:\n\n```\nregion,total\nus,20400\n```\n\nThe **us** wins.",
    includes: [`<p>Here&#39;s a result:</p>`, "<pre><code>region", "<strong>us</strong>"] },
  { name: "autolink bare URL", input: "see https://example.com for more",
    includes: [`<a href="https://example.com"`, "for more"] },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
  try {
    const out = renderMarkdown(c.input);
    for (const frag of c.includes) {
      assert.ok(
        out.includes(frag),
        `[${c.name}] expected output to include ${JSON.stringify(frag)}\n  got: ${out}`,
      );
    }
    for (const frag of c.excludes ?? []) {
      assert.ok(
        !out.includes(frag),
        `[${c.name}] expected output NOT to include ${JSON.stringify(frag)}\n  got: ${out}`,
      );
    }
    passed++;
  } catch (e) {
    failed++;
    failures.push((e as Error).message);
  }
}

console.log(`${passed}/${cases.length} passed`);
if (failed > 0) {
  console.error("\nfailures:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
