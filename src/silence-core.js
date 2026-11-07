"use strict";
// Reference implementation (see PLAN section 6.1). Pure: no Premiere, no Node APIs, no DOM.
const DEFAULTS = { threshold: 0.04, marginBefore: 0.2, marginAfter: 0.2, minCut: 0.2, minClip: 0.1 };

const toFrames = (sec, fps) => Math.round(sec * fps);   // same as auto-editor toTb: round(seconds * timebase)

/** Streaming peak-per-video-frame, same bucket arithmetic as auto-editor (fractional samples/frame with carried error). */
class PeakAccumulator {
  constructor(sampleRate, fps, channels) {
    if (!(sampleRate > 0) || !(fps > 0)) throw new Error("PeakAccumulator: bad sampleRate/fps");
    this.ch = channels > 0 ? channels : 1;               // samples arrive INTERLEAVED; the peak is taken over every channel (like auto-editor)
    this.exact = sampleRate / fps; this.err = 0; this.levels = []; this.peak = 0; this.count = 0; this.size = this._next();
  }
  _next() { const w = this.exact + this.err; const cur = Math.max(1, Math.round(w)); this.err = w - cur; return cur * this.ch; }
  /** samples: Int16Array of interleaved s16 samples (any chunking: buckets carry over between calls). */
  push(samples) {
    let peak = this.peak, count = this.count, size = this.size;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], v = s < 0 ? -s : s;
      if (v > peak) peak = v;
      if (++count >= size) { this.levels.push(Math.min(peak, 32767) / 32767); peak = 0; count = 0; size = this._next(); }
    }
    this.peak = peak; this.count = count; this.size = size;
  }
  /** Flushes a partial last bucket (auto-editor also emits it). Returns the levels array (one value per video frame). */
  finish() { if (this.count > 0) { this.levels.push(Math.min(this.peak, 32767) / 32767); this.count = 0; this.peak = 0; } return this.levels; }
}

const levelsToMask = (levels, threshold) => levels.map((v) => v >= threshold);

function applyMargin(arr, startM, endM) {            // in place; frames; negative values shrink (as auto-editor)
  const starts = [], ends = [], n = arr.length;
  for (let j = 1; j < n; j++) if (arr[j] !== arr[j - 1]) (arr[j] ? starts : ends).push(j);
  if (startM > 0) for (const i of starts) for (let k = Math.max(i - startM, 0); k < i; k++) arr[k] = true;
  if (startM < 0) for (const i of starts) for (let k = i; k < Math.min(i - startM, n); k++) arr[k] = false;
  if (endM > 0) for (const i of ends) for (let k = i; k < Math.min(i + endM, n); k++) arr[k] = true;
  if (endM < 0) for (const i of ends) for (let k = Math.max(i + endM, 0); k < i; k++) arr[k] = false;
  return arr;
}

const same = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
function applySmoothing(val, mincut, minclip) {      // returns a NEW array; exact port of editutil.smoothing (incl. the 2-state loop guard)
  let prev = null, prev2 = null;
  while (!same(prev, val) && !same(prev2, val)) {
    prev2 = prev; prev = val.slice(); const next = prev.slice(), n = prev.length;
    let startP = 0, active = false;
    for (let j = 0; j < n; j++) {
      if (prev[j] === true) {
        if (!active) { startP = j; active = true; }
        if (j === n - 1 && j - startP + 1 < minclip) for (let i = startP; i < n; i++) next[i] = false;
      } else if (active) { if (j - startP < minclip) for (let i = startP; i < j; i++) next[i] = false; active = false; }
    }
    startP = 0; active = false;
    for (let j = 0; j < n; j++) {
      if (prev[j] === false) {
        if (!active) { startP = j; active = true; }
        if (j === n - 1 && j - startP + 1 < mincut) for (let i = startP; i < n; i++) next[i] = true;
      } else if (active) { if (j - startP < mincut) for (let i = startP; i < j; i++) next[i] = true; active = false; }
    }
    val = next;
  }
  return val;
}

