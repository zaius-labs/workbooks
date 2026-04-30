// Composition store — the single piece of authoritative state for
// the player and timeline. The chat agent edits it via the
// set_composition tool; the Player mounts it in a sandboxed iframe;
// the Timeline parses its [data-start] elements into clips.

import { INITIAL_COMPOSITION, IFRAME_RUNTIME, IFRAME_RUNTIME_AUTOPLAY } from "./initial.js";
import { assets } from "./assets.svelte.js";
import {
  bootstrapLoro,
  getDoc,
  readComposition,
  writeComposition,
} from "./loroBackend.svelte.js";
import { recordEdit } from "./historyBackend.svelte.js";

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Round-trip-safe number → string. Drops trailing zeros, caps to
 *  2 decimals (HyperFrames Studio's precision for time fields). */
function fmtNum(n) {
  return Number(n).toFixed(2).replace(/\.?0+$/, "") || "0";
}

/** Insert or replace `name="value"` inside an attribute string,
 *  preserving order. Quote style: double quotes (HTML default).
 *  Returns the new attribute string. */
function setAttr(attrBlock, name, value) {
  const re = new RegExp(`\\b${escapeRe(name)}\\s*=\\s*("[^"]*"|'[^']*')`);
  const replacement = `${name}="${value.replace(/"/g, "&quot;")}"`;
  if (re.test(attrBlock)) return attrBlock.replace(re, replacement);
  // Append; preserve any trailing whitespace before the closing >.
  return attrBlock.replace(/\s*$/, "") + " " + replacement;
}

// ─── Asset-aware data-URL redaction ──────────────────────────
//
// Embedding a 200KB base64 image into the composition is fine for
// the iframe but catastrophic for the LLM agent's context: a single
// get_composition call with a banner image asset blows past the
// provider's token limit. We redact `src="data:..."` to a stable
// `src="@hf-asset:<id>"` placeholder before the agent sees it,
// and expand the placeholder back to the real data URL when the
// agent submits replacement HTML.
//
// Redaction is keyed on the assets registry — only data URLs we
// can resolve to a known asset get a round-trippable placeholder.
// Anonymous data URLs (someone pasted one through the source
// modal, say) get a non-round-trippable redaction marker that
// makes set_composition refuse the round-trip rather than lose
// content silently.
const ASSET_PREFIX = "@hf-asset:";
const REDACTED_MARKER = "@hf-redacted-data-url:";
const SRC_ATTR_RE = /(\bsrc\s*=\s*)("([^"]+)"|'([^']+)')/gi;

/** Replace embedded data: URLs with `@hf-asset:<id>` (round-tripable
 *  when the URL matches a known asset) or `@hf-redacted-data-url:N`
 *  (not round-tripable — set_composition will reject it). */
export function redactDataUrlsForAgent(html) {
  if (!html || typeof html !== "string") return html;
  return html.replace(SRC_ATTR_RE, (m, prefix, _full, dq, sq) => {
    const url = dq ?? sq ?? "";
    if (!url.startsWith("data:")) return m;
    const a = assets.items.find((it) => it.dataUrl === url);
    if (a) return `${prefix}"${ASSET_PREFIX}${a.id}"`;
    return `${prefix}"${REDACTED_MARKER}${url.length}b"`;
  });
}

/** Reverse of redactDataUrlsForAgent. Throws if the input contains
 *  a non-roundtrippable redaction marker (the agent would silently
 *  lose data we never showed it). */
export function expandAssetPlaceholders(html) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(REDACTED_MARKER)) {
    throw new Error(
      "set_composition received HTML with @hf-redacted-data-url markers. " +
      "These represent data URLs that weren't shown to you (e.g. user-pasted " +
      "blobs). Use add_asset_clip to insert assets and patchClip / patch_clip " +
      "to retime instead of round-tripping the full HTML."
    );
  }
  return html.replace(SRC_ATTR_RE, (m, prefix, _full, dq, sq) => {
    const placeholder = dq ?? sq ?? "";
    if (!placeholder.startsWith(ASSET_PREFIX)) return m;
    const id = placeholder.slice(ASSET_PREFIX.length);
    const a = assets.items.find((it) => it.id === id);
    if (!a) return m; // unknown asset id — leave the placeholder so the user can debug
    return `${prefix}"${a.dataUrl}"`;
  });
}

