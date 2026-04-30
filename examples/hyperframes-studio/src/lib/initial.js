// Starter HyperFrames composition — a 3-scene reel exercising the
// data-start / data-duration contract plus per-clip GSAP entrances.
// All sizing is viewport-relative (vmin / clamp) so the same source
// looks correct at 16:9, 9:16, 1:1, and 4:5 without further edits.
// Edit via the chat agent.
export const INITIAL_COMPOSITION = `<style>
  /* Use vmin-based sizing so type and gaps shrink for portrait /
   * square ratios. clamp() guards extreme aspect ratios. */
  body { margin: 0; width: 100vw; height: 100vh;
         background: #0c0a09; color: #fafaf9;
         font-family: "Inter", system-ui, sans-serif; overflow: hidden; }
  .scene { position: absolute; inset: 0; display: none;
           align-items: center; justify-content: center; flex-direction: column;
           padding: 6vmin 8vmin; box-sizing: border-box;
           gap: clamp(12px, 2.4vmin, 28px); text-align: center; }
  .scene.active { display: flex; }
  .eyebrow { font-family: "JetBrains Mono", ui-monospace, monospace;
             font-size: clamp(10px, 1.8vmin, 16px);
             letter-spacing: 0.18em; color: #fed7aa;
             text-transform: uppercase; }
  .title { font-size: clamp(36px, 9vmin, 96px);
           font-weight: 700; line-height: 1.02; margin: 0;
           letter-spacing: -0.02em; max-width: 18ch; }
  .subtitle { font-size: clamp(14px, 2.6vmin, 26px);
              color: #a8a29e; max-width: 36ch; margin: 0;
              line-height: 1.45; }
  .stat { font-size: clamp(64px, 18vmin, 200px);
          font-weight: 800; color: #fed7aa; line-height: 1;
          letter-spacing: -0.04em; }
  .stat-label { font-size: clamp(12px, 2vmin, 22px); color: #a8a29e; }
  .outro b { color: #fed7aa; }
  .pill { display: inline-flex; padding: 0.6vmin 1.6vmin; border-radius: 999px;
          background: #292524; border: 1px solid #44403c; color: #fed7aa;
          font-family: "JetBrains Mono", ui-monospace, monospace;
          font-size: clamp(10px, 1.6vmin, 14px); letter-spacing: 0.04em; }
</style>

<div id="intro" class="scene" data-start="0" data-duration="3">
  <div class="eyebrow">workbook · hyperframes</div>
  <h1 class="title">Compose video<br/>in HTML.</h1>
  <p class="subtitle">Each clip carries data-start and data-duration.
     The runtime ticks; GSAP animates; the timeline knows.</p>
</div>

<div id="stat" class="scene" data-start="3" data-duration="3">
  <span class="pill">scene 02 · the stat</span>
  <div class="stat">~2 MB</div>
  <div class="stat-label">runtime · cold-start under 200 ms</div>
</div>

<div id="outro" class="scene" data-start="6" data-duration="3">
  <h1 class="title">Edit on the left.<br/><b>Watch on the right.</b></h1>
  <p class="subtitle">Ask the agent to redesign a scene, retitle it, retime it,
     or add another. The player rebuilds on every save.</p>
</div>

<` + `script>
  // Author scripts run inside the iframe after the runtime is ready.
  // window.hf.timeline is a GSAP timeline; the runtime adds a label
  // for every clip id at the clip's start time, so positioning
  // tweens with "<clip-id>+=<offset>" makes them move with the clip
  // when the timeline editor retimes it. Equivalent functional form:
  //   tl.from(sel, props, hf.at("intro", 0.25))
  // Use gsap.from() so the resting state matches CSS.
  window.addEventListener("hf:ready", () => {
    const tl = window.hf.timeline;
    tl.from("#intro .eyebrow",  { y: 20, opacity: 0, duration: 0.5, ease: "power2.out" },  "intro+=0.1");
    tl.from("#intro .title",    { y: 60, opacity: 0, duration: 0.7, ease: "power3.out" },  "intro+=0.25");
    tl.from("#intro .subtitle", { y: 30, opacity: 0, duration: 0.6, ease: "power2.out" },  "intro+=0.55");

    tl.from("#stat .pill",       { y: 10, opacity: 0, duration: 0.4, ease: "power2.out" },        "stat+=0.05");
    tl.from("#stat .stat",       { scale: 0.8, opacity: 0, duration: 0.6, ease: "back.out(1.6)" }, "stat+=0.2");
    tl.from("#stat .stat-label", { y: 16, opacity: 0, duration: 0.4, ease: "power2.out" },        "stat+=0.55");

    tl.from("#outro .title",    { y: 50, opacity: 0, duration: 0.6, ease: "power3.out" }, "outro+=0.1");
    tl.from("#outro .subtitle", { y: 30, opacity: 0, duration: 0.5, ease: "power2.out" }, "outro+=0.4");
  });
</` + `script>`;

