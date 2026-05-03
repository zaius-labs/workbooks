// Image → video pipeline. Five cells, one connected path:
//
//   1. Drop image (single)
//   2. Depth Anything v2 via @work.books/runtime-wasm's Candle-ONNX runner
//   3. Sketch motion arrows on the image
//   4. OpenRouter LLM drafts a Kling/Veo-shaped prompt from depth + strokes
//   5. OpenRouter video model renders the final clip (default google/veo-3.1)

import { loadRuntime } from "virtual:workbook-runtime";
import { mountSettings } from "../_shared/settings.js";

const settings = mountSettings({
  keys: [
    {
      id: "gemini",
      label: "Google AI Studio API key",
      storageKey: "wb_i2v_gemini",
      signupUrl: "https://aistudio.google.com/app/apikey",
      hint: "Required. Used for both prompt drafting (Gemini Flash) and video generation (Veo). Stored in your browser's localStorage.",
      required: true,
    },
    {
      id: "prompt_model",
      label: "Prompt-drafting model",
      storageKey: "wb_i2v_prompt_model",
      signupUrl: "https://ai.google.dev/gemini-api/docs/models",
      hint: "Defaults to gemini-3-flash-preview. Use gemini-3-pro-preview for stronger drafts (slower).",
      required: false,
    },
    {
      id: "video_model",
      label: "Video-generation model",
      storageKey: "wb_i2v_video_model",
      signupUrl: "https://ai.google.dev/gemini-api/docs/video",
      hint: "Defaults to veo-3.1-fast-generate-preview. Use veo-3.1-generate-preview for the higher-quality (slower, pricier) variant.",
      required: false,
    },
  ],
});

