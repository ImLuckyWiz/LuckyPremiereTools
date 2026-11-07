"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/silence-core.js");

// ---- P1-2: presets, dB helpers, hashParams ---------------------------------------------------------------------------------
test("PRESETS: Tight is auto-editor's defaults, Balanced and Chunky match the plan's Appendix D, every preset sets every field", () => {
  assert.deepEqual(S.PRESETS.Tight, S.DEFAULTS);
  assert.deepEqual(S.PRESETS.Balanced, { threshold: 0.04, marginBefore: 0.25, marginAfter: 0.25, minCut: 0.6, minClip: 0.1 });
  assert.deepEqual(S.PRESETS.Chunky, { threshold: 0.04, marginBefore: 0.3, marginAfter: 0.3, minCut: 1.5, minClip: 0.2 });
  for (const [name, p] of Object.entries(S.PRESETS)) assert.deepEqual(Object.keys(p).sort(), Object.keys(S.DEFAULTS).sort(), name);
});
test("thresholdToDb / dbToThreshold: 0.04 is -27.96 dB, they are inverses, 0 is -Infinity", () => {
  assert.ok(Math.abs(S.thresholdToDb(0.04) - -27.96) < 0.005);
  assert.equal(S.thresholdToDb(1), 0);
  assert.equal(S.thresholdToDb(0), -Infinity);
  assert.equal(S.thresholdToDb(-1), -Infinity);
  for (const x of [0.001, 0.04, 0.5, 1]) assert.ok(Math.abs(S.dbToThreshold(S.thresholdToDb(x)) - x) < 1e-12);
  assert.ok(Math.abs(S.dbToThreshold(-28) - 0.0398) < 0.0001);
});
test("hashParams: 8 hex digits, same for the same data in any key order, different when a value changes", () => {
  const h = S.hashParams({ a: 1, b: { y: 2, x: 1 } });
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(S.hashParams({ b: { x: 1, y: 2 }, a: 1 }), h);
  assert.notEqual(S.hashParams({ a: 2, b: { y: 2, x: 1 } }), h);
  assert.notEqual(S.hashParams({ a: 1, b: { y: 2, x: 2 } }), h);
  assert.match(S.hashParams({}), /^[0-9a-f]{8}$/);
  assert.match(S.hashParams(null), /^[0-9a-f]{8}$/);
  // the three presets must never collide (they decide whether a plan is stale)
  const hs = Object.values(S.PRESETS).map(S.hashParams);
  assert.equal(new Set(hs).size, hs.length);
  // known value, so an accidental change of the hash (which would make every saved plan look stale) is caught
  assert.equal(S.hashParams(S.PRESETS.Balanced), "3eadfaa2");
});

// ---- P1-3: parseFfmpegInfo ------------------------------------------------------------------------------------------------
// The test/fixtures/ffmpeg-info-*.txt files are REAL `ffmpeg -i` stderr (ffmpeg 6.1.1) of small files generated with ffmpeg itself:
//   single: H.264 + 1 stereo AAC (mp4) / multitrack: 3 audio streams titled Mix, Mic, Game in an MKV, laid out like an OBS multi-track
//   recording (NOT recorded by OBS) / noaudio: video only / audiooffset: audio that starts 0.228 s after the video / surround51: 5.1 AC3.
const fs = require("node:fs");
const path = require("node:path");
const fixture = (n) => fs.readFileSync(path.join(__dirname, "fixtures", "ffmpeg-info-" + n + ".txt"), "utf8");

