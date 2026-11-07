"use strict";
/*
 * Pure logic of the plugin: read a .markers.json, check it, and turn it into the list of markers to create
 * (name, comment, time, duration, color). It knows nothing about Premiere, so it is tested with plain Node
 * (npm test) against tests/fixtures/markers_sample.json, which the Python app's tests keep in sync.
 */

const FORMAT = "luckytwitch-markers";
const SUPPORTED_FORMATS = ["luckytwitch-markers", "luckydownloader-markers"];
const SUPPORTED_VERSION = 1; // the file version this plugin understands (MARKERS_JSON_VERSION in the app)

// Premiere's marker color presets, in the order of its "Marker color" menu.
// The index is what the API takes. Use Diagnostics > "Add test markers" to confirm the order on your build.
const COLORS = [
  { index: 0, name: "Green" },
  { index: 1, name: "Red" },
  { index: 2, name: "Purple" },
  { index: 3, name: "Orange" },
  { index: 4, name: "Yellow" },
  { index: 5, name: "White" },
  { index: 6, name: "Blue" },
  { index: 7, name: "Cyan" },
];
const GREEN = 0, RED = 1, ORANGE = 3, YELLOW = 4, BLUE = 6;

const DEFAULT_RECIPES = [
  {
    name: "Default",
    padBefore: 0,
    padAfter: 0,
    mergeGap: 0,
    recipeCutClips: true,
    recipeCutChapters: false,
    recipeMarkers: true,
    recipeDeleteGaps: false,
    maxDeletePct: 99,
    minKeepPieces: 1,
  },
  {
    name: "Safety (5s)",
    padBefore: 5,
    padAfter: 5,
    mergeGap: 2,
    recipeCutClips: true,
    recipeCutChapters: false,
    recipeMarkers: true,
    recipeDeleteGaps: false,
    maxDeletePct: 99,
    minKeepPieces: 1,
  },
  {
    name: "Tight Cut & Delete",
    padBefore: 1,
    padAfter: 1,
    mergeGap: 0,
    recipeCutClips: true,
    recipeCutChapters: false,
    recipeMarkers: true,
    recipeDeleteGaps: true,
    maxDeletePct: 95,
    minKeepPieces: 1,
  },
];

const DEFAULT_SETTINGS = {
  importGames: true,
  importClips: true,
  importMuted: true,
  gameColor: BLUE,
  mutedColor: RED,
  colorByViews: true, // clips take the color of their view tier; off = all clips use clipColor
  clipColor: YELLOW,
  lowColor: YELLOW, // fewer views than midViews
  midColor: ORANGE, // midViews or more
  highColor: RED, // highViews or more
  midViews: 10,
  highViews: 50,
  minViews: 0, // clips with fewer views are skipped
  gamePrefix: false, // name game markers "GAME: <game>" like the XML does
  placement: "clip", // "clip" = markers on the clip's source (they follow your cuts), "sequence" = fixed times on the timeline (mapped through the clip that plays each marker)
  padBefore: 0, // seconds kept before each clip when cutting (clips that touch or overlap after padding are merged)
  padAfter: 0, // seconds kept after each clip when cutting
  mergeGap: 0, // clips closer together than this many seconds are treated as one when cutting
  backup: true, // duplicate the sequence before cutting
  recipeMarkers: true, // "Do it all": add the markers
  recipeCutClips: true, // "Do it all": cut at the start and end of every clip
  recipeCutChapters: false, // "Do it all": cut at every game / category change
  minClips: 1, // pre-flight: at least this many clips of the file must fall inside what the timeline plays
  autoRun: false, // opt-in: run the recipe by itself, once, when a markers file is found
  recipeDeleteGaps: false, // "Do it all": ripple-delete the pieces between the clips, as the LAST step (the confirmation comes before the run starts)
  maxDeletePct: 99, // refuse to delete more than this percent of the timeline's length (a real VOD keeps only ~10%, so the default is high)
  minKeepPieces: 1, // refuse unless at least this many pieces would be kept
  limitChapter: null,
  recipes: DEFAULT_RECIPES,
  activeRecipe: "Default",
};

class MarkersFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarkersFileError";
  }
}

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** Text of a .markers.json -> checked file object. Throws MarkersFileError with a message fit for the panel. */
function parseMarkersFile(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new MarkersFileError("That file is not valid JSON. Pick the .markers.json that LuckyTwitch wrote next to the video.");
  }
  if (!data || typeof data !== "object" || !SUPPORTED_FORMATS.includes(data.format)) {
    throw new MarkersFileError("That is not a LuckyTwitch markers file. Pick the .markers.json written next to the video (not the .markers.xml or .clips.json).");
  }
  if (!isNum(data.version) || data.version < 1) {
    throw new MarkersFileError("The markers file has no valid version number.");
  }
  if (data.version > SUPPORTED_VERSION) {
    throw new MarkersFileError(
      `This markers file is version ${data.version}, newer than this plugin understands (version ${SUPPORTED_VERSION}). Update the plugin to the one that comes with your LuckyTwitch Downloader.`
    );
  }
  if (!Array.isArray(data.markers)) {
    throw new MarkersFileError("The markers file has no \"markers\" list.");
  }
  const markers = [];
  let skipped = 0;
  for (const m of data.markers) {
    const ok = m && (m.kind === "game" || m.kind === "clip" || m.kind === "muted") && isNum(m.start) && isNum(m.end) && m.start >= 0;
    if (!ok) {
      skipped++;
      continue;
    }
    markers.push({
      kind: m.kind,
      name: String(m.name ?? ""),
      start: m.start,
      end: m.end,
      comment: typeof m.comment === "string" ? m.comment : "",
      views: isNum(m.views) ? m.views : 0,
      game: typeof m.game === "string" ? m.game : null,
      clips: Array.isArray(m.clips) ? m.clips : [],
    });
  }
  const preferences = data.preferences && typeof data.preferences === "object" ? {
    padBefore: isNum(data.preferences.pad_before) ? data.preferences.pad_before : (isNum(data.preferences.padBefore) ? data.preferences.padBefore : undefined),
    padAfter: isNum(data.preferences.pad_after) ? data.preferences.pad_after : (isNum(data.preferences.padAfter) ? data.preferences.padAfter : undefined),
    maxDeletePct: isNum(data.preferences.max_delete_pct) ? data.preferences.max_delete_pct : (isNum(data.preferences.maxDeletePct) ? data.preferences.maxDeletePct : undefined),
  } : null;
  return {
    version: data.version,
    name: typeof data.name === "string" ? data.name : "",
    fps: isNum(data.fps) ? data.fps : null,
    duration: isNum(data.duration) ? data.duration : null,
    part: data.part && isNum(data.part.start) ? data.part : null,
    source: data.source && typeof data.source === "object" ? data.source : null,
    preferences,
    markers,
    skipped,
  };
}

const colorIndex = (v, fallback) => (Number.isInteger(v) && v >= 0 && v < COLORS.length ? v : fallback);
const count = (v, fallback) => (isNum(Number(v)) && Number(v) >= 0 && v !== "" && v !== null ? Number(v) : fallback);