// Iframe runtime — loaded from the studio.
//
// Loads GSAP from a CDN (or skips animation if offline), builds a
// master timeline that scrubs clip visibility AND any author tweens
// the composition registers via window.hf.timeline. Drives playback
// from postMessage commands posted by the parent, and emits a `tick`
// every frame while playing so the timeline can render the playhead.
//
// The /script close is broken into two strings to dodge the host
// page's HTML parser; see core-bii in beads for context.
function makeRuntime({ autoplay }) {
  const initBody = `
(function(){
  const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js";

  function buildClips() {
    return Array.from(document.querySelectorAll("[data-start]")).map(el => ({
      el,
      id: el.id || "",
      start: parseFloat(el.getAttribute("data-start")) || 0,
      duration: parseFloat(el.getAttribute("data-duration")) || 0,
    }));
  }

  let clips = buildClips();
  let total = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  let tl = null;          // master GSAP timeline (paused; we drive .seek())
  let playing = false;
  let lastWall = 0;
  let t = 0;

  function applyVisibility(time) {
    for (const c of clips) {
      const inside = time >= c.start && time < c.start + c.duration;
      c.el.classList.toggle("active", inside);
    }
  }

  function buildTimeline(gsap) {
    const tl = gsap.timeline({ paused: true });
    // Stitch clip visibility AND a per-clip label into the timeline.
    // The label is what makes timeline edits non-destructive: the
    // author's script positions tweens with strings like
    // "intro+=0.25" or hf.at("intro", 0.25). When a clip moves,
    // the iframe remounts, the label lands at the new start time,
    // and every tween targeting that label moves with it.
    for (const c of clips) {
      if (c.id) {
        tl.addLabel(c.id, c.start);
        tl.addLabel(c.id + ":end", c.start + c.duration);
      }
      tl.set(c.el, { autoAlpha: 1, display: "" }, c.start);
      tl.set(c.el, { autoAlpha: 1 }, c.start + c.duration); // sentinel
    }
    // Pad the timeline to the full duration so the playhead can ride
    // past the last clip exit if the author wanted dead air at the end.
    tl.set({}, {}, total);
    return tl;
  }

  function loadGsap() {
    return new Promise((resolve) => {
      if (window.gsap) return resolve(window.gsap);
      const s = document.createElement("script");
      s.src = GSAP_URL;
      s.onload = () => resolve(window.gsap);
      s.onerror = () => resolve(null); // graceful degrade
      document.head.appendChild(s);
    });
  }

  function syncTo(time) {
    t = Math.max(0, Math.min(time, total));
    applyVisibility(t);
    if (tl) tl.seek(t, false);
  }

  function tick(now) {
    if (!playing) return;
    const dt = (now - lastWall) / 1000;
    lastWall = now;
    t = Math.min(total, t + dt);
    applyVisibility(t);
    if (tl) tl.seek(t, false);
    parent.postMessage({ type: "tick", t, total }, "*");
    if (t >= total) { playing = false; parent.postMessage({ type: "ended" }, "*"); return; }
    requestAnimationFrame(tick);
  }

  function play() {
    if (playing || total <= 0) return;
    if (t >= total) t = 0;
    playing = true;
    lastWall = performance.now();
    requestAnimationFrame(tick);
  }
  function pause() { playing = false; }
  function restart() { t = 0; playing = false; syncTo(0); parent.postMessage({ type: "tick", t: 0, total }, "*"); }

  // Resolve a clip-relative offset to absolute time. Authors who
  // don't want to use GSAP label syntax ("intro+=0.25") can write
  // hf.at("intro", 0.25) instead. Both produce the same result and
  // both stay correct when the clip moves.
  function clipAt(id, offset) {
    const c = clips.find((c) => c.id === id);
    return (c ? c.start : 0) + (Number.isFinite(offset) ? offset : 0);
  }

  loadGsap().then((gsap) => {
    if (gsap) {
      tl = buildTimeline(gsap);
      window.hf = { gsap, timeline: tl, clips, total, at: clipAt };
      window.dispatchEvent(new Event("hf:ready"));
    } else {
      window.hf = { gsap: null, timeline: null, clips, total, at: clipAt };
    }
    syncTo(0);
    parent.postMessage({ type: "ready", total }, "*");
    ${autoplay ? "play();" : ""}
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "play")     play();
    if (m.type === "pause")    pause();
    if (m.type === "toggle")   { playing ? pause() : play(); }
    if (m.type === "seek")     { syncTo(+m.value || 0); parent.postMessage({ type: "tick", t, total }, "*"); }
    if (m.type === "restart")  restart();
  });
})();
`;
  return "<" + "script>" + initBody + "</" + "script>";
}

export const IFRAME_RUNTIME          = makeRuntime({ autoplay: false });
export const IFRAME_RUNTIME_AUTOPLAY = makeRuntime({ autoplay: true  });