const DEFAULT_PROMPT_MODEL = "gemini-3-flash-preview";
const DEFAULT_VIDEO_MODEL = "veo-3.1-fast-generate-preview";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const els = {
  meta: document.getElementById("meta"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  imgPreview: document.getElementById("img-preview"),
  promptText: document.getElementById("prompt-text"),
  out: {
    depth: document.getElementById("out-depth"),
    strokes: document.getElementById("out-strokes"),
    prompt: document.getElementById("out-prompt"),
    video: document.getElementById("out-video"),
  },
};

let runtime = null;
let depthHandle = null;

const state = {
  image: null,         // { name, bytes, dataUrl, bitmap, width, height }
  depth: null,         // { canvas, summary, raw } from cell 2
  strokes: [],         // [{ from: {x, y}, to: {x, y} }] in image-pixel coords
  composedPrompt: "",  // editable text from cell 4
};

const DEPTH_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx";
const DEPTH_INPUT_SIZE = 518;

/* --------------------------- helpers ------------------------------- */

function placeholder(host, msg) {
  host.classList.add("empty");
  host.innerHTML = "";
  host.textContent = msg;
}
function renderError(host, err) {
  host.classList.remove("empty");
  host.innerHTML = "";
  const div = document.createElement("div");
  div.className = "err";
  div.textContent = err instanceof Error ? err.message : String(err);
  host.appendChild(div);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function setProgress(host, msg) {
  host.classList.remove("empty");
  host.innerHTML = "";
  const div = document.createElement("div");
  div.className = "progress";
  div.textContent = msg;
  host.appendChild(div);
  return (text) => { div.textContent = text; };
}
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function ensureRuntime(host) {
  if (runtime) return runtime;
  setProgress(host, "Loading workbook runtime…");
  runtime = await loadRuntime();
  if (!runtime?.wasm?.onnxLoad) {
    throw new Error("Runtime missing onnxLoad — workbook-runtime-wasm < 0.2.1?");
  }
  return runtime;
}

async function fetchModelBytes(url, onProgress) {
  const cache = await caches.open("workbook-onnx-models");
  let resp = await cache.match(url);
  if (!resp) {
    resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
    const total = Number(resp.headers.get("content-length") || 0);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    return bytes;
  }
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

/* --------------------------- Cell 1: drop --------------------------- */

function setupDropzone() {
  const dz = els.dropzone;
  dz.addEventListener("click", () => els.fileInput.click());
  dz.addEventListener("dragover", (ev) => { ev.preventDefault(); dz.classList.add("is-active"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-active"));
  dz.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dz.classList.remove("is-active");
    if (ev.dataTransfer?.files?.[0]) ingestFile(ev.dataTransfer.files[0]);
  });
  els.fileInput.addEventListener("change", (ev) => {
    if (ev.target.files?.[0]) ingestFile(ev.target.files[0]);
    ev.target.value = "";
  });
  document.getElementById("clear-img").addEventListener("click", () => {
    state.image = null;
    state.depth = null;
    state.strokes = [];
    state.composedPrompt = "";
    els.promptText.value = "";
    renderImagePreview();
    updateMeta();
    clearAllOutputs();
  });
  document.getElementById("clear-strokes").addEventListener("click", () => {
    state.strokes = [];
    renderStrokeCanvas();
  });
}

async function ingestFile(file) {
  if (!file.type.startsWith("image/")) return;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const dataUrl = await fileToDataUrl(file);
    const bitmap = await createImageBitmap(file);
    state.image = {
      name: file.name,
      bytes,
      dataUrl,
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    };
    state.depth = null;
    state.strokes = [];
    state.composedPrompt = "";
    els.promptText.value = "";
    renderImagePreview();
    renderStrokeCanvas();
    updateMeta();
    clearAllOutputs();
  } catch (err) {
    console.error("ingest", err);
  }
}

function renderImagePreview() {
  els.imgPreview.innerHTML = "";
  if (!state.image) return;
  const img = document.createElement("img");
  img.src = state.image.dataUrl;
  img.alt = state.image.name;
  img.className = "preview-img";
  els.imgPreview.appendChild(img);
  const meta = document.createElement("div");
  meta.className = "preview-meta";
  meta.textContent = `${state.image.name} · ${state.image.width}×${state.image.height}`;
  els.imgPreview.appendChild(meta);
}

function updateMeta() {
  if (!state.image) {
    els.meta.textContent = "Drop an image to begin.";
  } else {
    const stages = [
      "image ✓",
      state.depth ? "depth ✓" : "depth …",
      state.strokes.length ? `${state.strokes.length} stroke${state.strokes.length === 1 ? "" : "s"} ✓` : "no strokes",
      state.composedPrompt ? "prompt ✓" : "prompt …",
    ];
    els.meta.textContent = stages.join(" · ");
  }
}

function clearAllOutputs() {
  for (const host of Object.values(els.out)) {
    placeholder(host, "Step pending — work top to bottom.");
  }
  // Strokes cell needs the canvas regardless.
  renderStrokeCanvas();
}

/* --------------------------- Cell 2: depth -------------------------- */

async function runDepth(host) {
  if (!state.image) {
    placeholder(host, "Drop an image first.");
    return;
  }
  await ensureRuntime(host);
  if (depthHandle == null) {
    const update = setProgress(host, "Downloading depth-anything-v2-small.onnx…");
    const bytes = await fetchModelBytes(DEPTH_URL, (got, total) => {
      if (total > 0) update(`Downloading depth model ${(got / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB (${((got / total) * 100).toFixed(0)}%)`);
      else update(`Downloading depth model ${(got / 1024 / 1024).toFixed(1)} MB`);
    });
    update(`Parsing model (${(bytes.length / 1024 / 1024).toFixed(1)} MB)…`);
    depthHandle = runtime.wasm.onnxLoad(bytes);
  }

  const t0 = performance.now();
  setProgress(host, "Running depth estimation…");
  const tensorJs = runtime.wasm.imageToTensorRgb(
    state.image.bytes,
    DEPTH_INPUT_SIZE,
    DEPTH_INPUT_SIZE,
    new Float32Array([0.485, 0.456, 0.406]),
    new Float32Array([0.229, 0.224, 0.225]),
  );
  const outputs = runtime.wasm.onnxRun(depthHandle, { pixel_values: tensorJs });
  const depthKey = Object.keys(outputs)[0];
  const out = outputs[depthKey];
  if (!out) throw new Error("model returned no outputs");

  // Compute summary stats over the depth map for the LLM prompt step.
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < out.data.length; i++) {
    const v = out.data[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
  }
  const mean = sum / out.data.length;
  const range = mx - mn || 1;
  const summary = {
    min: mn,
    max: mx,
    mean,
    foreground_ratio: countAbove(out.data, mn + range * 0.6) / out.data.length,
  };

  const depthCanvasSquare = depthMapToCanvas(out.data, out.shape);
  // The model takes a square 518×518 input; resample the depth map
  // back to the source image's aspect ratio so the side-by-side
  // doesn't look squashed.
  const depthCanvas = resizeCanvasToAspect(
    depthCanvasSquare,
    state.image.width,
    state.image.height,
  );
  const ms = performance.now() - t0;

  state.depth = { canvas: depthCanvas, summary, raw: out };
  updateMeta();

  host.classList.remove("empty");
  host.innerHTML = "";
  const pair = document.createElement("div");
  pair.className = "vision-pair";
  pair.innerHTML = `<img alt="original"><div class="depth-mount"></div><div class="pair-name">${escapeHtml(state.image.name)} · ${ms.toFixed(0)}ms · foreground ${(summary.foreground_ratio * 100).toFixed(0)}%</div>`;
  pair.querySelector("img").src = state.image.dataUrl;
  pair.querySelector(".depth-mount").appendChild(depthCanvas);
  host.appendChild(pair);
}

function countAbove(arr, threshold) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > threshold) n++;
  return n;
}

function depthMapToCanvas(data, shape) {
  let h, w;
  if (shape.length === 3) [, h, w] = shape;
  else if (shape.length === 4) [, , h, w] = shape;
  else throw new Error(`unexpected depth shape ${shape}`);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < mn) mn = data[i];
    if (data[i] > mx) mx = data[i];
  }
  const range = mx - mn || 1;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const t = (data[i] - mn) / range;
    const [r, g, b] = inferno(1 - t);
    imgData.data[j] = r;
    imgData.data[j + 1] = g;
    imgData.data[j + 2] = b;
    imgData.data[j + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Cap the long edge at 1024 so we don't blow up GPU memory on huge
 * source images, but otherwise scale the square depth canvas back to
 * the source image's aspect ratio. Bilinear filtering smooths the
 * relatively-low-resolution depth output.
 */
function resizeCanvasToAspect(srcCanvas, targetW, targetH) {
  const maxDim = 1024;
  const scale = Math.min(1, maxDim / Math.max(targetW, targetH));
  const w = Math.round(targetW * scale);
  const h = Math.round(targetH * scale);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return out;
}

function inferno(t) {
  const stops = [
    [0, [0, 0, 4]], [0.13, [25, 11, 64]], [0.25, [66, 10, 104]],
    [0.38, [106, 23, 110]], [0.5, [147, 38, 103]], [0.63, [188, 55, 84]],
    [0.75, [221, 81, 58]], [0.88, [243, 132, 35]], [1, [252, 255, 164]],
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/* ------------------------ Cell 3: stroke canvas --------------------- */

function renderStrokeCanvas() {
  const host = els.out.strokes;
  if (!state.image) {
    placeholder(host, "Drop an image first.");
    return;
  }
  host.classList.remove("empty");
  host.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "stroke-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "stroke-canvas";
  // Drawing buffer at original image resolution; CSS sizes responsively.
  canvas.width = state.image.width;
  canvas.height = state.image.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(state.image.bitmap, 0, 0);
  redrawStrokes(ctx);
  wrap.appendChild(canvas);

  const info = document.createElement("div");
  info.className = "stroke-info";
  info.textContent = state.strokes.length
    ? `${state.strokes.length} arrow${state.strokes.length === 1 ? "" : "s"} drawn — drag for more, "Clear strokes" to reset.`
    : "Click and drag to draw motion arrows. Where things should move.";
  wrap.appendChild(info);
  host.appendChild(wrap);

  // Drag-to-draw: capture pointerdown/move/up; track in canvas coords.
  let dragging = false;
  let from = null;
  function toCanvas(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
      y: ((ev.clientY - rect.top) / rect.height) * canvas.height,
    };
  }
  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true;
    from = toCanvas(ev);
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const to = toCanvas(ev);
    // Live preview while dragging: redraw image + existing + this temp arrow.
    ctx.drawImage(state.image.bitmap, 0, 0);
    redrawStrokes(ctx);
    drawArrow(ctx, from, to, "rgba(99, 102, 241, 0.85)");
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    const to = toCanvas(ev);
    dragging = false;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist > 8) {
      state.strokes.push({ from, to });
      info.textContent = `${state.strokes.length} arrow${state.strokes.length === 1 ? "" : "s"} drawn — drag for more.`;
      ctx.drawImage(state.image.bitmap, 0, 0);
      redrawStrokes(ctx);
      updateMeta();
    } else {
      // Click without drag — redraw clean.
      ctx.drawImage(state.image.bitmap, 0, 0);
      redrawStrokes(ctx);
    }
  });
}

