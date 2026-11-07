const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("../src/timecode.js");

const TICKS = T.TICKS_PER_SECOND;
const TB60 = TICKS / 60; // 4233600000 ticks per frame
const FPS60 = T.fpsFromTimebase(TB60);

test("timebase -> fps", () => {
  assert.equal(TB60, 4233600000);
  assert.equal(FPS60, 60);
  assert.equal(T.fpsFromTimebase(TICKS / 24), 24);
  assert.equal(T.fpsFromTimebase(TICKS / 25), 25);
  assert.equal(T.fpsFromTimebase(TICKS / 30), 30);
  assert.equal(T.fpsFromTimebase(TICKS / 50), 50);
  assert.throws(() => T.fpsFromTimebase(0));
  assert.throws(() => T.fpsFromTimebase("abc"));
});

test("60 fps known timecodes, incl. every rollover", () => {
  const cases = [
    [0, "00:00:00:00"],
    [1, "00:00:00:01"],
    [59, "00:00:00:59"],
    [60, "00:00:01:00"],
    [3599, "00:00:59:59"],
    [3600, "00:01:00:00"],
    [215999, "00:59:59:59"],
    [216000, "01:00:00:00"],
    [216000 * 10 + 3661, "10:01:01:01"],
  ];
  for (const [frame, tc] of cases) {
    assert.equal(T.framesToTimecode(frame, 60), tc, "frame " + frame);
    assert.equal(T.timecodeToFrames(tc, 60), frame, tc);
  }
});

test("round trip frame -> timecode -> frame, every frame of 2 hours, at several rates", () => {
  for (const rate of [24, 25, 30, 50, 60]) {
    const fps = T.fpsFromTimebase(TICKS / rate);
    for (let f = 0; f <= rate * 7200; f++) {
      const tc = T.framesToTimecode(f, fps);
      if (T.timecodeToFrames(tc, fps) !== f) assert.fail(`${rate} fps frame ${f} -> ${tc}`);
    }
  }
});

test("seconds -> frame is exact for every frame of 3 hours, however the float was produced", () => {
  const frame = 1 / 60;
  let acc = 0; // accumulated by repeated addition: the worst float drift a planner can produce
  for (let k = 0; k <= 60 * 10800; k++) {
    const variants = [k / 60, k * frame, Math.round((k / 60) * 1e6) / 1e6, acc];
    for (const s of variants) {
      const got = T.secondsToFrames(s, 60);
      if (got !== k) assert.fail(`frame ${k}: ${s} gave ${got}`);
    }
    acc += frame;
  }
});

test("seconds off the grid snap to the nearest frame (0.5 frame rounds up)", () => {
  const f = 1 / 60;
  for (const k of [0, 1, 7, 599, 60000, 123456]) {
    assert.equal(T.secondsToFrames(k * f + 0.24 * f, 60), k);
    if (k > 0) assert.equal(T.secondsToFrames(k * f - 0.24 * f, 60), k);
    assert.equal(T.secondsToFrames(k * f + 0.76 * f, 60), k + 1);
  }
  assert.equal(T.secondsToFrames(0.5 * f, 60), 1);
});

test("seconds -> timecode end to end (the path that feeds razor)", () => {
  assert.equal(T.secondsToTimecode(0, 60), "00:00:00:00");
  assert.equal(T.secondsToTimecode(1, 60), "00:00:01:00");
  assert.equal(T.secondsToTimecode(1.0167, 60), "00:00:01:01"); // the 16.67 ms grid: 61.0 frames
  assert.equal(T.secondsToTimecode(3599.9833, 60), "00:59:59:59");
  assert.equal(T.secondsToTimecode(3600, 60), "01:00:00:00");
  assert.equal(T.secondsToTimecode(7384.35, 60), "02:03:04:21");
});

test("59.94: timecode counts with the nominal 60, non-drop", () => {
  const tb = Math.round((TICKS * 1001) / 60000); // 4237833600
  const fps = T.fpsFromTimebase(tb);
  assert.ok(Math.abs(fps - 59.94005994) < 1e-6);
  assert.equal(T.nominalFps(fps), 60);
  assert.equal(T.secondsToFrames(3600, fps), 215784); // 1 real hour is 215784.2 frames
  assert.equal(T.framesToTimecode(215784, fps), "00:59:56:24");
  for (let k = 0; k < 60 * 3600; k += 7) assert.equal(T.secondsToFrames(k / fps, fps), k);
});

test("sequence start offset is added on the way out and removed on the way in", () => {
  const start = 3600 * 60; // sequence starts at 01:00:00:00
  assert.equal(T.framesToTimecode(0, 60, start), "01:00:00:00");
  assert.equal(T.framesToTimecode(61, 60, start), "01:00:01:01");
  assert.equal(T.timecodeToFrames("01:00:01:01", 60, start), 61);
});

test("frames -> ticks", () => {
  assert.equal(T.framesToTicks(0, TB60), "0");
  assert.equal(T.framesToTicks(1, TB60), "4233600000");
  assert.equal(T.framesToTicks(60, TB60), String(TICKS));
  assert.equal(T.framesToTicks(216000 * 8, TB60), String(216000 * 8 * TB60)); // 8 h
  assert.throws(() => T.framesToTicks(216000 * 12, TB60)); // 12 h at 60 fps overflows 2^53: refuse
});

test("bad input is refused, never guessed", () => {
  assert.throws(() => T.secondsToFrames(-0.01, 60));
  assert.throws(() => T.secondsToFrames(NaN, 60));
  assert.throws(() => T.secondsToFrames(Infinity, 60));
  assert.throws(() => T.secondsToFrames("x", 60));
  assert.throws(() => T.secondsToFrames(1, 0));
  assert.throws(() => T.framesToTimecode(1.5, 60));
  assert.throws(() => T.framesToTimecode(-1, 60));
  assert.throws(() => T.timecodeToFrames("00:00:00;01", 60), /drop-frame/);
  assert.throws(() => T.timecodeToFrames("00:00:00:60", 60), /out of range/);
  assert.throws(() => T.timecodeToFrames("00:60:00:00", 60), /out of range/);
  assert.throws(() => T.timecodeToFrames("nonsense", 60), /not a timecode/);
});

test("source stays ES3 so ExtendScript can load it", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/timecode.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [name, re] of [
    ["arrow function", /=>/], ["let", /\blet\b/], ["const", /\bconst\b/], ["template literal", /`/],
    ["padStart", /padStart/], ["Array.isArray", /Array\.isArray/], ["JSON", /\bJSON\b/], ["trim", /\.trim\(/],
    ["Number.isFinite", /Number\.is/], ["Object.keys", /Object\.keys/], [".map(", /\.map\(/], [".forEach(", /\.forEach\(/],
  ]) assert.ok(!re.test(src), "ES3 violation: " + name);
});