test("parseFfmpegInfo: single audio stream", () => {
  assert.deepEqual(S.parseFfmpegInfo(fixture("single")), { duration: 5.01, containerStart: 0, audioStreams: [{ index: 0, rate: 48000, channels: 2, title: "" }] });
});
test("parseFfmpegInfo: OBS-style multi-track file gives every audio stream in order (index = position among audio streams), with titles and a negative container start", () => {
  assert.deepEqual(S.parseFfmpegInfo(fixture("multitrack")), {
    duration: 5.02, containerStart: -0.023,
    audioStreams: [{ index: 0, rate: 48000, channels: 2, title: "Mix" }, { index: 1, rate: 48000, channels: 1, title: "Mic" }, { index: 2, rate: 44100, channels: 2, title: "Game" }],
  });
});
test("parseFfmpegInfo: a video with no audio has an empty audioStreams list (Analyze must refuse it with a clear message)", () => {
  assert.deepEqual(S.parseFfmpegInfo(fixture("noaudio")), { duration: 5, containerStart: 0, audioStreams: [] });
});
test("parseFfmpegInfo: mono, and 5.1 counted as 6 channels", () => {
  assert.equal(S.parseFfmpegInfo(fixture("audiooffset")).audioStreams[0].channels, 1);
  assert.equal(S.parseFfmpegInfo(fixture("surround51")).audioStreams[0].channels, 6);
});
test("parseFfmpegInfo: documents the limit that ffmpeg -i shows only the CONTAINER start, never a stream's own start", () => {
  // The audio of this file starts 0.228 s late (ffprobe: start_time=0.228000), yet `ffmpeg -i` prints "start: 0.000000".
  // If this ever starts failing with a non-zero value, the audio offset became readable and the plan's audioStart can be done.
  const info = S.parseFfmpegInfo(fixture("audiooffset"));
  assert.equal(info.containerStart, 0);
  assert.equal("audioStart" in info, false);
});
test("parseFfmpegInfo: odd and empty input never throws", () => {
  const empty = { duration: null, containerStart: null, audioStreams: [] };
  for (const x of ["", null, undefined, "garbage\nmore garbage", 42]) assert.deepEqual(S.parseFfmpegInfo(x), empty);
  // synthetic one-liners (written by hand, in the shape ffmpeg prints them): unknown duration, language tag, unnamed layout, CRLF
  const t = "Input #0, matroska,webm, from 'x.mkv':\r\n  Duration: N/A, start: 0.000000, bitrate: N/A\r\n  Stream #0:1(eng): Audio: opus, 48000 Hz, 3 channels, fltp (default)\r\n  Stream #0:2: Audio: pcm_s16le, 8000 Hz, whatever, s16\r\n";
  assert.deepEqual(S.parseFfmpegInfo(t), { duration: null, containerStart: 0, audioStreams: [{ index: 0, rate: 48000, channels: 3, title: "" }, { index: 1, rate: 8000, channels: null, title: "" }] });
});
test("parseFfmpegInfo: only the first input is read", () => {
  const t = "Input #0, wav, from 'a.wav':\n  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s\nInput #1, wav, from 'b.wav':\n  Duration: 00:10:00.00, start: 0.000000, bitrate: 1 kb/s\n  Stream #1:0: Audio: pcm_s16le, 48000 Hz, stereo, s16, 1536 kb/s\n";
  const i = S.parseFfmpegInfo(t);
  assert.equal(i.duration, 1);
  assert.equal(i.audioStreams.length, 1);
});
test("parseFfmpegInfo: hours are read (a 3 hour VOD)", () => {
  assert.equal(S.parseFfmpegInfo("Input #0, mov, from 'v.mp4':\n  Duration: 03:02:11.50, start: 0.000000, bitrate: 1 kb/s\n").duration, 3 * 3600 + 2 * 60 + 11.5);
});

