"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../src/guard.js");

const clip = (o) => Object.assign({ start: 0, end: 3600, inPoint: 0, outPoint: 3600, media: "E:\\v\\a.mp4", name: "a.mp4" }, o || {});
const good = (o) => Object.assign({
  seq: { ok: true, fps: 60, dropFrame: false }, video: [1, 0, 0], audio: [1, 0, 0], v1: [clip()], a1: [clip()],
  markers: { existing: 0, probes: 0 }, file: { loaded: true, name: "a.markers.json", matchesMedia: true },
  plan: { clipsInside: 85, clipsTotal: 85, pending: 169, gaps: { ok: true, text: "85 gaps", problems: [] } },
}, o || {});
const has = (r, re) => r.hard.concat(r.soft).some((t) => re.test(t));

test("a fresh single-clip timeline passes", () => {
  const r = G.evaluate(good());
  assert.equal(r.ok, true);
  assert.equal(r.needsConfirm, false);
  assert.deepEqual(r.hard, []);
});
test("a clip on V2 / A2 / A3 is a hard stop that names the track", () => {
  assert.ok(has(G.evaluate(good({ video: [1, 1, 0] })), /V2 \(1 clip\)/));
  const r = G.evaluate(good({ audio: [1, 0, 4] }));
  assert.equal(r.ok, false);
  assert.ok(has(r, /A3 \(4 clips\)/));
});
test("an already-cut timeline (many clips on V1/A1) is refused", () => {
  assert.ok(has(G.evaluate(good({ video: [170] })), /V1 holds 170 clips/));
  assert.ok(has(G.evaluate(good({ audio: [170] })), /A1 holds 170 clips/));
});
test("empty V1 / A1 are refused", () => {
  assert.ok(has(G.evaluate(good({ video: [0] })), /V1 is empty/));
  assert.ok(has(G.evaluate(good({ audio: [0] })), /A1 is empty/));
});
test("no sequence, drop-frame", () => {
  assert.ok(has(G.evaluate({}), /no active sequence/i));
  assert.ok(has(G.evaluate(good({ seq: { ok: true, fps: 29.97, dropFrame: true } })), /drop-frame/));
});
test("clip not at 0, with a speed change, audio that differs, other media", () => {
  assert.ok(has(G.evaluate(good({ v1: [clip({ start: 5, end: 3605 })] })), /not at the start/));
  assert.ok(has(G.evaluate(good({ v1: [clip({ end: 1800 })] })), /speed change/));
  assert.ok(has(G.evaluate(good({ a1: [clip({ inPoint: 10, outPoint: 3610 })] })), /does not match the video clip/));
  assert.ok(has(G.evaluate(good({ a1: [clip({ media: "E:\\v\\other.mp4" })] })), /different media/));
});
test("media paths compare ignoring slashes and case", () => {
  assert.equal(G.evaluate(good({ a1: [clip({ media: "e:/V/A.MP4" })] })).ok, true);
});
test("markers file missing, unreadable or for another video", () => {
  assert.ok(has(G.evaluate(good({ file: { loaded: false } })), /No markers file/));
  assert.ok(has(G.evaluate(good({ file: { loaded: false, error: "it is not valid JSON" } })), /not valid JSON/));
  assert.ok(has(G.evaluate(good({ file: { loaded: true, name: "x.markers.json", matchesMedia: false } })), /does not match the video/));
});
test("probe leftovers are hard, real existing markers only ask", () => {
  assert.ok(has(G.evaluate(good({ markers: { existing: 5, probes: 5 } })), /LTPROBE/));
  const r = G.evaluate(good({ markers: { existing: 7, probes: 0 } }));
  assert.equal(r.ok, true);
  assert.equal(r.needsConfirm, true);
  assert.match(r.soft[0], /already has 7 markers/);
});
test("a plan with nothing inside, or an unsafe delete plan, is refused", () => {
  assert.ok(has(G.evaluate(good({ plan: { clipsInside: 0, clipsTotal: 85, pending: 0, gaps: { ok: true, text: "" } } })), /nothing to cut/));
  assert.ok(has(G.evaluate(good({ plan: { clipsInside: 3, clipsTotal: 3, pending: 5, gaps: { ok: false, problems: ["would delete 99.5%"] } } })), /would delete 99.5%/));
});
test("several problems are all reported, not just the first", () => {
  const r = G.evaluate(good({ video: [1, 2], audio: [3], file: { loaded: false } }));
  assert.ok(r.hard.length >= 3);
});


