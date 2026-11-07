"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../src/markers-core.js");

// The same file the Python tests check against what the app writes.
const repoCopy = path.join(__dirname, "..", "..", "tests", "fixtures", "markers_sample.json");
const SAMPLE = fs.readFileSync(fs.existsSync(repoCopy) ? repoCopy : path.join(__dirname, "fixtures", "markers_sample.json"), "utf8");
const file = () => core.parseMarkersFile(SAMPLE);

test("reads the file the app writes", () => {
  const f = file();
  assert.equal(f.version, 1);
  assert.equal(f.fps, 29.97);
  assert.equal(f.part.start, 1200);
  assert.equal(f.source.streamer, "Streamer");
  assert.deepEqual(f.markers.map((m) => m.kind), ["game", "clip", "game"]);
  assert.equal(f.markers[1].views, 120);
  assert.equal(f.markers[1].clips[0].url, "https://clips.twitch.tv/c1");
  assert.equal(f.skipped, 0);
});

test("a UTF-8 BOM in front of the JSON is fine", () => {
  assert.equal(core.parseMarkersFile("\uFEFF" + SAMPLE).markers.length, 3);
});

test("rejects things that are not a markers file, with a clear message", () => {
  assert.throws(() => core.parseMarkersFile("not json"), /not valid JSON/);
  assert.throws(() => core.parseMarkersFile("[]"), /not a LuckyTwitch markers file/);
  assert.throws(() => core.parseMarkersFile('{"format":"something-else","version":1,"markers":[]}'), /not a LuckyTwitch markers file/);
  assert.throws(() => core.parseMarkersFile(`{"format":"${core.FORMAT}","version":1}`), /no "markers" list/);
  assert.throws(() => core.parseMarkersFile(`{"format":"${core.FORMAT}","markers":[]}`), /valid version/);
});

test("accepts both luckytwitch-markers and luckydownloader-markers formats", () => {
  const lt = core.parseMarkersFile(JSON.stringify({ format: "luckytwitch-markers", version: 1, markers: [] }));
  assert.equal(lt.markers.length, 0);
  const ld = core.parseMarkersFile(JSON.stringify({ format: "luckydownloader-markers", version: 1, markers: [] }));
  assert.equal(ld.markers.length, 0);
});

test("a file from a newer app is refused instead of half-read", () => {
  const newer = JSON.stringify({ format: core.FORMAT, version: core.SUPPORTED_VERSION + 1, markers: [] });
  assert.throws(() => core.parseMarkersFile(newer), /newer than this plugin/);
});

test("bad entries are skipped and counted, good ones are kept", () => {
  const text = JSON.stringify({
    format: core.FORMAT,
    version: 1,
    markers: [
      { kind: "game", name: "A", start: 0, end: 5 },
      { kind: "mystery", name: "B", start: 0, end: 5 },
      { kind: "clip", name: "C", start: "x", end: 5 },
      { kind: "clip", name: "D", start: -1, end: 5 },
      null,
    ],
  });
  const f = core.parseMarkersFile(text);
  assert.equal(f.markers.length, 1);
  assert.equal(f.skipped, 4);
});

test("default plan: games blue, clips colored by views, in time order", () => {
  const { items, counts } = core.planMarkers(file(), {});
  assert.deepEqual(counts, { games: 2, clips: 1, hidden: 0 });
  assert.deepEqual(items.map((i) => [i.kind, i.name, i.start, i.duration, i.color]), [
    ["game", "Just Chatting", 0, 50, core.DEFAULT_SETTINGS.gameColor],
    ["clip", "Funny moment (bob, 120 views)", 7, 23, 1], // 120 views >= 50 -> red
    ["game", "Resident Evil 2", 50, 20, core.DEFAULT_SETTINGS.gameColor],
  ]);
  assert.equal(items[1].comment, "bob · 120 views · https://clips.twitch.tv/c1");
});

test("view tiers pick the color; below mid is the low color", () => {
  const s = core.normalizeSettings({ midViews: 10, highViews: 50, lowColor: 4, midColor: 3, highColor: 1 });
  assert.equal(core.colorForClip(9, s), 4);
  assert.equal(core.colorForClip(10, s), 3);
  assert.equal(core.colorForClip(49, s), 3);
  assert.equal(core.colorForClip(50, s), 1);
});

test("with color by views off every clip uses the one clip color", () => {
  const s = core.normalizeSettings({ colorByViews: false, clipColor: 7 });
  assert.equal(core.colorForClip(0, s), 7);
  assert.equal(core.colorForClip(100000, s), 7);
});

test("turning games or clips off leaves them out and counts them as hidden", () => {
  const noGames = core.planMarkers(file(), { importGames: false });
  assert.deepEqual(noGames.items.map((i) => i.kind), ["clip"]);
  assert.equal(noGames.counts.hidden, 2);
  const noClips = core.planMarkers(file(), { importClips: false });
  assert.deepEqual(noClips.items.map((i) => i.kind), ["game", "game"]);
  assert.equal(noClips.counts.hidden, 1);
});

test("minimum views drops the small clips", () => {
  assert.equal(core.planMarkers(file(), { minViews: 121 }).counts.clips, 0);
  assert.equal(core.planMarkers(file(), { minViews: 120 }).counts.clips, 1);
});

test("the GAME: prefix is optional", () => {
  const names = (s) => core.planMarkers(file(), s).items.filter((i) => i.kind === "game").map((i) => i.name);
  assert.deepEqual(names({}), ["Just Chatting", "Resident Evil 2"]);
  assert.deepEqual(names({ gamePrefix: true }), ["GAME: Just Chatting", "GAME: Resident Evil 2"]);
});

test("the base time (playhead) shifts every marker", () => {
  const { items } = core.planMarkers(file(), {}, 100);
  assert.deepEqual(items.map((i) => i.start), [100, 107, 150]);
});

test("a marker with no length gets duration 0", () => {
  const text = JSON.stringify({ format: core.FORMAT, version: 1, markers: [{ kind: "clip", name: "x", start: 5, end: 5 }] });
  assert.equal(core.planMarkers(core.parseMarkersFile(text), {}).items[0].duration, 0);
});

test("settings from storage are repaired, never trusted", () => {
  const s = core.normalizeSettings({ gameColor: 99, midViews: "abc", highViews: "75", offsetMode: "weird", importGames: 0, minClips: "2.7", autoRun: 1 });
  assert.equal(s.gameColor, core.DEFAULT_SETTINGS.gameColor);
  assert.equal(s.midViews, core.DEFAULT_SETTINGS.midViews);
  assert.equal(s.highViews, 75);
  assert.equal(s.offsetMode, undefined, "the old offset setting is gone: markers map through the clip");
  assert.equal(s.minClips, 2);
  assert.equal(s.autoRun, true);
  assert.equal(s.importGames, false);
  assert.deepEqual(core.normalizeSettings(null), core.DEFAULT_SETTINGS);
});

test("time and color labels", () => {
  assert.equal(core.formatTime(0), "0:00:00");
  assert.equal(core.formatTime(3725), "1:02:05");
  assert.equal(core.colorName(1), "Red");
  assert.equal(core.colorName(42), "#42");
});