function redrawStrokes(ctx) {
  for (const s of state.strokes) {
    drawArrow(ctx, s.from, s.to, "rgba(236, 72, 153, 0.95)");
  }
}

function drawArrow(ctx, from, to, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  // Scale stroke with image so it stays visible at any output size.
  const lw = Math.max(3, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.005);
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  // Arrowhead.
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLen = lw * 5;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - headLen * Math.cos(angle - Math.PI / 6),
    to.y - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - headLen * Math.cos(angle + Math.PI / 6),
    to.y - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ------------------------ Cell 4: compose prompt -------------------- */

async function runComposePrompt(host) {
  if (!state.image) throw new Error("Drop an image first.");
  if (!state.depth) throw new Error("Run cell 2 (depth) first — the LLM uses depth stats to ground the motion.");
  const apiKey = settings.get("gemini");
  if (!apiKey) {
    settings.showBanner("Google AI Studio API key needed. Click ⚙ to set it.");
    settings.open("gemini");
    throw new Error("Gemini API key required.");
  }
  const model = settings.get("prompt_model") || DEFAULT_PROMPT_MODEL;

  const strokeSummary = describeStrokes(state.strokes, state.image.width, state.image.height);
  const depthSummary = state.depth.summary;
  const fgPct = (depthSummary.foreground_ratio * 100).toFixed(0);

  const userText = [
    "I'm generating an image-to-video clip with Veo. Help me write a short, evocative motion prompt for the model.",
    "",
    "Context:",
    `- Source image: ${state.image.name} (${state.image.width}×${state.image.height}).`,
    `- Depth map foreground occupies roughly ${fgPct}% of the frame.`,
    `- Sketched motion arrows: ${strokeSummary || "none drawn — choose camera+subject motion that fits the image"}.`,
    "",
    "Write a single tight paragraph (2-3 sentences, ≤60 words) describing:",
    "- The camera move (push-in, slow orbit, hand-held, locked off).",
    "- The subject motion (what moves, how fast, in which direction).",
    "- Atmosphere (light, weather, mood).",
    "",
    "Be concrete and visual. No preamble, no bullets, just the prompt.",
  ].join("\n");

  setProgress(host, `Asking ${model} to draft the motion prompt…`);

  const { mimeType, base64 } = splitDataUrl(state.image.dataUrl);
  const resp = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "You write tight, vivid motion prompts for image-to-video generators. Prefer concrete visual detail over poetic abstraction.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: userText },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
      }),
    },
  );
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 600)}`);
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((p) => p?.text)
    .filter(Boolean)
    .join("")
    ?.trim();
  if (!text) {
    throw new Error(`Gemini returned no prompt text. First 400 chars: ${JSON.stringify(json).slice(0, 400)}`);
  }

  state.composedPrompt = text;
  els.promptText.value = text;
  updateMeta();

  host.classList.remove("empty");
  host.innerHTML = "";
  const note = document.createElement("div");
  note.className = "compose-note";
  note.textContent = `Drafted via ${model}. Edit above before generating.`;
  host.appendChild(note);
}

function splitDataUrl(dataUrl) {
  // "data:image/jpeg;base64,…" → { mimeType: "image/jpeg", base64: "…" }
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("unexpected dataUrl shape");
  return { mimeType: m[1], base64: m[2] };
}

function describeStrokes(strokes, w, h) {
  if (!strokes.length) return "";
  const parts = [];
  for (const [i, s] of strokes.entries()) {
    const fx = s.from.x / w, fy = s.from.y / h;
    const tx = s.to.x / w, ty = s.to.y / h;
    const dx = tx - fx, dy = ty - fy;
    const dir = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? "right" : "left")
      : (dy > 0 ? "down" : "up");
    const startQuad = `${fx < 0.5 ? "left" : "right"} ${fy < 0.5 ? "upper" : "lower"}`;
    parts.push(`#${i + 1} from ${startQuad} (${fx.toFixed(2)},${fy.toFixed(2)}) → ${dir}`);
  }
  return parts.join("; ");
}

