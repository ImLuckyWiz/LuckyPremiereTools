// Runs the REAL runner.js (cuts + deletes phases), guard.js, markers-core.js, timecode.js and host.jsx against a fake Premiere with a working
// razor and a ripple-delete that behaves like the step 2 logs (deleting the V1 piece does not ripple; deleting the A1 piece afterwards closes
// the gap on every track). Asserts what must happen and exits non-zero otherwise:   node mock/run-mock-deletes.js
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const T = require("../src/timecode.js");
const root = path.join(__dirname, "..");
const FPS = 60, TB = 4233600000, END = 2062800, DUR = 34379.86;
const failures = [];
const check = (name, cond, extra) => { console.log("   " + (cond ? "ok   " : "FAIL ") + name + (cond || !extra ? "" : "  -> " + extra)); if (!cond) failures.push(name); };

function markersFile(nClips) {
  const markers = [{ kind: "game", name: "Just Chatting", start: 0, end: 9000, comment: "Game: Just Chatting", game: "Just Chatting" },
                   { kind: "game", name: "GTA IV", start: 9000, end: DUR, comment: "Game: GTA IV", game: "GTA IV" }];
  for (let i = 0; i < nClips; i++) {
    const start = 100 + i * 300, end = start + 20 + (i % 7);
    markers.push({ kind: "clip", name: "Clip " + i + " (bob, " + (i * 3) + " views)", start, end, views: i * 3, comment: "bob \u00b7 " + (i * 3) + " views", clips: [{ url: "https://clips.twitch.tv/c" + i, creator: "bob", views: i * 3 }] });
  }
  return JSON.stringify({ format: "luckytwitch-markers", version: 1, name: "t", fps: 60, duration: DUR, part: { start: 0, end: DUR }, source: { streamer: "S", title: "T" }, markers });
}

