"use strict";
// Node side of Silence mode (SILENCE_CUT_PLAN.md section 6.2 and "Phase 0/1 outcome"). Runs inside the panel (CEP, Node 17.7.2,
// --enable-nodejs --mixed-context) and in plain Node for the tests. It only finds ffmpeg, reads file facts and measures loudness;
// it never touches Premiere, the timeline or any plan file.
//
// API (all promises, none of them throws; failures come back as {error: "text for the log"}):
//   LTSilenceRun.findFfmpeg(userPath)                 -> {path, version, ffprobe: path|null, tried} | {error, tried}
//   LTSilenceRun.probe(ffmpegPath, ffprobePath, media) -> {duration, containerStart, videoStart, startsKnown, warnings, audioStreams:[{index, rate, channels, title, start}]} | {error}
//   LTSilenceRun.measure(ffmpegPath, media, fps, {streams:[{index, shift}], duration, onProgress, isStopped}) -> {levels, frames, seconds} | {error} | {error:"stopped", stopped:true}
//   LTSilenceRun.candidatePaths(tool, ctx)            -> [{path, label}]   (pure; the search order, exported for the tests)
// Every function takes an optional last argument `deps` ({spawn, env, platform, home, now}) so the tests can use a fake ffmpeg.
// Node 17.7.2 is what the panel runs: no fetch, nothing from Node 18+.
(function (root) {
  const NO_NODE = "Node is not enabled for this panel (typeof require is not a function). Reinstall the panel so the manifest enables Node; Analyze needs it.";
  const OUT_CAP = 256 * 1024;                       // text kept from a tool's stdout / stderr
  const SAMPLE_RATE = 48000, CHANNELS = 2;          // decision D3: -ac 2 -ar 48000 -f s16le

  let CoreCache = null;
  function core() {
    if (CoreCache) return CoreCache;
    if (typeof window !== "undefined" && window.LTSilence) CoreCache = window.LTSilence;               // the panel: loaded by index.html before this file
    else if (typeof require === "function") CoreCache = require("../../src/silence-core.js");           // plain Node (tests)
    return CoreCache;
  }

  function defaultDeps() {
    const d = { now: () => Date.now(), env: {}, platform: "linux", home: "", spawn: null };
    if (typeof require === "function") {
      try { d.spawn = require("child_process").spawn; } catch (e) { /* stays null */ }
      try { const os = require("os"); d.platform = os.platform(); d.home = os.homedir(); } catch (e) { /* keep defaults */ }
    }
    if (typeof process !== "undefined" && process.env) d.env = process.env;
    return d;
  }
  const withDeps = (deps) => Object.assign(defaultDeps(), deps || {});

  // ---- where to look for ffmpeg / ffprobe ---------------------------------------------------------------------------------------
  /**
   * The search order (owner decision Q1 + P0-4): the path the user chose, env LT_FFMPEG, LuckyDownloader's tool folders, the usual fixed
   * folders, then the bare name (the PATH). ctx = {userPath, env, platform, home}. tool = "ffmpeg" | "ffprobe" (for ffprobe the two
   * "ffmpeg path" entries are left out). Pure; duplicates removed; blank entries skipped.
   * macOS apps started from the Dock do not inherit the shell PATH, so Homebrew/MacPorts folders come BEFORE the bare name there.
   */
  function candidatePaths(tool, ctx) {
    const c = ctx || {}, env = c.env || {}, win = c.platform === "win32", mac = c.platform === "darwin", sep = win ? "\\" : "/";
    const exe = tool + (win ? ".exe" : "");
    const join = (dir) => (dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + sep) + exe;
    const out = [], seen = Object.create(null);
    const has = (v) => typeof v === "string" && v.trim() !== "";                    // an env var that is empty or only spaces counts as not set
    const add = (p, label) => { if (typeof p === "string" && p.trim() && !seen[p]) { seen[p] = true; out.push({ path: p, label: label }); } };
    if (tool === "ffmpeg") { add(c.userPath, "the path chosen in the panel"); add(env.LT_FFMPEG, "environment variable LT_FFMPEG"); }
    if (has(env.LUCKYDOWNLOADER_TOOLS_DIR)) add(join(env.LUCKYDOWNLOADER_TOOLS_DIR), "LUCKYDOWNLOADER_TOOLS_DIR");
    if (has(env.LUCKYTWITCH_TOOLS_DIR)) add(join(env.LUCKYTWITCH_TOOLS_DIR), "LUCKYTWITCH_TOOLS_DIR");
    if (win && has(env.LOCALAPPDATA)) {
      add(join(env.LOCALAPPDATA + "\\LuckyDownloader\\tools"), "LuckyDownloader tools folder");
      add(join(env.LOCALAPPDATA + "\\LuckyTwitch\\tools"), "LuckyTwitch tools folder (older)");
    }
    if (mac && has(c.home)) {
      add(join(c.home + "/Library/Application Support/LuckyDownloader/tools"), "LuckyDownloader tools folder");
      add(join(c.home + "/Library/Application Support/LuckyTwitch/tools"), "LuckyTwitch tools folder (older)");
    }
    if (mac) for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]) add(join(dir), "standard macOS folder " + dir);
    add(exe, "PATH");
    if (win) {
      add(join("C:\\ffmpeg\\bin"), "C:\\ffmpeg\\bin");
      if (has(env.LOCALAPPDATA)) add(join(env.LOCALAPPDATA + "\\Microsoft\\WinGet\\Links"), "WinGet links folder");
      if (has(env.USERPROFILE)) add(join(env.USERPROFILE + "\\scoop\\shims"), "Scoop shims");
      add(join("C:\\ProgramData\\chocolatey\\bin"), "Chocolatey");
    }
    return out;
  }

  // ---- running a tool and capturing its text -----------------------------------------------------------------------------------
  function runCapture(d, cmd, args, o) {
    o = o || {};
    return new Promise((resolve) => {
      let child = null, out = "", err = "", done = false, timer = null;
      const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
      try { child = d.spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { finish({ code: null, stdout: "", stderr: "", error: e }); return; }
      child.on("error", (e) => finish({ code: null, stdout: out, stderr: err, error: e }));
      child.stdout.on("data", (b) => { if (out.length < OUT_CAP) out += b.toString("utf8"); });
      child.stderr.on("data", (b) => { if (err.length < OUT_CAP) err += b.toString("utf8"); });
      child.on("close", (code) => finish({ code: code, stdout: out, stderr: err, error: null }));
      if (o.timeoutMs) timer = setTimeout(() => { try { child.kill(); } catch (e) { /* already gone */ } finish({ code: null, stdout: out, stderr: err, error: new Error("timed out after " + o.timeoutMs + " ms"), timedOut: true }); }, o.timeoutMs);
    });
  }

  function why(e) {
    if (!e) return "";
    if (e.code === "ENOENT") return "not found";
    if (e.code === "EACCES" || e.code === "EPERM") return "not allowed to run";
    return String(e.message || e);
  }

  async function validateTool(d, p, tool) {
    const r = await runCapture(d, p, ["-version"], { timeoutMs: 5000 });
    if (r.error) return { ok: false, why: why(r.error) };
    const first = String(r.stdout || "").split(/\r?\n/)[0];
    if (r.code !== 0 || !new RegExp("^" + tool + " version", "i").test(first)) return { ok: false, why: "did not answer like " + tool + " (exit " + r.code + ")" };
    return { ok: true, version: first.trim() };
  }

  const dirOf = (p) => { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i > 0 ? p.slice(0, i) : ""; };

  async function findFfmpeg(userPath, deps) {
    const d = withDeps(deps), tried = [];
    if (typeof d.spawn !== "function") return { error: NO_NODE, tried: tried };
    const ctx = { userPath: userPath, env: d.env, platform: d.platform, home: d.home };
    let found = null;
    for (const c of candidatePaths("ffmpeg", ctx)) {
      const v = await validateTool(d, c.path, "ffmpeg");
      tried.push({ path: c.path, label: c.label, ok: v.ok, why: v.why || "" });
      if (v.ok) { found = { path: c.path, version: v.version }; break; }
    }
    if (!found) {
      return { error: "ffmpeg was not found. Press \"Choose ffmpeg...\" and pick ffmpeg (ffmpeg.exe on Windows). LuckyDownloader installs it for you. Looked in: " + tried.map((t) => t.label + " (" + t.path + "): " + t.why).join("; ") + ".", tried: tried };
    }
    // ffprobe: next to the ffmpeg we found first (same build), then the same search list.
    const exe = "ffprobe" + (d.platform === "win32" ? ".exe" : ""), dir = dirOf(found.path), sib = dir ? dir + (d.platform === "win32" ? "\\" : "/") + exe : null;
    const probeList = [];
    if (sib) probeList.push({ path: sib, label: "next to ffmpeg" });
    for (const c of candidatePaths("ffprobe", ctx)) if (!sib || c.path !== sib) probeList.push(c);
    let ffprobe = null;
    for (const c of probeList) {
      const v = await validateTool(d, c.path, "ffprobe");
      tried.push({ path: c.path, label: c.label, ok: v.ok, why: v.why || "" });
      if (v.ok) { ffprobe = c.path; break; }
    }
    return { path: found.path, version: found.version, ffprobe: ffprobe, tried: tried };
  }

  // ---- reading the file's facts ---------------------------------------------------------------------------------------------------
  async function probe(ffmpegPath, ffprobePath, media, deps) {
    const d = withDeps(deps), C = core();
    if (typeof d.spawn !== "function") return { error: NO_NODE };
    if (!C) return { error: "silence-core is not loaded." };
    const r = await runCapture(d, ffmpegPath, ["-hide_banner", "-nostdin", "-i", media], { timeoutMs: 30000 });   // exit 1 ("no output file") is normal here
    if (r.error) return { error: "Could not run ffmpeg to read the file: " + why(r.error) };
    if (!/^Input #0/m.test(r.stderr)) return { error: "ffmpeg could not read this file as media: " + String(r.stderr || "").trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300) };
    const info = C.parseFfmpegInfo(r.stderr);
    if (!info.audioStreams.length) return { error: "This file has no audio track, so there is no silence to find." };
    const res = { duration: info.duration, containerStart: info.containerStart, videoStart: null, startsKnown: false, warnings: [], audioStreams: info.audioStreams.map((a) => Object.assign({}, a, { start: null })) };
    if (!ffprobePath) { res.warnings.push("ffprobe was not found, so the audio start offset could not be read (OBS recordings can be off by 0.2 s)."); return res; }
    const p = await runCapture(d, ffprobePath, ["-v", "error", "-show_entries", "stream=index,codec_type,start_time", "-of", "csv=p=0", media], { timeoutMs: 30000 });
    if (p.error || p.code !== 0) { res.warnings.push("ffprobe failed (" + (p.error ? why(p.error) : "exit " + p.code) + "), so the audio start offset could not be read."); return res; }
    const st = C.parseFfprobeStarts(p.stdout);
    if (st.audioStarts.length !== res.audioStreams.length) { res.warnings.push("ffprobe and ffmpeg disagree on the number of audio streams (" + st.audioStarts.length + " vs " + res.audioStreams.length + "), so the audio start offset was ignored."); return res; }
    res.videoStart = st.videoStart;
    res.audioStreams.forEach((a, i) => { a.start = st.audioStarts[i]; });
    res.startsKnown = true;
    return res;
  }

  // ---- measuring loudness ---------------------------------------------------------------------------------------------------------
  /** One audio stream -> per-frame peak levels (not yet shifted). Resolves {levels} | {error} | {error:"stopped", stopped:true}. */
  function measureOne(d, C, ffmpegPath, media, fps, k, o) {
    return new Promise((resolve) => {
      let child = null, done = false, err = "", carry = -1, bytes = 0, lastReport = 0;
      const acc = new C.PeakAccumulator(SAMPLE_RATE, fps, CHANNELS);
      const expectedBytes = o.duration > 0 ? o.duration * SAMPLE_RATE * CHANNELS * 2 : 0;
      const finish = (r) => { if (done) return; done = true; resolve(r); };
      const args = ["-v", "error", "-nostdin", "-i", media, "-vn", "-map", "0:a:" + k, "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"];
      if (o.isStopped && o.isStopped()) { finish({ error: "stopped", stopped: true }); return; }
      try { child = d.spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { finish({ error: "Could not start ffmpeg: " + why(e) }); return; }
      child.on("error", (e) => finish({ error: "Could not start ffmpeg: " + why(e) }));
      child.stderr.on("data", (b) => { if (err.length < 64 * 1024) err += b.toString("utf8"); });
      child.stdout.on("data", (chunk) => {
        if (done) return;
        if (o.isStopped && o.isStopped()) { try { child.kill(); } catch (e) { /* gone */ } finish({ error: "stopped", stopped: true }); return; }
        bytes += chunk.length;
        // A Buffer from a stream can sit at an odd byteOffset, and a 16-bit sample can be split between two chunks: copy into an aligned
        // ArrayBuffer and carry a left-over odd byte to the next chunk.
        let buf = chunk;
        if (carry >= 0) { buf = Buffer.concat([Buffer.from([carry]), chunk]); carry = -1; }
        const usable = buf.length - (buf.length & 1);
        if (buf.length & 1) carry = buf[buf.length - 1];
        if (usable > 0) { const ab = new ArrayBuffer(usable); new Uint8Array(ab).set(buf.subarray(0, usable)); acc.push(new Int16Array(ab)); }
        if (o.onProgress && expectedBytes > 0) {
          const t = d.now();
          if (t - lastReport >= (o.progressMs === undefined ? 250 : o.progressMs)) { lastReport = t; o.onProgress(Math.min(1, bytes / expectedBytes)); }
        }
      });
      child.on("close", (code) => {
        if (done) return;
        if (o.isStopped && o.isStopped()) { finish({ error: "stopped", stopped: true }); return; }
        if (code !== 0) { finish({ error: "ffmpeg stopped with exit code " + code + (err.trim() ? ": " + err.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400) : "") }); return; }
        const levels = acc.finish(), expectedFrames = o.duration > 0 ? o.duration * fps : 0;
        if (!levels.length) { finish({ error: "ffmpeg produced no audio data for audio track " + (k + 1) + "." }); return; }
        if (expectedFrames > 0 && levels.length < 0.9 * expectedFrames) { finish({ error: "ffmpeg's audio output ended early (" + levels.length + " of about " + Math.round(expectedFrames) + " frames), so the analysis would be wrong. Nothing was saved." }); return; }
        finish({ levels: levels });
      });
    });
  }

  /**
   * Decodes every requested audio stream (one ffmpeg process each, one after the other), shifts each stream's levels by its start offset
   * (opts.streams[i].shift in seconds, from audioShift(); rounded to whole frames), and combines them by per-frame maximum.
   * opts: {streams: [{index, shift}] (default: track 0, no shift), duration (seconds; enables the truncation check and progress),
   *        onProgress(fraction 0..1, at most every 250 ms), isStopped() (polled for every chunk)}.
   */
  async function measure(ffmpegPath, media, fps, opts, deps) {
    const d = withDeps(deps), C = core(), o = opts || {};
    if (typeof d.spawn !== "function") return { error: NO_NODE };
    if (!C) return { error: "silence-core is not loaded." };
    if (!(fps > 0)) return { error: "The sequence frame rate is unknown." };
    const streams = o.streams && o.streams.length ? o.streams : [{ index: 0, shift: 0 }], started = d.now(), total = o.duration > 0 ? Math.round(o.duration * fps) : null, all = [];
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i];
      const r = await measureOne(d, C, ffmpegPath, media, fps, s.index, {
        duration: o.duration, isStopped: o.isStopped, progressMs: o.progressMs,
        onProgress: o.onProgress ? (f) => o.onProgress((i + f) / streams.length) : null,
      });
      if (r.error) return r.stopped ? { error: "stopped", stopped: true } : { error: streams.length > 1 ? "Audio track " + (s.index + 1) + ": " + r.error : r.error };
      all.push(C.shiftLevels(r.levels, Math.round((s.shift || 0) * fps), total));
    }
    if (o.onProgress) o.onProgress(1);
    const levels = C.combineMax(all);
    return { levels: levels, frames: levels.length, seconds: (d.now() - started) / 1000 };
  }

  const API = { findFfmpeg, probe, measure, candidatePaths, NO_NODE };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (root) root.LTSilenceRun = API;
})(typeof window !== "undefined" ? window : null);