// ---------------------------------------------------------------------------------------------------------------------------------
// evaluateCuts: the mid-run guard (what the cuts phase may find on the timeline)
// ---------------------------------------------------------------------------------------------------------------------------------
const FPS = 60, S0 = 0, E0 = 36000; // a 10-minute clip, 60 fps, in frames
const EDGES = [0, 6000, 7200, 18000, 19200, 36000];
const sec = (f) => f / FPS;
const piecesFor = (bounds) => bounds.slice(0, -1).map((b, i) => ({ start: sec(b), end: sec(bounds[i + 1]), inPoint: sec(b), outPoint: sec(bounds[i + 1]) }));
const cutFacts = (bounds, o) => Object.assign({
  seq: { fps: FPS, dropFrame: false }, video: [bounds.length - 1, 0, 0], audio: [bounds.length - 1, 0, 0],
  v1: piecesFor(bounds), a1: piecesFor(bounds), mode: "partial",
  expect: { origin: { start: 0, end: sec(E0), inPoint: 0, outPoint: sec(E0) }, edges: EDGES },
}, o || {});

test("evaluateCuts: an uncut clip is a valid partial state with every cut still to do (back to front)", () => {
  const r = G.evaluateCuts(cutFacts([0, E0]));
  assert.equal(r.ok, true, r.hard.join(" | "));
  assert.deepEqual(r.remaining, [19200, 18000, 7200, 6000]);
  assert.equal(r.boundaries, 0);
});
test("evaluateCuts: a half-cut timeline passes as partial and lists what is left", () => {
  const r = G.evaluateCuts(cutFacts([0, 18000, 19200, E0]));
  assert.equal(r.ok, true, r.hard.join(" | "));
  assert.deepEqual(r.remaining, [7200, 6000]);
  assert.equal(r.boundaries, 2);
});
test("evaluateCuts: complete passes only when every planned cut is there", () => {
  assert.equal(G.evaluateCuts(cutFacts(EDGES, { mode: "complete" })).ok, true);
  const r = G.evaluateCuts(cutFacts([0, 18000, 19200, E0], { mode: "complete" }));
  assert.equal(r.ok, false);
  assert.ok(has(r, /planned cut\(s\) are missing/) || r.hard.some((h) => /needs 6|has 3 pieces/.test(h)));
});
test("evaluateCuts: a cut the plan never asked for is refused, even one frame off", () => {
  const r = G.evaluateCuts(cutFacts([0, 6001, 7200, 18000, 19200, E0]));
  assert.equal(r.ok, false);
  assert.ok(r.hard.some((h) => /did not ask for \(first at frame 6001\)/.test(h)));
});
test("evaluateCuts: V1/A1 piece counts that differ are refused (a razor reached one track only)", () => {
  const f = cutFacts([0, 6000, 7200, E0]); f.a1 = piecesFor([0, 6000, E0]);
  const r = G.evaluateCuts(f);
  assert.equal(r.ok, false);
  assert.ok(r.hard.some((h) => /V1 has 3 pieces but A1 has 2/.test(h)));
});
test("evaluateCuts: V1 and A1 that differ by a frame are refused", () => {
  const f = cutFacts([0, 6000, 7200, E0]); f.a1[1] = Object.assign({}, f.a1[1], { start: sec(6001), inPoint: sec(6001) }); f.a1[0] = Object.assign({}, f.a1[0], { end: sec(6001) });
  const r = G.evaluateCuts(f);
  assert.equal(r.ok, false);
  assert.ok(r.hard.some((h) => /differ between V1 and A1/.test(h)));
});
test("evaluateCuts: a hole, an overlap, or a clip that no longer covers the original are refused", () => {
  const hole = cutFacts([0, 6000, 7200, E0]); hole.v1[1] = Object.assign({}, hole.v1[1], { start: sec(6002) }); hole.a1[1] = Object.assign({}, hole.a1[1], { start: sec(6002) });
  assert.ok(G.evaluateCuts(hole).hard.some((h) => /hole|overlap/.test(h)));
  const short = cutFacts([0, 6000, 7200, E0]); short.v1[2] = Object.assign({}, short.v1[2], { end: sec(E0 - 5) }); short.a1[2] = Object.assign({}, short.a1[2], { end: sec(E0 - 5) });
  assert.ok(G.evaluateCuts(short).hard.some((h) => /do not cover the original clip/.test(h)));
});
test("evaluateCuts: source continuity (a piece that plays the wrong source) is refused", () => {
  const f = cutFacts([0, 6000, 7200, E0]);
  f.v1[1] = Object.assign({}, f.v1[1], { inPoint: sec(6000) + 1 / FPS, outPoint: sec(7200) + 1 / FPS }); f.a1[1] = Object.assign({}, f.v1[1]);
  assert.ok(G.evaluateCuts(f).hard.some((h) => /expected source/.test(h)));
});
test("evaluateCuts: an edge that is not on a whole frame is refused", () => {
  const f = cutFacts([0, 6000, 7200, E0]); const off = sec(6000) + 0.4 / FPS;
  f.v1[0] = Object.assign({}, f.v1[0], { end: off }); f.v1[1] = Object.assign({}, f.v1[1], { start: off }); f.a1[0] = Object.assign({}, f.v1[0]); f.a1[1] = Object.assign({}, f.v1[1]);
  assert.ok(G.evaluateCuts(f).hard.some((h) => /not on a whole frame/.test(h)));
});
test("evaluateCuts: clips on another track and drop-frame are refused mid-run too", () => {
  assert.ok(G.evaluateCuts(cutFacts([0, 6000, E0], { video: [2, 1, 0] })).hard.some((h) => /V2 \(1\)/.test(h)));
  assert.ok(G.evaluateCuts(cutFacts([0, 6000, E0], { seq: { fps: 29.97, dropFrame: true } })).hard.some((h) => /drop-frame/.test(h)));
  assert.equal(G.evaluateCuts({}).ok, false);
});
test("evaluateCuts: complete also compares the keep/delete classification with the plan", () => {
  const f = cutFacts(EDGES, { mode: "complete", expectGaps: { deleteCount: 3, keepCount: 2 } });
  f.gaps = { ok: true, deleteCount: 3, keepCount: 2, problems: [] };
  assert.equal(G.evaluateCuts(f).ok, true);
  f.gaps = { ok: true, deleteCount: 2, keepCount: 3, problems: [] };
  assert.ok(G.evaluateCuts(f).hard.some((h) => /give 2 to delete \/ 3 to keep \(plan: 3 \/ 2\)/.test(h)));
  f.gaps = null;
  assert.equal(G.evaluateCuts(f).ok, false);
});
test("the strict start-of-run guard still refuses a cut timeline (evaluateCuts is a separate, mid-run check)", () => {
  assert.ok(has(G.evaluate(good({ video: [217], audio: [217] })), /V1 holds 217 clips/));
});


