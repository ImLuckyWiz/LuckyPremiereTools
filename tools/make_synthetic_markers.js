#!/usr/bin/env node
"use strict";
// SPIKE P0-2 helper: writes a synthetic "<video stem>.markers.json" that makes the panel's existing Cut button cut a clip into
// N pieces, so the razor time for 500 / 1000 cuts can be measured in real Premiere (SILENCE_CUT_PLAN.md, task P0-2).
//
//   node tools/make_synthetic_markers.js --media "D:\vods\my video.mp4" --duration 3600 --fps 29.97 --cuts 500
//
// --media     path of the video that sits on V1 (only its NAME is used, the file is not read)
// --duration  length of that video in seconds
// --fps       the SEQUENCE frame rate (e.g. 29.97, 30, 59.94)
// --cuts      how many cut points to make (the panel's "cuts" count); 500 and 1000 are the interesting values
// --out       folder to write into (default: next to --media's name in the current folder)
// The file holds alternating speech / silence ranges of equal length, so cuts = 2 * ranges - 1 (first range starts at a gap).
// It is checked here with the REAL planner (src/markers-core.js) before it is written: the number printed as "cuts the panel will
// make" is what pendingCutPoints() returns for a single clip that plays the whole video.
const fs = require("node:fs");
const path = require("node:path");
const core = require("../src/markers-core.js");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const media = arg("media"), duration = Number(arg("duration")), fps = Number(arg("fps")), cuts = Number(arg("cuts"));
if (!media || !(duration > 0) || !(fps > 0) || !(cuts >= 2)) {
  console.error("usage: node tools/make_synthetic_markers.js --media <video path> --duration <seconds> --fps <sequence fps> --cuts <N> [--out <folder>]");
  process.exit(2);
}
// N cuts = 2 points per range, minus 1 because the first range starts at 0.0 + a gap... keep it simple: ranges alternate
// gap, speech, gap, speech ... with (cuts + 1) equal slots; every slot boundary is a cut point; speech slots are the odd ones.
const slots = cuts + 1, slotLen = duration / slots;
const ranges = [];
for (let i = 1; i < slots; i += 2) ranges.push({ start: i * slotLen, end: Math.min((i + 1) * slotLen, duration) });
const stem = String(media).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");   // not path.basename: the path may be a Windows one
const file = {
  format: "luckytwitch-markers", version: 1, name: stem + " (synthetic " + cuts + " cuts)", fps, duration,
  part: { start: 0, end: duration }, source: { tool: "luckytwitch-synthetic-spike" },
  markers: ranges.map((r, i) => ({ kind: "clip", name: "Synthetic " + (i + 1), start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000, views: 0, comment: "" })),
};
const text = JSON.stringify(file, null, 2);
const parsed = core.parseMarkersFile(text);
const items = core.planMarkers(parsed, { padBefore: 0, padAfter: 0, mergeGap: 0 }, 0).items;
const plan = core.planCutSet(items, { clips: true, chapters: false, padBefore: 0, padAfter: 0, mergeGap: 0, min: 0, max: duration });
const frame = 1 / fps;
const pending = core.pendingCutPoints(plan.points, [{ start: 0, end: duration, inPoint: 0, outPoint: duration, speed: 1 }], frame);
const outDir = arg("out", ".");
const outName = stem + ".markers.json";
if (!core.markersNameMatchesMedia(outName, media)) throw new Error("internal: the file name would not match the video");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, outName), text);
console.log("wrote " + path.join(outDir, outName));
console.log("ranges " + ranges.length + ", cut points in the plan " + plan.points.length + ", cuts the panel will make " + pending.length + " (asked for " + cuts + ")");
if (pending.length !== cuts) { console.error("WARNING: the planner makes " + pending.length + " cuts, not " + cuts + " (frame snapping merged some points: use a longer --duration or fewer cuts)"); process.exit(1); }