test("placement defaults to the clip and is repaired", () => {
  assert.equal(core.DEFAULT_SETTINGS.placement, "clip");
  assert.equal(core.normalizeSettings({ placement: "sequence" }).placement, "sequence");
  assert.equal(core.normalizeSettings({ placement: "x" }).placement, "clip");
});

test("the settings summary says what matters in one line", () => {
  assert.equal(core.summarizeSettings({}), "Games Blue · Clips by views (Yellow/Orange/Red) · on the clip");
  assert.equal(
    core.summarizeSettings({ importGames: false, colorByViews: false, clipColor: 7, minViews: 5, placement: "sequence" }),
    "No games · Clips Cyan · min 5 views · on the sequence"
  );
  assert.equal(core.summarizeSettings({ importClips: false }), "Games Blue · no clips · on the clip");
});

test("path helpers work for Windows and Mac paths", () => {
  const win = "E:\\VideosGuini\\IlloJuan\\2026 - DÚO\\part1.mp4";
  assert.equal(core.baseName(win), "part1.mp4");
  assert.equal(core.dirName(win), "E:\\VideosGuini\\IlloJuan\\2026 - DÚO");
  assert.equal(core.baseName("/Users/a/b/part1.mp4"), "part1.mp4");
  assert.equal(core.dirName("/Users/a/b/part1.mp4"), "/Users/a/b");
  assert.equal(core.dirName("part1.mp4"), "");
  assert.equal(core.stripExtension("a.b.mp4"), "a.b");
});

test("folder paths become file URLs with accents and spaces encoded", () => {
  const forms = core.fileUrlForms("E:\\Videos Guini\\DÚO");
  assert.equal(forms[0], "file:/E:/Videos%20Guini/D%C3%9AO");
  assert.equal(forms[1], "file:///E:/Videos%20Guini/D%C3%9AO");
  assert.equal(forms[2], "E:\\Videos Guini\\DÚO");
  assert.equal(core.fileUrlForms("/Users/a b")[0], "file:/Users/a%20b");
  assert.deepEqual(core.fileUrlForms(""), []);
});

test("picks the markers file that belongs to the video", () => {
  const names = ["x - part1.mp4", "x - part1.markers.json", "x - part2.markers.json", "x - part1.markers.xml", "x - part1.clips.json"];
  assert.deepEqual(core.pickMarkersFile(names, "x - part1.mp4"), { name: "x - part1.markers.json", how: "same name as the video" });
  assert.equal(core.pickMarkersFile(names, "x - part2.mp4").name, "x - part2.markers.json");
  assert.equal(core.pickMarkersFile(names, "X - PART1.MP4").name, "x - part1.markers.json", "case does not matter");
  // two files and a video that matches neither: not guessed
  assert.equal(core.pickMarkersFile(names, "other.mp4"), null);
  assert.equal(core.pickMarkersFile(names), null);
  // a single file is accepted even if the name differs, and says so
  assert.deepEqual(core.pickMarkersFile(["a.markers.json", "a.mp4"], "b.mp4"), { name: "a.markers.json", how: "the only one in the folder" });
  assert.equal(core.pickMarkersFile(["a.mp4"], "a.mp4"), null);
  assert.equal(core.pickMarkersFile([], "a.mp4"), null);
  // name that starts like the video's (e.g. the file has a suffix)
  assert.equal(core.pickMarkersFile(["v.final.markers.json", "z.markers.json"], "v.mp4").name, "v.final.markers.json");
});

const item = (start, duration, kind = "clip", name = "c") => ({ kind, name, start, duration });

test("cut plan: only clips, overlapping stretches merge, padding applies, no-length clips are counted", () => {
  const items = [item(100, 20, "clip", "a"), item(110, 30, "clip", "b"), item(300, 10), item(500, 0), item(0, 50, "game")];
  const p = core.planCuts(items);
  assert.deepEqual(p.ranges.map((r) => [r.start, r.end]), [[100, 140], [300, 310]]);
  assert.deepEqual(p.ranges[0].names, ["a", "b"]);
  assert.equal(p.merged, 1);
  assert.equal(p.noLength, 1);
  const padded = core.planCuts(items, { padBefore: 5, padAfter: 10, min: 0, max: 315 });
  assert.deepEqual(padded.ranges.map((r) => [r.start, r.end]), [[95, 150], [295, 315]]);
  const withGames = core.planCuts(items, { kinds: ["game", "clip"] });
  assert.equal(withGames.ranges[0].start, 0);
  assert.deepEqual(core.planCuts(items, { mergeGap: 200 }).ranges.map((r) => [r.start, r.end]), [[100, 310]]);
});

test("cuts on a clip: source time maps to timeline time and is trimmed to what the clip plays", () => {
  const clip = { start: 10, end: 110, inPoint: 50, outPoint: 150, speed: 1 };
  const cuts = core.cutsForClip([{ start: 40, end: 60, names: ["a"] }, { start: 120, end: 200, names: ["b"] }, { start: 0, end: 30, names: ["gone"] }], clip);
  assert.deepEqual(cuts.map((c) => [c.srcStart, c.srcEnd, c.tlStart, c.tlEnd]), [[50, 60, 10, 20], [120, 150, 80, 110]]);
  assert.deepEqual(core.cutPoints(cuts, clip), [20, 80]); // the clip's own ends (10 and 110) are not cuts
  const fast = core.cutsForClip([{ start: 60, end: 80, names: [] }], { start: 0, end: 50, inPoint: 50, outPoint: 150, speed: 2 });
  assert.deepEqual([fast[0].tlStart, fast[0].tlEnd], [5, 15]);
});

test("the sample clip becomes one stretch to cut", () => {
  const { items } = core.planMarkers(file(), {});
  const p = core.planCuts(items);
  assert.deepEqual(p.ranges.map((r) => [r.start, r.end]), [[7, 30]]);
});

// ---- 0.5.0: cut set, timeline mapping, coverage, new settings ----------------------------------------------------
test("new settings have safe defaults and are validated", () => {
  const d = core.normalizeSettings(null);
  assert.equal(d.padBefore, 0);
  assert.equal(d.padAfter, 0);
  assert.equal(d.mergeGap, 0);
  assert.equal(d.backup, true);
  const s = core.normalizeSettings({ padBefore: "1.5", padAfter: "-3", mergeGap: "abc", backup: false });
  assert.equal(s.padBefore, 1.5);
  assert.equal(s.padAfter, 0, "a negative pad falls back to the default");
  assert.equal(s.mergeGap, 0);
  assert.equal(s.backup, false);
  assert.match(core.summarizeSettings({ padBefore: 1, padAfter: 2, mergeGap: 3 }), /pad 1s\/2s · merge < 3s/);
});