/** Whatever was stored / typed -> a complete, valid settings object. */
function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    importGames: r.importGames === undefined ? d.importGames : !!r.importGames,
    importClips: r.importClips === undefined ? d.importClips : !!r.importClips,
    gameColor: colorIndex(r.gameColor, d.gameColor),
    colorByViews: r.colorByViews === undefined ? d.colorByViews : !!r.colorByViews,
    clipColor: colorIndex(r.clipColor, d.clipColor),
    lowColor: colorIndex(r.lowColor, d.lowColor),
    midColor: colorIndex(r.midColor, d.midColor),
    highColor: colorIndex(r.highColor, d.highColor),
    midViews: count(r.midViews, d.midViews),
    highViews: count(r.highViews, d.highViews),
    minViews: count(r.minViews, d.minViews),
    gamePrefix: r.gamePrefix === undefined ? d.gamePrefix : !!r.gamePrefix,
    placement: r.placement === "sequence" ? "sequence" : "clip",
    padBefore: count(r.padBefore, d.padBefore),
    padAfter: count(r.padAfter, d.padAfter),
    mergeGap: count(r.mergeGap, d.mergeGap),
    backup: r.backup === undefined ? d.backup : !!r.backup,
    recipeMarkers: r.recipeMarkers === undefined ? d.recipeMarkers : !!r.recipeMarkers,
    recipeCutClips: r.recipeCutClips === undefined ? d.recipeCutClips : !!r.recipeCutClips,
    recipeCutChapters: r.recipeCutChapters === undefined ? d.recipeCutChapters : !!r.recipeCutChapters,
    minClips: Math.floor(count(r.minClips, d.minClips)),
    autoRun: r.autoRun === undefined ? d.autoRun : !!r.autoRun,
    recipeDeleteGaps: r.recipeDeleteGaps === undefined ? d.recipeDeleteGaps : !!r.recipeDeleteGaps,
    maxDeletePct: Math.min(100, Math.max(1, count(r.maxDeletePct, d.maxDeletePct))),
    minKeepPieces: Math.max(1, Math.floor(count(r.minKeepPieces, d.minKeepPieces))),
    importMuted: r.importMuted === undefined ? d.importMuted : !!r.importMuted,
    mutedColor: colorIndex(r.mutedColor, d.mutedColor),
    limitChapter: r.limitChapter !== undefined && r.limitChapter !== null && r.limitChapter !== "" ? Number(r.limitChapter) : null,
    recipes: Array.isArray(r.recipes) && r.recipes.length > 0 ? r.recipes : d.recipes,
    activeRecipe: typeof r.activeRecipe === "string" ? r.activeRecipe : d.activeRecipe,
  };
}

function applyPreferences(settings, preferences) {
  if (!preferences || typeof preferences !== "object") return normalizeSettings(settings);
  const cur = normalizeSettings(settings);
  const padBefore = preferences.padBefore !== undefined ? preferences.padBefore : (preferences.pad_before !== undefined ? preferences.pad_before : cur.padBefore);
  const padAfter = preferences.padAfter !== undefined ? preferences.padAfter : (preferences.pad_after !== undefined ? preferences.pad_after : cur.padAfter);
  const maxDeletePct = preferences.maxDeletePct !== undefined ? preferences.maxDeletePct : (preferences.max_delete_pct !== undefined ? preferences.max_delete_pct : cur.maxDeletePct);
  return normalizeSettings(Object.assign({}, cur, { padBefore, padAfter, maxDeletePct }));
}

function applyRecipe(settings, recipe) {
  if (!recipe || typeof recipe !== "object") return normalizeSettings(settings);
  const cur = normalizeSettings(settings);
  const merged = Object.assign({}, cur);
  for (const k of ["padBefore", "padAfter", "mergeGap", "recipeCutClips", "recipeCutChapters", "recipeMarkers", "recipeDeleteGaps", "maxDeletePct", "minKeepPieces"]) {
    if (recipe[k] !== undefined) merged[k] = recipe[k];
  }
  if (recipe.name) merged.activeRecipe = String(recipe.name);
  return normalizeSettings(merged);
}

function colorForClip(views, s) {
  if (!s.colorByViews) return s.clipColor;
  if (views >= s.highViews) return s.highColor;
  if (views >= s.midViews) return s.midColor;
  return s.lowColor;
}

/**
 * File + settings -> what to create. `baseSeconds` is where the start of the part lands in the sequence
 * (0, or the playhead). Times are seconds; a marker with no length (end <= start) gets duration 0.
 */
function planMarkers(file, rawSettings, baseSeconds = 0) {
  const s = normalizeSettings(rawSettings);
  const items = [];
  const counts = { games: 0, clips: 0, hidden: 0 };
  for (const m of file.markers) {
    if (m.kind === "muted") {
      if (!s.importMuted) {
        counts.hidden++;
        continue;
      }
      counts.muted = (counts.muted || 0) + 1;
      items.push({
        kind: "muted",
        name: m.name || "Muted audio",
        comment: m.comment || "",
        start: baseSeconds + m.start,
        duration: Math.max(0, m.end - m.start),
        color: s.mutedColor,
      });
      continue;
    }
    if (m.kind === "game") {
      if (!s.importGames) {
        counts.hidden++;
        continue;
      }
      counts.games++;
      items.push({
        kind: "game",
        name: s.gamePrefix ? `GAME: ${m.name}` : m.name,
        comment: m.comment,
        start: baseSeconds + m.start,
        duration: Math.max(0, m.end - m.start),
        color: s.gameColor,
      });
    } else {
      if (!s.importClips || m.views < s.minViews) {
        counts.hidden++;
        continue;
      }
      counts.clips++;
      items.push({
        kind: "clip",
        name: m.name,
        comment: m.comment,
        start: baseSeconds + m.start,
        duration: Math.max(0, m.end - m.start),
        color: colorForClip(m.views, s),
      });
    }
  }
  items.sort((a, b) => a.start - b.start || (a.kind === b.kind ? 0 : a.kind === "game" ? -1 : 1));
  return { items, counts };
}

function formatTime(seconds) {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function colorName(index) {
  const c = COLORS.find((x) => x.index === index);
  return c ? c.name : `#${index}`;
}

/** One line that tells what the (collapsed) settings are, so nobody has to open them to know. */
function summarizeSettings(raw) {
  const s = normalizeSettings(raw);
  const parts = [];
  parts.push(s.importGames ? `Games ${colorName(s.gameColor)}` : "No games");
  if (!s.importClips) parts.push("no clips");
  else {
    parts.push(s.colorByViews ? `Clips by views (${colorName(s.lowColor)}/${colorName(s.midColor)}/${colorName(s.highColor)})` : `Clips ${colorName(s.clipColor)}`);
    if (s.minViews > 0) parts.push(`min ${s.minViews} views`);
  }
  parts.push(s.placement === "clip" ? "on the clip" : "on the sequence");
  if (s.padBefore > 0 || s.padAfter > 0) parts.push(`pad ${s.padBefore}s/${s.padAfter}s`);
  if (s.mergeGap > 0) parts.push(`merge < ${s.mergeGap}s`);
  return parts.join(" · ");
}

// ---- finding the markers file by itself -------------------------------------------------------------------
const MARKERS_SUFFIX = ".markers.json";

/** "E:\\a\\b\\video.mp4" or "/a/b/video.mp4" -> "video.mp4" */
function baseName(path) {
  const s = String(path || "");
  return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1);
}

