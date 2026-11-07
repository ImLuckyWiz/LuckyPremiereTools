// Runs the REAL runner.js (cuts phase), guard.js, markers-core.js, timecode.js and host.jsx against a fake Premiere with a working razor.
// Asserts what must happen and exits non-zero if anything differs:   node mock/run-mock-cuts.js
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltcut-"));
  const media = path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.mp4");
  fs.writeFileSync(media, "x");
  fs.writeFileSync(path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.markers.json"), markersFile(108));
  const pi = { name: "v", getMediaPath: () => media, getMarkers: () => ({ numMarkers: 0 }) };
  const tracks = {}, calls = { v: 0, a: 0 }, ctl = { handlers: null };
  const mkClip = (s, e, i) => { const c = { s, e, i }; for (const [k, f] of [["start", "s"], ["end", "e"], ["inPoint", "i"]]) Object.defineProperty(c, k, { get: () => ({ seconds: c[f] / FPS }) });
    Object.defineProperty(c, "outPoint", { get: () => ({ seconds: (c.i + c.e - c.s) / FPS }) }); c.projectItem = pi; c.name = "v"; return c; };
  const mkTrack = (spec) => { const t = { arr: [] }; Object.defineProperty(t.arr, "numItems", { get: () => t.arr.length }); t.clips = t.arr; spec.forEach(([s, e, i]) => t.arr.push(mkClip(s, e, i))); return t; };
  tracks.V1 = mkTrack([[0, END, 0]]); tracks.A1 = mkTrack([[0, END, 0]]);
  tracks.V2 = mkTrack(o.v2 ? [[600, 1200, 0]] : []); tracks.V3 = mkTrack([]); tracks.A2 = mkTrack([]); tracks.A3 = mkTrack([]);
  const split = (t, f) => { const k = t.arr.findIndex((c) => f > c.s && f < c.e); if (k < 0) return; const c = t.arr[k]; t.arr.splice(k, 1, mkClip(c.s, f, c.i), mkClip(f, c.e, c.i + f - c.s)); };
  if (o.preCut) { split(tracks.V1, o.preCut); split(tracks.A1, o.preCut); }
  const razor = (t, kind) => (tc) => {
    const n = ++calls[kind]; let f = T.timecodeToFrames(tc, FPS, 0);
    if (o.missAt && kind === "v" && n === o.missAt) return;
    if (o.a1SkipAt && kind === "a" && n === o.a1SkipAt) return;
    if (o.offAt && n === o.offAt) f += 1;
    if (o.stopAt && kind === "v" && n === o.stopAt) ctl.handlers.rStop();
    split(t, f);
  };
  const group = (names) => { const g = { numTracks: names.length }; names.forEach((n, i) => (g[i] = tracks[n])); return g; };
  const seq = { name: "Seq", timebase: String(TB), zeroPoint: "0", videoTracks: group(["V1", "V2", "V3"]), audioTracks: group(["A1", "A2", "A3"]) };
  const q = { CTI: { timecode: o.dropFrame ? "00:00:00;00" : "00:00:00:00" }, getVideoTrackAt: () => ({ razor: razor(tracks.V1, "v") }), getAudioTrackAt: () => ({ razor: razor(tracks.A1, "a") }) };
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
  return { tracks, els, handlers, calls, host };
}
// Press a button, answer the confirm box ("yes" | "no"), optionally run a hook just before answering, wait for the end text.
function press(S, id, answer, hook) {
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
      if (/CUTS DONE|CUTS PHASE DID NOT FINISH/.test(v) || /PANEL ERROR/.test(v)) { clearInterval(iv); resolve({ log: v, asked }); }
    }, 5);
  });
}
const show = (r) => console.log(r.log.split("\n").filter((l) => !/^\s+\[ok\]/.test(l)).join("\n").trim());
const edgesOf = (t) => t.arr.map((c) => c.s).concat([t.arr[t.arr.length - 1].e]);
const contiguous = (t) => t.arr.every((c, i) => i === 0 || c.s === t.arr[i - 1].e);
const synced = (S) => S.tracks.V1.arr.length === S.tracks.A1.arr.length && S.tracks.V1.arr.every((c, i) => c.s === S.tracks.A1.arr[i].s && c.e === S.tracks.A1.arr[i].e);

