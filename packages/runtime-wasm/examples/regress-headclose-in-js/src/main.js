// This module deliberately contains the literal substring "</head>"
// inside a template literal — the exact pattern that triggered
// core-bii. Before the fix, the workbook CLI's regex-based head-close
// injector would replace THIS occurrence (the first `</head>` in the
// final HTML, which lives inside this JS string after singleFile
// inlines the bundle) and land ~16 MB of base64 wasm here, severing
// the template literal and breaking the bundle's syntax.

function buildSrcdoc(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body>${body}</body></html>`;
}

const out = document.getElementById("out");
out.textContent = "buildSrcdoc rendered " + buildSrcdoc("<p>hello</p>").length + " chars";

// Sanity log so the dev console makes the regression visible.
console.log("[core-bii regression] OK — bundle parsed and ran. " +
  "buildSrcdoc still has its template literal intact: " +
  buildSrcdoc("<p>hello</p>"));
