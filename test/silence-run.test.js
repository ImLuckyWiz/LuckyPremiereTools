"use strict";
// Phase 2 tests for cep-panel/js/silence.js. A real child process is used for every tool call: mock/fake-ffmpeg.js plays ffmpeg and
// ffprobe, so the stream handling (chunks, odd byte counts, exit codes, kill) is exercised for real, not mocked away.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const R = require("../cep-panel/js/silence.js");

const FAKE = path.join(__dirname, "..", "mock", "fake-ffmpeg.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lt-silence-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

let specN = 0;
const writeSpec = (obj) => { const p = path.join(TMP, "media" + ++specN + ".json"); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
/** deps whose spawn runs the fake tool for the commands in `map` ({command: "ffmpeg"|"ffprobe"}) and fails with ENOENT for everything else. */
function deps(map, extra) {
  const calls = [];
  const d = Object.assign({
    env: {}, platform: "linux", home: "/home/t", now: () => Date.now(),
    spawn: (cmd, args, opts) => { calls.push(cmd + " " + args.join(" ")); return map[cmd] ? spawn(process.execPath, [FAKE, map[cmd]].concat(args), opts) : spawn("/nonexistent-lt-test-dir/" + path.basename(cmd), args, opts); },
  }, extra || {});
  d.calls = calls;
  return d;
}
const BOTH = { "/fake/bin/ffmpeg": "ffmpeg", "/fake/bin/ffprobe": "ffprobe" };
const LOUD = 16384, LOUD_LEVEL = LOUD / 32767;
const half = (spec) => Object.assign({ duration: 2, video: { start: 0 }, audio: [{ pattern: [{ sec: 1, amp: 0 }, { sec: 1, amp: LOUD }] }] }, spec);

// ---- candidatePaths (pure) ---------------------------------------------------------------------------------------------------------
test("candidatePaths: Windows order is user path, LT_FFMPEG, LuckyDownloader folders, PATH, fixed folders; duplicates removed", () => {
  const env = { LT_FFMPEG: "D:\\x\\ffmpeg.exe", LOCALAPPDATA: "C:\\Users\\L\\AppData\\Local", LUCKYDOWNLOADER_TOOLS_DIR: "E:\\tools", USERPROFILE: "C:\\Users\\L" };
  const got = R.candidatePaths("ffmpeg", { userPath: "D:\\x\\ffmpeg.exe", env, platform: "win32", home: "" }).map((c) => c.path);
  assert.deepEqual(got, [
    "D:\\x\\ffmpeg.exe",                                                       // user path; LT_FFMPEG is the same string, listed once
    "E:\\tools\\ffmpeg.exe",
    "C:\\Users\\L\\AppData\\Local\\LuckyDownloader\\tools\\ffmpeg.exe",
    "C:\\Users\\L\\AppData\\Local\\LuckyTwitch\\tools\\ffmpeg.exe",
    "ffmpeg.exe",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Users\\L\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe",
    "C:\\Users\\L\\scoop\\shims\\ffmpeg.exe",
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
  ]);
});
test("candidatePaths: macOS tries LuckyDownloader and the Homebrew/MacPorts folders BEFORE the bare name (Dock apps have no shell PATH)", () => {
  const got = R.candidatePaths("ffmpeg", { env: { LUCKYTWITCH_TOOLS_DIR: "/opt/lt/" }, platform: "darwin", home: "/Users/m" }).map((c) => c.path);
  assert.deepEqual(got, [
    "/opt/lt/ffmpeg",
    "/Users/m/Library/Application Support/LuckyDownloader/tools/ffmpeg",
    "/Users/m/Library/Application Support/LuckyTwitch/tools/ffmpeg",
    "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg", "ffmpeg",
  ]);
});
test("candidatePaths: ffprobe never uses the ffmpeg-specific entries; Linux is just the bare name; blanks are skipped", () => {
  const got = R.candidatePaths("ffprobe", { userPath: "/x/ffmpeg", env: { LT_FFMPEG: "/y/ffmpeg", LUCKYDOWNLOADER_TOOLS_DIR: "  " }, platform: "linux", home: "/h" }).map((c) => c.path);
  assert.deepEqual(got, ["ffprobe"]);
});

// ---- findFfmpeg ---------------------------------------------------------------------------------------------------------------------
test("findFfmpeg: the user's path wins, its version line is returned, ffprobe is found next to it", async () => {
  const r = await R.findFfmpeg("/fake/bin/ffmpeg", deps(BOTH));
  assert.equal(r.path, "/fake/bin/ffmpeg");
  assert.equal(r.ffprobe, "/fake/bin/ffprobe");
  assert.match(r.version, /^ffmpeg version fake-1\.0/);
});
test("findFfmpeg: a bad user path is skipped (and listed as tried), LT_FFMPEG is next", async () => {
  const r = await R.findFfmpeg("/nope/ffmpeg", deps(BOTH, { env: { LT_FFMPEG: "/fake/bin/ffmpeg" } }));
  assert.equal(r.path, "/fake/bin/ffmpeg");
  assert.equal(r.tried[0].path, "/nope/ffmpeg");
  assert.equal(r.tried[0].ok, false);
  assert.equal(r.tried[0].why, "not found");
});
test("findFfmpeg on a Mac whose app has no PATH: finds Homebrew's ffmpeg and ffprobe", async () => {
  const r = await R.findFfmpeg("", deps({ "/opt/homebrew/bin/ffmpeg": "ffmpeg", "/opt/homebrew/bin/ffprobe": "ffprobe" }, { platform: "darwin", home: "/Users/m", env: {} }));
  assert.equal(r.path, "/opt/homebrew/bin/ffmpeg");
  assert.equal(r.ffprobe, "/opt/homebrew/bin/ffprobe");
  assert.ok(r.tried[0].path.includes("LuckyDownloader"), "LuckyDownloader's folder is tried first");
});
test("findFfmpeg on Windows: LuckyDownloader's tools folder, with ffprobe.exe next to ffmpeg.exe (backslashes kept)", async () => {
  const base = "C:\\Users\\L\\AppData\\Local\\LuckyDownloader\\tools\\";
  const r = await R.findFfmpeg("", deps({ [base + "ffmpeg.exe"]: "ffmpeg", [base + "ffprobe.exe"]: "ffprobe" }, { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\L\\AppData\\Local" } }));
  assert.equal(r.path, base + "ffmpeg.exe");
  assert.equal(r.ffprobe, base + "ffprobe.exe");
});
test("findFfmpeg: nothing found gives one message that names the Choose button and every place it looked", async () => {
  const r = await R.findFfmpeg("", deps({}, { platform: "darwin", home: "/Users/m" }));
  assert.match(r.error, /Choose ffmpeg/);
  assert.match(r.error, /\/opt\/homebrew\/bin\/ffmpeg/);
  assert.match(r.error, /PATH/);
  assert.ok(r.tried.length >= 5 && r.tried.every((t) => !t.ok));
});
test("findFfmpeg: ffmpeg without ffprobe still works (ffprobe: null)", async () => {
  const r = await R.findFfmpeg("/fake/bin/ffmpeg", deps({ "/fake/bin/ffmpeg": "ffmpeg" }));
  assert.equal(r.path, "/fake/bin/ffmpeg");
  assert.equal(r.ffprobe, null);
});
test("findFfmpeg: a program that does not answer like ffmpeg is rejected", async () => {
  const r = await R.findFfmpeg("/fake/bin/ffmpeg", deps({ "/fake/bin/ffmpeg": "ffprobe" }));   // answers "ffprobe version ..."
  assert.ok(r.error);
  assert.match(r.tried[0].why, /did not answer like ffmpeg/);
});
test("findFfmpeg: without Node (no spawn) says so instead of throwing", async () => {
  const r = await R.findFfmpeg("", { spawn: null });
  assert.equal(r.error, R.NO_NODE);
});

// ---- probe ---------------------------------------------------------------------------------------------------------------------------
test("probe: duration, every audio stream with title and its own start (from ffprobe), and the video start", async () => {
  const f = writeSpec({ duration: 5, video: { start: 0.016667 }, audio: [{ title: "Mix", start: 0 }, { title: "Mic", channels: 1, start: 0.163 }] });
  const r = await R.probe("/fake/bin/ffmpeg", "/fake/bin/ffprobe", f, deps(BOTH));
  assert.equal(r.error, undefined);
  assert.equal(r.duration, 5);
  assert.equal(r.videoStart, 0.016667);
  assert.equal(r.startsKnown, true);
  assert.deepEqual(r.audioStreams.map((a) => [a.index, a.title, a.channels, a.start]), [[0, "Mix", 2, 0], [1, "Mic", 1, 0.163]]);
  assert.deepEqual(r.warnings, []);
});
test("probe without ffprobe: still works, but says the start offset is unknown", async () => {
  const f = writeSpec({ duration: 5, video: {}, audio: [{ start: 0.2 }] });
  const r = await R.probe("/fake/bin/ffmpeg", null, f, deps(BOTH));
  assert.equal(r.startsKnown, false);
  assert.equal(r.audioStreams[0].start, null);
  assert.match(r.warnings[0], /ffprobe was not found/);
});
test("probe: a failing ffprobe is a warning, not an error", async () => {
  const f = writeSpec({ duration: 5, video: {}, audio: [{}], mode: "fail" });
  const r = await R.probe("/fake/bin/ffmpeg", "/fake/bin/ffprobe", f, deps(BOTH));
  assert.equal(r.error, undefined);
  assert.equal(r.startsKnown, false);
  assert.match(r.warnings[0], /ffprobe failed/);
});
test("probe: a file with no audio track, a file that is not media, and a missing ffmpeg are clear errors", async () => {
  assert.match((await R.probe("/fake/bin/ffmpeg", "/fake/bin/ffprobe", writeSpec({ duration: 5, video: {}, audio: [] }), deps(BOTH))).error, /no audio track/);
  assert.match((await R.probe("/fake/bin/ffmpeg", "/fake/bin/ffprobe", writeSpec({ mode: "garbage" }), deps(BOTH))).error, /could not read this file as media/);
  assert.match((await R.probe("/nope/ffmpeg", null, writeSpec({ duration: 5, audio: [{}] }), deps(BOTH))).error, /Could not run ffmpeg.*not found/);
});

// ---- measure ---------------------------------------------------------------------------------------------------------------------------
test("measure: one frame per 1/fps, silence is 0, the loud half is about 0.5", async () => {
  const r = await R.measure("/fake/bin/ffmpeg", writeSpec(half()), 30, { duration: 2 }, deps(BOTH));
  assert.equal(r.error, undefined);
  assert.equal(r.levels.length, 60);
  assert.ok(r.levels.slice(0, 30).every((v) => v === 0));
  assert.ok(r.levels.slice(30).every((v) => Math.abs(v - LOUD_LEVEL) < 1e-9));
  assert.equal(r.frames, 60);
  assert.ok(r.seconds >= 0);
});
test("measure: chunks of odd byte length (a 16-bit sample split between two chunks) give exactly the same levels", async () => {
  const spec = half({ duration: 4, audio: [{ pattern: [{ sec: 1.37, amp: 0 }, { sec: 0.4, amp: 300 }, { sec: 1.0, amp: LOUD }, { sec: 1.23, amp: 5 }] }] });
  const a = await R.measure("/fake/bin/ffmpeg", writeSpec(spec), 29.97, { duration: 4 }, deps(BOTH));
  const b = await R.measure("/fake/bin/ffmpeg", writeSpec(Object.assign({}, spec, { mode: "odd" })), 29.97, { duration: 4 }, deps(BOTH));
  assert.ok(a.levels.length > 100);
  assert.deepEqual(b.levels, a.levels);
});
test("measure: two audio tracks are combined by per-frame maximum (loud in either means loud)", async () => {
  const spec = half({ audio: [{ pattern: [{ sec: 1, amp: 0 }, { sec: 1, amp: LOUD }] }, { pattern: [{ sec: 1, amp: LOUD }, { sec: 1, amp: 0 }] }] });
  const r = await R.measure("/fake/bin/ffmpeg", writeSpec(spec), 30, { duration: 2, streams: [{ index: 0, shift: 0 }, { index: 1, shift: 0 }] }, deps(BOTH));
  assert.equal(r.levels.length, 60);
  assert.ok(r.levels.every((v) => Math.abs(v - LOUD_LEVEL) < 1e-9));
});
test("measure: only the requested track is decoded", async () => {
  const spec = half({ audio: [{ pattern: [{ sec: 2, amp: LOUD }] }, { pattern: [{ sec: 2, amp: 0 }] }] });
  const r = await R.measure("/fake/bin/ffmpeg", writeSpec(spec), 30, { duration: 2, streams: [{ index: 1, shift: 0 }] }, deps(BOTH));
  assert.ok(r.levels.every((v) => v === 0));
});
test("measure: a stream that starts 0.5 s late is moved 15 frames later at 30 fps, and the result keeps the video's length", async () => {
  const r = await R.measure("/fake/bin/ffmpeg", writeSpec(half()), 30, { duration: 2, streams: [{ index: 0, shift: 0.5 }] }, deps(BOTH));
  assert.equal(r.levels.length, 60);
  assert.ok(r.levels.slice(0, 45).every((v) => v === 0));
  assert.ok(r.levels.slice(45).every((v) => v > 0.4));
});
test("measure: ffmpeg exiting with an error reports the exit code and the last stderr lines", async () => {
  const r = await R.measure("/fake/bin/ffmpeg", writeSpec(half({ mode: "fail" })), 30, { duration: 2 }, deps(BOTH));
  assert.match(r.error, /exit code 1/);
  assert.match(r.error, /simulated decoder failure/);
});
test("measure: ffmpeg that cannot be started (ENOENT) is a clear error", async () => {
  const r = await R.measure("/nope/ffmpeg", writeSpec(half()), 30, { duration: 2 }, deps(BOTH));
  assert.match(r.error, /Could not start ffmpeg: not found/);
});
test("measure: truncated output (exit 0 but only 40% of the audio) is refused when the duration is known, accepted when it is not", async () => {
  const f = writeSpec(half({ mode: "truncate" }));
  assert.match((await R.measure("/fake/bin/ffmpeg", f, 30, { duration: 2 }, deps(BOTH))).error, /ended early/);
  const r = await R.measure("/fake/bin/ffmpeg", f, 30, {}, deps(BOTH));          // no duration: nothing to compare with
  assert.equal(r.error, undefined);
  assert.equal(r.levels.length, 24);
});
test("measure: stopping in the middle kills ffmpeg and returns {error:'stopped'}", async () => {
  const f = writeSpec({ duration: 5, audio: [{ pattern: [{ sec: 5, amp: LOUD }] }], mode: "slow" });
  let polls = 0;
  const t0 = Date.now();
  const r = await R.measure("/fake/bin/ffmpeg", f, 30, { duration: 5, isStopped: () => ++polls > 3 }, deps(BOTH));
  assert.deepEqual(r, { error: "stopped", stopped: true });
  assert.ok(polls >= 4);
  assert.ok(Date.now() - t0 < 2000, "it must not wait for the whole file");
});
test("measure: stopped before the start never launches ffmpeg", async () => {
  const d = deps(BOTH);
  const r = await R.measure("/fake/bin/ffmpeg", writeSpec(half()), 30, { duration: 2, isStopped: () => true }, d);
  assert.equal(r.stopped, true);
  assert.equal(d.calls.length, 0);
});
test("measure: progress goes up, never past 1, and ends at exactly 1 (two tracks count as two halves)", async () => {
  const f = writeSpec({ duration: 3, audio: [{ pattern: [{ sec: 3, amp: LOUD }] }, { pattern: [{ sec: 3, amp: LOUD }] }], mode: "slow" });
  const seen = [];
  const r = await R.measure("/fake/bin/ffmpeg", f, 30, { duration: 3, progressMs: 0, onProgress: (x) => seen.push(x), streams: [{ index: 0, shift: 0 }, { index: 1, shift: 0 }] }, deps(BOTH));
  assert.equal(r.error, undefined);
  assert.ok(seen.length >= 4);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "monotonic");
  assert.ok(seen.every((x) => x >= 0 && x <= 1));
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(seen.some((x) => x > 0.5 && x < 1), "the second track reports its own progress");
});
test("measure: progress is throttled (default 250 ms), and bad input is an error, not a throw", async () => {
  const f = writeSpec({ duration: 3, audio: [{ pattern: [{ sec: 3, amp: LOUD }] }], mode: "slow" });
  let n = 0;
  await R.measure("/fake/bin/ffmpeg", f, 30, { duration: 3, onProgress: () => n++ }, deps(BOTH));
  assert.ok(n <= 6, "at most a handful of reports for a ~0.5 s decode, got " + n);
  assert.match((await R.measure("/fake/bin/ffmpeg", f, 0, {}, deps(BOTH))).error, /frame rate/);
  assert.equal((await R.measure("/fake/bin/ffmpeg", f, 30, {}, { spawn: null })).error, R.NO_NODE);
});