// ---- P1-4: estimateRunSeconds / summarize -----------------------------------------------------------------------------------
// The rows of the table in SILENCE_CUT_PLAN.md section 7.1 (gaps = cuts / 2, one relink pair per gap). Columns are whole seconds; the total
// is in minutes with the rounding the table used (one decimal, whole minutes from 2000 cuts). The total includes planTodo's fixed 4 s final check.
const TABLE = [
  { cuts: 100, cut: 8, del: 11, rel: 11, min: 0.6, tol: 0.05 },
  { cuts: 200, cut: 20, del: 20, rel: 20, min: 1.1, tol: 0.05 },
  { cuts: 500, cut: 103, del: 44, rel: 45, min: 3.3, tol: 0.05 },
  { cuts: 1000, cut: 400, del: 86, rel: 87, min: 9.6, tol: 0.05 },
  { cuts: 2000, cut: 1590, del: 168, rel: 171, min: 32, tol: 0.5 },
  { cuts: 4000, cut: 6347, del: 333, rel: 339, min: 117, tol: 0.5 },
];
test("estimateRunSeconds reproduces every row of the plan's section 7.1 table (columns within 1 s, total within the table's rounding)", () => {
  for (const r of TABLE) {
    const e = S.estimateRunSeconds(r.cuts, r.cuts / 2, r.cuts / 2);
    assert.ok(Math.abs(e.cuts - r.cut) <= 1, `${r.cuts} cuts: razor ${e.cuts.toFixed(1)} vs ${r.cut}`);
    assert.ok(Math.abs(e.deletes - r.del) <= 1, `${r.cuts} cuts: delete ${e.deletes.toFixed(1)} vs ${r.del}`);
    assert.ok(Math.abs(e.relink - r.rel) <= 1, `${r.cuts} cuts: relink ${e.relink.toFixed(1)} vs ${r.rel}`);
    assert.ok(Math.abs(e.total / 60 - r.min) <= r.tol + 1e-9, `${r.cuts} cuts: total ${(e.total / 60).toFixed(2)} min vs ${r.min}`);
    assert.equal(e.total, e.cuts + e.deletes + e.relink + e.final);
  }
});
test("estimateRunSeconds matches the numbers the panel itself uses today (runner.js planTodo: 4 + 15.7*(n/199)^2, 3 + 0.165*gaps, 3 + 0.168*pairs, + 4)", () => {
  const n = 199, e = S.estimateRunSeconds(n, 100, 101);
  assert.ok(Math.abs(e.cuts - (4 + 15.7)) < 1e-9);
  assert.ok(Math.abs(e.deletes - (3 + 0.165 * 100)) < 1e-9);
  assert.ok(Math.abs(e.relink - (3 + 0.168 * 101)) < 1e-9);
  assert.equal(S.estimateRunSeconds(0, 5, 5).total, 0);
  assert.equal(S.estimateRunSeconds(-3, 5, 5).total, 0);
});
test("summarize: speech, silence, percentage, silences, cuts, keeps for a normal file (silence at the start, in the middle and at the end)", () => {
  const s = S.summarize([{ start: 3.5, end: 41.2 }, { start: 44, end: 59 }], 70, 30);
  assert.ok(Math.abs(s.speechSec - 52.7) < 1e-9);
  assert.ok(Math.abs(s.silenceSec - 17.3) < 1e-9);
  assert.ok(Math.abs(s.removedPct - (100 * 17.3) / 70) < 1e-9);
  assert.equal(s.silences, 3); assert.equal(s.cuts, 4); assert.equal(s.keeps, 2);
  assert.ok(s.estSeconds > 0 && s.estSeconds === s.est.total);
});
test("summarize: no speech = one silence and nothing to cut; all speech = nothing to remove; never throws on empty input", () => {
  const none = S.summarize([], 70, 30);
  assert.equal(none.speechSec, 0); assert.equal(none.removedPct, 100); assert.equal(none.silences, 1); assert.equal(none.cuts, 0); assert.equal(none.keeps, 0); assert.equal(none.estSeconds, 0);
  const all = S.summarize([{ start: 0, end: 70 }], 70, 30);
  assert.equal(all.removedPct, 0); assert.equal(all.silences, 0); assert.equal(all.cuts, 0); assert.equal(all.keeps, 1);
  for (const args of [[null, 0, 0], [undefined, undefined, undefined], [[], -5, 30], [[{ start: 5, end: 1 }], 10, 30]]) assert.doesNotThrow(() => S.summarize(...args));
  assert.equal(S.summarize(null, 0, 0).removedPct, 0);
});
test("summarize: ranges that touch have no gap and no cut between them; ranges are clamped to the media", () => {
  const t = S.summarize([{ start: 0, end: 10 }, { start: 10, end: 20 }], 30, 30);
  assert.equal(t.silences, 1); assert.equal(t.cuts, 1); assert.equal(t.keeps, 2);
  const c = S.summarize([{ start: 5, end: 500 }], 30, 30);
  assert.ok(Math.abs(c.speechSec - 25) < 1e-9); assert.equal(c.silences, 1); assert.equal(c.cuts, 1);
});
test("summarize: counts from the real planner win over the ones derived from the ranges", () => {
  const s = S.summarize([{ start: 3.5, end: 41.2 }], 70, 30, { cuts: 10, deleteCount: 5, keepCount: 6 });
  assert.equal(s.cuts, 10); assert.equal(s.silences, 5); assert.equal(s.keeps, 6);
  assert.ok(Math.abs(s.estSeconds - S.estimateRunSeconds(10, 5, 6).total) < 1e-9);
});

