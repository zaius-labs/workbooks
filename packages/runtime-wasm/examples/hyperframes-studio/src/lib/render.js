// In-browser composition renderer.
//
// Strategy
// --------
// Mount an offscreen iframe at the target pixel resolution; drive
// playback frame-by-frame via postMessage(seek); rasterize each
// frame to a canvas with html2canvas-pro; encode to webm.
//
// Two encoding pipelines:
//
// 1. WebCodecs (preferred) — `VideoEncoder` with explicit
//    per-frame `timestamp` in microseconds (frame_index / fps).
//    `webm-muxer` packages the encoded chunks. Output duration is
//    frame-exact regardless of how slow rasterization is. Works
//    in Chromium 94+, Firefox 130+, Safari 16.4+.
//
// 2. MediaRecorder fallback — `canvas.captureStream(0)` + manual
//    `requestFrame()`. Video duration follows wall-clock time, NOT
//    frame count, so a slow rasterizer stretches the output. Used
//    only when WebCodecs is missing. The modal warns the user.
//
// Quality / limits
// ----------------
// - Rasterization uses html2canvas-pro from a CDN (loaded once).
//   CSS filters, blur, mix-blend-mode are approximate — for high
//   fidelity, use the HTML export path + HyperFrames CLI.

import { composition } from "./composition.svelte.js";
import { IFRAME_RUNTIME } from "./initial.js";

const HTML2CANVAS_URL = "https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.10/dist/html2canvas-pro.min.js";
const WEBM_MUXER_URL  = "https://cdn.jsdelivr.net/npm/webm-muxer@5.0.4/+esm";

let html2canvasLoader = null;
async function loadHtml2Canvas() {
  if (window.html2canvas) return window.html2canvas;
  if (html2canvasLoader) return html2canvasLoader;
  html2canvasLoader = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = HTML2CANVAS_URL;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => reject(new Error("html2canvas failed to load (offline?)"));
    document.head.appendChild(s);
  });
  return html2canvasLoader;
}

let webmMuxerLoader = null;
async function loadWebmMuxer() {
  if (webmMuxerLoader) return webmMuxerLoader;
  webmMuxerLoader = import(/* @vite-ignore */ WEBM_MUXER_URL);
  return webmMuxerLoader;
}

export function hasWebCodecs() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/** Build the standalone composition HTML at a specific pixel size.
 *  Author CSS using clamp/vmin adapts to whatever box we hand it. */
function buildRenderSrcdoc({ w, h }) {
  return `<!DOCTYPE html><html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000;">
${composition.html}
${IFRAME_RUNTIME}
</body></html>`;
}

/** Mount an offscreen render iframe at the target pixel resolution
 *  and wait for the runtime's `ready` postMessage. Returns the
 *  iframe element + a cleanup function. */
async function mountRenderIframe({ width, height }) {
  const stage = document.createElement("div");
  stage.style.cssText = `
    position: fixed; left: -100000px; top: 0;
    width: ${width}px; height: ${height}px;
    pointer-events: none; z-index: -1;
  `;
  const iframe = document.createElement("iframe");
  iframe.width = String(width);
  iframe.height = String(height);
  iframe.style.cssText = `width:${width}px;height:${height}px;border:0;display:block;background:#000;`;
  // Same-origin needed so html2canvas can read contentDocument.
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.setAttribute("title", "HyperFrames render target");
  iframe.srcdoc = buildRenderSrcdoc({ w: width, h: height });
  stage.appendChild(iframe);
  document.body.appendChild(stage);

  const cleanup = () => stage.remove();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onReady);
      reject(new Error("Render iframe didn't become ready in 8s"));
    }, 8000);
    function onReady(ev) {
      if (ev.source !== iframe.contentWindow) return;
      const m = ev.data || {};
      if (m.type === "ready") {
        clearTimeout(timeout);
        window.removeEventListener("message", onReady);
        resolve();
      }
    }
    window.addEventListener("message", onReady);
  });

  return { iframe, cleanup };
}

/** Seek the iframe to a composition time and wait for layout +
 *  GSAP to settle. Two rAFs is the minimum reliable lag. */
async function seekAndSettle(iframe, t) {
  iframe.contentWindow.postMessage({ type: "seek", value: t }, "*");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** Pick the WebCodecs codec string the host supports. VP9 first, VP8
 *  fallback. Returns { codec, muxerCodec, bitrate }. */
async function pickWebCodecsCodec({ width, height, fps }) {
  const candidates = [
    { codec: "vp09.00.10.08", muxerCodec: "V_VP9" },
    { codec: "vp09.00.31.08", muxerCodec: "V_VP9" }, // higher level for 4K-ish
    { codec: "vp8",           muxerCodec: "V_VP8" },
  ];
  for (const c of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.codec, width, height,
        bitrate: 8_000_000, framerate: fps,
      });
      if (support?.supported) return c;
    } catch { /* try next */ }
  }
  throw new Error("No supported VideoEncoder codec");
}