/** Boolean mask -> [{start, end, keep}] in FRAMES (end exclusive). */
function chunkify(arr) {
  if (!arr.length) return [];
  const out = []; let s = 0;
  for (let j = 1; j < arr.length; j++) if (arr[j] !== arr[j - 1]) { out.push({ start: s, end: j, keep: arr[j - 1] }); s = j; }
  out.push({ start: s, end: arr.length, keep: arr[arr.length - 1] });
  return out;
}

/** levels -> keep ranges in SOURCE SECONDS: the full pipeline threshold -> margin -> smoothing -> chunkify. */
function analyze(levels, fps, params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const mask = levelsToMask(levels, p.threshold);
  applyMargin(mask, toFrames(p.marginBefore, fps), toFrames(p.marginAfter, fps));
  const out = applySmoothing(mask, toFrames(p.minCut, fps), toFrames(p.minClip, fps));
  const chunks = chunkify(out), ranges = [];
  let keepFrames = 0;
  for (const c of chunks) if (c.keep) { ranges.push({ start: c.start / fps, end: c.end / fps }); keepFrames += c.end - c.start; }
  return { mask: out, chunks, ranges, stats: { frames: out.length, keepFrames, cutFrames: out.length - keepFrames, silences: chunks.filter((c) => !c.keep).length } };
}
/** keep ranges (source seconds) -> an object that markers-core.parseMarkersFile() accepts: every LOUD range is a "clip" marker. */
function buildSilenceFile(ranges, meta) {
  return {
    format: "luckytwitch-markers", version: 1, name: meta.name, fps: meta.fps, duration: meta.duration,
    part: { start: 0, end: meta.duration }, source: { tool: "luckytwitch-silence", analyzer: meta.analyzer, params: meta.params, media: meta.media },
    markers: ranges.map((r, i) => ({ kind: "clip", name: "Speech " + (i + 1), start: r.start, end: r.end, views: 0, comment: "" })),
  };
}
/** The three presets of the UI (SILENCE_CUT_PLAN.md Appendix D). Every preset sets every analysis field. Balanced is the default for VODs. */
const PRESETS = {
  Tight: { threshold: 0.04, marginBefore: 0.2, marginAfter: 0.2, minCut: 0.2, minClip: 0.1 },       // auto-editor defaults
  Balanced: { threshold: 0.04, marginBefore: 0.25, marginAfter: 0.25, minCut: 0.6, minClip: 0.1 },
  Chunky: { threshold: 0.04, marginBefore: 0.3, marginAfter: 0.3, minCut: 1.5, minClip: 0.2 },
};

/** Peak level (0..1) <-> dB, for the UI hint next to the threshold (0.04 -> -27.96 dB). A level of 0 or less is -Infinity dB. */
const thresholdToDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const dbToThreshold = (db) => Math.pow(10, db / 20);

/**
 * Small deterministic hash of a plain object (8 hex digits), used to tell whether a plan was made with the current settings.
 * Keys are sorted at every level so the order they were written in does not matter. FNV-1a, 32 bit: no `crypto`, this file stays pure.
 * It is a change detector, not a security feature.
 */
function hashParams(obj) {
  const canon = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  };
  const s = canon(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ("00000000" + h.toString(16)).slice(-8);
}

// ---- ffmpeg -i parsing ------------------------------------------------------------------------------------------------------
const LAYOUT_CHANNELS = { mono: 1, stereo: 2, downmix: 2, quad: 4, hexagonal: 6, octagonal: 8 };
function channelsOf(layout) {
  const l = String(layout || "").trim().toLowerCase();
  if (l in LAYOUT_CHANNELS) return LAYOUT_CHANNELS[l];
  let m = /^(\d+) channels?\b/.exec(l);              // "2 channels" (a layout ffmpeg has no name for)
  if (m) return Number(m[1]);
  m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(l);            // "5.1", "5.1(side)", "7.1", "2.1", "5.1.2"
  if (m) return Number(m[1]) + Number(m[2]) + Number(m[3] || 0);
  return null;
}