// ---- P1-5: the analysis maths (levels, margin, smoothing, chunkify, analyze, sidecar) ----------------------------------------
const core = require("../src/markers-core.js");
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const bools = (s) => s.split("").map((c) => c === "1");
const str = (a) => a.map((v) => (v ? "1" : "0")).join("");
function feed(acc, samples, chunk) { for (let i = 0; i < samples.length; i += chunk) acc.push(samples.subarray(i, Math.min(samples.length, i + chunk))); return acc.finish(); }

test("PeakAccumulator: a sine of known amplitude gives that level in every frame, one level per frame", () => {
  const sr = 48000, fps = 30, A = 16384, s = new Int16Array(sr);
  for (let i = 0; i < s.length; i++) s[i] = Math.round(A * Math.sin((2 * Math.PI * 440 * i) / sr));
  const lv = feed(new S.PeakAccumulator(sr, fps, 1), s, 4096);
  assert.equal(lv.length, 30);
  for (const v of lv) assert.ok(Math.abs(v - A / 32767) < 0.002, String(v));
});
test("PeakAccumulator: the chunk size never changes the result (1 sample, 7, 4096, everything at once)", () => {
  const r = rng(7), s = new Int16Array(2 * 48000 * 2);              // 2 s stereo, interleaved
  for (let i = 0; i < s.length; i++) s[i] = Math.floor((r() - 0.5) * 2 * (r() < 0.2 ? 30000 : 900));
  const ref = feed(new S.PeakAccumulator(48000, 30000 / 1001, 2), s, s.length);
  for (const c of [1, 7, 4096, 100003]) assert.deepEqual(feed(new S.PeakAccumulator(48000, 30000 / 1001, 2), s, c), ref, "chunk " + c);
});
test("PeakAccumulator: fractional frame rates keep the frame count within 1 of duration x fps", () => {
  for (const fps of [30000 / 1001, 60000 / 1001, 24000 / 1001, 25, 50, 60]) {
    const s = new Int16Array(48000 * 10).fill(1000);
    const n = feed(new S.PeakAccumulator(48000, fps, 1), s, 8192).length;
    assert.ok(Math.abs(n - 10 * fps) <= 1, `fps ${fps}: ${n} frames vs ${10 * fps}`);
  }
});
test("PeakAccumulator: a mic on the left channel only reads the same level as mono (the peak is taken over all channels, not averaged)", () => {
  const r = rng(3), mono = new Int16Array(48000), st = new Int16Array(96000);
  for (let i = 0; i < mono.length; i++) { mono[i] = Math.floor((r() - 0.5) * 20000); st[2 * i] = mono[i]; st[2 * i + 1] = 0; }
  assert.deepEqual(feed(new S.PeakAccumulator(48000, 29.97, 2), st, 5000), feed(new S.PeakAccumulator(48000, 29.97, 1), mono, 5000));
  const right = new Int16Array(96000);
  for (let i = 0; i < mono.length; i++) right[2 * i + 1] = mono[i];
  assert.deepEqual(feed(new S.PeakAccumulator(48000, 29.97, 2), right, 5000), feed(new S.PeakAccumulator(48000, 29.97, 1), mono, 5000));
});
test("PeakAccumulator: -32768 counts as full scale (1.0), silence as 0, a partial last bucket is flushed, bad arguments are refused", () => {
  assert.deepEqual(feed(new S.PeakAccumulator(30, 30, 1), Int16Array.from([-32768, 0, 32767]), 2), [1, 0, 1]);
  assert.equal(feed(new S.PeakAccumulator(100, 10, 1), new Int16Array(25).fill(5), 25).length, 3);    // 10 + 10 + a partial 5
  assert.deepEqual(new S.PeakAccumulator(100, 10, 1).finish(), []);
  assert.throws(() => new S.PeakAccumulator(0, 30, 1)); assert.throws(() => new S.PeakAccumulator(48000, 0, 1));
});
test("toFrames rounds like auto-editor (round half up on the value in frames)", () => {
  assert.equal(S.toFrames(0.2, 29.97), 6); assert.equal(S.toFrames(0.25, 30), 8); assert.equal(S.toFrames(0.1, 59.94), 6);
  assert.equal(S.toFrames(0, 30), 0); assert.equal(S.toFrames(1.5, 60), 90);
});