/* ------------------------ Cell 5: generate video -------------------- */

async function runGenerateVideo(host) {
  if (!state.image) throw new Error("Drop an image first.");
  const prompt = (els.promptText.value || state.composedPrompt || "").trim();
  if (!prompt) throw new Error("Write or compose a motion prompt first (cell 4).");
  const apiKey = settings.get("gemini");
  if (!apiKey) {
    settings.showBanner("Google AI Studio API key needed. Click ⚙ to set it.");
    settings.open("gemini");
    throw new Error("Gemini API key required.");
  }
  const model = settings.get("video_model") || DEFAULT_VIDEO_MODEL;
  const update = setProgress(host, `Submitting to ${model}…`);

  // 1. Submit a long-running prediction request.
  const { mimeType, base64 } = splitDataUrl(state.image.dataUrl);
  const submitResp = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        instances: [
          {
            prompt,
            image: { bytesBase64Encoded: base64, mimeType },
          },
        ],
        parameters: {
          aspectRatio: state.image.width >= state.image.height ? "16:9" : "9:16",
          // personGeneration omitted — Veo enforces region-specific
          // policies and `allow_all` is rejected; defaulting picks the
          // permissive option allowed for the caller's region.
        },
      }),
    },
  );
  if (!submitResp.ok) {
    const txt = await submitResp.text();
    throw new Error(`Gemini submit ${submitResp.status}: ${txt.slice(0, 600)}`);
  }
  const submitJson = await submitResp.json();
  const opName = submitJson?.name;
  if (!opName) {
    throw new Error(`No operation name in submit response. Body: ${JSON.stringify(submitJson).slice(0, 400)}`);
  }
  update(`Submitted (${opName.slice(-12)}). Polling for video — typical render is 60–180s…`);

  // 2. Poll until done. Veo gives no per-step progress; just wait.
  const startedAt = Date.now();
  let opJson = null;
  while (true) {
    await new Promise((r) => setTimeout(r, 6000));
    const pollResp = await fetch(
      `${GEMINI_BASE}/${opName}`,
      { headers: { "x-goog-api-key": apiKey } },
    );
    if (!pollResp.ok) {
      const txt = await pollResp.text();
      throw new Error(`Gemini poll ${pollResp.status}: ${txt.slice(0, 400)}`);
    }
    opJson = await pollResp.json();
    if (opJson?.error) {
      throw new Error(`Veo error: ${JSON.stringify(opJson.error).slice(0, 600)}`);
    }
    if (opJson?.done) break;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    update(`Rendering with ${model} — ${elapsed}s elapsed (typical 60–180s)…`);
  }

  // 3. Check for Google's RAI / safety-filter refusals BEFORE looking
  // for a video URI — they come back as a successful operation with a
  // filter-reasons field instead of generated samples.
  const raiReasons = opJson?.response?.generateVideoResponse?.raiMediaFilteredReasons;
  const raiCount = opJson?.response?.generateVideoResponse?.raiMediaFilteredCount;
  if (raiCount > 0 || (Array.isArray(raiReasons) && raiReasons.length > 0)) {
    const reason = (raiReasons || ["unspecified safety filter"]).join(" • ");
    throw new Error(
      `Veo refused to generate this clip:\n\n${reason}\n\n` +
        `This is Google's safety filter — it commonly trips on celebrity likeness, ` +
        `kids, or trademarked content. Try a different source image.`,
    );
  }

  // Extract the video URI from the operation response. Standard shape
  // is response.generateVideoResponse.generatedSamples[N].video.uri,
  // but Google has shipped variants — handle a few.
  const videoUri = extractVeoVideoUri(opJson);
  if (!videoUri) {
    throw new Error(
      `Operation done but no video URI in response. Body: ${JSON.stringify(opJson).slice(0, 600)}`,
    );
  }

  // 4. Download the video bytes (the URI requires the API key as a
  // header) and embed via a blob: URL so the <video> element can play
  // it. The URI is short-lived, so we don't display it directly.
  update("Downloading video…");
  const videoResp = await fetch(videoUri, { headers: { "x-goog-api-key": apiKey } });
  if (!videoResp.ok) {
    const txt = await videoResp.text();
    throw new Error(`Video download ${videoResp.status}: ${txt.slice(0, 200)}`);
  }
  const blob = await videoResp.blob();
  const blobUrl = URL.createObjectURL(blob);

  renderVideoResult(host, model, blobUrl, blob.size);
}