/** "E:\\a\\b\\video.mp4" -> "E:\\a\\b" (no trailing slash; "" when there is no folder part) */
function dirName(path) {
  const s = String(path || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? "" : s.slice(0, i);
}

function stripExtension(name) {
  const i = String(name).lastIndexOf(".");
  return i > 0 ? String(name).slice(0, i) : String(name);
}

/** The ways a folder path can be written for UXP's getEntryWithUrl, most likely first (file:/ + percent-encoding handles "Ú", spaces...). */
function fileUrlForms(path) {
  const s = String(path || "");
  if (!s) return [];
  const forward = s.replace(/\\/g, "/");
  const encoded = forward
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  const rooted = encoded.startsWith("/") ? encoded : "/" + encoded; // "/E:/..." or "/Users/..."
  return Array.from(new Set(["file:" + rooted, "file://" + rooted, s]));
}

/**
 * Which of a folder's file names is the markers file for this video?
 * Returns {name, how} or null. With a video name it prefers "<video>.markers.json", then a name that starts like it;
 * a lone .markers.json in the folder is accepted last (the panel shows which file it took, so a wrong guess is visible).
 */
function pickMarkersFile(names, mediaFileName) {
  const lower = (x) => String(x).toLowerCase();
  const cands = (names || []).filter((n) => lower(n).endsWith(MARKERS_SUFFIX));
  if (!cands.length) return null;
  if (mediaFileName) {
    const stem = lower(stripExtension(baseName(mediaFileName)));
    const exact = cands.find((n) => lower(n) === stem + MARKERS_SUFFIX);
    if (exact) return { name: exact, how: "same name as the video" };
    const starts = cands.filter((n) => lower(n).startsWith(stem)).sort((a, b) => a.length - b.length);
    if (starts.length) return { name: starts[0], how: "name starts like the video's" };
    const inside = cands.filter((n) => {
      const st = lower(n.slice(0, -MARKERS_SUFFIX.length));
      return st.length > 3 && stem.startsWith(st);
    });
    if (inside.length === 1) return { name: inside[0], how: "the video's name starts like the file's" };
  }
  if (cands.length === 1) return { name: cands[0], how: "the only one in the folder" };
  return null;
}

// ---- cut planning (used by the dry-run probe now, and by the cutting feature later) -----------------------
/**
 * Marker items -> the stretches of SOURCE time to keep/cut around, as [{start, end, names}] (seconds).
 * Overlapping (or `mergeGap`-close) stretches are merged so no point is cut twice. Items with no length are
 * counted in `noLength` and left out (there is no "out" to cut at).
 * opts: kinds (default ["clip"]), padBefore, padAfter, mergeGap, min, max (clamp to the media).
 */
function planCuts(items, opts) {
  const o = Object.assign({ kinds: ["clip"], padBefore: 0, padAfter: 0, mergeGap: 0, min: 0, max: Infinity }, opts || {});
  const wanted = (items || []).filter((i) => o.kinds.includes(i.kind));
  const noLength = wanted.filter((i) => !(i.duration > 0)).length;
  const raw = wanted
    .filter((i) => i.duration > 0)
    .map((i) => ({ start: Math.max(o.min, i.start - o.padBefore), end: Math.min(o.max, i.start + i.duration + o.padAfter), names: [i.name] }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const r of raw) {
    const last = ranges[ranges.length - 1];
    if (last && r.start <= last.end + o.mergeGap + 0.001) {
      last.end = Math.max(last.end, r.end);
      last.names.push(...r.names);
    } else ranges.push({ start: r.start, end: r.end, names: r.names.slice() });
  }
  return { ranges, merged: raw.length - ranges.length, noLength };
}

/**
 * Source-time stretches -> where they fall on the timeline for one clip
 * clip = {start, end (timeline s), inPoint, outPoint (source s), speed}. Stretches are trimmed to what the clip plays.
 */
function cutsForClip(ranges, clip) {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const out = [];
  for (const r of ranges) {
    const s = Math.max(r.start, clip.inPoint);
    const e = Math.min(r.end, clip.outPoint);
    if (!(e > s)) continue;
    out.push({
      srcStart: s,
      srcEnd: e,
      tlStart: clip.start + (s - clip.inPoint) / speed,
      tlEnd: clip.start + (e - clip.inPoint) / speed,
      names: r.names,
    });
  }
  return out;
}

/** The distinct timeline times where a razor would have to cut (the clip's own two ends are not cuts). */
function cutPoints(cuts, clip) {
  const eps = 0.0005;
  const pts = [];
  for (const c of cuts) for (const t of [c.tlStart, c.tlEnd]) if (t > clip.start + eps && t < clip.end - eps) pts.push(t);
  return Array.from(new Set(pts.map((t) => Math.round(t * 1000) / 1000))).sort((a, b) => a - b);
}


// ---- the cut set: clips and/or chapters -> source-time cut points -> timeline times, for any number of timeline clips ----
/**
 * Marker items -> everything a cut run needs, in SOURCE seconds (seconds into the video file, which is what the markers file uses).
 * opts: clips (default true), chapters (default false), padBefore, padAfter, mergeGap, min, max.
 * - ranges: the stretches to keep from the clip markers (padded; touching / overlapping / mergeGap-close ones merged, so two clips next
 *   to each other get no padding between them and no cut between them).
 * - chapters: the game / category markers that have a length. They are NOT merged, because their boundaries are what we cut at.
 * - points: every distinct source time a razor would cut at (ranges' ends + chapter boundaries), sorted.
 */
function planCutSet(items, opts) {
  const o = Object.assign({ clips: true, chapters: false, padBefore: 0, padAfter: 0, mergeGap: 0, min: 0, max: Infinity }, opts || {});
  const clipPlan = o.clips
    ? planCuts(items, { kinds: ["clip"], padBefore: o.padBefore, padAfter: o.padAfter, mergeGap: o.mergeGap, min: o.min, max: o.max })
    : { ranges: [], merged: 0, noLength: 0 };
  const chapters = [];
  if (o.chapters) {
    for (const i of items || []) {
      if (i.kind !== "game" || !(i.duration > 0)) continue;
      const start = Math.max(o.min, i.start);
      const end = Math.min(o.max, i.start + i.duration);
      if (end > start) chapters.push({ start, end, name: i.name });
    }
    chapters.sort((a, b) => a.start - b.start);
  }
  const raw = [];
  for (const r of clipPlan.ranges) raw.push(r.start, r.end);
  for (const c of chapters) raw.push(c.start, c.end);
  const points = Array.from(new Set(raw.map((t) => Math.round(t * 1000) / 1000))).sort((a, b) => a - b);
  return { ranges: clipPlan.ranges, chapters, points, merged: clipPlan.merged, noLength: clipPlan.noLength };
}

/**
 * Source-time points -> timeline cut points over several timeline clips (all playing the same media).
 * clips = [{start, end (timeline s), inPoint, outPoint (source s), speed}]. Each clip only gets the points inside what it plays
 * (so a clip that starts later in the source, e.g. after you deleted the first hour, simply ignores the earlier points).
 * Returns [{tl, src}] sorted by timeline time; points on a clip's own edges are not cuts.
 */
function timelinePoints(points, clips) {
  const eps = 0.0005;
  const out = [];
  for (const c of clips || []) {
    const speed = c.speed > 0 ? c.speed : 1;
    for (const p of points || []) {
      if (!(p > c.inPoint + eps && p < c.outPoint - eps)) continue;
      const tl = c.start + (p - c.inPoint) / speed;
      if (tl > c.start + eps && tl < c.end - eps) out.push({ tl: Math.round(tl * 1000) / 1000, src: p });
    }
  }
  const seen = new Set();
  return out
    .filter((x) => (seen.has(x.tl) ? false : seen.add(x.tl)))
    .sort((a, b) => a.tl - b.tl);
}

/**
 * How the keep-ranges relate to what the timeline plays: the merged source windows of the clips, and how many ranges touch one of
 * them (inside) or none (outside, which a cut ignores). Used for the pre-flight line and the button counts.
 */
function coverage(ranges, clips) {
  const wins = (clips || []).map((c) => ({ start: c.inPoint, end: c.outPoint })).filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const windows = [];
  for (const w of wins) {
    const last = windows[windows.length - 1];
    if (last && w.start <= last.end + 0.001) last.end = Math.max(last.end, w.end);
    else windows.push({ start: w.start, end: w.end });
  }
  let inside = 0;
  for (const r of ranges || []) if (windows.some((w) => Math.min(w.end, r.end) - Math.max(w.start, r.start) > 0.001)) inside++;
  return { windows, inside, outside: (ranges || []).length - inside };
}

/** Does this markers file belong to this video? ("<video>.markers.json", or a name that starts like the video's, or the other way round.) */
function markersNameMatchesMedia(markersName, mediaPath) {
  const lower = (x) => String(x || "").toLowerCase();
  const n = lower(markersName);
  if (!n.endsWith(MARKERS_SUFFIX)) return false;
  const stem = lower(stripExtension(baseName(mediaPath)));
  const mstem = n.slice(0, -MARKERS_SUFFIX.length);
  if (!stem || !mstem) return false;
  return mstem === stem || mstem.startsWith(stem) || (mstem.length > 3 && stem.startsWith(mstem));
}

// ---- 0.6.0: the "Do it all" recipe, chapter scope, pre-flight, progress --------------------------------------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The saved recipe -> the steps a run performs, in order. Cutting at clips and at chapters is ONE step (one pass of halving
 * rounds over the union of both sets of points: fewer timeline edits than two passes).
 */
function recipeSteps(raw) {
  const s = normalizeSettings(raw);
  const steps = [];
  // 0.7.4: markers on the CLIP go first (they sit on the source, so they follow every cut). Markers on the SEQUENCE are fixed times, so they go
  // last, after the cuts and the ripple delete, mapped through the final pieces. (Clip markers show twice once the cut has unlinked video and
  // audio, because each piece reads the same source markers; sequence markers belong to the timeline and show once.)
  const markersLast = s.placement === "sequence" && (s.recipeCutClips || s.recipeCutChapters || s.recipeDeleteGaps);
  if (s.recipeMarkers && !markersLast) steps.push({ id: "markers" });
  if (s.recipeCutClips || s.recipeCutChapters) steps.push({ id: "cut", clips: s.recipeCutClips, chapters: s.recipeCutChapters });
  if (s.recipeDeleteGaps) steps.push({ id: "delete" }); // after the cut: it works on the pieces the cut made
  if (s.recipeMarkers && markersLast) steps.push({ id: "markers" });
  return steps;
}

/** Label of the Do it all button. counts = {markers, clips, chapters, gaps}: what each step would do right now (gaps: undefined = not known yet). */
function recipeLabel(raw, counts) {
  const s = normalizeSettings(raw);
  const c = counts || {};
  const parts = [];
  if (s.recipeMarkers) parts.push(plural(c.markers || 0, "marker", "markers"));
  if (s.recipeCutClips) parts.push(`cut ${plural(c.clips || 0, "clip", "clips")}`);
  if (s.recipeCutChapters) parts.push(`cut ${plural(c.chapters || 0, "chapter", "chapters")}`);
  if (s.recipeDeleteGaps) parts.push(c.gaps === undefined ? "delete the gaps" : `delete ${plural(c.gaps, "gap", "gaps")}`);
  return parts.length ? `Do it all: ${parts.join(" + ")}` : "Do it all (nothing ticked in Settings)";
}

/** The chapters of a file (game / category markers that have a length), in order: [{index, name, start, end}] (source seconds). */
function chapterList(file) {
  return ((file && file.markers) || [])
    .filter((m) => m.kind === "game" && m.end > m.start)
    .map((m) => ({ name: m.name, start: m.start, end: m.end }))
    .sort((a, b) => a.start - b.start)
    .map((c, index) => ({ index, ...c }));
}

/** "Limit to chapter": the range {min, max, name} of chapter `index`, or null (whole file) when there is no such chapter. */
function chapterScope(file, index) {
  if (index === null || index === undefined || index === "") return null;
  const c = chapterList(file)[Number(index)];
  return c ? { min: c.start, max: c.end, name: c.name } : null;
}

/** Marker items that START inside the scope (null = no limit). Cuts are limited through planCutSet's min / max instead. */
function restrictItems(items, scope) {
  if (!scope) return items;
  return (items || []).filter((i) => i.start >= scope.min - 0.001 && i.start < scope.max - 0.001);
}

const frameOf = (frame) => (frame > 0 ? frame : 0);
const snapToFrame = (t, frame) => (frameOf(frame) ? Math.round(t / frame) * frame : t);

/**
 * The timeline times that still need a cut, snapped to the sequence's frames: the cut points (source seconds) mapped through every
 * timeline clip, minus the ones that already are the edge of a piece. `clips` are what the timeline plays ({start, end, inPoint,
 * outPoint, speed}). This is what the cut engine works through, and what the pre-flight and the auto-run use to know "already done".
 */
function pendingCutPoints(points, clips, frame) {
  const f = frameOf(frame);
  const edge = Math.max(0.01, f / 2);
  const snapped = timelinePoints(points, clips).map((p) => Math.round(snapToFrame(p.tl, f) * 1e6) / 1e6);
  return Array.from(new Set(snapped))
    .filter((x) => (clips || []).some((c) => x > c.start + edge && x < c.end - edge))
    .sort((a, b) => a - b);
}

/** How many halving rounds the cut needs: the piece with the most pending points decides (k points need ceil(log2(k+1)) rounds). */
function roundsFor(pending, clips, frame) {
  const edge = Math.max(0.01, frameOf(frame) / 2);
  let worst = 0;
  for (const c of clips || []) {
    const k = (pending || []).filter((x) => x > c.start + edge && x < c.end - edge).length;
    worst = Math.max(worst, Math.ceil(Math.log2(k + 1)));
  }
  return worst;
}

/**
 * Markers in SOURCE time -> markers on the TIMELINE, through the clip that plays each one (not an offset from the start or the playhead).
 * The first clip (by timeline position) that plays any part of a marker gets it; a marker that begins before the clip's in point is
 * shortened to what the clip plays. Markers no clip plays are left out and counted in `outside`.
 */
function mapItemsToTimeline(items, clips) {
  const eps = 0.0005;
  const sorted = (clips || []).slice().sort((a, b) => a.start - b.start);
  const out = [];
  let outside = 0;
  for (const it of items || []) {
    const s0 = it.start;
    const e0 = it.start + Math.max(0, it.duration || 0);
    const isPoint = !(e0 > s0);
    let hit = null;
    for (const c of sorted) {
      const speed = c.speed > 0 ? c.speed : 1;
      const a = Math.max(s0, c.inPoint);
      const b = Math.min(e0, c.outPoint);
      const plays = isPoint ? s0 >= c.inPoint - eps && s0 < c.outPoint - eps : b > a + eps;
      if (!plays) continue;
      hit = { ...it, start: c.start + (a - c.inPoint) / speed, duration: isPoint ? 0 : (b - a) / speed };
      break;
    }
    if (hit) out.push(hit);
    else outside++;
  }
  return { items: out, outside };
}

/**
 * Pre-flight: everything that must be true BEFORE a run touches the project, from facts the panel reads (nothing here reads Premiere).
 * f = {loaded, recipe: {markers, clips, chapters}, minClips, markerCount, markers: {what, total, present} | null, markersError,
 *      timeline: {descs, mediaName, trackIndex} | null, timelineError, workspace: {videoTrack, video, audio: [{track, free}]} | null,
 *      clipsInside, clipsTotal, chaptersInside, chaptersTotal, pending (cut points still to make), rounds, backup,
 *      gaps (0.7.0: the planGapDelete result for the pieces the recipe would leave, when recipe.deleteGaps)}
 * Returns {ok, alreadyDone, problems, checks: [{ok, text}], summary}. `ok` is false when any check fails; `alreadyDone` is true
 * when every ticked step has nothing left to do.
 */
function evaluatePreflight(f) {
  const checks = [];
  const problems = [];
  const check = (ok, text, problem) => {
    checks.push({ ok, text });
    if (!ok) problems.push(problem || text);
  };
  const r = f.recipe || {};
  const cuts = !!(r.clips || r.chapters);
  const dels = !!r.deleteGaps;
  check(!!f.loaded, f.loaded ? "A markers file is loaded." : "No markers file is loaded.", "No markers file is loaded. Wait for the search or choose one.");
  if (!r.markers && !cuts && !dels) {
    problems.push("Nothing is ticked in Settings > Do it all.");
    return { ok: false, alreadyDone: false, problems, checks, summary: "" };
  }
  let markersDone = true;
  if (r.markers) {
    if (!(f.markerCount > 0)) check(false, "No markers to add with these settings.");
    else if (f.markersError) check(false, `Markers cannot be added: ${f.markersError}`);
    else if (f.markers) {
      const left = f.markers.total - f.markers.present;
      markersDone = left <= 0;
      check(true, `${plural(f.markerCount, "marker", "markers")} go on ${f.markers.what}${f.markers.present ? ` (${f.markers.present} already there)` : ""}.`);
    } else check(true, `${plural(f.markerCount, "marker", "markers")} to add.`);
  }
  let cutsDone = true;
  let gapsDone = true;
  if (cuts || dels) {
    if (f.timelineError || !f.timeline) check(false, `The timeline cannot be ${cuts ? "cut" : "read"}: ${f.timelineError || "the file's video is not on it"}`);
    else {
      check(true, `The timeline plays the file's video: ${plural(f.timeline.descs.length, "clip", "clips")} on V${f.timeline.trackIndex + 1}.`);
      if (cuts) {
        const w = f.workspace;
        const vt = w ? w.videoTrack + 1 : 1;
        check(!!w && w.video >= 0, w && w.video >= 0 ? `Empty V${w.video + 1} is free above V${vt} (workspace).` : `No empty video track above V${vt}: add one (right-click the track header > Add Track).`);
        for (const a of (w && w.audio) || []) {
          check(a.free >= 0, a.free >= 0 ? `Empty A${a.free + 1} is free above A${a.track + 1} (workspace).` : `No empty audio track above A${a.track + 1}: add one (right-click the track header > Add Track).`);
        }
        if (r.clips) {
          const need = Math.max(1, Math.min(f.minClips || 1, f.clipsTotal || 0));
          check(f.clipsInside >= need && f.clipsTotal > 0, `${f.clipsInside} of ${f.clipsTotal} clips fall inside what the timeline plays${f.clipsInside >= need && f.clipsTotal > 0 ? "." : ` (need at least ${need}).`}`);
        }
        if (r.chapters) check(f.chaptersInside >= 1, `${f.chaptersInside} of ${f.chaptersTotal} chapters fall inside what the timeline plays${f.chaptersInside >= 1 ? "." : " (need at least 1)."}`);
        cutsDone = !(f.pending > 0);
      }
      if (dels) {
        const g = f.gaps;
        if (!g) check(false, "The gaps could not be worked out from the timeline.");
        else if (!g.ok) check(false, `Delete the gaps: ${g.problems.join(" ")}`);
        else {
          check(true, g.nothing ? "Delete the gaps: no gap piece is left." : `Delete the gaps: ${g.text}.`);
          gapsDone = !!g.nothing;
        }
      }
    }
  }
  const parts = [];
  if (r.markers && f.markerCount > 0) parts.push(`add ${plural(f.markerCount, "marker", "markers")}`);
  if (cuts && f.pending > 0) {
    const what = [r.clips ? "clips" : "", r.chapters ? "chapters" : ""].filter(Boolean).join(" + ");
    parts.push(`cut at ${what}: ${plural(f.pending, "cut", "cuts")} in ${plural(f.rounds || 1, "round", "rounds")}`);
  }
  if (dels && f.gaps && f.gaps.ok && !f.gaps.nothing) parts.push(`delete the gaps: ${f.gaps.text}`);
  const summary = parts.length ? `${parts.join(", then ")}${(cuts || dels) && f.backup ? ", after one backup of the sequence" : ""}.` : "";
  const ok = problems.length === 0;
  return { ok, alreadyDone: ok && (!r.markers || markersDone) && (!cuts || cutsDone) && (!dels || gapsDone), problems, checks, summary };
}

/** "Step 2/2 · cutting · round 4/6 · 14 of 38 cuts" */
function progressText(p) {
  const parts = [];
  if (p.steps > 1 || p.step) parts.push(`Step ${p.step}/${p.steps}`);
  if (p.label) parts.push(p.label);
  if (p.rounds) parts.push(`${p.roundLabel || "round"} ${p.round}/${p.rounds}`);
  if (p.total) parts.push(`${p.done} of ${p.total} ${p.unit || "cuts"}`);
  return parts.join(" · ");
}

/** The decision for the opt-in auto-run, with the reason when it does not run (empty reason = nothing worth saying). */
function autoRunVerdict(v) {
  if (!v.enabled) return { run: false, why: "" };
  if (!v.autoLoaded) return { run: false, why: "" }; // a file you chose by hand is not run for you
  if (v.key && v.key === v.ranKey) return { run: false, why: "" }; // once per detected file
  if (v.deletes) return { run: false, why: "Auto-run skipped: the recipe deletes the gaps, which always needs your confirmation (press Do it all yourself)." };
  if (!v.pre) return { run: false, why: "Auto-run: the pre-flight could not be read." };
  if (!v.pre.ok) return { run: false, why: `Auto-run skipped: ${v.pre.problems[0]}` };
  if (v.pre.alreadyDone) return { run: false, why: "Auto-run skipped: everything in the recipe is already done." };
  return { run: true, why: "" };
}

/**
 * Runs the recipe's steps one after the other and stops at the first failure or when stop is asked, saying what is done and what is not.
 * deps = {backup(), markers(), cut(), delete(), shouldStop(), onStep(n, total, step)}; backup is only called when there is a cut or delete
 * step (one backup per run). Each dep may throw; a cut may return {stopped: true}. Returns {ok, stopped, failed: {step, error} | null, backupFailed,
 * done: [{step, result}], notRun: [step], backedUp}. Nothing is touched when the backup fails.
 */
async function runRecipe(steps, deps) {
  const out = { ok: false, stopped: false, failed: null, backupFailed: null, done: [], notRun: [], backedUp: false };
  if (steps.some((s) => s.id === "cut" || s.id === "delete") && deps.backup) {
    try {
      out.backedUp = !!(await deps.backup());
    } catch (e) {
      out.backupFailed = e;
      out.notRun = steps.slice();
      return out;
    }
  }
  for (let i = 0; i < steps.length; i++) {
    if (deps.shouldStop && deps.shouldStop()) {
      out.stopped = true;
      out.notRun = steps.slice(i);
      return out;
    }
    const step = steps[i];
    if (deps.onStep) deps.onStep(i + 1, steps.length, step);
    let result;
    try {
      result = await deps[step.id]();
    } catch (e) {
      out.failed = { step, error: e };
      out.notRun = steps.slice(i + 1);
      return out;
    }
    out.done.push({ step, result });
    if (result && result.stopped) {
      out.stopped = true;
      out.notRun = steps.slice(i + 1);
      return out;
    }
  }
  out.ok = true;
  return out;
}

const stepName = (id) => (id === "markers" ? "add markers" : id === "delete" ? "delete the gaps" : "cut");

/** The message for the end of a run: what was done, and what is left on the timeline when it did not finish. */
function outcomeText(out, steps) {
  const doneBits = out.done.map(({ step, result: r }) => {
    if (step.id === "markers") return r && r.added === 0 ? `markers were already there (${r.skipped})` : `${plural((r && r.added) || 0, "marker", "markers")} added${r && r.what ? ` to ${r.what}` : ""}`;
    if (step.id === "delete") return !r || (!r.deleted && !r.total) ? "no gap to delete" : `${plural(r.deleted || 0, "gap piece", "gap pieces")} deleted${r.stopped ? ` of ${r.total}` : ""}${r.deletedSeconds ? ` (${fmtSeconds(r.deletedSeconds)})` : ""}`;
    return r && r.points === 0 && !r.cuts ? "nothing needed cutting" : `${plural((r && r.cuts) || 0, "cut", "cuts")} made${r && r.stopped ? ` of ${r.points}` : ""}`;
  });
  const done = doneBits.length ? doneBits.join("; ") : "nothing";
  const notRun = out.notRun.map((s) => stepName(s.id)).join(", ");
  if (out.backupFailed) return `Nothing was changed: the backup failed (${out.backupFailed.message || out.backupFailed}). Untick the backup box in Settings to run without one, or duplicate the sequence yourself first.`;
  if (out.failed) {
    const n = steps.indexOf(out.failed.step) + 1;
    const st = out.failed.error && out.failed.error.state;
    let left = "";
    if (st && st.kind === "delete") left = ` On the timeline: ${st.deleted} of ${st.total} gap pieces are deleted, ${st.total - st.deleted} are still there.${st.note ? ` ${st.note}` : ""}`;
    else if (st) left = ` On the timeline: ${st.done} of ${st.total} cuts are made${st.leftover ? `, and ${plural(st.leftover, "temporary copy is", "temporary copies are")} still on the workspace tracks (delete them or undo)` : ""}.`;
    return `Stopped at step ${n}/${steps.length} (${stepName(out.failed.step.id)}): ${out.failed.error.message || out.failed.error}. Done before that: ${done}.${notRun ? ` Not run: ${notRun}.` : ""}${left}${out.backedUp ? " The backup copy of the sequence from the start of the run is in the Project panel." : ""}`;
  }
  if (out.stopped) {
    const cut = out.done.find((d) => d.step.id === "cut");
    const del = out.done.find((d) => d.step.id === "delete");
    let part = cut && cut.result && cut.result.stopped ? ` The cut stopped after round ${cut.result.rounds}: ${cut.result.cuts} of ${cut.result.points} cuts are made, ${cut.result.points - cut.result.cuts - (cut.result.skipped || 0)} not yet. Run it again to finish: points that already have a cut are skipped.` : "";
    if (del && del.result && del.result.stopped) part += ` The delete stopped after batch ${del.result.rounds}: ${del.result.deleted} of ${del.result.total} gap pieces are deleted, ${del.result.total - del.result.deleted} not yet. Run it again to finish: it works out what is left, and asks you to confirm again.`;
    return `Stopped by you. Done: ${done}.${notRun ? ` Not run: ${notRun}.` : ""}${part}`;
  }
  return `Done: ${done}.${out.done.some((d) => d.step.id === "cut" && d.result && d.result.cuts) ? " Look at the timeline." : ""}${out.done.some((d) => d.step.id === "delete" && d.result && d.result.deleted) ? " The clips are back to back on the timeline." : ""}`;
}

// ---- 0.7.0: ripple delete of the gaps -----------------------------------------------------------------------
// After the cut, the timeline is a row of pieces. A piece is KEEP when the part of the source it plays lies inside a keep range of the
// plan (the padded, merged clip ranges: chapters are not ranges), GAP when it touches no range, and UNCERTAIN when it holds only part
// of a range (a cut is missing, or the padding / merge settings changed since the cut). Only gaps are ever deleted, and a run that
// finds an uncertain piece refuses.
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** 31096.2 -> "31,096 s" */
const fmtSeconds = (s) => `${fmtInt(s)} s`;
/** How far a piece edge may sit from a range edge and still count as being on it: half a frame (the cut snaps to frames) plus 10 ms. */
const pieceTol = (frame) => (frame > 0 ? frame / 2 + 0.01 : 0.03);

/**
 * pieces = [{start, end (timeline s), inPoint, outPoint (source s), speed}], ranges = [{start, end}] in source seconds.
 * opts: frame (frame length, s), scope ({min, max} source seconds when the run is limited to one chapter, else null).
 * Returns one {index, piece, seconds, planned, verdict: "keep" | "gap" | "uncertain" | "outside", why?} per piece, in order.
 * `seconds` is the piece's length on the timeline; `planned` the timeline seconds of it that the plan wants to keep.
 * "outside" = a piece that lies entirely outside the chapter scope: it is left alone (neither kept nor deleted).
 */
function classifyPieces(pieces, ranges, opts) {
  const o = Object.assign({ frame: 0, scope: null }, opts || {});
  const tol = pieceTol(o.frame);
  const rs = ranges || [];
  return (pieces || []).map((p, index) => {
    const a = p.inPoint, b = p.outPoint;
    const speed = p.speed > 0 ? p.speed : 1;
    const seconds = p.end - p.start;
    const base = { index, piece: p, seconds, planned: 0 };
    if (![a, b, p.start, p.end].every(isNum) || !(b > a) || !(seconds > 0)) return { ...base, verdict: "uncertain", why: "its length or source range is not valid" };
    let overlap = 0, worst = 0, inside = false;
    for (const r of rs) {
      const ov = Math.min(b, r.end) - Math.max(a, r.start);
      if (ov > 0) {
        overlap += ov;
        worst = Math.max(worst, ov);
      }
      if (a >= r.start - tol && b <= r.end + tol) inside = true;
    }
    const planned = overlap / speed;
    if (o.scope) {
      if (b <= o.scope.min + tol || a >= o.scope.max - tol) return { ...base, planned, verdict: "outside" };
      if (!(a >= o.scope.min - tol && b <= o.scope.max + tol)) return { ...base, planned, verdict: "uncertain", why: "it crosses the edge of the chapter this run is limited to" };
    }
    if (inside) return { ...base, planned, verdict: "keep" };
    if (worst <= tol) return { ...base, planned, verdict: "gap" };
    return { ...base, planned, verdict: "uncertain", why: "it holds only part of a clip: the cuts do not match the current plan" };
  });
}

/**
 * What the pieces WILL be after a cut at `tlPoints` (timeline seconds, as pendingCutPoints returns them): each piece is split where a
 * point falls inside it. This is how the Do it all pre-flight can show what the delete step will do before anything is cut.
 */
function simulatePieces(pieces, tlPoints) {
  const pts = (tlPoints || []).slice().sort((a, b) => a - b);
  const out = [];
  for (const d of pieces || []) {
    const speed = d.speed > 0 ? d.speed : 1;
    const cuts = pts.filter((t) => t > d.start && t < d.end);
    let s = d.start, i = d.inPoint;
    for (const t of cuts.concat([d.end])) {
      const last = t === d.end;
      const o = last ? d.outPoint : i + (t - s) * speed;
      out.push({ start: s, end: t, inPoint: i, outPoint: o, speed: d.speed });
      s = t;
      i = o;
    }
  }
  return out;
}

/**
 * Pieces + keep ranges -> the delete plan and the safety verdict. Nothing here reads Premiere.
 * opts: frame, scope, maxDeletePct (refuse above this percent of the timeline), minKeep (refuse unless at least this many pieces are
 * kept), audioUnmatched (video pieces that have no linked audio piece: deleting would leave their audio behind).
 * The guard compares what the classification keeps (keepSeconds) with what the plan says should be kept (expectedKeepSeconds: the
 * ranges clamped to what the pieces play) and refuses when they differ by more than `tolerance`. Returns
 * {ok, problems, nothing, del, keep, uncertain, outside, deleteCount, keepCount, deleteSeconds, keepSeconds, totalSeconds, deletePct,
 *  expectedKeepSeconds, keepDiff, tolerance, text}. `del` / `keep` / ... are the classifyPieces entries.
 */
function planGapDelete(pieces, ranges, opts) {
  const o = Object.assign({ frame: 0, scope: null, maxDeletePct: 99, minKeep: 1, audioUnmatched: 0 }, opts || {});
  const tol = pieceTol(o.frame);
  const classified = classifyPieces(pieces, ranges, o);
  const pick = (v) => classified.filter((c) => c.verdict === v);
  const keep = pick("keep"), del = pick("gap"), uncertain = pick("uncertain"), outside = pick("outside");
  const secs = (l) => l.reduce((a, c) => a + c.seconds, 0);
  const keepSeconds = secs(keep), deleteSeconds = secs(del);
  const totalSeconds = keepSeconds + deleteSeconds + secs(uncertain);
  const deletePct = totalSeconds > 0 ? (100 * deleteSeconds) / totalSeconds : 0;
  const expectedKeepSeconds = classified.filter((c) => c.verdict !== "outside").reduce((a, c) => a + c.planned, 0);
  const keepDiff = Math.abs(keepSeconds - expectedKeepSeconds);
  const tolerance = Math.max(0.5, 4 * (ranges || []).length * tol);
  const problems = [];
  if (o.audioUnmatched > 0) problems.push(`${plural(o.audioUnmatched, "video piece has", "video pieces have")} no linked audio piece with the same start and end: deleting would leave the audio behind and put it out of sync.`);
  if (uncertain.length) {
    const first = uncertain[0];
    problems.push(`${plural(uncertain.length, "piece is", "pieces are")} only partly inside a clip (first at ${formatTime(first.piece.start)} on the timeline: ${first.why}). Run the cut first, or put the padding / merge settings back to what they were when you cut.`);
  }
  if (!uncertain.length) {
    if (keep.length < o.minKeep) problems.push(`Only ${plural(keep.length, "piece", "pieces")} would be kept (need at least ${o.minKeep}).`);
    else if (keepDiff > tolerance) problems.push(`The pieces that would be kept add up to ${fmtSeconds(keepSeconds)}, but the plan says ${fmtSeconds(expectedKeepSeconds)} should be kept (difference ${keepDiff.toFixed(1)} s, allowed ${tolerance.toFixed(1)} s).`);
    if (del.length && deletePct > o.maxDeletePct) problems.push(`It would delete ${deletePct.toFixed(1)}% of the timeline; the limit in Settings is ${o.maxDeletePct}%.`);
  }
  const ok = problems.length === 0;
  const text = `${plural(del.length, "piece", "pieces")}, ${fmtSeconds(deleteSeconds)}, ${deletePct.toFixed(1)}%; keep ${plural(keep.length, "piece", "pieces")}, ${fmtSeconds(keepSeconds)}`;
  return {
    ok, problems, nothing: ok && del.length === 0, del, keep, uncertain, outside,
    deleteCount: del.length, keepCount: keep.length, deleteSeconds, keepSeconds, totalSeconds, deletePct, expectedKeepSeconds, keepDiff, tolerance, text,
  };
}

/** What identifies a previewed plan: the confirmation only counts while the plan still looks like this. */
const gapKey = (plan) => (plan ? `${plan.deleteCount}|${plan.keepCount}|${Math.round(plan.deleteSeconds)}` : "");

/** [a, b, c, d, e] with size 2 -> [[a, b], [c, d], [e]] */
function chunkList(list, size) {
  const n = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < (list || []).length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * What a delete should leave on ONE track. before = [{S, E, I, O}] sorted by S; removed = indexes (into before) that were removed;
 * ripple = true: everything after a removed piece moves left by its length (a hole that was already there stays), false: nothing moves.
 * Returns the remaining pieces in order with their expected {S, E} (source in / out unchanged).
 */
function rippleExpectation(before, removed, ripple) {
  const gone = removed instanceof Set ? removed : new Set(removed || []);
  const ranges = [];
  (before || []).forEach((c, i) => {
    if (gone.has(i) && !ranges.some((r) => Math.abs(r.S - c.S) < 1e-6 && Math.abs(r.E - c.E) < 1e-6)) ranges.push({ S: c.S, E: c.E });
  });
  return (before || []).filter((_, i) => !gone.has(i)).map((c) => {
    const shift = ripple === false ? 0 : shiftAfter(c.S, ranges);
    return { S: c.S - shift, E: c.E - shift, I: c.I, O: c.O };
  });
}

/** How far something that starts at `S` moves left when the time ranges [{S, E}] are ripple-deleted. */
function shiftAfter(S, ranges) {
  let shift = 0;
  for (const r of ranges || []) if (r.S < S - 1e-6) shift += r.E - r.S;
  return shift;
}

/** Compares the pieces a track has now with what rippleExpectation says. Returns {ok, maxErr, bad, problems}; ok only when every piece is within tol. */
function checkSpans(expected, after, tol) {
  const problems = [];
  if ((expected || []).length !== (after || []).length) return { ok: false, maxErr: Infinity, bad: Infinity, problems: [`${(after || []).length} pieces are there, ${(expected || []).length} were expected`] };
  let maxErr = 0, bad = 0;
  expected.forEach((e, i) => {
    const a = after[i];
    const d = Math.max(Math.abs(a.S - e.S), Math.abs(a.E - e.E), Math.abs(a.I - e.I), Math.abs(a.O - e.O));
    maxErr = Math.max(maxErr, d);
    if (!(d <= tol)) {
      bad++;
      if (problems.length < 3) problems.push(`piece ${i + 1} of ${expected.length} is at ${a.S.toFixed(3)}-${a.E.toFixed(3)} (source ${a.I.toFixed(3)}), expected ${e.S.toFixed(3)}-${e.E.toFixed(3)} (source ${e.I.toFixed(3)})`);
    }
  });
  if (bad > problems.length) problems.push(`... ${bad} of ${expected.length} pieces are off in total`);
  return { ok: bad === 0, maxErr, bad, problems };
}

/**
 * 0.7.3. What a ripple delete may leave on ONE track. The first real delete (9.5 h VOD) showed that Premiere closes each removed piece
 * by its length minus 0 to 1 frame (60 removed pieces left 43 frames of holes; 1 removed piece left 1 frame; never more than 1 frame per
 * removed piece), so "every piece exactly where a ripple puts it" is the wrong test. The right one, per piece and per hole:
 *   - every remaining piece keeps its source in / out and its length (within a quarter frame),
 *   - the hole in front of a piece (how much further right it sits than the same gap in the ripple's own answer) is between 0 and
 *     `maxFramesPerPiece` frames for each removed piece that was in front of it since the previous remaining piece, and nothing for 0,
 *   - nothing closes too far (a negative hole would be an overlap).
 * before = [{S, E, I, O}] sorted by S, removed = Set / array of indexes into it, after = the pieces now, frame = seconds (0 = unknown).
 * Returns {ok, problems, maxErr, holes: [{i, hole, removed}] (hole = seconds between piece i and i + 1 beyond what a ripple leaves),
 * lead: {hole, removed, target} | null (the same in front of the first piece; target = where a ripple puts it), fills: the holes worth
 * closing (more than fillMin, with a removed piece in front), leadFill: lead | null, holeSeconds, removedCount}.
 */
function checkRippleHoles(before, removed, after, frame, opts) {
  const o = Object.assign({ maxFramesPerPiece: 1, fillMin: 0.001 }, opts || {});
  const q = frame > 0 ? frame / 4 : 0.005;
  const gone = removed instanceof Set ? removed : new Set(removed || []);
  const expected = rippleExpectation(before, gone, true);
  const aft = after || [];
  const empty = { holes: [], lead: null, fills: [], leadFill: null, holeSeconds: 0, removedCount: gone.size };
  if (expected.length !== aft.length) return { ok: false, maxErr: Infinity, problems: [`${aft.length} pieces are there, ${expected.length} were expected`], ...empty };
  const keptIdx = [];
  (before || []).forEach((_, i) => { if (!gone.has(i)) keptIdx.push(i); });
  const perPiece = (frame > 0 ? frame * o.maxFramesPerPiece : 0) + q;
  const problems = [];
  let bad = 0, maxErr = 0;
  const flag = (text) => {
    bad++;
    if (problems.length < 3) problems.push(text);
  };
  const where = (i) => `piece ${i + 1} of ${expected.length}`;
  expected.forEach((e, i) => {
    const a = aft[i];
    const d = Math.max(Math.abs(a.E - a.S - (e.E - e.S)), Math.abs(a.I - e.I), Math.abs(a.O - e.O));
    maxErr = Math.max(maxErr, d);
    if (!(d <= q)) flag(`${where(i)} plays source ${a.I.toFixed(3)}-${a.O.toFixed(3)} for ${(a.E - a.S).toFixed(3)} s, expected source ${e.I.toFixed(3)}-${e.O.toFixed(3)} for ${(e.E - e.S).toFixed(3)} s`);
  });
  const allowed = (hole, r) => hole >= -q && hole <= (r > 0 ? r * perPiece : q);
  const fr = (h) => (frame > 0 ? ` (${(h / frame).toFixed(2)} frames)` : "");
  let lead = null;
  const holes = [];
  if (expected.length) {
    lead = { hole: aft[0].S - expected[0].S, removed: keptIdx[0], target: expected[0].S };
    if (!allowed(lead.hole, lead.removed)) flag(`${where(0)} starts ${(lead.hole * 1000).toFixed(1)} ms${fr(lead.hole)} from where a ripple puts it, with ${lead.removed} removed piece(s) in front of it`);
    for (let i = 0; i + 1 < expected.length; i++) {
      const removedBetween = keptIdx[i + 1] - keptIdx[i] - 1;
      const hole = aft[i + 1].S - aft[i].E - (expected[i + 1].S - expected[i].E);
      holes.push({ i, hole, removed: removedBetween });
      if (!allowed(hole, removedBetween)) flag(`between ${where(i)} and the next one the gap is ${(hole * 1000).toFixed(1)} ms${fr(hole)} off what a ripple leaves, with ${removedBetween} removed piece(s) between them (at most ${o.maxFramesPerPiece} frame each)`);
    }
  }
  if (bad > problems.length) problems.push(`... ${bad} problems in total`);
  const fills = holes.filter((h) => h.removed > 0 && h.hole > o.fillMin);
  const leadFill = lead && lead.removed > 0 && lead.hole > o.fillMin ? lead : null;
  const holeSeconds = fills.reduce((a, h) => a + h.hole, 0) + (leadFill ? leadFill.hole : 0);
  return { ok: bad === 0, maxErr, problems, holes, lead, fills, leadFill, holeSeconds, removedCount: gone.size };
}

const LT_CORE_API = {
  FORMAT,
  SUPPORTED_FORMATS,
  SUPPORTED_VERSION,
  COLORS,
  DEFAULT_SETTINGS,
  MarkersFileError,
  parseMarkersFile,
  normalizeSettings,
  colorForClip,
  planMarkers,
  formatTime,
  colorName,
  summarizeSettings,
  MARKERS_SUFFIX,
  baseName,
  dirName,
  stripExtension,
  fileUrlForms,
  pickMarkersFile,
  planCuts,
  cutsForClip,
  cutPoints,
  planCutSet,
  timelinePoints,
  coverage,
  markersNameMatchesMedia,
  recipeSteps,
  recipeLabel,
  chapterList,
  chapterScope,
  restrictItems,
  snapToFrame,
  pendingCutPoints,
  roundsFor,
  mapItemsToTimeline,
  evaluatePreflight,
  progressText,
  autoRunVerdict,
  runRecipe,
  outcomeText,
  fmtSeconds,
  pieceTol,
  classifyPieces,
  simulatePieces,
  planGapDelete,
  gapKey,
  chunkList,
  rippleExpectation,
  shiftAfter,
  checkSpans,
  checkRippleHoles,
  DEFAULT_RECIPES,
  applyPreferences,
  applyRecipe,
};
if (typeof module !== "undefined" && module.exports) module.exports = LT_CORE_API;
if (typeof window !== "undefined") window.LTCore = LT_CORE_API;