test("applyMargin: start margin only, end margin only, both", () => {
  assert.equal(str(S.applyMargin(bools("0001100000"), 2, 0)), "0111100000");
  assert.equal(str(S.applyMargin(bools("0001100000"), 0, 3)), "0001111100");
  assert.equal(str(S.applyMargin(bools("0001100000"), 2, 1)), "0111110000");
});
test("applyMargin: a margin larger than the gap merges the two sounds; array edges are respected", () => {
  assert.equal(str(S.applyMargin(bools("100100"), 5, 0)), "111100");
  assert.equal(str(S.applyMargin(bools("11000"), 3, 1)), "11100");        // loud at the very start: no start to widen
  assert.equal(str(S.applyMargin(bools("00011"), 1, 4)), "00111");        // loud at the very end: no end to widen
  assert.equal(str(S.applyMargin(bools("0110"), 10, 10)), "1111");        // margins far bigger than the array
  assert.equal(str(S.applyMargin([], 3, 3)), "");
});
test("applyMargin: negative margins shrink the loud part", () => {
  assert.equal(str(S.applyMargin(bools("00111100"), -1, -2)), "00010000");
});
test("applySmoothing: minclip removes short sounds, mincut fills short silences", () => {
  assert.equal(str(S.applySmoothing(bools("0001000000"), 0, 2)), "0000000000");
  assert.equal(str(S.applySmoothing(bools("11101111"), 2, 0)), "11111111");
  assert.equal(str(S.applySmoothing(bools("0111000"), 0, 3)), "0111000");   // exactly minclip long stays
});
test("applySmoothing: both limits interacting settle on a stable result", () => {
  assert.equal(str(S.applySmoothing(bools("10111000000"), 3, 2)), "11111000000");
});
test("applySmoothing: empty input, a lone run shorter than both limits (auto-editor's 2-state loop guard) and an already stable mask terminate", () => {
  assert.equal(str(S.applySmoothing([], 5, 5)), "");
  assert.equal(str(S.applySmoothing([true], 2, 2)), "1");
  assert.equal(str(S.applySmoothing([false], 2, 2)), "0");
  assert.equal(str(S.applySmoothing(bools("0011100"), 2, 2)), "0011100");
});
test("applySmoothing does not modify its input", () => {
  const a = bools("1011"), copy = a.slice();
  S.applySmoothing(a, 3, 3);
  assert.deepEqual(a, copy);
});
test("applySmoothing + chunkify: 300 random masks with random limits terminate and the chunks always tile the whole array", () => {
  const r = rng(99);
  for (let k = 0; k < 300; k++) {
    const n = Math.floor(r() * 300), m = Array.from({ length: n }, () => r() < 0.5);
    const out = S.applySmoothing(m, Math.floor(r() * 25), Math.floor(r() * 25));
    assert.equal(out.length, n);
    const ch = S.chunkify(out);
    assert.equal(ch.reduce((a, c) => a + (c.end - c.start), 0), n);
    for (let i = 0; i < ch.length; i++) {
      assert.ok(ch[i].end > ch[i].start);
      if (i) { assert.equal(ch[i].start, ch[i - 1].end); assert.notEqual(ch[i].keep, ch[i - 1].keep); }
    }
  }
});
test("chunkify: runs, one run, empty", () => {
  assert.deepEqual(S.chunkify(bools("0011100")), [{ start: 0, end: 2, keep: false }, { start: 2, end: 5, keep: true }, { start: 5, end: 7, keep: false }]);
  assert.deepEqual(S.chunkify(bools("111")), [{ start: 0, end: 3, keep: true }]);
  assert.deepEqual(S.chunkify([]), []);
});
test("levelsToMask: a level exactly at the threshold counts as loud (>=)", () => {
  assert.deepEqual(S.levelsToMask([0.0399, 0.04, 0.0401, 0], 0.04), [false, true, true, false]);
});