test("cut set: clips give padded merged ranges, chapters give boundaries that are never merged", () => {
  const items = [
    item(100, 20, "clip", "a"), item(120, 10, "clip", "b"), // touch: one range, no cut between them
    item(200, 10, "clip", "c"),
    item(0, 150, "game", "Chatting"), item(150, 150, "game", "Game 2"),
  ];
  const clipsOnly = core.planCutSet(items);
  assert.deepEqual(clipsOnly.ranges.map((r) => [r.start, r.end]), [[100, 130], [200, 210]]);
  assert.deepEqual(clipsOnly.points, [100, 130, 200, 210]);
  assert.deepEqual(clipsOnly.chapters, []);
  const chaptersOnly = core.planCutSet(items, { clips: false, chapters: true });
  assert.deepEqual(chaptersOnly.chapters.map((c) => [c.start, c.end]), [[0, 150], [150, 300]]);
  assert.deepEqual(chaptersOnly.points, [0, 150, 300], "the shared boundary is one point");
  const both = core.planCutSet(items, { chapters: true });
  assert.deepEqual(both.points, [0, 100, 130, 150, 200, 210, 300]);
});

test("cut set: padding never puts a cut between clips that end up touching", () => {
  const items = [item(100, 20), item(124, 10), item(300, 10)];
  const p = core.planCutSet(items, { padBefore: 3, padAfter: 3 });
  assert.deepEqual(p.ranges.map((r) => [r.start, r.end]), [[97, 137], [297, 313]], "100-120 and 124-134 grow into each other and merge");
  assert.equal(p.merged, 1);
});

test("timeline points: a clip that starts later in the source ignores earlier points", () => {
  // the first hour of the source was deleted: the clip plays source 1800-2400 from timeline 0
  const clips = [{ start: 0, end: 600, inPoint: 1800, outPoint: 2400, speed: 1 }];
  const pts = core.timelinePoints([1700, 1850, 2000, 2100, 2500], clips);
  assert.deepEqual(pts.map((p) => p.tl), [50, 200, 300]);
  assert.deepEqual(pts.map((p) => p.src), [1850, 2000, 2100]);
});

test("timeline points: several pieces of the same media, speed, and edges that are not cuts", () => {
  const clips = [
    { start: 0, end: 100, inPoint: 0, outPoint: 100, speed: 1 },
    { start: 100, end: 150, inPoint: 200, outPoint: 300, speed: 2 }, // plays source 200-300 at double speed
  ];
  const pts = core.timelinePoints([0, 50, 100, 200, 250, 300], clips);
  assert.deepEqual(pts.map((p) => [p.tl, p.src]), [[50, 50], [125, 250]], "0/100/200/300 sit on clip edges");
});

test("coverage: merged source windows and how many keep-ranges fall inside them", () => {
  const clips = [
    { inPoint: 1800, outPoint: 2000 }, { inPoint: 2000, outPoint: 2400 }, // touching pieces form one window
    { inPoint: 3000, outPoint: 3100 },
  ];
  const c = core.coverage([{ start: 1700, end: 1850 }, { start: 2100, end: 2200 }, { start: 2500, end: 2600 }, { start: 3050, end: 3060 }], clips);
  assert.deepEqual(c.windows, [{ start: 1800, end: 2400 }, { start: 3000, end: 3100 }]);
  assert.equal(c.inside, 3, "the first range overlaps the window by being clamped");
  assert.equal(c.outside, 1);
});

test("markers file name belongs to a video", () => {
  const m = core.markersNameMatchesMedia;
  assert.ok(m("IlloJuan - part1.markers.json", "E:\\a\\IlloJuan - part1.mp4"));
  assert.ok(m("v.final.markers.json", "/x/v.mp4"));
  assert.ok(m("video.markers.json", "/x/video.final.mp4"));
  assert.ok(!m("v.markers.json", "/x/v.final.mp4"), "a very short name is too loose to trust");
  assert.ok(!m("other.markers.json", "/x/v.mp4"));
  assert.ok(!m("(pasted text)", "/x/v.mp4"));
  assert.ok(!m("v.markers.xml", "/x/v.mp4"));
});

// ---- 0.6.0: recipe, chapter scope, cut points, mapping, pre-flight, run ------------------------------------
const clip = (start, end, inPoint, speed = 1) => ({ start, end, inPoint, outPoint: inPoint + (end - start) * speed, speed });

test("recipe: defaults, steps (clips + chapters are one cut step) and the button label", () => {
  const d = core.DEFAULT_SETTINGS;
  assert.deepEqual([d.recipeMarkers, d.recipeCutClips, d.recipeCutChapters, d.autoRun, d.minClips], [true, true, false, false, 1]);
  assert.deepEqual(core.recipeSteps({}), [{ id: "markers" }, { id: "cut", clips: true, chapters: false }]);
  assert.deepEqual(core.recipeSteps({ recipeCutChapters: true }), [{ id: "markers" }, { id: "cut", clips: true, chapters: true }]);
  assert.deepEqual(core.recipeSteps({ recipeMarkers: false, recipeCutClips: false, recipeCutChapters: false }), []);
  assert.equal(core.recipeLabel({}, { markers: 21, clips: 19, chapters: 2 }), "Do it all: 21 markers + cut 19 clips");
  assert.equal(core.recipeLabel({ recipeCutChapters: true }, { markers: 1, clips: 1, chapters: 1 }), "Do it all: 1 marker + cut 1 clip + cut 1 chapter");
  assert.match(core.recipeLabel({ recipeMarkers: false, recipeCutClips: false }, {}), /nothing ticked/);
});

test("chapters: list, scope and restricting marker items", () => {
  const f = core.parseMarkersFile(JSON.stringify({ format: core.FORMAT, version: 1, markers: [
    { kind: "game", name: "B", start: 50, end: 70 }, { kind: "game", name: "A", start: 0, end: 50 }, { kind: "game", name: "no length", start: 80, end: 80 },
    { kind: "clip", name: "c1", start: 7, end: 30 }, { kind: "clip", name: "c2", start: 55, end: 60 }, { kind: "clip", name: "c3", start: 50, end: 52 },
  ] }));
  const list = core.chapterList(f);
  assert.deepEqual(list.map((c) => [c.index, c.name, c.start, c.end]), [[0, "A", 0, 50], [1, "B", 50, 70]]);
  assert.equal(core.chapterScope(f, null), null);
  assert.equal(core.chapterScope(f, 7), null);
  assert.deepEqual(core.chapterScope(f, "1"), { min: 50, max: 70, name: "B" });
  const items = core.planMarkers(f, {}).items;
  assert.deepEqual(core.restrictItems(items, core.chapterScope(f, 1)).map((i) => i.name), ["B", "c3", "c2"].sort((a, b) => items.findIndex((i) => i.name === a) - items.findIndex((i) => i.name === b)));
  assert.equal(core.restrictItems(items, null), items);
  // cuts are limited through planCutSet's min / max: a clip crossing the chapter edge is clamped to it
  const set = core.planCutSet([{ kind: "clip", name: "x", start: 40, duration: 20 }, { kind: "clip", name: "y", start: 5, duration: 5 }], { min: 50, max: 70 });
  assert.deepEqual(set.points, [50, 60]);
});

test("pendingCutPoints: snapped to frames, already-cut edges dropped; roundsFor is the exact halving count", () => {
  const frame = 1 / 30;
  const one = [clip(0, 1000, 0)];
  const pts = core.pendingCutPoints([100.01, 130, 5000], one, frame);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[0] - Math.round(100.01 * 30) / 30) < 1e-6);
  // after a cut at 100 the points 100 is an edge of a piece and no longer pending
  const cut = [clip(0, 100, 0), clip(100, 1000, 100)];
  assert.deepEqual(core.pendingCutPoints([100, 130], cut, 0), [130]);
  assert.equal(core.roundsFor(new Array(38).fill(0).map((_, i) => 10 + i * 20), one, 0), 6);
  assert.equal(core.roundsFor([], one, 0), 0);
  // two pieces: 3 points in one (2 rounds) and 1 in the other (1 round) -> 2 rounds
  assert.equal(core.roundsFor([10, 20, 30, 600], [clip(0, 500, 0), clip(500, 1000, 500)], 0), 2);
});