/**
 * Text that `ffmpeg -i <file>` prints on stderr -> {duration, containerStart, audioStreams}. Pure; never throws (empty or unrelated text
 * gives duration null and no streams). Only the first input (#0) is read.
 *  - duration: seconds, or null ("N/A" or missing).
 *  - containerStart: the "start:" of the Duration line, in seconds (can be negative), or null. It is the START OF THE CONTAINER. `ffmpeg -i` does
 *    NOT print each stream's own start time (verified: a file whose audio starts 0.228 s late still prints "start: 0.000000"), so the audio
 *    stream's offset cannot be read from this text. See SILENCE_CUT_PLAN.md, "Findings while implementing".
 *  - audioStreams: [{index, rate, channels, title}] in file order. `index` is the position among the AUDIO streams, i.e. the k of
 *    `-map 0:a:k`, not the absolute stream number. rate/channels are null when ffmpeg prints something this parser does not know; title is "" if none.
 */
function parseFfmpegInfo(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const info = { duration: null, containerStart: null, audioStreams: [] };
  let inInput = false, seenInput = false, last = null, inMeta = false;
  for (const line of lines) {
    if (/^Input #\d+,/.test(line)) { if (seenInput) break; seenInput = true; inInput = true; continue; }
    if (!inInput) continue;
    const d = /^\s*Duration:\s*(?:(\d+):(\d+):(\d+(?:\.\d+)?)|N\/A)\s*(?:,\s*start:\s*(-?\d+(?:\.\d+)?))?/.exec(line);
    if (d) {
      if (d[1] !== undefined) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
      if (d[4] !== undefined) info.containerStart = Number(d[4]);
      continue;
    }
    const st = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(\w+):\s*(.*)$/.exec(line);
    if (st) {
      last = null; inMeta = false;
      if (st[1] === "Audio") {
        const parts = st[2].split(",").map((x) => x.trim());
        const rate = /^(\d+) Hz$/.exec(parts[1] || "");
        last = { index: info.audioStreams.length, rate: rate ? Number(rate[1]) : null, channels: channelsOf(parts[2]), title: "" };
        info.audioStreams.push(last);
      }
      continue;
    }
    if (/^\s*Metadata:\s*$/.test(line)) { inMeta = !!last; continue; }
    const t = /^\s+title\s*:\s*(.*)$/.exec(line);
    if (t && last && inMeta && !last.title) last.title = t[1].trim();
  }
  return info;
}

// ---- ffprobe stream start times (P0-3) ----------------------------------------------------------------------------------------
/**
 * Text of `ffprobe -v error -show_entries stream=index,codec_type,start_time -of csv=p=0 <file>` -> {videoStart, audioStarts}.
 * Lines look like "0,video,0.000000", "1,audio,0.006000", "2,data,0.000000" (checked on 5 real Twitch VODs and 2 OBS recordings).
 *  - videoStart: start_time of the FIRST video stream in seconds, or null (no video stream, or "N/A").
 *  - audioStarts: one number-or-null per audio stream, in file order, so audioStarts[k] belongs to `-map 0:a:k` and to
 *    parseFfmpegInfo(...).audioStreams[k].
 * Pure; never throws (empty or unrelated text gives {videoStart: null, audioStarts: []}).
 */
function parseFfprobeStarts(text) {
  const out = { videoStart: null, audioStarts: [] };
  const num = (v) => { const n = Number(String(v).trim()); return String(v).trim() !== "" && isFinite(n) ? n : null; };
  let seenVideo = false;
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const f = line.split(",");
    if (f.length < 3) continue;
    const kind = f[1].trim();
    if (kind === "video" && !seenVideo) { seenVideo = true; out.videoStart = num(f[2]); }
    else if (kind === "audio") out.audioStarts.push(num(f[2]));
  }
  return out;
}

/**
 * Seconds to ADD to every range that analyze() produced for one audio stream, so the ranges are on the video's clock.
 * The decoded PCM (`ffmpeg ... -vn -f s16le -`) starts at the stream's first sample and is NOT padded with silence for a late start
 * (verified: audio starting 0.478 s late decodes to exactly its own length), so level bucket i sits at audioStart - videoStart + i/fps.
 * A missing start time counts as 0. The shift is 0 unless it is at least half a frame: smaller offsets cannot move a cut (D4).
 * UNVERIFIED in Premiere: that Premiere's time zero is the video's first frame. For OBS-style files (video 0, audio late) every origin
 * agrees; for the 1-2 frame video offsets seen on some Twitch VODs the two possible origins differ by at most 2 frames.
 */