function build(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltdel-"));
  const media = path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.mp4");
  fs.writeFileSync(media, "x");
  fs.writeFileSync(path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.markers.json"), markersFile(108));
  const pi = { name: "v", getMediaPath: () => media, getMarkers: () => ({ numMarkers: 0 }) };
  const tracks = {}, calls = { vr: 0, ar: 0 }, ctl = { handlers: null };
  const mkClip = (t, s, e, i) => {
    const c = { s, e, i, t };
    for (const [k, f] of [["start", "s"], ["end", "e"], ["inPoint", "i"]]) Object.defineProperty(c, k, { get: () => ({ seconds: c[f] / FPS }) });
    Object.defineProperty(c, "outPoint", { get: () => ({ seconds: (c.i + c.e - c.s) / FPS }) });
    c.projectItem = pi; c.name = "v";
    c.remove = (ripple) => {
      const isV = t === tracks.V1; calls[isV ? "vr" : "ar"]++;
      if (isV && o.stopAtRemove && calls.vr === o.stopAtRemove) ctl.handlers.rStop();
      t.arr.splice(t.arr.indexOf(c), 1);
      if (!ripple || o.noRipple) return;
      const partner = isV ? tracks.A1 : t === tracks.A1 ? tracks.V1 : null;
      if (partner && partner.arr.some((x) => x.s < c.e - 0.5 && x.e > c.s + 0.5)) return;   // partner still there: nothing closes yet
      const shift = c.e - c.s - (o.hole || 0);
      for (const tt of Object.values(tracks)) tt.arr.forEach((x) => { if (x.s >= c.e - 0.5) { x.s -= shift; x.e -= shift; } });
    };
    return c;
  };
  const mkTrack = (spec) => { const t = { arr: [] }; Object.defineProperty(t.arr, "numItems", { get: () => t.arr.length }); t.clips = t.arr; spec.forEach(([s, e, i]) => t.arr.push(mkClip(t, s, e, i))); return t; };
  tracks.V1 = mkTrack([[0, END, 0]]); tracks.A1 = mkTrack([[0, END, 0]]);
  tracks.V2 = mkTrack(o.v2 ? [[600, 1200, 0]] : []); tracks.V3 = mkTrack([]); tracks.A2 = mkTrack([]); tracks.A3 = mkTrack([]);
  const split = (t, f) => { const k = t.arr.findIndex((c) => f > c.s && f < c.e); if (k < 0) return; const c = t.arr[k]; t.arr.splice(k, 1, mkClip(t, c.s, f, c.i), mkClip(t, f, c.e, c.i + f - c.s)); };
  const razor = (t) => (tc) => split(t, T.timecodeToFrames(tc, FPS, 0));
  const group = (names) => { const g = { numTracks: names.length }; names.forEach((n, i) => (g[i] = tracks[n])); return g; };
  const seq = { name: "Seq", timebase: String(TB), zeroPoint: "0", videoTracks: group(["V1", "V2", "V3"]), audioTracks: group(["A1", "A2", "A3"]) };
  const q = { CTI: { timecode: "00:00:00:00" }, getVideoTrackAt: () => ({ razor: razor(tracks.V1) }), getAudioTrackAt: () => ({ razor: razor(tracks.A1) }) };
  const host = { app: { project: { activeSequence: seq, path: path.join(dir, "Untitled.prproj") }, enableQE() {}, version: "mock" }, qe: { project: { getActiveSequence: () => q } } };
  vm.createContext(host);
  vm.runInContext(fs.readFileSync(path.join(root, "src/timecode.js"), "utf8"), host);
  vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/jsx/host.jsx"), "utf8"), host);
  const els = {}, handlers = {};
  const el = (id) => els[id] || (els[id] = { value: "", scrollTop: 0, scrollHeight: 0, style: {}, textContent: "", addEventListener(ev, fn) { handlers[id] = fn; } });
  const cepfs = { readdir: (p) => ({ err: 0, data: fs.readdirSync(p) }), readFile: (p) => ({ err: 0, data: fs.readFileSync(p, "utf8") }) };
  const panel = { window: { __adobe_cep__: { evalScript(code, cb) { setImmediate(() => cb(String(vm.runInContext(code, host)))); } }, cep: { fs: cepfs, encoding: { UTF8: "UTF-8" } } },
    document: { getElementById: el }, setTimeout, Promise, Date, JSON, String, Number, Object, Math, Array, isFinite, console };
  vm.createContext(panel);
  vm.runInContext(fs.readFileSync(path.join(root, "src/markers-core.js"), "utf8") + "\nwindow.LTCore = LT_CORE_API;", panel);
  vm.runInContext(fs.readFileSync(path.join(root, "src/guard.js"), "utf8"), panel);
  vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/js/runner.js"), "utf8"), panel);
  ctl.handlers = handlers;
  return { tracks, els, handlers, calls };
}
function press(S, id, answer, hook) {
  const done = id === "rCuts" ? /CUTS DONE|CUTS PHASE DID NOT FINISH/ : /DELETES DONE|DELETES PHASE DID NOT FINISH/;
  return new Promise((resolve) => {
    const start = S.els.log.value.length; let answered = false, asked = false;
    S.handlers[id]();
    const iv = setInterval(() => {
      if (S.els.rAskBox && S.els.rAskBox.style.display === "block" && !answered) {
        answered = true; asked = true;
        if (hook) hook(S);
        if (answer === "yes") S.handlers.rYes(); else S.handlers.rNo();
      }
      const v = S.els.log.value.slice(start);
      if (done.test(v) || /PANEL ERROR/.test(v)) { clearInterval(iv); resolve({ log: v, asked }); }
    }, 5);
  });
}
const show = (r) => console.log(r.log.split("\n").filter((l) => !/^\s+\[ok\]/.test(l)).join("\n").trim());
const contiguous = (t) => t.arr.every((c, i) => (i === 0 ? c.s === 0 : c.s === t.arr[i - 1].e));
const synced = (S) => S.tracks.V1.arr.length === S.tracks.A1.arr.length && S.tracks.V1.arr.every((c, i) => c.s === S.tracks.A1.arr[i].s && c.e === S.tracks.A1.arr[i].e && c.i === S.tracks.A1.arr[i].i);
const cutBuilt = async (o) => { const S = build(o); await press(S, "rCuts", "yes"); return S; };

(async () => {
  console.log("==== 1. fully cut timeline: asks, deletes every gap (last first), verifies every piece position ====");
  let S = await cutBuilt(), pieces0 = S.tracks.V1.arr.length, srcs0 = S.tracks.V1.arr.map((c) => c.i + ":" + (c.e - c.s));
  let r = await press(S, "rDel", "yes"); show(r);
  const G = Number((/(\d+) gap pieces to delete/.exec(r.log) || [0, 0])[1]);
  check("a delete plan was read (" + G + " gaps, " + pieces0 + " pieces before)", G > 50 && pieces0 > G);
  check("it asked first", r.asked);
  check("DELETES DONE", /DELETES DONE/.test(r.log));
  check("V1 and A1 each lost exactly " + G + " pieces", S.tracks.V1.arr.length === pieces0 - G && S.tracks.A1.arr.length === pieces0 - G, S.tracks.V1.arr.length + "/" + S.tracks.A1.arr.length);
  check("no holes, V1 = A1, starts at 0", contiguous(S.tracks.V1) && contiguous(S.tracks.A1) && synced(S));
  check("the timeline got shorter", S.tracks.V1.arr[S.tracks.V1.arr.length - 1].e < END);
  const final1 = S.tracks.V1.arr.map((c) => c.s + "," + c.i).join(";");
  check("only kept pieces are left (source ranges are a subset of what was there)", S.tracks.V1.arr.every((c) => srcs0.indexOf(c.i + ":" + (c.e - c.s)) >= 0));

  console.log("\n==== 2. run D1 AGAIN: no gap left, no confirm, nothing removed, result checked ====");
  const rem = S.calls.vr; r = await press(S, "rDel", "yes"); show(r);
  check("says no gap piece is left", /No gap piece is left/.test(r.log));
  check("did not ask, removed nothing, DELETES DONE", !r.asked && S.calls.vr === rem && /DELETES DONE/.test(r.log));

  console.log("\n==== 3. Stop pressed mid-run: halts consistent, run again RESUMES and ends exactly like run 1 ====");
  S = await cutBuilt({ stopAtRemove: 30 }); r = await press(S, "rDel", "yes"); show(r);
  const mid = S.tracks.V1.arr.length;
  check("stopped part way (" + (pieces0 - mid) + " of " + G + " deleted), consistent", /Stopped by you/.test(r.log) && mid < pieces0 && mid > pieces0 - G && contiguous(S.tracks.V1) && synced(S));
  r = await press(S, "rDel", "yes"); show(r);
  check("resumed and finished identically to run 1", /DELETES DONE/.test(r.log) && S.tracks.V1.arr.map((c) => c.s + "," + c.i).join(";") === final1);

  console.log("\n==== 4. you press Cancel: nothing is deleted ====");
  S = await cutBuilt(); r = await press(S, "rDel", "no"); show(r);
  check("nothing deleted", S.tracks.V1.arr.length === pieces0 && S.calls.vr === 0 && /Cancelled/.test(r.log));

  console.log("\n==== 5. the clip is NOT cut yet: refused, nothing deleted ====");
  S = build(); r = await press(S, "rDel", "yes"); show(r);
  check("refused, never asked", /REFUSED/.test(r.log) && S.calls.vr === 0 && !r.asked);

  console.log("\n==== 6. V1 and A1 out of step (a V1 piece went missing): refused ====");
  S = await cutBuilt(); S.tracks.V1.arr.splice(40, 1); r = await press(S, "rDel", "yes"); show(r);
  check("refused, nothing deleted", /V1 has \d+ pieces but A1 has \d+/.test(r.log) && S.calls.vr === 0);

  console.log("\n==== 7. a clip on V2: refused ====");
  S = await cutBuilt(); S.tracks.V2.arr.push({ s: 600, e: 1200, i: 0, start: { seconds: 10 }, end: { seconds: 20 }, inPoint: { seconds: 0 }, outPoint: { seconds: 10 } });
  r = await press(S, "rDel", "yes"); show(r);
  check("refused, nothing deleted", /There are clips on V2/.test(r.log) && S.calls.vr === 0);

  console.log("\n==== 8. the timeline changes while the confirm box is open: refused, nothing deleted ====");
  S = await cutBuilt(); r = await press(S, "rDel", "yes", (s) => { s.tracks.V1.arr.splice(40, 1); });
  show(r);
  check("refused after the box, nothing deleted", /changed while the box was open/.test(r.log) && S.calls.vr === 0);

  console.log("\n==== 9. Premiere leaves a 1-frame hole at each join: caught on the first pair that has a piece after it, stopped ====");
  S = await cutBuilt({ hole: 1 }); r = await press(S, "rDel", "yes"); show(r);
  check("FAIL names the hole/drift, not DELETES DONE, stopped at pair 2 (pair 1 is the last piece: nothing follows it)", /hole or a drift/.test(r.log) && !/DELETES DONE/.test(r.log) && S.calls.vr === 2 && /1 pair\(s\) done before it/.test(r.log), "vr=" + S.calls.vr);

  console.log("\n==== 10. the ripple does not close the gap at all: caught on the first pair that has a piece after it ====");
  S = await cutBuilt({ noRipple: true }); r = await press(S, "rDel", "yes"); show(r);
  check("FAIL, stopped at pair 2", /FAIL at deletes/.test(r.log) && !/DELETES DONE/.test(r.log) && S.calls.vr === 2, "vr=" + S.calls.vr);

  // ---- padding ("safety cut"): the panel's Settings fields feed every plan ----
  const setField = (S, id, v) => { S.els[id] = Object.assign(S.els[id] || { style: {}, scrollTop: 0, scrollHeight: 0, textContent: "", addEventListener() {} }, { value: String(v) }); };
  const padded = async (a, b, o) => { const S = build(o); setField(S, "padBefore", a); setField(S, "padAfter", b); return S; };
  const clipSrc = (i) => [Math.round((100 + i * 300) * FPS), Math.round((20 + (i % 7)) * FPS)];   // source in frame, length frames of clip i

  console.log("\n==== 11. padding 10 s before / 10 s after: cuts + deletes keep every clip WITH its safety margin ====");
  S = await padded(10, 10); r = await press(S, "rCuts", "yes"); show(r);
  check("cuts done, the settings are logged", /CUTS DONE/.test(r.log) && /keep 10 s before and 10 s after/.test(r.log));
  r = await press(S, "rDel", "yes"); show(r);
  check("DELETES DONE with padding", /DELETES DONE/.test(r.log));
  const kept = S.tracks.V1.arr;
  check("108 kept pieces, V1 = A1, no holes", kept.length === 108 && synced(S) && contiguous(S.tracks.V1), String(kept.length));
  const badPad = kept.filter((c, i) => { const [si, len] = clipSrc(i); return c.i !== si - 10 * FPS || c.e - c.s !== len + 20 * FPS; });
  check("every kept piece starts 10 s before its clip and ends 10 s after it", badPad.length === 0, badPad.length + " wrong, first: " + (badPad[0] ? badPad[0].i + "/" + (badPad[0].e - badPad[0].s) : ""));
  check("the padded timeline is longer than the 3283.67 s of the unpadded run 1 (108 x 20 s of margin)", Math.abs(kept[kept.length - 1].e / FPS - 4638) < 0.5, String(kept[kept.length - 1].e / FPS));

  console.log("\n==== 12. padding so big that neighbouring clips overlap: they are merged, fewer cuts, still exact ====");
  S = await padded(200, 200); r = await press(S, "rCuts", "yes"); show(r);
  check("cuts done", /CUTS DONE/.test(r.log));
  const cuts12 = Number((/plan: (\d+) cuts/.exec(r.log) || [0, 0])[1]);
  check("far fewer cuts than the 215 of the unpadded plan (clips merged): " + cuts12, cuts12 > 0 && cuts12 < 10);
  r = await press(S, "rDel", "yes"); show(r);
  check("DELETES DONE, one big kept piece", /DELETES DONE/.test(r.log) && S.tracks.V1.arr.length === 1 && synced(S));

  console.log("\n==== 13. padding CHANGED between the cut and the delete: the delete must refuse, nothing deleted ====");
  S = await padded(10, 10); await press(S, "rCuts", "yes");
  setField(S, "padBefore", 0); setField(S, "padAfter", 0); r = await press(S, "rDel", "yes"); show(r);
  const n13 = S.tracks.V1.arr.length;
  check("padded cuts + padding set back to 0: refused or nothing wrongly deleted", S.calls.vr === 0 && !/DELETES DONE/.test(r.log) && n13 > 200, "removes=" + S.calls.vr + " pieces=" + n13);
  S = await padded(0, 0); await press(S, "rCuts", "yes");
  setField(S, "padBefore", 10); setField(S, "padAfter", 10); r = await press(S, "rDel", "yes"); show(r);
  check("unpadded cuts + padding raised to 10: refused or nothing wrongly deleted", S.calls.vr === 0 && !/DELETES DONE/.test(r.log) && S.tracks.V1.arr.length > 200, "removes=" + S.calls.vr + " pieces=" + S.tracks.V1.arr.length);

  console.log("\n==== 14. a setting that is not a number: refused with its name, nothing cut ====");
  S = await padded("abc", 10); r = await press(S, "rCuts", "yes"); show(r);
  check("refused naming the setting, nothing cut", /Keep before each clip/.test(r.log) && S.tracks.V1.arr.length === 1 && !r.asked);
  S = await padded("-5", 10); r = await press(S, "rCuts", "yes"); show(r);
  check("negative padding refused", /Keep before each clip/.test(r.log) && S.tracks.V1.arr.length === 1);
  S = await padded("10,5", "10.5"); r = await press(S, "rCuts", "yes"); show(r);
  check("a decimal comma is accepted (10,5 s)", /CUTS DONE/.test(r.log) && /keep 10\.5 s before and 10\.5 s after/.test(r.log));

  console.log(failures.length ? "\n" + failures.length + " CHECK(S) FAILED: " + failures.join("; ") : "\nALL CHECKS PASSED");
  process.exit(failures.length ? 1 : 0);
})();