const NOPAD = { threshold: 0.04, marginBefore: 0, marginAfter: 0, minCut: 0, minClip: 0 };
test("analyze: all silent -> no ranges (and everything is one silence)", () => {
  const a = S.analyze(new Array(90).fill(0), 30, NOPAD);
  assert.deepEqual(a.ranges, []);
  assert.deepEqual(a.stats, { frames: 90, keepFrames: 0, cutFrames: 90, silences: 1 });
});
test("analyze: all loud -> one range [0, n/fps]", () => {
  const a = S.analyze(new Array(90).fill(0.5), 30, NOPAD);
  assert.deepEqual(a.ranges, [{ start: 0, end: 3 }]);
  assert.equal(a.stats.silences, 0);
});
test("analyze: silence at the start and at the end, ranges in seconds", () => {
  const lv = new Array(60).fill(0); for (let i = 15; i < 45; i++) lv[i] = 0.3;
  const a = S.analyze(lv, 30, NOPAD);
  assert.deepEqual(a.ranges, [{ start: 0.5, end: 1.5 }]);
  assert.deepEqual(a.stats, { frames: 60, keepFrames: 30, cutFrames: 30, silences: 2 });
});
test("analyze: threshold exactly equal to a level counts as loud; empty input is fine", () => {
  assert.deepEqual(S.analyze([0, 0.04, 0], 30, NOPAD).ranges, [{ start: 1 / 30, end: 2 / 30 }]);
  const e = S.analyze([], 30, {});
  assert.deepEqual(e.ranges, []); assert.equal(e.stats.frames, 0);
});
test("analyze: margin runs BEFORE smoothing (a gap that the margins close is never seen as a silence to cut)", () => {
  const lv = new Array(100).fill(0); lv[10] = 0.5; lv[16] = 0.5;      // two blips 5 frames apart
  const p = { threshold: 0.04, marginBefore: 0.1, marginAfter: 0.1, minCut: 0, minClip: 0 };   // 3 frames each side at 30 fps
  const a = S.analyze(lv, 30, p);
  assert.equal(a.ranges.length, 1);                                    // 7..19 merged by the margins
  assert.deepEqual(a.ranges[0], { start: 7 / 30, end: 20 / 30 });
});
test("analyze: minCut keeps a 0.4 s pause (filled) and cuts a 0.7 s one when the margins are 0", () => {
  const fps = 30, lv = new Array(300).fill(0);
  for (let i = 0; i < 100; i++) lv[i] = 0.5;                           // speech 0-100
  for (let i = 112; i < 200; i++) lv[i] = 0.5;                         // 12 frame (0.4 s) pause, then speech
  for (let i = 221; i < 300; i++) lv[i] = 0.5;                         // 21 frame (0.7 s) pause, then speech
  const a = S.analyze(lv, fps, { threshold: 0.04, marginBefore: 0, marginAfter: 0, minCut: 0.6, minClip: 0.1 });   // minCut = 18 frames
  assert.deepEqual(a.ranges, [{ start: 0, end: 200 / fps }, { start: 221 / fps, end: 10 }]);
});
test("analyze: with the presets the margins (8 frames at 30 fps for Balanced, 6 for Tight) eat into the pauses first, then minCut decides", () => {
  const fps = 30, lv = new Array(300).fill(0);
  for (let i = 0; i < 100; i++) lv[i] = 0.5;
  for (let i = 112; i < 200; i++) lv[i] = 0.5;                         // 12 frame pause: both margins close it
  for (let i = 250; i < 300; i++) lv[i] = 0.5;                         // 50 frame pause: stays
  assert.deepEqual(S.analyze(lv, fps, S.PRESETS.Balanced).ranges, [{ start: 0, end: 208 / fps }, { start: 242 / fps, end: 10 }]);
  assert.deepEqual(S.analyze(lv, fps, S.PRESETS.Tight).ranges, [{ start: 0, end: 206 / fps }, { start: 244 / fps, end: 10 }]);
  assert.deepEqual(S.analyze(lv, fps).ranges, S.analyze(lv, fps, S.DEFAULTS).ranges);      // no params = auto-editor defaults
});

