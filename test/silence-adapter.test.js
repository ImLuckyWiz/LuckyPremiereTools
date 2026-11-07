"use strict";
// P1-6: the ADAPTER (SILENCE_CUT_PLAN.md D1, section 3.3). A silence analysis is written as a markers file where every loud range is a
// "clip" marker, and the UNMODIFIED planner in src/markers-core.js must accept it, cut it on whole frames and classify keep / gap right.
// buildChain() repeats runner.js buildPlan() step by step, with the settings silence mode forces (R2): no padding, no merge, no chapters.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/markers-core.js");
const S = require("../src/silence-core.js");

const SILENCE_SETTINGS = { padBefore: 0, padAfter: 0, mergeGap: 0, recipeCutClips: true, recipeCutChapters: false };

function buildChain(fileObj, seqFps, mediaSeconds, settings) {
  const file = C.parseMarkersFile(JSON.stringify(fileObj));
  const s = C.normalizeSettings(Object.assign({}, SILENCE_SETTINGS, settings || {}));
  const frame = 1 / seqFps;
  const items = C.planMarkers(file, s, 0).items;
  const cs = C.planCutSet(items, { clips: s.recipeCutClips, chapters: s.recipeCutChapters, padBefore: s.padBefore, padAfter: s.padAfter, mergeGap: s.mergeGap, min: 0, max: mediaSeconds });
  const clips = [{ start: 0, end: mediaSeconds, inPoint: 0, outPoint: mediaSeconds, speed: 1 }];
  const pending = C.pendingCutPoints(cs.points, clips, frame);
  const pieces = C.simulatePieces(clips, pending);
  const gaps = C.planGapDelete(pieces, cs.ranges, { frame, maxDeletePct: s.maxDeletePct, minKeep: s.minKeepPieces, scope: null });
  return { file, settings: s, items, cs, pending, pieces, gaps, frame };
}

// A deterministic "speech" pattern, snapped to whole frames of `fps`: that is exactly what analyze() produces (frame index / fps), because the
// analysis grid IS the sequence grid (decision D4). Times that fall exactly half way between two frames are NOT a valid input: there the
// planner's millisecond rounding can legitimately pick either neighbour, and the analyzer never produces such a time.
function rangesFor(durationSec, fps) {
  const out = []; let t = 1.37, k = 0;
  const snap = (x) => Math.round(x * fps) / fps;
  while (t < durationSec - 6) {
    const len = 2.113 + (k % 5) * 1.731, gap = 0.931 + (k % 3) * 0.877;
    out.push({ start: snap(t), end: snap(Math.min(t + len, durationSec - 1)) });
    t += len + gap; k++;
  }
  return out;
}
const metaFor = (fps, duration) => ({ name: "clip", fps, duration, analyzer: "1", params: S.PRESETS.Balanced, media: { path: "D:/v/clip.mp4", size: 10, mtimeMs: 20 } });