test("mapItemsToTimeline: through the clip that plays each marker, clamped, outside counted", () => {
  const items = [
    { name: "a", start: 1100, duration: 30 }, { name: "edge", start: 990, duration: 30 }, { name: "pt", start: 1200, duration: 0 },
    { name: "gone", start: 100, duration: 5 }, { name: "atOut", start: 1500, duration: 0 },
  ];
  const r = core.mapItemsToTimeline(items, [clip(200, 700, 1000)]);
  assert.deepEqual(r.items.map((i) => [i.name, i.start, i.duration]), [["a", 300, 30], ["edge", 200, 20], ["pt", 400, 0]]);
  assert.equal(r.outside, 2);
  // speed 2: the clip plays source twice as fast, so durations halve; a marker played by two clips goes to the earlier one
  const fast = core.mapItemsToTimeline([{ name: "z", start: 10, duration: 8 }], [clip(50, 100, 0, 2), clip(0, 20, 0)]);
  assert.deepEqual([fast.items[0].start, fast.items[0].duration], [10, 8], "the clip at timeline 0 comes first");
  const sp = core.mapItemsToTimeline([{ name: "z", start: 10, duration: 8 }], [clip(50, 100, 0, 2)]);
  assert.deepEqual([sp.items[0].start, sp.items[0].duration], [55, 4]);
});

const baseFacts = (over = {}) => ({
  loaded: true, recipe: { markers: true, clips: true, chapters: false }, minClips: 1, markerCount: 21,
  markers: { what: 'the clip "vod.mp4"', total: 21, present: 0 }, markersError: "",
  timeline: { descs: [clip(0, 100, 0)], mediaName: "vod.mp4", trackIndex: 0 }, timelineError: "",
  workspace: { videoTrack: 0, video: 1, audio: [{ track: 0, free: 1 }] },
  clipsInside: 14, clipsTotal: 19, chaptersInside: 2, chaptersTotal: 2, pending: 28, rounds: 5, backup: true, ...over,
});

test("pre-flight passes with everything in place and says what will happen", () => {
  const r = core.evaluatePreflight(baseFacts());
  assert.equal(r.ok, true);
  assert.equal(r.alreadyDone, false);
  assert.match(r.summary, /add 21 markers, then cut at clips: 28 cuts in 5 rounds, after one backup/);
  assert.ok(r.checks.some((c) => /Empty V2 is free above V1/.test(c.text)));
  assert.ok(r.checks.some((c) => /Empty A2 is free above A1/.test(c.text)));
});

test("pre-flight fails, before anything is touched, for each missing thing", () => {
  const bad = (over, re) => {
    const r = core.evaluatePreflight(baseFacts(over));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(" | "), re);
  };
  bad({ loaded: false }, /No markers file/);
  bad({ workspace: { videoTrack: 0, video: -1, audio: [{ track: 0, free: 1 }] } }, /No empty video track above V1/);
  bad({ workspace: { videoTrack: 0, video: 1, audio: [{ track: 0, free: -1 }] } }, /No empty audio track above A1/);
  bad({ clipsInside: 0 }, /0 of 19 clips fall inside .*\(need at least 1\)/);
  bad({ minClips: 5, clipsInside: 3 }, /need at least 5/);
  bad({ timeline: null, timelineError: "no video" }, /cannot be cut: no video/);
  bad({ markersError: "no clip" }, /Markers cannot be added: no clip/);
  bad({ markerCount: 0 }, /No markers to add/);
  bad({ recipe: { markers: false, clips: false, chapters: false } }, /Nothing is ticked/);
  bad({ recipe: { markers: false, clips: false, chapters: true }, chaptersInside: 0 }, /0 of 2 chapters/);
  // a markers-only recipe needs no tracks and no timeline
  const only = core.evaluatePreflight(baseFacts({ recipe: { markers: true, clips: false, chapters: false }, timeline: null, workspace: null, timelineError: "x" }));
  assert.equal(only.ok, true);
});

test("pre-flight knows when everything is already done", () => {
  assert.equal(core.evaluatePreflight(baseFacts({ pending: 0, markers: { what: "x", total: 21, present: 21 } })).alreadyDone, true);
  assert.equal(core.evaluatePreflight(baseFacts({ pending: 0 })).alreadyDone, false, "markers still to add");
  assert.equal(core.evaluatePreflight(baseFacts({ markers: { what: "x", total: 21, present: 21 } })).alreadyDone, false, "cuts still to make");
});

test("auto-run verdict: opt-in, once per file, only when the pre-flight passes and work is left", () => {
  const ok = core.evaluatePreflight(baseFacts());
  const v = (o) => core.autoRunVerdict({ enabled: true, autoLoaded: true, key: "k", ranKey: "", pre: ok, ...o });
  assert.equal(v({}).run, true);
  assert.equal(v({ enabled: false }).run, false);
  assert.equal(v({ autoLoaded: false }).run, false);
  assert.equal(v({ ranKey: "k" }).run, false);
  assert.match(v({ pre: core.evaluatePreflight(baseFacts({ clipsInside: 0 })) }).why, /Auto-run skipped: 0 of 19 clips/);
  assert.match(v({ pre: core.evaluatePreflight(baseFacts({ pending: 0, markers: { what: "x", total: 21, present: 21 } })) }).why, /already done/);
});