function extractVeoVideoUri(opJson) {
  const r = opJson?.response;
  if (!r) return null;
  // Newer shape: generateVideoResponse.generatedSamples[].video.uri
  const samples1 = r?.generateVideoResponse?.generatedSamples;
  if (Array.isArray(samples1) && samples1[0]?.video?.uri) return samples1[0].video.uri;
  // Alt shape: predictions[].videoUri
  const predictions = r?.predictions;
  if (Array.isArray(predictions)) {
    for (const p of predictions) {
      if (typeof p?.videoUri === "string") return p.videoUri;
      if (typeof p?.video?.uri === "string") return p.video.uri;
      if (typeof p?.uri === "string" && /\.(mp4|webm|mov)/i.test(p.uri)) return p.uri;
    }
  }
  // Hail mary: any URI in the response that looks like a video.
  const flat = JSON.stringify(r);
  const m = flat.match(/https?:\/\/[^"]+\.(mp4|webm|mov)([?][^"]*)?/i);
  return m ? m[0] : null;
}

function renderVideoResult(host, model, videoUrl, sizeBytes) {
  host.classList.remove("empty");
  host.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "video-wrap";
  const video = document.createElement("video");
  video.src = videoUrl;
  video.controls = true;
  video.autoplay = true;
  video.loop = true;
  video.style.width = "100%";
  wrap.appendChild(video);
  const meta = document.createElement("div");
  meta.className = "video-meta";
  const sizeStr = sizeBytes ? ` · ${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : "";
  meta.innerHTML = `Rendered via <code>${escapeHtml(model)}</code>${sizeStr} · <a href="${videoUrl}" download="generated.mp4">download ↓</a>`;
  wrap.appendChild(meta);
  host.appendChild(wrap);
}

function extractVideoUrl(json) {
  // Common shapes:
  //   choices[0].message.content with a video URL string
  //   choices[0].message.content[].video_url.url
  //   choices[0].message.attachments[0].url
  const choice = json?.choices?.[0]?.message;
  if (!choice) return null;
  if (typeof choice.content === "string") {
    const m = choice.content.match(/https?:\/\/[^\s"<]+\.(mp4|webm|mov|m3u8)(\?[^\s"<]*)?/i);
    if (m) return m[0];
  }
  if (Array.isArray(choice.content)) {
    for (const part of choice.content) {
      if (part?.type === "video_url" && part?.video_url?.url) return part.video_url.url;
      if (part?.type === "image_url" && /\.(mp4|webm|mov)(\?|$)/i.test(part?.image_url?.url ?? "")) {
        return part.image_url.url;
      }
      if (typeof part?.text === "string") {
        const m = part.text.match(/https?:\/\/[^\s"<]+\.(mp4|webm|mov|m3u8)(\?[^\s"<]*)?/i);
        if (m) return m[0];
      }
    }
  }
  if (Array.isArray(choice.attachments)) {
    for (const a of choice.attachments) {
      if (typeof a?.url === "string" && /\.(mp4|webm|mov)(\?|$)/i.test(a.url)) return a.url;
    }
  }
  return null;
}

/* --------------------------- runners + boot ------------------------- */

const RUNNERS = {
  "cell-depth": () => runDepth(els.out.depth),
  "cell-prompt": () => runComposePrompt(els.out.prompt),
  "cell-video": () => runGenerateVideo(els.out.video),
};

document.addEventListener("click", async (ev) => {
  const target = ev.target.closest("[data-run]");
  if (!target) return;
  const id = target.dataset.run;
  const runner = RUNNERS[id];
  if (!runner) return;
  target.classList.add("is-running");
  try {
    await runner();
  } catch (err) {
    const targetId = id.replace("cell-", "out-");
    const host = document.getElementById(targetId);
    if (host) renderError(host, err);
    console.error(id, err);
  }
  target.classList.remove("is-running");
});

setupDropzone();
clearAllOutputs();
updateMeta();

// Reflect the configured video model in the cell 5 prose, and re-sync
// whenever the user edits it in ⚙. Keeps the description honest about
// which model the Generate button will actually call.
function syncVideoModelDisplay() {
  const span = document.getElementById("video-model-display");
  if (span) span.textContent = settings.get("video_model") || DEFAULT_VIDEO_MODEL;
}
syncVideoModelDisplay();
settings.onChange((id) => {
  if (id === "video_model") syncVideoModelDisplay();
});
