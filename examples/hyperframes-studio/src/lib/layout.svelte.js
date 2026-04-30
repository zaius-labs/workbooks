// Persisted layout sizes — chat column width, timeline row height.
// Sizes survive reload via localStorage. Components bind to these
// reactive values; splitters mutate them via setChatWidth / setTimelineHeight.

const KEY_CHAT     = "hf.layout.chatWidth";
const KEY_TL       = "hf.layout.timelineHeight";
const KEY_PPS      = "hf.layout.pps";
const KEY_ASPECT   = "hf.layout.aspect";
const KEY_LEFT_TAB = "hf.layout.leftTab";

export const LEFT_TABS = ["chat", "assets", "mcp", "history"];

// Standard social/cinematic aspect ratios. Order = display order
// in the picker. Stored as the "w:h" string so it round-trips
// localStorage cleanly and keys the iframe's CSS aspect-ratio.
// `render` is the canonical pixel size to use when rendering to
// video — driven by typical platform expectations.
export const ASPECT_PRESETS = [
  { id: "16:9", label: "16:9", w: 16, h: 9,  hint: "Landscape · YouTube, web",       render: { w: 1920, h: 1080 } },
  { id: "9:16", label: "9:16", w: 9,  h: 16, hint: "Portrait · TikTok, Reels, Shorts", render: { w: 1080, h: 1920 } },
  { id: "1:1",  label: "1:1",  w: 1,  h: 1,  hint: "Square · feed, IG post",          render: { w: 1080, h: 1080 } },
  { id: "4:5",  label: "4:5",  w: 4,  h: 5,  hint: "Portrait · IG feed",              render: { w: 1080, h: 1350 } },
];

const CHAT_MIN = 320;
const CHAT_MAX = 760;
const TL_MIN   = 96;
const TL_MAX   = 480;

// HyperFrames Studio's zoom scale. Multipliers on pps_base = 100,
// so 1 second = 25 / 50 / 100 / 150 / 200 px.
const PPS_BASE = 100;
export const ZOOM_PRESETS = [0.25, 0.5, 1, 1.5, 2];

function readInt(key, fallback) {
  const v = parseInt(localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}
function readFloat(key, fallback) {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? v : fallback;
}

function readAspect() {
  const v = localStorage.getItem(KEY_ASPECT);
  return ASPECT_PRESETS.some((a) => a.id === v) ? v : "16:9";
}

function readLeftTab() {
  const v = localStorage.getItem(KEY_LEFT_TAB);
  return LEFT_TABS.includes(v) ? v : "chat";
}

class LayoutStore {
  chatWidth      = $state(readInt(KEY_CHAT, 440));
  timelineHeight = $state(readInt(KEY_TL, 180));
  // Pixels-per-second the timeline uses for clip widths and ruler
  // tick spacing. Single knob — drag/scrub/render all funnel through it.
  pps            = $state(readFloat(KEY_PPS, PPS_BASE));
  // Player canvas aspect ratio. The iframe's outer frame uses CSS
  // aspect-ratio so the visible canvas matches the export target.
  aspect         = $state(readAspect());
  // Which tab is active in the left side panel — chat or assets.
  leftTab        = $state(readLeftTab());

  setChatWidth(px) {
    const max = Math.min(CHAT_MAX, Math.floor((window.innerWidth || 1200) - 480));
    this.chatWidth = Math.max(CHAT_MIN, Math.min(max, Math.round(px)));
    localStorage.setItem(KEY_CHAT, String(this.chatWidth));
  }

  setTimelineHeight(px) {
    const max = Math.min(TL_MAX, Math.floor((window.innerHeight || 800) - 220));
    this.timelineHeight = Math.max(TL_MIN, Math.min(max, Math.round(px)));
    localStorage.setItem(KEY_TL, String(this.timelineHeight));
  }

  setZoom(multiplier) {
    const m = Math.max(ZOOM_PRESETS[0], Math.min(ZOOM_PRESETS[ZOOM_PRESETS.length - 1], +multiplier));
    this.pps = PPS_BASE * m;
    localStorage.setItem(KEY_PPS, String(this.pps));
  }

  setAspect(id) {
    if (!ASPECT_PRESETS.some((a) => a.id === id)) return;
    this.aspect = id;
    localStorage.setItem(KEY_ASPECT, id);
  }

  setLeftTab(tab) {
    if (!LEFT_TABS.includes(tab)) return;
    this.leftTab = tab;
    localStorage.setItem(KEY_LEFT_TAB, tab);
  }
  get aspectRatio() {
    const a = ASPECT_PRESETS.find((p) => p.id === this.aspect) ?? ASPECT_PRESETS[0];
    return `${a.w} / ${a.h}`;
  }

  /** Step zoom up or down by one preset. */
  zoomBy(direction) {
    const cur = this.pps / PPS_BASE;
    const sortedPresets = [...ZOOM_PRESETS].sort((a, b) => a - b);
    let idx = sortedPresets.findIndex((p) => Math.abs(p - cur) < 1e-3);
    if (idx === -1) {
      // Snap to nearest if current isn't on a preset.
      idx = sortedPresets.reduce((best, p, i) =>
        Math.abs(p - cur) < Math.abs(sortedPresets[best] - cur) ? i : best, 0);
    }
    const next = Math.max(0, Math.min(sortedPresets.length - 1, idx + direction));
    this.setZoom(sortedPresets[next]);
  }
}

export const layout = new LayoutStore();