test("runRecipe: one backup, steps in order, stops at the first failure and says what is left", async () => {
  const steps = core.recipeSteps({});
  const calls = [];
  const deps = (over = {}) => ({
    backup: async () => { calls.push("backup"); return true; },
    markers: async () => { calls.push("markers"); return { added: 21, skipped: 0, what: "the clip" }; },
    cut: async () => { calls.push("cut"); return { cuts: 28, points: 28, skipped: 0, rounds: 5, stopped: false }; },
    shouldStop: () => false, onStep: (n, t) => calls.push(`step ${n}/${t}`), ...over,
  });
  const ok = await core.runRecipe(steps, deps());
  assert.deepEqual(calls, ["backup", "step 1/2", "markers", "step 2/2", "cut"]);
  assert.equal(ok.ok, true);
  assert.match(core.outcomeText(ok, steps), /^Done: 21 markers added to the clip; 28 cuts made\. Look at the timeline\.$/);

  calls.length = 0;
  const err = Object.assign(new Error("Stopped after 8 of 28 cuts (round 3): check failed"), { state: { done: 8, total: 28, round: 3, leftover: 2 } });
  const bad = await core.runRecipe(steps, deps({ cut: async () => { throw err; } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.failed.step.id, "cut");
  const text = core.outcomeText(bad, steps);
  assert.match(text, /Stopped at step 2\/2 \(cut\)/);
  assert.match(text, /Done before that: 21 markers added/);
  assert.match(text, /8 of 28 cuts are made, and 2 temporary copies are still on the workspace tracks/);
  assert.match(text, /backup copy .* is in the Project panel/);

  calls.length = 0;
  const noBackup = await core.runRecipe(steps, deps({ backup: async () => { throw new Error("refused"); } }));
  assert.deepEqual(calls, [], "a failed backup stops everything before any step");
  assert.match(core.outcomeText(noBackup, steps), /Nothing was changed: the backup failed \(refused\)/);

  const markersOnly = [];
  await core.runRecipe(core.recipeSteps({ recipeCutClips: false }), deps({ backup: async () => { markersOnly.push("backup"); } }));
  assert.deepEqual(markersOnly, [], "no cut step, no backup");
});

test("runRecipe: Stop between steps and inside the cut", async () => {
  const steps = core.recipeSteps({});
  let stop = false;
  const between = await core.runRecipe(steps, { backup: async () => true, markers: async () => { stop = true; return { added: 3, skipped: 0 }; }, cut: async () => assert.fail("must not run"), shouldStop: () => stop });
  assert.equal(between.stopped, true);
  assert.match(core.outcomeText(between, steps), /Stopped by you\. Done: 3 markers added\. Not run: cut\./);
  const inside = await core.runRecipe(steps, { backup: async () => true, markers: async () => ({ added: 3, skipped: 0 }), cut: async () => ({ cuts: 7, points: 28, skipped: 0, rounds: 3, stopped: true }), shouldStop: () => false });
  assert.equal(inside.stopped, true);
  assert.match(core.outcomeText(inside, steps), /cut stopped after round 3: 7 of 28 cuts are made, 21 not yet/);
});

test("progressText", () => {
  assert.equal(core.progressText({ step: 2, steps: 3, label: "cutting", round: 4, rounds: 6, done: 14, total: 38 }), "Step 2/3 · cutting · round 4/6 · 14 of 38 cuts");
  assert.equal(core.progressText({ step: 1, steps: 2, label: "adding markers" }), "Step 1/2 · adding markers");
});

// ---- 0.7.0: ripple delete of the gaps ----------------------------------------------------------------------------
const F60 = 1 / 60; // frame of a 60 fps sequence
const piece = (start, end, inPoint, outPoint, speed = 1) => ({ start, end, inPoint: inPoint === undefined ? start : inPoint, outPoint: outPoint === undefined ? end : outPoint, speed });
const verdicts = (list) => list.map((c) => c.verdict);

test("settings: the delete settings have defaults, are clamped, and a high default limit lets a normal 90% delete through", () => {
  const d = core.normalizeSettings({});
  assert.deepEqual([d.recipeDeleteGaps, d.maxDeletePct, d.minKeepPieces], [false, 99, 1]);
  const s = core.normalizeSettings({ recipeDeleteGaps: true, maxDeletePct: "95", minKeepPieces: "3.7" });
  assert.deepEqual([s.recipeDeleteGaps, s.maxDeletePct, s.minKeepPieces], [true, 95, 3]);
  assert.equal(core.normalizeSettings({ maxDeletePct: 0 }).maxDeletePct, 1, "0 would block everything: clamped to 1");
  assert.equal(core.normalizeSettings({ maxDeletePct: 250 }).maxDeletePct, 100);
  assert.equal(core.normalizeSettings({ maxDeletePct: "abc" }).maxDeletePct, 99);
  assert.equal(core.normalizeSettings({ minKeepPieces: 0 }).minKeepPieces, 1);
});

test("classifyPieces: keep, gap, uncertain, and the half-frame tolerance of a snapped cut", () => {
  const ranges = [{ start: 100, end: 130 }, { start: 200, end: 260 }];
  const pieces = [
    piece(0, 100), // gap before the first clip
    piece(100, 130), // exactly the clip
    piece(130, 200), // gap between
    piece(200.008, 259.995), // the clip, cut 8 ms late and 5 ms early (frame snapping)
    piece(259.995, 400), // gap after; it starts 5 ms inside the range: well within a half frame
  ];
  const c = core.classifyPieces(pieces, ranges, { frame: F60 });
  assert.deepEqual(verdicts(c), ["gap", "keep", "gap", "keep", "gap"]);
  // a piece that holds part of a clip is uncertain, never gap
  const u = core.classifyPieces([piece(90, 120), piece(110, 300)], ranges, { frame: F60 });
  assert.deepEqual(verdicts(u), ["uncertain", "uncertain"]);
  assert.match(u[0].why, /only part of a clip/);
  // 40 ms into a clip is NOT a snapping error
  assert.equal(core.classifyPieces([piece(130.04, 200)], [{ start: 100, end: 130.1 }], { frame: F60 })[0].verdict, "uncertain");
  // broken numbers never count as gap
  assert.equal(core.classifyPieces([{ start: 0, end: NaN, inPoint: 0, outPoint: 5, speed: 1 }], ranges)[0].verdict, "uncertain");
});

test("classifyPieces works in SOURCE time: a timeline that starts at source 1800, and a sped-up piece", () => {
  const ranges = [{ start: 2000, end: 2100 }];
  const c = core.classifyPieces([piece(0, 200, 1800, 2000), piece(200, 300, 2000, 2100), piece(300, 500, 2100, 2300)], ranges, { frame: F60 });
  assert.deepEqual(verdicts(c), ["gap", "keep", "gap"]);
  const fast = core.classifyPieces([piece(0, 50, 2000, 2100, 2)], ranges, { frame: F60 });
  assert.equal(fast[0].verdict, "keep");
  assert.equal(fast[0].seconds, 50, "its length on the timeline, not in the source");
  assert.equal(fast[0].planned, 50);
});

test("classifyPieces with a chapter scope: pieces outside are left alone, a piece crossing the scope edge is uncertain", () => {
  const ranges = [{ start: 60, end: 70 }];
  const scope = { min: 50, max: 80 };
  const c = core.classifyPieces([piece(0, 40), piece(40, 55), piece(55, 60), piece(60, 70), piece(70, 80), piece(80, 100)], ranges, { frame: F60, scope });
  assert.deepEqual(verdicts(c), ["outside", "uncertain", "gap", "keep", "gap", "outside"]);
  assert.match(c[1].why, /edge of the chapter/);
});

test("simulatePieces splits the pieces where the pending cuts fall, with the source in points to match", () => {
  const out = core.simulatePieces([piece(0, 100, 1000, 1100), piece(100, 150, 2000, 2100, 2)], [10, 40, 120, 999]);
  assert.deepEqual(out.map((p) => [p.start, p.end, p.inPoint, p.outPoint]), [[0, 10, 1000, 1010], [10, 40, 1010, 1040], [40, 100, 1040, 1100], [100, 120, 2000, 2040], [120, 150, 2040, 2100]]);
  assert.deepEqual(core.simulatePieces([piece(0, 50)], []).length, 1);
});

// A timeline shaped like the real 9.5 h VOD: 34,379.862 s, 108 clips that keep ~9.6%.
function realVod() {
  const ranges = [];
  for (let i = 0; i < 108; i++) ranges.push({ start: 100 + i * 318, end: 100 + i * 318 + 30.4, names: [`c${i}`] });
  const whole = [piece(0, 34379.862, 0, 34379.862)];
  const points = core.planCutSet(ranges.map((r) => ({ kind: "clip", name: r.names[0], start: r.start, duration: r.end - r.start })), { clips: true }).points;
  const pending = core.pendingCutPoints(points, whole, F60);
  return { ranges, whole, pending, pieces: core.simulatePieces(whole, pending) };
}

test("planGapDelete on a real-VOD shape: ~90% deleted is normal and passes the default guard; 216 cut points make 217 pieces", () => {
  const { ranges, pending, pieces } = realVod();
  assert.equal(pending.length, 216);
  assert.equal(pieces.length, 217);
  const plan = core.planGapDelete(pieces, ranges, { frame: F60 });
  assert.equal(plan.ok, true, plan.problems.join(" "));
  assert.deepEqual([plan.keepCount, plan.deleteCount, plan.uncertain.length], [108, 109, 0]);
  assert.ok(Math.abs(plan.keepSeconds - 108 * 30.4) < 0.1, `${plan.keepSeconds}`);
  assert.ok(plan.deletePct > 90 && plan.deletePct < 90.6, `${plan.deletePct}`);
  assert.ok(plan.keepDiff < plan.tolerance);
  assert.match(plan.text, /^109 pieces, 31,0\d\d s, 90\.\d%; keep 108 pieces, 3,283 s$/);
  assert.equal(core.gapKey(plan), `109|108|${Math.round(plan.deleteSeconds)}`);
});

test("planGapDelete refuses: percentage limit, too few pieces to keep, uncertain pieces, audio left behind", () => {
  const { ranges, pieces } = realVod();
  const lowLimit = core.planGapDelete(pieces, ranges, { frame: F60, maxDeletePct: 80 });
  assert.equal(lowLimit.ok, false);
  assert.match(lowLimit.problems[0], /It would delete 90\.\d% of the timeline; the limit in Settings is 80%/);
  assert.equal(core.planGapDelete(pieces, ranges, { frame: F60, maxDeletePct: 91 }).ok, true);
  const few = core.planGapDelete(pieces, ranges, { frame: F60, minKeep: 200 });
  assert.match(few.problems[0], /Only 108 pieces would be kept \(need at least 200\)/);
  // nothing cut yet: the one big piece holds all the clips
  const uncut = core.planGapDelete([piece(0, 34379.862)], ranges, { frame: F60 });
  assert.equal(uncut.ok, false);
  assert.match(uncut.problems[0], /1 piece is only partly inside a clip \(first at 0:00:00 on the timeline: .*Run the cut first/);
  // a ranges list that matches nothing (all pieces would be gap) keeps zero pieces
  const none = core.planGapDelete(pieces, [], { frame: F60 });
  assert.equal(none.ok, false);
  assert.match(none.problems[0], /Only 0 pieces would be kept/);
  const audio = core.planGapDelete(pieces, ranges, { frame: F60, audioUnmatched: 2 });
  assert.match(audio.problems[0], /2 video pieces have no linked audio piece/);
});

test("planGapDelete: the plan-vs-classification check refuses when the two disagree by more than the tolerance", () => {
  // ranges that overlap each other and were not merged: the plan counts 150 s to keep, the classification keeps 100 s
  const bad = core.planGapDelete([piece(0, 100), piece(100, 200)], [{ start: 0, end: 100 }, { start: 50, end: 100 }], { frame: F60 });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(" "), /add up to .* but the plan says .* should be kept/);
});

test("planGapDelete: nothing to delete is fine, not a problem", () => {
  const plan = core.planGapDelete([piece(100, 130)], [{ start: 100, end: 130 }], { frame: F60 });
  assert.deepEqual([plan.ok, plan.nothing, plan.deleteCount, plan.keepCount], [true, true, 0, 1]);
});

test("chunkList", () => {
  assert.deepEqual(core.chunkList([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(core.chunkList([], 3), []);
  assert.deepEqual(core.chunkList([1, 2], 0), [[1], [2]], "a size below 1 is 1");
});

test("rippleExpectation + checkSpans: later pieces move left by the removed length, a hole that was already there stays", () => {
  const before = [{ S: 0, E: 10, I: 0, O: 10 }, { S: 10, E: 15, I: 10, O: 15 }, { S: 20, E: 30, I: 20, O: 30 }, { S: 30, E: 40, I: 30, O: 40 }];
  const exp = core.rippleExpectation(before, [1], true);
  assert.deepEqual(exp.map((e) => [e.S, e.E, e.I]), [[0, 10, 0], [15, 25, 20], [25, 35, 30]], "the 5 s hole at 15-20 stays, only the removed 5 s closes");
  assert.deepEqual(core.rippleExpectation(before, [1], false).map((e) => e.S), [0, 20, 30], "no ripple: nothing moves");
  // two removed pieces: the shifts add up for what lies after both
  assert.deepEqual(core.rippleExpectation(before, new Set([0, 2]), true).map((e) => [e.S, e.E]), [[0, 5], [10, 20]]);
  const after = [{ S: 0, E: 10, I: 0, O: 10 }, { S: 15, E: 25, I: 20, O: 30 }, { S: 25.004, E: 35.004, I: 30, O: 40 }];
  assert.equal(core.checkSpans(exp, after, 0.02).ok, true);
  const off = core.checkSpans(exp, [after[0], after[1], { S: 30, E: 40, I: 30, O: 40 }], 0.02);
  assert.equal(off.ok, false);
  assert.match(off.problems[0], /piece 3 of 3 is at 30\.000-40\.000/);
  assert.equal(core.checkSpans(exp, after.slice(0, 2), 0.02).ok, false, "a different count is a failure");
  assert.equal(core.shiftAfter(30, [{ S: 10, E: 15 }, { S: 20, E: 30 }]), 15);
});

test("recipe with the delete step: it is the last step, the label shows it, and one backup covers cut and delete", async () => {
  assert.deepEqual(core.recipeSteps({ recipeDeleteGaps: true }), [{ id: "markers" }, { id: "cut", clips: true, chapters: false }, { id: "delete" }]);
  assert.deepEqual(core.recipeSteps({ recipeMarkers: false, recipeCutClips: false, recipeDeleteGaps: true }), [{ id: "delete" }]);
  assert.equal(core.recipeLabel({ recipeDeleteGaps: true }, { markers: 3, clips: 2, gaps: 109 }), "Do it all: 3 markers + cut 2 clips + delete 109 gaps");
  assert.equal(core.recipeLabel({ recipeDeleteGaps: true }, { markers: 3, clips: 2 }), "Do it all: 3 markers + cut 2 clips + delete the gaps");
  const order = [];
  const steps = core.recipeSteps({ recipeDeleteGaps: true });
  const out = await core.runRecipe(steps, {
    backup: async () => { order.push("backup"); return true; },
    markers: async () => { order.push("markers"); return { added: 3, skipped: 0, what: "the clip" }; },
    cut: async () => { order.push("cut"); return { cuts: 4, points: 4, skipped: 0, rounds: 3, stopped: false }; },
    delete: async () => { order.push("delete"); return { deleted: 3, total: 3, rounds: 1, stopped: false, deletedSeconds: 31096.2 }; },
    shouldStop: () => false,
  });
  assert.deepEqual(order, ["backup", "markers", "cut", "delete"]);
  assert.equal(core.outcomeText(out, steps), "Done: 3 markers added to the clip; 4 cuts made; 3 gap pieces deleted (31,096 s). Look at the timeline. The clips are back to back on the timeline.");
  const onlyDelete = [];
  await core.runRecipe(core.recipeSteps({ recipeMarkers: false, recipeCutClips: false, recipeDeleteGaps: true }), { backup: async () => { onlyDelete.push("backup"); }, delete: async () => ({ deleted: 0, total: 0 }) });
  assert.deepEqual(onlyDelete, ["backup"], "a delete-only recipe also gets its backup");
});

test("outcomeText: a failed or stopped delete says what is left", async () => {
  const steps = core.recipeSteps({ recipeDeleteGaps: true });
  const err = Object.assign(new Error("Stopped in batch 2: a later piece did not move"), { state: { kind: "delete", deleted: 60, total: 109, note: "The failed batch may be partly applied." } });
  const bad = await core.runRecipe(steps, {
    backup: async () => true, markers: async () => ({ added: 3, skipped: 0 }), cut: async () => ({ cuts: 4, points: 4, skipped: 0, rounds: 3 }),
    delete: async () => { throw err; },
  });
  const t = core.outcomeText(bad, steps);
  assert.match(t, /Stopped at step 3\/3 \(delete the gaps\): Stopped in batch 2/);
  assert.match(t, /Done before that: 3 markers added; 4 cuts made\./);
  assert.match(t, /On the timeline: 60 of 109 gap pieces are deleted, 49 are still there\. The failed batch may be partly applied\./);
  const stopped = await core.runRecipe(steps, {
    backup: async () => true, markers: async () => ({ added: 0, skipped: 3 }), cut: async () => ({ cuts: 0, points: 0, skipped: 0, rounds: 0 }),
    delete: async () => ({ deleted: 60, total: 109, rounds: 2, stopped: true, deletedSeconds: 100 }), shouldStop: () => false,
  });
  assert.match(core.outcomeText(stopped, steps), /Stopped by you\. Done: .*60 gap pieces deleted of 109 \(100 s\)\. The delete stopped after batch 2: 60 of 109 gap pieces are deleted, 49 not yet\. Run it again to finish/);
});

test("pre-flight with the delete step: shows the preview, fails with the guard's reason, and a delete-only recipe needs no workspace", () => {
  const { ranges, pieces } = realVod();
  const good = core.planGapDelete(pieces, ranges, { frame: F60 });
  const facts = (over = {}) => baseFacts({ recipe: { markers: false, clips: true, chapters: false, deleteGaps: true }, markerCount: 0, markers: null, gaps: good, ...over });
  const r = core.evaluatePreflight(facts());
  assert.equal(r.ok, true);
  assert.match(r.summary, /^cut at clips: 28 cuts in 5 rounds, then delete the gaps: 109 pieces, 31,0\d\d s, 90\.\d%; keep 108 pieces, 3,283 s, after one backup of the sequence\.$/);
  assert.ok(r.checks.some((c) => /Delete the gaps: 109 pieces/.test(c.text)));
  const refused = core.evaluatePreflight(facts({ gaps: core.planGapDelete(pieces, ranges, { frame: F60, maxDeletePct: 80 }) }));
  assert.equal(refused.ok, false);
  assert.match(refused.problems[0], /^Delete the gaps: It would delete 90\.\d% of the timeline; the limit in Settings is 80%/);
  // delete only: no empty tracks are needed, and nothing is "already done" while gaps are left
  const only = core.evaluatePreflight(facts({ recipe: { markers: false, clips: false, chapters: false, deleteGaps: true }, workspace: { videoTrack: 0, video: -1, audio: [{ track: 0, free: -1 }] }, pending: 0 }));
  assert.equal(only.ok, true, only.problems.join(" "));
  assert.equal(only.alreadyDone, false);
  assert.ok(!only.checks.some((c) => /workspace/.test(c.text)));
  // no gap left: already done
  const none = core.planGapDelete([piece(100, 130)], [{ start: 100, end: 130 }], { frame: F60 });
  const done = core.evaluatePreflight(facts({ recipe: { markers: false, clips: false, chapters: false, deleteGaps: true }, gaps: none, pending: 0 }));
  assert.equal(done.alreadyDone, true);
  assert.ok(done.checks.some((c) => /no gap piece is left/.test(c.text)));
  // a delete-only recipe on an unreadable timeline
  const noTl = core.evaluatePreflight(facts({ recipe: { markers: false, clips: false, chapters: false, deleteGaps: true }, timeline: null, workspace: null, timelineError: "no clip", gaps: null }));
  assert.match(noTl.problems[0], /The timeline cannot be read: no clip/);
});

test("auto-run never runs a recipe that deletes, and says why", () => {
  const ok = core.evaluatePreflight(baseFacts());
  const v = core.autoRunVerdict({ enabled: true, autoLoaded: true, key: "k", ranKey: "", pre: ok, deletes: true });
  assert.equal(v.run, false);
  assert.match(v.why, /Auto-run skipped: the recipe deletes the gaps, which always needs your confirmation/);
  assert.equal(core.autoRunVerdict({ enabled: true, autoLoaded: true, key: "k", ranKey: "", pre: ok, deletes: false }).run, true);
});

test("progressText names the unit and the round word (0.7.0: batches of gap pieces)", () => {
  assert.equal(core.progressText({ step: 3, steps: 3, label: "deleting gaps", roundLabel: "batch", round: 2, rounds: 4, done: 60, total: 109, unit: "gap pieces" }), "Step 3/3 · deleting gaps · batch 2/4 · 60 of 109 gap pieces");
});

// ---- 0.7.3: what a ripple delete may leave (checkRippleHoles) ------------------------------------------------------
test("checkRippleHoles: an exact ripple has no hole and nothing to close", () => {
  const f = 1 / 60;
  const before = [{ S: 0, E: 100, I: 0, O: 100 }, { S: 100, E: 130, I: 100, O: 130 }, { S: 130, E: 300, I: 130, O: 300 }, { S: 300, E: 340, I: 300, O: 340 }];
  const after = [{ S: 0, E: 30, I: 100, O: 130 }, { S: 30, E: 70, I: 300, O: 340 }];
  const r = core.checkRippleHoles(before, new Set([0, 2]), after, f);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.fills.length, r.leadFill, r.holeSeconds], [0, null, 0]);
});

test("checkRippleHoles: the shape of the real log (a one-frame hole per removed piece) passes and lists the holes to close", () => {
  const f = 1 / 60;
  const before = [{ S: 0, E: 671.997, I: 0, O: 671.997 }, { S: 671.997, E: 701.997, I: 671.997, O: 701.997 }, { S: 701.997, E: 711.997, I: 701.997, O: 711.997 }, { S: 711.997, E: 741.997, I: 711.997, O: 741.997 }, { S: 741.997, E: 755.997, I: 741.997, O: 755.997 }, { S: 755.997, E: 785.997, I: 755.997, O: 785.997 }];
  const after = [{ S: f, E: 30 + f, I: 671.997, O: 701.997 }, { S: 30 + 2 * f, E: 60 + 2 * f, I: 711.997, O: 741.997 }, { S: 60 + 3 * f, E: 90 + 3 * f, I: 755.997, O: 785.997 }];
  const r = core.checkRippleHoles(before, new Set([0, 2, 4]), after, f);
  assert.strictEqual(r.ok, true, r.problems.join("; "));
  assert.deepStrictEqual(r.fills.map((h) => [h.i, h.removed]), [[0, 1], [1, 1]]);
  assert.ok(r.leadFill && Math.abs(r.leadFill.hole - f) < 1e-9 && r.leadFill.target === 0);
  assert.ok(Math.abs(r.holeSeconds - 3 * f) < 1e-9);
});

test("checkRippleHoles: two adjacent removed pieces may leave two frames, three frames for one piece is refused", () => {
  const f = 1 / 60;
  const before = [{ S: 0, E: 10, I: 0, O: 10 }, { S: 10, E: 20, I: 10, O: 20 }, { S: 20, E: 30, I: 20, O: 30 }];
  const two = core.checkRippleHoles(before, new Set([0, 1]), [{ S: 2 * f, E: 10 + 2 * f, I: 20, O: 30 }], f);
  assert.strictEqual(two.ok, true, two.problems.join("; "));
  const far = core.checkRippleHoles(before, new Set([0]), [{ S: 3 * f, E: 10 + 3 * f, I: 10, O: 20 }, { S: 10 + 3 * f, E: 20 + 3 * f, I: 20, O: 30 }], f);
  assert.strictEqual(far.ok, false);
  assert.match(far.problems[0], /starts 50\.0 ms \(3\.00 frames\) from where a ripple puts it, with 1 removed piece\(s\) in front of it/);
});

test("checkRippleHoles: refuses a piece that closed too far, a changed piece, a hole where nothing was removed, a wrong count", () => {
  const f = 1 / 60;
  const before = [{ S: 0, E: 10, I: 0, O: 10 }, { S: 10, E: 20, I: 10, O: 20 }, { S: 20, E: 30, I: 20, O: 30 }];
  const over = core.checkRippleHoles(before, new Set([0]), [{ S: -f, E: 10 - f, I: 10, O: 20 }, { S: 10 - f, E: 20 - f, I: 20, O: 30 }], f);
  assert.strictEqual(over.ok, false, "closed one frame too far = overlap");
  const changed = core.checkRippleHoles(before, new Set([0]), [{ S: 0, E: 10, I: 10.5, O: 20.5 }, { S: 10, E: 20, I: 20, O: 30 }], f);
  assert.strictEqual(changed.ok, false);
  assert.match(changed.problems[0], /plays source 10\.500-20\.500/);
  const strayHole = core.checkRippleHoles(before, new Set([2]), [{ S: 0, E: 10, I: 0, O: 10 }, { S: 10 + f, E: 20 + f, I: 10, O: 20 }], f);
  assert.strictEqual(strayHole.ok, false, "a hole between two pieces that had nothing removed between them");
  const count = core.checkRippleHoles(before, new Set([0]), [{ S: 0, E: 10, I: 10, O: 20 }], f);
  assert.strictEqual(count.ok, false);
  assert.match(count.problems[0], /1 pieces are there, 2 were expected/);
});

test("checkRippleHoles: a pre-existing gap stays and is not counted as a hole; holes under the fill minimum are not listed", () => {
  const f = 1 / 60;
  const before = [{ S: 0, E: 10, I: 0, O: 10 }, { S: 10, E: 20, I: 10, O: 20 }, { S: 25, E: 35, I: 25, O: 35 }];
  const r = core.checkRippleHoles(before, new Set([0]), [{ S: 0, E: 10, I: 10, O: 20 }, { S: 15, E: 25, I: 25, O: 35 }], f);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fills.length, 0, "the 5 s gap was already there");
  const tiny = core.checkRippleHoles(before, new Set([0]), [{ S: 0.0004, E: 10.0004, I: 10, O: 20 }, { S: 15.0004, E: 25.0004, I: 25, O: 35 }], f);
  assert.strictEqual(tiny.ok, true);
  assert.deepStrictEqual([tiny.fills.length, tiny.leadFill], [0, null]);
});

test("checkRippleHoles without a known frame length is strict (5 ms per removed piece)", () => {
  const before = [{ S: 0, E: 10, I: 0, O: 10 }, { S: 10, E: 20, I: 10, O: 20 }];
  assert.strictEqual(core.checkRippleHoles(before, new Set([0]), [{ S: 0.004, E: 10.004, I: 10, O: 20 }], 0).ok, true);
  assert.strictEqual(core.checkRippleHoles(before, new Set([0]), [{ S: 0.017, E: 10.017, I: 10, O: 20 }], 0).ok, false);
});

test("recipeSteps: markers on the sequence go after the cut and the delete, markers on the clip stay first", () => {
  assert.deepEqual(core.recipeSteps({ placement: "sequence", recipeDeleteGaps: true }), [{ id: "cut", clips: true, chapters: false }, { id: "delete" }, { id: "markers" }]);
  assert.deepEqual(core.recipeSteps({ placement: "sequence", recipeCutClips: false }), [{ id: "markers" }]);
  assert.deepEqual(core.recipeSteps({ placement: "clip", recipeDeleteGaps: true })[0], { id: "markers" });
});

test("v0.15.0: muted markers are recognized and planned", () => {
  const json = JSON.stringify({
    format: core.FORMAT,
    version: 1,
    markers: [
      { kind: "muted", name: "Muted audio", start: 10, end: 40, comment: "Silenced" },
      { kind: "clip", name: "Good clip", start: 50, end: 70, views: 25 },
    ]
  });
  const f = core.parseMarkersFile(json);
  assert.equal(f.markers.length, 2);
  assert.equal(f.skipped, 0);
  assert.equal(f.markers[0].kind, "muted");

  const plan = core.planMarkers(f, {});
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].kind, "muted");
  assert.equal(plan.items[0].color, core.DEFAULT_SETTINGS.mutedColor);
});

test("v0.15.0: preferences from markers file and applyPreferences", () => {
  const json = JSON.stringify({
    format: core.FORMAT,
    version: 1,
    preferences: { pad_before: 5.5, pad_after: 6.0, max_delete_pct: 90 },
    markers: []
  });
  const f = core.parseMarkersFile(json);
  assert.deepEqual(f.preferences, { padBefore: 5.5, padAfter: 6.0, maxDeletePct: 90 });

  const s = core.applyPreferences(core.DEFAULT_SETTINGS, f.preferences);
  assert.equal(s.padBefore, 5.5);
  assert.equal(s.padAfter, 6.0);
  assert.equal(s.maxDeletePct, 90);
});

test("v0.15.0: named recipes and applyRecipe", () => {
  assert.ok(core.DEFAULT_RECIPES.length >= 3);
  const safety = core.DEFAULT_RECIPES.find((r) => r.name.includes("Safety"));
  assert.ok(safety);
  const s = core.applyRecipe(core.DEFAULT_SETTINGS, safety);
  assert.equal(s.padBefore, 5);
  assert.equal(s.padAfter, 5);
  assert.equal(s.activeRecipe, safety.name);
});