// ---------------------------------------------------------------------------------------------------------------------------------
// evaluateDeletes / expectAfterDeletes: the deletes phase
// ---------------------------------------------------------------------------------------------------------------------------------
// 5 cut pieces (frames): keep 0-100, gap 100-160, keep 160-400, gap 400-430, keep 430-600
const PCS = [[0, 100], [100, 160], [160, 400], [400, 430], [430, 600]].map(([a, b]) => ({ start: a / 60, end: b / 60, inPoint: a / 60, outPoint: b / 60 }));
const GAPS = [1, 3];
const delFacts = (pieces, o) => Object.assign({
  seq: { fps: 60, dropFrame: false }, video: [pieces.length, 0, 0], audio: [pieces.length, 0, 0], v1: pieces, a1: pieces.map((p) => Object.assign({}, p)),
  gaps: { ok: true, deleteCount: 0, keepCount: pieces.length, problems: [], text: "0 pieces" }, mode: "partial",
}, o || {});

test("expectAfterDeletes: kept pieces move left by the gaps before them, source ranges do not change", () => {
  const e = G.expectAfterDeletes(PCS, GAPS);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((p) => [Math.round(p.start * 60), Math.round(p.end * 60)]), [[0, 100], [100, 340], [340, 510]]);
  assert.deepEqual(e.map((p) => Math.round(p.inPoint * 60)), [0, 160, 430]);
  assert.equal(G.expectAfterDeletes(PCS, []).length, 5);
});
test("evaluateDeletes: a fully cut timeline passes as partial; complete demands no gap left and the exact positions", () => {
  assert.equal(G.evaluateDeletes(delFacts(PCS)).ok, true);
  const e = G.expectAfterDeletes(PCS, GAPS);
  const ok = G.evaluateDeletes(delFacts(e, { mode: "complete", expect: e, expectKeep: 3, gaps: { ok: true, deleteCount: 0, keepCount: 3, problems: [], text: "0 pieces" } }));
  assert.equal(ok.ok, true, ok.hard.join(" | "));
  const still = G.evaluateDeletes(delFacts(PCS, { mode: "complete", gaps: { ok: true, deleteCount: 2, keepCount: 3, problems: [], text: "2 pieces" } }));
  assert.ok(still.hard.some((h) => /2 gap piece\(s\) are still on the timeline/.test(h)));
});
test("evaluateDeletes: a 1-frame hole, or pieces in the wrong place, are refused", () => {
  const e = G.expectAfterDeletes(PCS, GAPS);
  const holed = e.map((p, i) => (i === 2 ? Object.assign({}, p, { start: p.start + 1 / 60, end: p.end + 1 / 60 }) : p));
  const r = G.evaluateDeletes(delFacts(holed, { mode: "complete", expect: e, gaps: { ok: true, deleteCount: 0, keepCount: 3, problems: [], text: "" } }));
  assert.equal(r.ok, false);
  assert.ok(r.hard.some((h) => /hole|overlap/.test(h)) && r.hard.some((h) => /exact ripple delete puts them/.test(h)));
  const moved = e.map((p) => Object.assign({}, p, { start: p.start + 2 / 60, end: p.end + 2 / 60 }));
  assert.ok(G.evaluateDeletes(delFacts(moved, { mode: "complete", expect: e, gaps: { ok: true, deleteCount: 0, keepCount: 3, problems: [], text: "" } })).hard.some((h) => /not at 0|exact ripple delete puts them/.test(h)));
});
test("evaluateDeletes: V1/A1 out of step, other tracks, drop-frame, an unsafe delete plan, a lost kept piece are refused", () => {
  const f = delFacts(PCS); f.a1 = PCS.slice(0, 4);
  assert.ok(G.evaluateDeletes(f).hard.some((h) => /V1 has 5 pieces but A1 has 4/.test(h)));
  assert.ok(G.evaluateDeletes(delFacts(PCS, { video: [5, 2, 0] })).hard.some((h) => /V2 \(2\)/.test(h)));
  assert.ok(G.evaluateDeletes(delFacts(PCS, { seq: { fps: 29.97, dropFrame: true } })).hard.some((h) => /drop-frame/.test(h)));
  assert.ok(G.evaluateDeletes(delFacts(PCS, { gaps: { ok: false, problems: ["1 piece is only partly inside a clip."] } })).hard.some((h) => /not safe/.test(h)));
  assert.ok(G.evaluateDeletes(delFacts(PCS, { expectKeep: 3, gaps: { ok: true, deleteCount: 2, keepCount: 2, problems: [], text: "" } })).hard.some((h) => /a kept piece went missing/.test(h)));
  assert.equal(G.evaluateDeletes({}).ok, false);
});
test("evaluateDeletes: the source going backwards or a changed speed is refused", () => {
  const back = PCS.map((p, i) => (i === 3 ? Object.assign({}, p, { inPoint: 0.5, outPoint: 0.5 + (p.end - p.start) }) : p));
  assert.ok(G.evaluateDeletes(delFacts(back)).hard.some((h) => /goes backwards/.test(h)));
  const slow = PCS.map((p, i) => (i === 2 ? Object.assign({}, p, { outPoint: p.inPoint + 1 }) : p));
  assert.ok(G.evaluateDeletes(delFacts(slow)).hard.some((h) => /changed speed/.test(h)));
});