(async () => {
  console.log("==== 1. fresh timeline: asks, cuts at every planned point, verifies ====");
  let S = build(), r = await press(S, "rCuts", "yes"); show(r);
  const N = Number((/plan: (\d+) cuts/.exec(r.log) || [0, 0])[1]);
  check("a plan with cuts was read (" + N + " cuts)", N > 100);
  check("it asked first (confirm box)", r.asked);
  check("CUTS DONE", /CUTS DONE/.test(r.log));
  check("V1 and A1 have N+1 pieces", S.tracks.V1.arr.length === N + 1 && S.tracks.A1.arr.length === N + 1, S.tracks.V1.arr.length + "/" + S.tracks.A1.arr.length);
  check("no holes, V1 = A1, covers the whole clip", contiguous(S.tracks.V1) && contiguous(S.tracks.A1) && synced(S) && S.tracks.V1.arr[0].s === 0 && S.tracks.V1.arr[N].e === END);
  check("2 razor calls per cut", S.calls.v === N && S.calls.a === N, S.calls.v + "/" + S.calls.a);
  const done1 = S.tracks.V1.arr.map((c) => c.s).join(",");

  console.log("\n==== 2. run it AGAIN on the cut timeline: nothing left to cut, result checked, no confirm, nothing razored ====");
  const before = S.calls.v; r = await press(S, "rCuts", "yes"); show(r);
  check("says every cut is already there", /Every planned cut is already there/.test(r.log));
  check("did not ask and did not razor", !r.asked && S.calls.v === before);
  check("CUTS DONE and same timeline", /CUTS DONE/.test(r.log) && S.tracks.V1.arr.map((c) => c.s).join(",") === done1);

  console.log("\n==== 3. Stop pressed mid-run: halts consistent, run again RESUMES and finishes ====");
  S = build({ stopAt: 25 }); r = await press(S, "rCuts", "yes"); show(r);
  const part = S.tracks.V1.arr.length - 1;
  check("stopped part way (" + part + " cuts), still consistent", /Stopped by you/.test(r.log) && part > 0 && part < N && contiguous(S.tracks.V1) && synced(S));
  r = await press(S, "rCuts", "yes"); show(r);
  check("second press says how many cuts were already there", new RegExp(part + " cuts are already there").test(r.log) || /already there from an earlier run/.test(r.log));
  check("resumed and finished with exactly N+1 pieces", /CUTS DONE/.test(r.log) && S.tracks.V1.arr.length === N + 1 && S.tracks.V1.arr.map((c) => c.s).join(",") === done1);

  console.log("\n==== 4. you press Cancel: nothing is cut ====");
  S = build(); r = await press(S, "rCuts", "no"); show(r);
  check("nothing cut", S.tracks.V1.arr.length === 1 && S.calls.v === 0 && /Cancelled/.test(r.log));

  console.log("\n==== 5. clip on V2: refused before the first razor ====");
  S = build({ v2: true }); r = await press(S, "rCuts", "yes"); show(r);
  check("refused, nothing cut, never asked", /REFUSED/.test(r.log) && S.calls.v === 0 && !r.asked);

  console.log("\n==== 6. drop-frame sequence: refused ====");
  S = build({ dropFrame: true }); r = await press(S, "rCuts", "yes"); show(r);
  check("refused, nothing cut", /drop-frame/.test(r.log) && S.calls.v === 0);

  console.log("\n==== 7. someone already cut V1/A1 at a frame the plan never asked for: refused ====");
  S = build({ preCut: 100001 }); r = await press(S, "rCuts", "yes"); show(r);
  check("refused, no razor", /did not ask for/.test(r.log) && S.calls.v === 0);

  console.log("\n==== 8. the timeline changes while the confirm box is open: refused, nothing cut ====");
  S = build(); r = await press(S, "rCuts", "yes", (s) => { s.tracks.V2.arr.push({ s: 600, e: 1200, i: 0, start: { seconds: 10 }, end: { seconds: 20 }, inPoint: { seconds: 0 }, outPoint: { seconds: 10 } }); });
  show(r);
  check("refused after the box, nothing cut", /changed while the box was open/.test(r.log) && S.calls.v === 0);

  console.log("\n==== 9. Premiere ignores one V1 razor (A1 still cuts): caught after that chunk ====");
  S = build({ missAt: 15 }); // the V1 razor is skipped at call 15, A1 still cuts -> V1 and A1 piece counts differ
  r = await press(S, "rCuts", "yes"); show(r);
  check("FAIL reported with the counts, stopped, no CUTS DONE", /FAIL after cut/.test(r.log) && !/CUTS DONE/.test(r.log) && S.tracks.V1.arr.length < N + 1);

  console.log("\n==== 10. the A1 razor is skipped once: caught ====");
  S = build({ a1SkipAt: 40 }); r = await press(S, "rCuts", "yes"); show(r);
  check("FAIL reported, stopped", /FAIL after cut/.test(r.log) && !/CUTS DONE/.test(r.log));

  console.log("\n==== 11. Premiere cuts ONE frame off on both tracks (counts still add up): the final read-back must FAIL ====");
  S = build({ offAt: 60 }); r = await press(S, "rCuts", "yes"); show(r);
  check("final check FAIL, not CUTS DONE", /check: FAIL/.test(r.log) && !/CUTS DONE/.test(r.log), r.log.split("\n").filter((l) => /check:/.test(l)).join(" "));

  console.log(failures.length ? "\n" + failures.length + " CHECK(S) FAILED: " + failures.join("; ") : "\nALL CHECKS PASSED");
  process.exit(failures.length ? 1 : 0);
})();