test("buildSilenceFile: passes the unmodified parseMarkersFile with nothing skipped, every loud range is a clip marker, there is NO preferences key", () => {
  const ranges = [{ start: 3.5035, end: 41.2412 }, { start: 44.0444, end: 58.9589 }];
  const meta = { name: "x - part1", fps: 59.94, duration: 70, analyzer: "1", params: S.PRESETS.Balanced, media: { path: "D:/vods/x - part1.mp4", size: 1, mtimeMs: 2 } };
  const f = S.buildSilenceFile(ranges, meta);
  assert.equal("preferences" in f, false);
  const parsed = core.parseMarkersFile(JSON.stringify(f));
  assert.equal(parsed.skipped, 0); assert.equal(parsed.markers.length, 2); assert.equal(parsed.preferences, null);
  assert.ok(parsed.markers.every((m) => m.kind === "clip"));
  assert.deepEqual(parsed.markers.map((m) => [m.start, m.end]), [[3.5035, 41.2412], [44.0444, 58.9589]]);
  assert.equal(parsed.fps, 59.94); assert.equal(parsed.duration, 70);
  assert.equal(S.buildSilenceFile([], meta).markers.length, 0);       // all silent is still a valid object
});

// ---- P0-3: ffprobe stream start times ---------------------------------------------------------------------------------------------
// The three ffprobe-starts-*.txt fixtures are the owner's real ffprobe output for a Twitch VOD (audio 6 ms late, plus a data stream),
// a Twitch VOD whose VIDEO starts one frame late at 60 fps, and an OBS recording whose audio starts 163 ms late.
const probeFixture = (n) => fs.readFileSync(path.join(__dirname, "fixtures", "ffprobe-starts-" + n + ".txt"), "utf8");
test("parseFfprobeStarts: real ffprobe csv from Twitch and OBS files", () => {
  assert.deepEqual(S.parseFfprobeStarts(probeFixture("twitch1")), { videoStart: 0, audioStarts: [0.006] });
  assert.deepEqual(S.parseFfprobeStarts(probeFixture("twitch4")), { videoStart: 0.016667, audioStarts: [0] });
  assert.deepEqual(S.parseFfprobeStarts(probeFixture("obs")), { videoStart: 0, audioStarts: [0.163] });
});
test("parseFfprobeStarts: several audio streams stay in file order, N/A and blanks become null, CRLF is fine, junk never throws", () => {
  assert.deepEqual(S.parseFfprobeStarts("0,video,N/A\r\n1,audio,0.1\r\n2,audio,N/A\r\n3,audio,\r\n4,video,9\r\n"), { videoStart: null, audioStarts: [0.1, null, null] });
  const empty = { videoStart: null, audioStarts: [] };
  for (const x of ["", null, undefined, "garbage", 42, "a,b"]) assert.deepEqual(S.parseFfprobeStarts(x), empty);
});
test("audioShift: OBS audio 163 ms late moves the ranges by +0.163 s; sub-half-frame offsets and missing values move nothing", () => {
  assert.equal(S.audioShift(0, 0.163, 60), 0.163);
  assert.equal(S.audioShift(0, 0.006, 60), 0);                   // 6 ms < half a frame (8.33 ms)
  assert.equal(S.audioShift(0, 0.009, 60), 0.009);
  assert.equal(S.audioShift(null, null, 60), 0);
  assert.equal(S.audioShift(0, 0, 0), 0);
});
test("audioShift: a late VIDEO start means the audio is ahead, so the shift is negative", () => {
  assert.ok(Math.abs(S.audioShift(0.016667, 0, 60) + 0.016667) < 1e-9);
  assert.ok(Math.abs(S.audioShift(0.032667, 0, 60) + 0.032667) < 1e-9);
});
