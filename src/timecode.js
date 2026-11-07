// LTTime: seconds <-> frames <-> timecode for the LuckyTwitch CEP port.
//
// ES3 ONLY (no arrow functions, let/const, padStart, Array.isArray, JSON...), so the exact same file runs in Node (tests),
// in the CEP panel and inside ExtendScript. All real math is on INTEGER FRAMES; seconds are only converted once, at the edge.
//
// Frame rate comes from the sequence timebase (ticks per frame, Premiere's `sequence.timebase`), never from a typed-in number.
// Timecode is NON-DROP (HH:MM:SS:FF, FF counted with the nominal rate: 60 for 60 and 59.94). Drop-frame (';') is refused on
// purpose: a silently wrong cut is worse than an error.
var LTTime = (function () {
  var TICKS_PER_SECOND = 254016000000;
  var MAX_SAFE = 9007199254740991;

  function fail(msg) { throw new Error("LTTime: " + msg); }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  /** Exact frame rate from the sequence timebase (ticks per frame). 4233600000 -> 60. */
  function fpsFromTimebase(timebase) {
    var tb = Number(timebase);
    if (!(tb > 0)) fail("bad timebase " + timebase);
    return TICKS_PER_SECOND / tb;
  }

  /** The rate the timecode counts frames with: 60 for 60 and 59.94, 30 for 29.97, 24 for 23.976. */
  function nominalFps(fps) {
    var n = Math.round(fps);
    if (!(n >= 1)) fail("bad fps " + fps);
    return n;
  }

  /** Seconds -> the nearest whole frame (half a frame rounds up). */
  function secondsToFrames(seconds, fps) {
    var s = Number(seconds);
    if (!(s >= 0) || s > 1e7) fail("bad seconds " + seconds);
    if (!(fps > 0)) fail("bad fps " + fps);
    return Math.round(s * fps);
  }

  /** Whole frame -> seconds (for display and for comparing against Premiere's float seconds). */
  function framesToSeconds(frames, fps) { return frames / fps; }

  /**
   * Frame -> "HH:MM:SS:FF". `startFrame` is the sequence start timecode in frames (sequence.zeroPoint / timebase), 0 when the
   * sequence starts at 00:00:00:00. QE's timecode includes that start, so it has to be added here.
   */
  function framesToTimecode(frames, fps, startFrame) {
    var base = nominalFps(fps);
    var f = Number(frames);
    if (!(f >= 0) || Math.floor(f) !== f) fail("frames must be a whole number >= 0, got " + frames);
    var total = f + (startFrame ? Number(startFrame) : 0);
    if (!(total >= 0)) fail("timecode before 00:00:00:00");
    var ff = total % base;
    var secs = Math.floor(total / base);
    return pad2(Math.floor(secs / 3600)) + ":" + pad2(Math.floor(secs / 60) % 60) + ":" + pad2(secs % 60) + ":" + pad2(ff);
  }

  /** Seconds -> snapped to the frame grid -> "HH:MM:SS:FF". This is what feeds qe razor(). */
  function secondsToTimecode(seconds, fps, startFrame) {
    return framesToTimecode(secondsToFrames(seconds, fps), fps, startFrame);
  }

  /** "HH:MM:SS:FF" -> frame (minus `startFrame`). Rejects drop-frame and out-of-range fields. */
  function timecodeToFrames(tc, fps, startFrame) {
    var base = nominalFps(fps);
    var m = /^(\d+):(\d\d):(\d\d):(\d\d)$/.exec(String(tc));
    if (!m) {
      if (/;/.test(String(tc))) fail("drop-frame timecode is not supported: " + tc);
      fail("not a timecode: " + tc);
    }
    var mm = Number(m[2]), ss = Number(m[3]), ff = Number(m[4]);
    if (mm > 59 || ss > 59 || ff >= base) fail("timecode field out of range: " + tc);
    var total = ((Number(m[1]) * 60 + mm) * 60 + ss) * base + ff;
    return total - (startFrame ? Number(startFrame) : 0);
  }

  /** Frame -> ticks as a string (what sequence.setPlayerPosition wants). Refuses values a double can't hold exactly. */
  function framesToTicks(frames, timebase) {
    var n = Number(frames) * Number(timebase);
    if (!(n >= 0) || n > MAX_SAFE) fail("ticks out of range for frame " + frames);
    return String(n);
  }

  return {
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    fpsFromTimebase: fpsFromTimebase,
    nominalFps: nominalFps,
    secondsToFrames: secondsToFrames,
    framesToSeconds: framesToSeconds,
    framesToTimecode: framesToTimecode,
    secondsToTimecode: secondsToTimecode,
    timecodeToFrames: timecodeToFrames,
    framesToTicks: framesToTicks
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LTTime;