function audioShift(videoStart, audioStart, fps) {
  const a = typeof audioStart === "number" && isFinite(audioStart) ? audioStart : 0;
  const v = typeof videoStart === "number" && isFinite(videoStart) ? videoStart : 0;
  const off = a - v, half = fps > 0 ? 0.5 / fps : 0.001;
  return Math.abs(off) >= half ? off : 0;
}

// ---- run-time estimate and summary --------------------------------------------------------------------------------------------
/**
 * Rough seconds for a cut + delete + relink run: the same model as runner.js planTodo() (fitted to real runs of 169-199 cuts, so beyond
 * that it is an EXTRAPOLATION until P0-2 measures it). Razor time grows with the square of the cut count; a fixed 4 s is the final check.
 * Returns {total, cuts, deletes, relink, final}.
 */
function estimateRunSeconds(cuts, gaps, keeps) {
  if (!(cuts > 0)) return { total: 0, cuts: 0, deletes: 0, relink: 0, final: 0 };
  const c = 4 + 15.7 * Math.pow(cuts / 199, 2), d = 3 + 0.165 * Math.max(0, gaps), l = 3 + 0.168 * Math.max(0, keeps);
  return { total: c + d + l + 4, cuts: c, deletes: d, relink: l, final: 4 };
}

/**
 * keep ranges (source seconds) -> the numbers the panel shows before anything is touched.
 * ranges: [{start, end}] sorted, as analyze() returns; durationSec: length of the media; fps: the grid the cuts snap to.
 * planCounts (optional, from the real planner: {cuts, deleteCount, keepCount}) wins over the counts derived here from the ranges.
 * Returns {speechSec, silenceSec, removedPct, silences, cuts, keeps, estSeconds, est}. Never throws; empty ranges mean "all silence".
 * A boundary within half a frame of the start or end of the media is not a cut (the planner ignores it too).
 */
function summarize(ranges, durationSec, fps, planCounts) {
  const dur = durationSec > 0 ? durationSec : 0, half = fps > 0 ? 0.5 / fps : 0.001;
  const rs = (ranges || []).map((r) => ({ start: Math.max(0, r.start), end: Math.min(dur, r.end) })).filter((r) => r.end > r.start);
  let speech = 0;
  for (const r of rs) speech += r.end - r.start;
  const silence = Math.max(0, dur - speech);
  let silences = 0, cuts = 0;
  const edgeStart = (t) => t > half, edgeEnd = (t) => t < dur - half;
  if (rs.length === 0) { silences = dur > 0 ? 1 : 0; }
  else {
    if (edgeStart(rs[0].start)) { silences++; cuts++; }
    for (let i = 1; i < rs.length; i++) {
      if (rs[i].start - rs[i - 1].end > half) { silences++; cuts += 2; }
      else cuts += 0;                                  // touching ranges: no gap, no cut between them
    }
    if (edgeEnd(rs[rs.length - 1].end)) { silences++; cuts++; }
  }
  let keeps = rs.length;
  if (planCounts) {
    if (planCounts.cuts >= 0) cuts = planCounts.cuts;
    if (planCounts.deleteCount >= 0) silences = planCounts.deleteCount;
    if (planCounts.keepCount >= 0) keeps = planCounts.keepCount;
  }
  const est = estimateRunSeconds(cuts, silences, keeps);
  return { speechSec: speech, silenceSec: silence, removedPct: dur > 0 ? (100 * silence) / dur : 0, silences, cuts, keeps, estSeconds: est.total, est };
}

const LT_SILENCE_API = { buildSilenceFile, DEFAULTS, PRESETS, toFrames, PeakAccumulator, levelsToMask, applyMargin, applySmoothing, chunkify, analyze, thresholdToDb, dbToThreshold, hashParams, parseFfmpegInfo, parseFfprobeStarts, audioShift, estimateRunSeconds, summarize };
if (typeof module !== "undefined" && module.exports) module.exports = LT_SILENCE_API;
if (typeof window !== "undefined") window.LTSilence = LT_SILENCE_API;