/** Pick the best webm MIME type the host MediaRecorder supports. */
function pickMediaRecorderMime() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "video/webm";
}

// ─── WebCodecs path ────────────────────────────────────────────
async function renderViaWebCodecs({
  width, height, fps,
  iframe, html2canvas,
  totalFrames, totalDuration,
  onProgress, onPhase, signal,
}) {
  const { Muxer, ArrayBufferTarget } = await loadWebmMuxer();
  const { codec, muxerCodec } = await pickWebCodecsCodec({ width, height, fps });

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: muxerCodec, width, height, frameRate: fps },
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  encoder.configure({
    codec, width, height,
    bitrate: 8_000_000,
    framerate: fps,
  });

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const frameDur = Math.round(1_000_000 / fps);

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new Error("Render cancelled");
      if (encoderError) throw encoderError;

      const t = Math.min(totalDuration, i / fps);
      await seekAndSettle(iframe, t);

      const snap = await html2canvas(iframe.contentDocument.body, {
        width, height, useCORS: true, backgroundColor: "#000",
        scale: 1, logging: false,
      });
      ctx.drawImage(snap, 0, 0, width, height);

      // Explicit timestamp = frame_index × (1e6 / fps). The encoder
      // doesn't care that wall-clock between frames was 200ms — the
      // output video advances by 33.33ms for 30fps regardless.
      const frame = new VideoFrame(canvas, {
        timestamp: i * frameDur,
        duration: frameDur,
      });
      // Keyframe every 2s (typical) plus the first frame.
      encoder.encode(frame, { keyFrame: i === 0 || i % (fps * 2) === 0 });
      frame.close();

      // Backpressure: don't queue too many encoded frames in RAM.
      while (encoder.encodeQueueSize > 4) {
        await new Promise((r) => setTimeout(r, 0));
      }

      onProgress?.({ frame: i + 1, totalFrames, percent: ((i + 1) / totalFrames) * 100 });
    }
    onPhase?.("finalizing");
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: "video/webm" });
  } finally {
    try { encoder.close(); } catch {}
  }
}

// ─── MediaRecorder fallback ────────────────────────────────────
async function renderViaMediaRecorder({
  width, height, fps,
  iframe, html2canvas,
  totalFrames, totalDuration,
  onProgress, onPhase, signal,
}) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mimeType = pickMediaRecorderMime();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.start();

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new Error("Render cancelled");
      const t = Math.min(totalDuration, i / fps);
      await seekAndSettle(iframe, t);
      const snap = await html2canvas(iframe.contentDocument.body, {
        width, height, useCORS: true, backgroundColor: "#000",
        scale: 1, logging: false,
      });
      ctx.drawImage(snap, 0, 0, width, height);
      track.requestFrame?.();
      onProgress?.({ frame: i + 1, totalFrames, percent: ((i + 1) / totalFrames) * 100 });
    }
    onPhase?.("finalizing");
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.requestData?.();
      recorder.stop();
    });
    return new Blob(chunks, { type: mimeType });
  } finally {
    if (recorder.state !== "inactive") {
      try { recorder.stop(); } catch {}
    }
  }
}

/** Run a full render. `onProgress({frame, totalFrames, percent})`
 *  fires per frame; `onPhase(name)` on phase transitions:
 *    loading-rasterizer → mounting-iframe → recording → finalizing.
 *  Returns the final Blob. Aborts on `signal.aborted`. */
export async function renderComposition({
  width, height,
  fps = 30,
  onProgress, onPhase, signal,
} = {}) {
  if (!width || !height) throw new Error("width and height are required");
  if (composition.totalDuration <= 0) throw new Error("Composition has no clips to render");

  onPhase?.("loading-rasterizer");
  const html2canvas = await loadHtml2Canvas();

  onPhase?.("mounting-iframe");
  const { iframe, cleanup } = await mountRenderIframe({ width, height });

  const totalDuration = composition.totalDuration;
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));

  onPhase?.("recording");
  try {
    const args = { width, height, fps, iframe, html2canvas, totalFrames, totalDuration, onProgress, onPhase, signal };
    return hasWebCodecs()
      ? await renderViaWebCodecs(args)
      : await renderViaMediaRecorder(args);
  } finally {
    cleanup();
  }
}

/** Save a Blob to disk via an anchor click. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Escape hatch: ship the composition as standalone HTML the user
 *  can render externally with the HyperFrames CLI. */
export function downloadAsHtml() {
  const html = composition.exportHtml();
  downloadBlob(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    `composition-${Date.now()}.html`,
  );
}