function parseClips(html) {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    "text/html",
  );
  const out = [];
  for (const el of doc.querySelectorAll("[data-start]")) {
    const start = parseFloat(el.getAttribute("data-start"));
    // Live duration takes precedence; authored is the user-intent
    // fallback (e.g. a video may have set data-duration to its
    // natural length but the author intended longer).
    const liveDur = parseFloat(el.getAttribute("data-duration") ?? "");
    const authoredDur = parseFloat(el.getAttribute("data-hf-authored-duration") ?? "");
    const dur = Number.isFinite(liveDur) ? liveDur : (Number.isFinite(authoredDur) ? authoredDur : 0);
    if (!Number.isFinite(start) || !Number.isFinite(dur)) continue;
    const id = el.id || el.tagName.toLowerCase();
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    // HyperFrames-style explicit lane assignment. Either attribute is
    // accepted; data-track-index is the canonical name. NaN for
    // unindexed clips so the lane builder can pack them as fallback.
    const idxRaw = el.getAttribute("data-track-index") ?? el.getAttribute("data-track");
    const trackIndex = idxRaw == null ? NaN : parseInt(idxRaw, 10);
    // Capability hints needed by the timeline editor. canTrimStart
    // requires a media in-point — only video/audio clips, OR any
    // clip the author explicitly opted in via data-playback-start.
    const tagName = el.tagName.toLowerCase();
    const hasPlaybackStart = el.hasAttribute("data-playback-start");
    const isMedia = tagName === "video" || tagName === "audio";
    const playbackStart = parseFloat(el.getAttribute("data-playback-start") ?? "");
    // HyperFrames-style semantic metadata. label overrides
    // textContent for the timeline display; group lets several
    // clips render adjacent regardless of overlap; role colors
    // (caption/voiceover/b-roll/overlay) and priority sorts within
    // a group.
    const role     = el.getAttribute("data-timeline-role")     ?? "";
    const group    = el.getAttribute("data-timeline-group")    ?? "";
    const tlLabel  = el.getAttribute("data-timeline-label")    ?? "";
    const priorityRaw = el.getAttribute("data-timeline-priority");
    const priority = priorityRaw == null ? 0 : (parseFloat(priorityRaw) || 0);
    const label = tlLabel || (text ? text.slice(0, 60) : id);

    out.push({
      id,
      start,
      duration: dur,
      trackIndex: Number.isFinite(trackIndex) && trackIndex >= 0 ? trackIndex : NaN,
      tagName,
      label,
      role,
      group,
      priority,
      playbackStart: Number.isFinite(playbackStart) ? playbackStart : 0,
      caps: {
        canMove: true,
        canTrimEnd: true,
        canTrimStart: isMedia || hasPlaybackStart,
      },
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

class CompositionStore {
  // Source HTML the agent edits.
  html = $state(INITIAL_COMPOSITION);

  // Player state — driven by `tick` messages from the iframe runtime.
  curTime = $state(0);
  playing = $state(false);
  // Bumped on every set() so the iframe component knows to remount.
  revision = $state(0);

  // Hydration: awaits the Loro backend bootstrap, then pulls the
  // current "html" value out of the CRDT. Components bound to .html
  // re-render once the value lands. Resolves asynchronously without
  // blocking module initialization.
  hydrated = $state(false);

  constructor() {
    // main.js awaits bootstrapLoro() before mounting, so by the time
    // any component constructs this store, getDoc() is non-null.
    // Hydrate synchronously to avoid the microtask gap that would
    // otherwise let the first render see INITIAL_COMPOSITION before
    // the saved state lands.
    if (getDoc()) {
      const stored = readComposition();
      if (stored && stored.length > 0) {
        this.html = stored;
        this.revision += 1;
      }
      this.hydrated = true;
    } else {
      // Fallback for the rare case bootstrap didn't run before mount
      // (e.g. an alternate entry point that skips main.js's await).
      bootstrapLoro()
        .then(() => {
          const stored = readComposition();
          if (stored && stored.length > 0) {
            this.html = stored;
            this.revision += 1;
          }
          this.hydrated = true;
        })
        .catch((e) => {
          console.warn("composition: hydrate failed:", e?.message ?? e);
          this.hydrated = true;
        });
    }
  }

  /** Apply the current html as a Loro op + schedule snapshot save +
   *  record an audit-chain commit so the history primitive captures
   *  this edit. The commit is fire-and-forget; recordEdit catches its
   *  own errors so a history failure doesn't break the editor.
   *  An optional message overrides the default — used by revert to
   *  tag commits with their source ("revert to abc1234"). */
  _persist(auditMessage) {
    writeComposition(this.html);
    const msg = auditMessage ?? `composition save (${this.html.length} chars)`;
    recordEdit("composition", this.html, msg);
  }

  clips = $derived(parseClips(this.html));
  totalDuration = $derived.by(() => {
    let m = 0;
    for (const c of this.clips) m = Math.max(m, c.start + c.duration);
    return m;
  });

  /** Wraps the composition with the iframe's tick runtime.
   * NOTE: deliberately omits <head> / </head> from this string. The
   * workbook CLI's portable-asset injector pattern-matches the first
   * </head> in the built HTML, and a literal one inside a JS template
   * literal would get the 17 MB wasm bundle injected into our srcdoc.
   * Browsers parse a <body>-only srcdoc fine. Tracked as core-bii. */
  buildSrcdoc() {
    return `<!DOCTYPE html><html><body>${this.html}\n${IFRAME_RUNTIME}</body></html>`;
  }

  /** Replace the entire composition; the player remounts.
   *
   *  Options:
   *    auditMessage   override the default audit-chain message
   *    suppressAudit  true → don't record an audit commit at all
   *                   (used by cursor-only undo: the user is just
   *                   viewing a past state, not creating a new edit)
   *
   *  When suppressAudit is true, the Loro doc + IDB persist still
   *  happen — the visible state moves — but the Prolly chain stays
   *  put. A subsequent real edit picks up the cursor's position and
   *  truncates the redo space at commit time. */
  set(html, auditMessage, opts) {
    this.html = String(html ?? "");
    this.curTime = 0;
    this.playing = false;
    this.revision += 1;
    if (opts?.suppressAudit) {
      writeComposition(this.html);
    } else {
      this._persist(auditMessage);
    }
  }

  /** Patch a single clip's data-* attributes in place — fast local
   *  edit path that doesn't round-trip through the LLM.
   *
   *  patch keys: { start, duration, trackIndex, playbackStart }.
   *  Falsy / undefined keys are skipped (no attr churn).
   *  curTime is preserved (unlike set()) so trim/move don't jump
   *  the playhead back to 0.
   *
   *  Implementation parses the body's HTML, mutates one element,
   *  and serializes back. To stay byte-stable on the rest of the
   *  composition we use a regex tag rewrite instead of full DOM
   *  serialize-then-stringify (which would normalize whitespace,
   *  attribute order, and entity encoding). */
  /**
   * Bash-style atomic find-and-replace on the composition HTML.
   * Mirrors Claude Code's Edit tool semantics:
   *   - `oldString` MUST appear exactly once in the source unless
   *     `replaceAll` is true. Zero matches or ambiguous matches
   *     return an error tuple instead of throwing — the agent's
   *     edit_composition tool surfaces the error message.
   *   - `newString` may be empty (removes the match).
   *   - The whole HTML round-trips through writeComposition so
   *     diff-shrink Loro ops fire and the audit chain records.
   *
   * @param {string} oldString
   * @param {string} newString
   * @param {{ replaceAll?: boolean }} [opts]
   * @returns {{ ok: true, count: number } | { ok: false, error: string, count?: number }}
   */
  editHtml(oldString, newString, { replaceAll = false } = {}) {
    if (typeof oldString !== "string" || oldString.length === 0) {
      return { ok: false, error: "oldString must be a non-empty string" };
    }
    if (typeof newString !== "string") {
      return { ok: false, error: "newString must be a string" };
    }
    if (oldString === newString) {
      return { ok: false, error: "oldString and newString are identical — no edit to apply" };
    }
    const cur = this.html;
    // Count occurrences without regex (oldString can contain
    // arbitrary punctuation; regex-escaping every call is more
    // brittle than scanning).
    let count = 0;
    let from = 0;
    while (true) {
      const idx = cur.indexOf(oldString, from);
      if (idx < 0) break;
      count++;
      from = idx + oldString.length;
    }
    if (count === 0) {
      return { ok: false, error: "oldString not found in composition" };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        count,
        error:
          `oldString appears ${count} times — make it unique (add surrounding context) ` +
          `or pass replace_all=true to replace every occurrence.`,
      };
    }
    let next;
    if (replaceAll) {
      next = cur.split(oldString).join(newString);
    } else {
      const i = cur.indexOf(oldString);
      next = cur.slice(0, i) + newString + cur.slice(i + oldString.length);
    }
    this.set(next);
    return { ok: true, count: replaceAll ? count : 1 };
  }

  patchClip(id, patch) {
    if (!id || !patch || typeof DOMParser === "undefined") return false;
    // Extract the opening tag of the element with this id, edit its
    // attrs, splice it back. This preserves all other content byte-
    // for-byte (whitespace, casing, sibling order, inner HTML).
    const openTagRe = new RegExp(
      `<([a-zA-Z][a-zA-Z0-9-]*)\\b([^>]*\\bid\\s*=\\s*["']${escapeRe(id)}["'][^>]*)>`,
    );
    const m = openTagRe.exec(this.html);
    if (!m) return false;
    const [whole, tagName, attrBlock] = m;

    let attrs = attrBlock;
    if (Number.isFinite(patch.start))         attrs = setAttr(attrs, "data-start",          fmtNum(patch.start));
    if (Number.isFinite(patch.duration))      {
      const v = fmtNum(patch.duration);
      attrs = setAttr(attrs, "data-duration", v);
      // HyperFrames-style authored-vs-runtime split: a user edit IS
      // the authored intent, so mirror duration into the authored
      // attribute. The runtime may later override data-duration
      // (e.g. when a <video> reports a shorter natural duration);
      // data-hf-authored-duration preserves user intent regardless.
      attrs = setAttr(attrs, "data-hf-authored-duration", v);
    }
    if (Number.isFinite(patch.trackIndex))    attrs = setAttr(attrs, "data-track-index",    String(Math.max(0, Math.round(patch.trackIndex))));
    if (Number.isFinite(patch.playbackStart)) attrs = setAttr(attrs, "data-playback-start", fmtNum(patch.playbackStart));

    if (attrs === attrBlock) return false; // no-op

    const replaced = `<${tagName}${attrs}>`;
    this.html = this.html.slice(0, m.index) + replaced + this.html.slice(m.index + whole.length);
    this.revision += 1;
    this._persist();
    return true;
  }

  /** Remove a clip from the composition by element id. Walks the
   *  HTML, finds the matching element (any clip-shaped tag — img /
   *  video / audio / div / etc.), strips it. Returns true if the
   *  clip was found + removed.
   *
   *  Persistence + revision bump are handled by _persist; downstream
   *  ($effect on composition.html) re-renders the iframe and the
   *  timeline picks up the change via clipsFromHtml.
   */
  removeClipById(id) {
    if (!id || typeof id !== "string") return false;
    // Match a self-closing or paired element with this exact id.
    // Authored clips may use any tag; we look for `id="<id>"` then
    // walk back to the opening `<` and forward to the matching close.
    const idAttr = new RegExp(`\\bid="${escapeRe(id)}"`);
    const openMatch = idAttr.exec(this.html);
    if (!openMatch) return false;

    // Walk back to the opening `<`.
    let openStart = openMatch.index;
    while (openStart > 0 && this.html[openStart] !== "<") openStart--;
    if (this.html[openStart] !== "<") return false;

    // Find the tag name to determine close shape.
    const tagNameMatch = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(this.html.slice(openStart));
    if (!tagNameMatch) return false;
    const tagName = tagNameMatch[1].toLowerCase();

    // Locate the end of the opening `<...>` tag (skip past quoted attrs).
    let cursor = openStart + 1;
    let inQuote = null;
    while (cursor < this.html.length) {
      const ch = this.html[cursor];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else {
        if (ch === '"' || ch === "'") inQuote = ch;
        else if (ch === ">") break;
      }
      cursor++;
    }
    if (cursor >= this.html.length) return false;
    const openTagEnd = cursor + 1;

    // Self-closing? <img />, <br/>, etc., or void elements.
    const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link"]);
    const isSelfClosing = this.html[cursor - 1] === "/" || VOID_TAGS.has(tagName);

    let removeStart = openStart;
    let removeEnd;
    if (isSelfClosing) {
      removeEnd = openTagEnd;
    } else {
      // Find matching close tag, accounting for nested tags of the
      // same name. Most clips don't nest themselves, but the walker
      // is correct for the general case.
      const openRe = new RegExp(`<\\s*${tagName}\\b`, "gi");
      const closeRe = new RegExp(`</\\s*${tagName}\\s*>`, "gi");
      let depth = 1;
      let walker = openTagEnd;
      while (walker < this.html.length && depth > 0) {
        openRe.lastIndex = walker;
        closeRe.lastIndex = walker;
        const nextOpen = openRe.exec(this.html);
        const nextClose = closeRe.exec(this.html);
        if (!nextClose) break;
        if (nextOpen && nextOpen.index < nextClose.index) {
          depth++;
          walker = nextOpen.index + nextOpen[0].length;
        } else {
          depth--;
          walker = nextClose.index + nextClose[0].length;
          if (depth === 0) {
            removeEnd = walker;
            break;
          }
        }
      }
      if (removeEnd === undefined) return false;
    }

    // Eat any leading newline so the surgery doesn't leave a blank line.
    if (this.html[removeStart - 1] === "\n") removeStart--;
    this.html = this.html.slice(0, removeStart) + this.html.slice(removeEnd);
    this.revision += 1;
    this._persist();
    return true;
  }

  /** Append a media clip (image/video/audio) at the given start +
   *  track. src is typically a data: URL produced from a dropped
   *  File. Returns the new clip's id. */
  addMediaClip({ kind, src, start = 0, duration = 3, trackIndex = 0, label = "" } = {}) {
    if (kind !== "img" && kind !== "video" && kind !== "audio") return null;
    const id = `clip-${Math.random().toString(36).slice(2, 8)}`;
    const safeSrc = String(src ?? "").replace(/"/g, "&quot;");
    const safeLabel = String(label ?? "").replace(/"/g, "&quot;").replace(/[<>]/g, "");
    const startStr = fmtNum(start);
    const durStr = fmtNum(duration);
    const idx = String(Math.max(0, Math.round(trackIndex)));
    const tag = kind === "img" ? "img" : kind;
    // Render media full-frame by default. Author can restyle later.
    const styleAttr = kind === "img"
      ? ` style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;"`
      : ` style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;"${kind === "video" ? " muted playsinline" : ""}`;
    const labelAttr = safeLabel ? ` data-timeline-label="${safeLabel}"` : "";
    const el = `\n<${tag} id="${id}" class="scene" data-start="${startStr}" data-duration="${durStr}" data-track-index="${idx}" data-hf-authored-duration="${durStr}"${labelAttr} src="${safeSrc}"${styleAttr}></${tag}>`;
    this.html = this.html + el;
    this.revision += 1;
    this._persist();
    return id;
  }

  /** Standalone HTML the user can save / open / hand off — same
   *  shape as buildSrcdoc but with a meaningful title and viewport
   *  so it's a respectable artifact on its own. */
  exportHtml() {
    const title = `hyperframes · ${this.totalDuration.toFixed(1)}s · ${this.clips.length} clips`;
    return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;background:#000;">
<title>${title}</title>
${this.html}
${IFRAME_RUNTIME_AUTOPLAY}
</body>
</html>
`;
  }
}

export const composition = new CompositionStore();