test("adapter: the planner accepts the silence file, keeps every loud range as a piece and every silence as a gap, and planGapDelete says ok (6 frame rates)", () => {
  for (const fps of [23.976, 25, 29.97, 30, 59.94, 60]) {
    const dur = 600, ranges = rangesFor(dur, fps);
    assert.ok(ranges.length > 20);
    const ch = buildChain(S.buildSilenceFile(ranges, metaFor(fps, dur)), fps, dur);
    assert.equal(ch.file.skipped, 0, `${fps} fps`);
    assert.equal(ch.cs.ranges.length, ranges.length, `${fps} fps: ranges merged or lost`);
    // speech starts after 0 and ends before the media ends, so: gaps = ranges + 1, cuts = 2 * ranges
    assert.equal(ch.pending.length, 2 * ranges.length, `${fps} fps: cut points`);
    assert.equal(ch.pieces.length, 2 * ranges.length + 1, `${fps} fps: pieces`);
    assert.equal(ch.gaps.ok, true, `${fps} fps: ${ch.gaps.problems.join(" | ")}`);
    assert.equal(ch.gaps.keepCount, ranges.length, `${fps} fps: keep pieces`);
    assert.equal(ch.gaps.deleteCount, ranges.length + 1, `${fps} fps: gap pieces`);
    assert.equal(ch.gaps.uncertain.length, 0);
  }
});
test("adapter: every cut point lands on a whole frame of the sequence (within 1e-4 of a frame), at 6 frame rates", () => {
  for (const fps of [23.976, 25, 29.97, 30, 59.94, 60]) {
    const dur = 3600, ranges = rangesFor(dur, fps);
    const ch = buildChain(S.buildSilenceFile(ranges, metaFor(fps, dur)), fps, dur);
    let worst = 0;
    for (const t of ch.pending) worst = Math.max(worst, Math.abs(t / ch.frame - Math.round(t / ch.frame)));
    assert.ok(worst < 1e-4, `${fps} fps: worst distance from a whole frame ${worst}`);
  }
});
test("adapter: the planner's millisecond rounding never moves a cut to a different frame (1 hour at 6 frame rates)", () => {
  for (const fps of [23.976, 25, 29.97, 30, 59.94, 60]) {
    const frame = 1 / fps, dur = 3600, ranges = rangesFor(dur, fps);
    const ch = buildChain(S.buildSilenceFile(ranges, metaFor(fps, dur)), fps, dur);
    // the exact frame each range edge belongs to, computed straight from the seconds, against what the planner chose
    const want = new Set();
    for (const r of ranges) for (const t of [r.start, r.end]) want.add(Math.round(t / frame));
    const got = new Set(ch.pending.map((t) => Math.round(t / frame)));
    let moved = 0; for (const f of want) if (!got.has(f)) moved++;
    assert.equal(moved, 0, `${fps} fps: ${moved} cuts on another frame`);
  }
});
test("adapter: speech at the very start and at the very end gives no leading / trailing gap, and the counts follow", () => {
  const dur = 60, fps = 30;
  const ch = buildChain(S.buildSilenceFile([{ start: 0, end: 10 }, { start: 20, end: 60 }], metaFor(fps, dur)), fps, dur);
  assert.equal(ch.pending.length, 2);
  assert.equal(ch.gaps.keepCount, 2); assert.equal(ch.gaps.deleteCount, 1); assert.equal(ch.gaps.ok, true);
});
test("adapter: pads and merge left over from Twitch use would change the plan, which is why silence mode must force them to 0 (the trap, section 3.4 #1)", () => {
  const dur = 120, fps = 30, ranges = [{ start: 10, end: 20 }, { start: 25, end: 40 }, { start: 60, end: 70 }];
  const f = S.buildSilenceFile(ranges, metaFor(fps, dur));
  const clean = buildChain(f, fps, dur);
  const padded = buildChain(f, fps, dur, { padBefore: 10, padAfter: 10, mergeGap: 5 });
  assert.equal(clean.cs.ranges.length, 3);
  assert.notDeepEqual(padded.cs.points, clean.cs.points);     // with leftover pads the plan is different: proof the override matters
  assert.deepEqual(clean.cs.ranges.map((r) => [r.start, r.end]), ranges.map((r) => [r.start, r.end]));
});
test("adapter: the plan file name must match the video (markersNameMatchesMedia), and a stale 'preferences' key is absent", () => {
  assert.equal(C.markersNameMatchesMedia("clip.silence.markers.json", "D:/v/clip.mp4"), true);
  assert.equal(C.markersNameMatchesMedia("clip.silence.markers.json", "D:\\v\\other.mp4"), false);
  const parsed = C.parseMarkersFile(JSON.stringify(S.buildSilenceFile([{ start: 1, end: 2 }], metaFor(30, 10))));
  assert.equal(parsed.preferences, null);
});
test("adapter: an all-silent analysis (no ranges) is a valid file with no clip markers; the guard's 'only 0 pieces would be kept' refusal then applies", () => {
  const dur = 60, fps = 30;
  const ch = buildChain(S.buildSilenceFile([], metaFor(fps, dur)), fps, dur);
  assert.equal(ch.file.markers.length, 0);
  assert.equal(ch.pending.length, 0);
  assert.equal(ch.gaps.ok, false);
});
test("adapter: summarize() agrees with the real planner on cuts, gaps and keeps", () => {
  for (const fps of [23.976, 29.97, 60]) {
    const dur = 900, ranges = rangesFor(dur, fps);
    const ch = buildChain(S.buildSilenceFile(ranges, metaFor(fps, dur)), fps, dur);
    const mine = S.summarize(ranges, dur, fps);
    assert.equal(mine.cuts, ch.pending.length, `${fps} fps cuts`);
    assert.equal(mine.silences, ch.gaps.deleteCount, `${fps} fps gaps`);
    assert.equal(mine.keeps, ch.gaps.keepCount, `${fps} fps keeps`);
  }
});
test("adapter, end to end: PCM-like levels -> analyze() (Balanced) -> silence file -> unmodified planner, at 3 frame rates", () => {
  for (const fps of [29.97, 50, 59.94]) {
    const sr = 48000, dur = 120, s = new Int16Array(sr * dur);
    for (let i = 0; i < s.length; i++) { const sec = i / sr, talking = (sec % 9) < 6; s[i] = talking ? Math.round(9000 * Math.sin(i * 0.05)) : 150; }
    const acc = new S.PeakAccumulator(sr, fps, 1);
    for (let i = 0; i < s.length; i += 65536) acc.push(s.subarray(i, i + 65536));
    const a = S.analyze(acc.finish(), fps, S.PRESETS.Balanced);
    assert.ok(a.ranges.length >= 10, `${fps} fps: ${a.ranges.length} ranges`);
    const ch = buildChain(S.buildSilenceFile(a.ranges, metaFor(fps, dur)), fps, dur);
    assert.equal(ch.gaps.ok, true, `${fps} fps: ${ch.gaps.problems.join(" | ")}`);
    assert.equal(ch.gaps.keepCount, a.ranges.length);
    const sm = S.summarize(a.ranges, dur, fps);
    assert.equal(sm.cuts, ch.pending.length); assert.equal(sm.silences, ch.gaps.deleteCount);
  }
});
