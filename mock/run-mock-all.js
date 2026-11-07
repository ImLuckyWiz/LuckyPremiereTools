// Runs the REAL runner.js "DO IT ALL" (markers -> cuts -> deletes -> relink -> final check), guard.js, markers-core.js, timecode.js and host.jsx against a fake
// Premiere that has a marker collection, a working razor, a ripple delete (like the step 2 logs) and a TOGGLING linkSelection with getLinkedItems().
// Asserts what must happen and exits non-zero otherwise:   node mock/run-mock-all.js
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
    markers.push({ kind: "clip", name: "Clip · " + i + " (bob, " + (i * 3) + " views)", start, end, views: i * 3, comment: "bob · " + (i * 3) + " views", clips: [{ url: "https://clips.twitch.tv/c" + i, creator: "bob", views: i * 3 }] });
  }
  return JSON.stringify({ format: "luckytwitch-markers", version: 1, name: "t", fps: 60, duration: DUR, part: { start: 0, end: DUR }, source: { streamer: "S", title: "T" }, markers });
}

function build(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltall-"));
  const media = path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.mp4");
  fs.writeFileSync(media, "x");
  fs.writeFileSync(path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.markers.json"), markersFile(108));
  // markers
  const list = [];
  const mkMarker = (start) => {
    let end = start, color = 0, nm = "";
    const m = { comments: "", type: "Comment" };
    Object.defineProperty(m, "name", { get: () => nm, set: (v) => { nm = String(v); } });
    Object.defineProperty(m, "start", { get: () => ({ seconds: start }) });
    Object.defineProperty(m, "end", { get: () => ({ seconds: end }), set: (v) => { end = v; } });
    m.setColorByIndex = (i) => { color = i; }; m.getColorByIndex = () => color;
    return m;
  };
  const markers = { get numMarkers() { return list.length; }, createMarker(s) { const m = mkMarker(s); list.push(m); return m; },
    getFirstMarker: () => list[0] || null, getNextMarker: (m) => list[list.indexOf(m) + 1] || null, deleteMarker(m) { list.splice(list.indexOf(m), 1); } };
  for (let i = 0; i < (o.existing || 0); i++) { const m = markers.createMarker(5 + i); m.name = "mine " + i; m.comments = "keep me"; }
  const pi = { name: "v", getMarkers: () => markers, getMediaPath: () => media };
  // timeline
  const tracks = {}, calls = { v: 0, a: 0, vr: 0, ar: 0, link: 0 }, ctl = { handlers: null }, selected = new Set(), links = new Map();
  const mkClip = (t, s, e, i) => {
    const c = { s, e, i, t };
    for (const [k, f] of [["start", "s"], ["end", "e"], ["inPoint", "i"]]) Object.defineProperty(c, k, { get: () => ({ seconds: c[f] / FPS }) });
    Object.defineProperty(c, "outPoint", { get: () => ({ seconds: (c.i + c.e - c.s) / FPS }) });
    c.projectItem = pi; c.name = "v"; c.mediaType = t === tracks.V1 ? "Video" : "Audio";
    c.setSelected = (v) => { v ? selected.add(c) : selected.delete(c); };
    c.getLinkedItems = () => (links.has(c) ? [links.get(c)] : []);
    c.remove = (ripple) => {
      const isV = t === tracks.V1; calls[isV ? "vr" : "ar"]++;
      if (isV && o.stopAtRemove && calls.vr === o.stopAtRemove) ctl.handlers.rStop();
      t.arr.splice(t.arr.indexOf(c), 1);
      if (!ripple) return;
      const partner = isV ? tracks.A1 : t === tracks.A1 ? tracks.V1 : null;
      if (partner && partner.arr.some((x) => x.s < c.e - 0.5 && x.e > c.s + 0.5)) return;
      const shift = c.e - c.s;
      for (const tt of Object.values(tracks)) tt.arr.forEach((x) => { if (x.s >= c.e - 0.5) { x.s -= shift; x.e -= shift; } });
    };
    return c;
  };
  const mkTrack = (spec) => { const t = { arr: [] }; Object.defineProperty(t.arr, "numItems", { get: () => t.arr.length }); t.clips = t.arr; spec.forEach(([s, e, i]) => t.arr.push(mkClip(t, s, e, i))); return t; };
  tracks.V1 = mkTrack([[0, END, 0]]); tracks.A1 = mkTrack([[0, END, 0]]);
  tracks.V2 = mkTrack(o.v2 ? [[600, 1200, 0]] : []); tracks.V3 = mkTrack([]); tracks.A2 = mkTrack([]); tracks.A3 = mkTrack([]);
  const split = (t, f) => { const k = t.arr.findIndex((c) => f > c.s && f < c.e); if (k < 0) return; const c = t.arr[k]; t.arr.splice(k, 1, mkClip(t, c.s, f, c.i), mkClip(t, f, c.e, c.i + f - c.s)); };
  const razor = (t, kind) => (tc) => {
    const n = ++calls[kind];
    if (o.missAt && kind === "v" && n === o.missAt) return;
    if (o.stopAtRazor && kind === "v" && n === o.stopAtRazor) ctl.handlers.rStop();
    split(t, T.timecodeToFrames(tc, FPS, 0));
  };
  const group = (names) => { const g = { numTracks: names.length }; names.forEach((n, i) => (g[i] = tracks[n])); return g; };
  const seq = { name: "Seq", timebase: String(TB), zeroPoint: "0", videoTracks: group(["V1", "V2", "V3"]), audioTracks: group(["A1", "A2", "A3"]),
    getSelection: () => Array.from(selected),
    linkSelection() {
      const s = Array.from(selected); const n = ++calls.link;
      if (o.linkSilentAt && n === o.linkSilentAt) return;
      if (s.length !== 2) return;
      if (links.get(s[0]) === s[1]) { links.delete(s[0]); links.delete(s[1]); calls.unlinked = (calls.unlinked || 0) + 1; return; }   // a TOGGLE: a second call unlinks
      links.set(s[0], s[1]); links.set(s[1], s[0]); if (o.linkMoves) s[0].s += 1;
    } };
  const q = { CTI: { timecode: "00:00:00:00" }, getVideoTrackAt: () => ({ razor: razor(tracks.V1, "v") }), getAudioTrackAt: () => ({ razor: razor(tracks.A1, "a") }) };
  const host = { app: { project: { activeSequence: seq, path: path.join(dir, "Untitled.prproj") }, enableQE() {}, version: "mock" }, qe: { project: { getActiveSequence: () => q } } };
  vm.createContext(host);
  if (!o.extUrl) vm.runInContext(fs.readFileSync(path.join(root, "src/timecode.js"), "utf8"), host);
  // o.extUrl: LTTime is NOT preloaded; the panel must load it through $.evalFile from the folder getSystemPath("extension") names (Windows and macOS spellings)
  if (o.extUrl) host.$ = { evalFile(p) { if (p !== o.extExpect + "/shared/timecode.js") throw new Error("evalFile got an unexpected path: " + p); vm.runInContext(fs.readFileSync(path.join(root, "src/timecode.js"), "utf8"), host); } };
  vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/jsx/host.jsx"), "utf8"), host);
  const els = {}, handlers = {};
  const el = (id) => els[id] || (els[id] = { value: "", options: [], appendChild(child) { this.options.push(child); }, scrollTop: 0, scrollHeight: 0, style: {}, textContent: "", className: "", hidden: false, open: false, scrollIntoView() {}, addEventListener(ev, fn) { if (ev === "click") handlers[id] = fn; } });
  const cepfs = { readdir: (p) => ({ err: 0, data: fs.readdirSync(p) }), readFile: (p) => ({ err: 0, data: fs.readFileSync(p, "utf8") }) };
  const panel = { window: { __adobe_cep__: { evalScript(code, cb) { setImmediate(() => { let out; try { out = String(vm.runInContext(code, host)); } catch (e) { out = "EvalScript error."; } cb(out); }); }, getSystemPath: () => o.extUrl }, cep: { fs: cepfs, encoding: { UTF8: "UTF-8" } } },
    document: { getElementById: el, createElement: (tag) => ({ tag, value: "", textContent: "" }) }, setTimeout, clearTimeout, Promise, Date, JSON, String, Number, Object, Math, Array, isFinite, console };
  vm.createContext(panel);
  vm.runInContext(fs.readFileSync(path.join(root, "src/markers-core.js"), "utf8") + "\nwindow.LTCore = LT_CORE_API;", panel);
  vm.runInContext(fs.readFileSync(path.join(root, "src/guard.js"), "utf8"), panel);
  if (o.ui) { panel.window.LTUI_AUTO = false; vm.runInContext(fs.readFileSync(path.join(root, "src/progress.js"), "utf8"), panel); }
  vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/js/runner.js"), "utf8"), panel);
  if (o.ui) vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/js/ui.js"), "utf8"), panel);
  ctl.handlers = handlers;
  return { tracks, els, handlers, calls, list, links, panel };
}
const END_RE = { rAll: /DO IT ALL DONE|DO IT ALL DID NOT FINISH|REFUSED\. Nothing was changed|Cancelled by you/, rCuts: /CUTS DONE|CUTS PHASE DID NOT FINISH/, rDel: /DELETES DONE|DELETES PHASE DID NOT FINISH/, rLink: /RELINK DONE|RELINK PHASE DID NOT FINISH/, rMarkers: /MARKERS DONE|DID NOT FINISH/ };
// press a button; answers EVERY confirm box that appears ("yes" | "no"); counts them; optional hook just before answering the first one
function press(S, id, answer, hook) {
  return new Promise((resolve) => {
    const start = S.els.log.value.length; let asks = 0, shown = false, first = true, texts = [];
    S.handlers[id]();
    const iv = setInterval(() => {
      const vis = S.els.rAskBox && S.els.rAskBox.style.display === "block";
      if (vis && !shown) { shown = true; asks++; texts.push(S.els.rAskText.textContent); if (first && hook) hook(S); first = false; if (answer === "yes") S.handlers.rYes(); else S.handlers.rNo(); }
      if (!vis) shown = false;
      const v = S.els.log.value.slice(start);
      if (END_RE[id].test(v) || /PANEL ERROR/.test(v)) { clearInterval(iv); resolve({ log: v, asks, texts }); }
    }, 5);
  });
}
const show = (r) => console.log(r.log.split("\n").filter((l) => !/^\s+\[ok\]/.test(l) && !/^    \d+\/\d+ (cuts|deleted|pairs|\()/.test(l) && !/pairs processed \(/.test(l)).join("\n").trim().split("\n").slice(0, 400).join("\n"));
const contiguous = (t) => t.arr.every((c, i) => (i === 0 ? c.s === 0 : c.s === t.arr[i - 1].e));
const synced = (S) => S.tracks.V1.arr.length === S.tracks.A1.arr.length && S.tracks.V1.arr.every((c, i) => c.s === S.tracks.A1.arr[i].s && c.e === S.tracks.A1.arr[i].e && c.i === S.tracks.A1.arr[i].i);
const linkedAll = (S) => S.tracks.V1.arr.every((c, i) => S.links.get(c) === S.tracks.A1.arr[i]);
const nLinked = (S) => S.tracks.V1.arr.filter((c, i) => S.links.get(c) === S.tracks.A1.arr[i]).length;
const finished = (S, N) => S.tracks.V1.arr.length === N && synced(S) && contiguous(S.tracks.V1) && linkedAll(S);
const setField = (S, id, v) => { S.els[id] = Object.assign(S.els[id] || { style: {}, scrollTop: 0, scrollHeight: 0, textContent: "", addEventListener() {} }, v); };

(async () => {
  console.log("==== 1. fresh timeline: ONE confirm, then markers + cuts + deletes + relink + final check ====");
  let S = build(), r = await press(S, "rAll", "yes"); show(r);
  check("asked exactly once", r.asks === 1, String(r.asks));
  check("the confirm lists all four steps and the settings", /1\. add 110 markers/.test(r.texts[0]) && /2\. cut at/.test(r.texts[0]) && /3\. ripple-delete/.test(r.texts[0]) && /4\. link/.test(r.texts[0]) && /Settings:/.test(r.texts[0]), r.texts[0]);
  check("DO IT ALL DONE after the final check passed", /DO IT ALL DONE/.test(r.log) && /Final check/.test(r.log) && /check: PASS \d+ pieces on V1 and A1/.test(r.log));
  const N = S.tracks.V1.arr.length;
  check("108 kept pieces, V1 = A1, no holes, every pair linked", N === 108 && finished(S, 108), N + " pieces, " + nLinked(S) + " linked");
  check("110 markers on the clip", S.list.length === 110, String(S.list.length));
  check("each pair linked exactly once (never toggled twice)", S.calls.link === 108 && !S.calls.unlinked, S.calls.link + " calls, " + (S.calls.unlinked || 0) + " unlinks");
  const endState = S.tracks.V1.arr.map((c) => c.s + "," + c.i).join(";");

  console.log("\n==== 2. press it AGAIN on the finished timeline: no confirm, nothing touched, only the final check ====");
  const before = { link: S.calls.link, vr: S.calls.vr, v: S.calls.v, mk: S.list.length }; r = await press(S, "rAll", "yes"); show(r);
  check("said nothing is left to do, did not ask", /Nothing is left to do/.test(r.log) && r.asks === 0);
  check("touched nothing (no link / razor / remove calls, same markers)", S.calls.link === before.link && S.calls.vr === before.vr && S.calls.v === before.v && S.list.length === before.mk);
  check("DO IT ALL DONE, same timeline", /DO IT ALL DONE/.test(r.log) && S.tracks.V1.arr.map((c) => c.s + "," + c.i).join(";") === endState);

  console.log("\n==== 3. you press Cancel: nothing at all is changed ====");
  S = build(); r = await press(S, "rAll", "no"); show(r);
  check("nothing changed (1 piece, no markers, no calls)", /Cancelled by you/.test(r.log) && S.tracks.V1.arr.length === 1 && S.list.length === 0 && S.calls.v === 0 && S.calls.link === 0);

  console.log("\n==== 4. Stop pressed in the middle of the CUTS: halts consistent; pressing again RESUMES (no markers again) and finishes identically ====");
  S = build({ stopAtRazor: 60 }); r = await press(S, "rAll", "yes"); show(r);
  const cutsDone = S.tracks.V1.arr.length - 1;
  check("stopped part way through the cuts, nothing after them ran", /DO IT ALL DID NOT FINISH/.test(r.log) && cutsDone > 0 && cutsDone < 215 && S.calls.vr === 0 && S.calls.link === 0 && S.list.length === 110, cutsDone + " cuts");
  r = await press(S, "rAll", "yes"); show(r);
  check("second press describes the timeline as part cut, and does NOT add the markers again", /part cut \(\d+ of \d+ cuts already there\)/.test(r.log) && !/Markers: Add the markers/.test(r.log) && S.list.length === 110);
  check("resumed to the same final timeline, all linked", /DO IT ALL DONE/.test(r.log) && finished(S, 108) && S.tracks.V1.arr.map((c) => c.s + "," + c.i).join(";") === endState);

  console.log("\n==== 5. Stop pressed in the middle of the DELETES: resumes with 'part deleted' and finishes identically ====");
  S = build({ stopAtRemove: 30 }); r = await press(S, "rAll", "yes"); show(r);
  const midDel = S.tracks.V1.arr.length;
  check("stopped part way through the deletes, nothing linked", /DO IT ALL DID NOT FINISH/.test(r.log) && midDel > 108 && midDel < 217 && S.calls.link === 0, String(midDel));
  r = await press(S, "rAll", "yes"); show(r);
  check("second press says part deleted, skips markers + cuts, finishes", /part deleted \(\d+ gap pieces still there\)/.test(r.log) && !/Cuts: /.test(r.log) && /DO IT ALL DONE/.test(r.log) && finished(S, 108) && S.tracks.V1.arr.map((c) => c.s + "," + c.i).join(";") === endState);

  console.log("\n==== 6. deleted but not linked (the state after the single D1 button): only the relink runs ====");
  S = build(); await press(S, "rMarkers", "yes"); await press(S, "rCuts", "yes"); await press(S, "rDel", "yes");
  r = await press(S, "rAll", "yes"); show(r);
  check("state: deleted, 0 of 108 pairs linked; only the relink step is offered", /deleted, 0 of 108 pairs linked/.test(r.log) && /1\. link 108/.test(r.texts[0]) && !/cut at/.test(r.texts[0]) && !/ripple-delete/.test(r.texts[0]));
  check("DONE and every pair linked", /DO IT ALL DONE/.test(r.log) && finished(S, 108) && S.calls.link === 108);

  console.log("\n==== 7. HALF the pairs already linked: only the unlinked ones are linked, none is toggled twice ====");
  S = build(); await press(S, "rMarkers", "yes"); await press(S, "rCuts", "yes"); await press(S, "rDel", "yes");
  for (let i = 0; i < 50; i++) { const v = S.tracks.V1.arr[i], a = S.tracks.A1.arr[i]; S.links.set(v, a); S.links.set(a, v); }
  r = await press(S, "rAll", "yes"); show(r);
  check("50 of 108 recognised as linked", /deleted, 50 of 108 pairs linked/.test(r.log));
  check("DONE, all linked, exactly 58 link calls, no unlinks", /DO IT ALL DONE/.test(r.log) && linkedAll(S) && S.calls.link === 58 && !S.calls.unlinked, S.calls.link + " calls, " + (S.calls.unlinked || 0) + " unlinks");

  console.log("\n==== 8. a gap piece is still there but a pair is already linked: REFUSED, nothing changed ====");
  S = build({ stopAtRemove: 20 }); await press(S, "rMarkers", "yes"); await press(S, "rCuts", "yes"); await press(S, "rDel", "yes");
  { const v = S.tracks.V1.arr[0], a = S.tracks.A1.arr[0]; S.links.set(v, a); S.links.set(a, v); }
  const lenBefore = S.tracks.V1.arr.length, rm0 = S.calls.vr; r = await press(S, "rAll", "yes"); show(r);
  check("refused (linked pieces + gap pieces left), nothing removed, never asked", /REFUSED/.test(r.log) && /already linked while/.test(r.log) && S.tracks.V1.arr.length === lenBefore && S.calls.vr === rm0 && r.asks === 0, S.tracks.V1.arr.length + " vs " + lenBefore);

  console.log("\n==== 8b. already cut + deleted but the clip has NO markers and the box is ticked: REFUSED up front with the real reason ====");
  S = build(); await press(S, "rCuts", "yes"); await press(S, "rDel", "yes"); const n8 = S.tracks.V1.arr.length;
  r = await press(S, "rAll", "yes"); show(r);
  check("refused before changing anything, says markers can only be added before the first cut", /REFUSED/.test(r.log) && /BEFORE the first cut/.test(r.log) && r.asks === 0 && S.calls.link === 0 && S.tracks.V1.arr.length === n8);
  setField(S, "recipeMarkers", { checked: false }); r = await press(S, "rAll", "yes"); show(r);
  check("with the box unticked the same timeline is finished (relink) and DONE", /DO IT ALL DONE/.test(r.log) && linkedAll(S) && S.list.length === 0);

  console.log("\n==== 9. Premiere silently skips one V1 razor: stopped in the cuts, nothing after ran, no DONE ====");
  S = build({ missAt: 40 }); r = await press(S, "rAll", "yes"); show(r);
  check("did not finish, no deletes, no links, not DONE", /DO IT ALL DID NOT FINISH/.test(r.log) && !/DO IT ALL DONE/.test(r.log) && S.calls.vr === 0 && S.calls.link === 0);

  console.log("\n==== 10. linkSelection silently does nothing for one pair: the relink verify fails, the run does NOT say DONE ====");
  S = build({ linkSilentAt: 30 }); r = await press(S, "rAll", "yes"); show(r);
  check("not DONE, the failure names a pair that is not linked", /DO IT ALL DID NOT FINISH/.test(r.log) && !/DO IT ALL DONE/.test(r.log) && /not linked/.test(r.log));
  check("it did not retry on its own (one link call per pair, 108 max)", S.calls.link <= 108 && !S.calls.unlinked, String(S.calls.link));

  console.log("\n==== 11. linking nudges a clip: caught, stopped ====");
  S = build({ linkMoves: true }); r = await press(S, "rAll", "yes"); show(r);
  check("not DONE, positions-changed failure", /DO IT ALL DID NOT FINISH/.test(r.log) && !/DO IT ALL DONE/.test(r.log) && /changed/.test(r.log));

  console.log("\n==== 12. a clip on V2: REFUSED before anything is touched ====");
  S = build({ v2: true }); r = await press(S, "rAll", "yes"); show(r);
  check("refused, never asked, nothing changed", /REFUSED/.test(r.log) && r.asks === 0 && S.tracks.V1.arr.length === 1 && S.list.length === 0);

  console.log("\n==== 13. markers box unticked: everything else runs, no markers are added ====");
  S = build(); setField(S, "recipeMarkers", { checked: false }); r = await press(S, "rAll", "yes"); show(r);
  check("DONE with 0 markers", /DO IT ALL DONE/.test(r.log) && S.list.length === 0 && finished(S, 108) && !/add \d+ markers/.test(r.texts[0]));

  console.log("\n==== 14. the clip already has 3 markers of the person: they are kept, the 110 are added, the run still finishes ====");
  S = build({ existing: 3 }); r = await press(S, "rAll", "yes"); show(r);
  check("asked once, DONE, 113 markers, the 3 originals untouched", r.asks === 1 && /DO IT ALL DONE/.test(r.log) && S.list.length === 113 && S.list.filter((m) => /^mine/.test(m.name)).length === 3 && finished(S, 108), r.asks + "/" + S.list.length);
  check("the confirm mentions the existing markers", /already has 3 markers|3 marker/.test(r.texts[0]), r.texts[0]);

  console.log("\n==== 15. the timeline changes while the confirm box is open (a V2 clip appears): the first phase refuses, nothing is changed ====");
  S = build(); r = await press(S, "rAll", "yes", (s) => { s.tracks.V2.arr.push({ s: 600, e: 1200, i: 0, start: { seconds: 10 }, end: { seconds: 20 }, inPoint: { seconds: 0 }, outPoint: { seconds: 10 } }); });
  show(r);
  check("did not finish, timeline untouched (1 piece, no cuts, no links)", /DO IT ALL DID NOT FINISH/.test(r.log) && S.tracks.V1.arr.length === 1 && S.calls.v === 0 && S.calls.link === 0);

  console.log("\n==== 16. padding 10/10 + merge: the whole run with settings ====");
  S = build(); setField(S, "padBefore", { value: "10" }); setField(S, "padAfter", { value: "10" }); r = await press(S, "rAll", "yes"); show(r);
  check("DONE with padded pieces, all linked, timeline 4638 s", /DO IT ALL DONE/.test(r.log) && finished(S, 108) && Math.abs(S.tracks.V1.arr[107].e / FPS - 4638) < 0.5, String(S.tracks.V1.arr[S.tracks.V1.arr.length - 1].e / FPS));

  console.log("\n==== 17. the single buttons still work the same (C1, D1, L1 individually on a fresh run) ====");
  S = build(); r = await press(S, "rCuts", "yes"); check("C1 alone: CUTS DONE, asked once", /CUTS DONE/.test(r.log) && r.asks === 1);
  r = await press(S, "rDel", "yes"); check("D1 alone: DELETES DONE, asked once", /DELETES DONE/.test(r.log) && r.asks === 1);
  r = await press(S, "rLink", "yes"); check("L1 alone: RELINK DONE, asked once, all linked", /RELINK DONE/.test(r.log) && r.asks === 1 && linkedAll(S));

  console.log("\n==== 18. RUNNING LOCK: a second press while the confirm is open must not start a second run ====");
  const waitFor = (f, ms) => new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (f() || Date.now() - t0 > (ms || 20000)) { clearInterval(iv); res(f()); } }, 5); });
  const LOCKED = ["rAll", "rDry", "rMarkers", "rRemove", "rCuts", "rDel", "rLink", "rChoose", "rAuto"];
  const boxOpen = (S) => S.els.rAskBox && S.els.rAskBox.style.display === "block";
  S = build(); const start18 = S.els.log.value.length;
  S.handlers.rAll();
  check("the confirm opens", await waitFor(() => boxOpen(S)));
  check("every run button is disabled while the confirm is open, Stop and Continue/Cancel are not", LOCKED.every((id) => S.els[id].disabled === true) && !S.els.rStop.disabled && !S.els.rYes.disabled && !S.els.rNo.disabled);
  S.handlers.rAll(); S.handlers.rCuts(); S.handlers.rMarkers(); S.handlers.rDel();
  await waitFor(() => /Ignored/.test(S.els.log.value.slice(start18)), 500);
  const mid = S.els.log.value.slice(start18);
  check("the extra presses were ignored with a message, no second header", (mid.match(/=== DO IT ALL/g) || []).length === 1 && (mid.match(/Ignored: a run is already active/g) || []).length >= 1, String((mid.match(/=== DO IT ALL/g) || []).length));
  S.handlers.rYes();
  await waitFor(() => /DO IT ALL DONE|DID NOT FINISH/.test(S.els.log.value.slice(start18)));
  await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  const full18 = S.els.log.value.slice(start18);
  check("the first run finished normally: one header, DONE, all linked", (full18.match(/=== DO IT ALL/g) || []).length === 1 && /DO IT ALL DONE/.test(full18) && finished(S, 108));
  check("buttons are enabled again at the end", LOCKED.every((id) => S.els[id].disabled === false));

  console.log("\n==== 19. the lock is released after Cancel, after a refusal, and Stop during a confirm acts as Cancel ====");
  S = build(); r = await press(S, "rAll", "no"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("Cancel: nothing changed, buttons enabled again", /Cancelled by you/.test(r.log) && S.tracks.V1.arr.length === 1 && S.calls.v === 0 && LOCKED.every((id) => S.els[id].disabled === false));
  S = build(); const start19 = S.els.log.value.length; S.handlers.rAll();
  await waitFor(() => boxOpen(S)); S.handlers.rStop();
  await waitFor(() => /Cancelled by you/.test(S.els.log.value.slice(start19)));
  await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("Stop while the confirm is open = Cancel: box closed, nothing changed, buttons enabled", !boxOpen(S) && /Stop pressed while waiting/.test(S.els.log.value) && S.tracks.V1.arr.length === 1 && S.calls.v === 0 && S.calls.link === 0 && LOCKED.every((id) => S.els[id].disabled === false));
  S = build({ v2: true }); r = await press(S, "rAll", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("a refusal also releases the lock", /REFUSED/.test(r.log) && LOCKED.every((id) => S.els[id].disabled === false));
  r = await press(S, "rAll", "yes");
  check("and the button works again afterwards", /REFUSED/.test(r.log));
  S = build(); r = await press(S, "rAll", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("a normal run: the lock is released after DONE", /DO IT ALL DONE/.test(r.log) && LOCKED.every((id) => S.els[id].disabled === false));

  console.log("\n==== 20. THE PANEL'S LOOK (js/ui.js + progress.js on the real runner): pre-flight, progress, final message ====");
  S = build({ ui: true }); const W = S.panel.window, txt = (id) => S.els[id].textContent, v1len = () => S.tracks.V1.arr.length;
  let pfr = await W.LTRunner.preflight();
  check("the pre-flight read everything and changed nothing", pfr && pfr.ok && v1len() === 1 && S.calls.v === 0 && S.calls.link === 0 && S.list.length === 0, JSON.stringify(pfr && pfr.problems));
  check("the plan card says what will happen", /fresh/.test(txt("pfState")) && /^Add \d+ markers/.test(txt("pfMarkersTx")) && /^Cut at \d+ points/.test(txt("pfCutsTx")) && /^Delete \d+ gap/.test(txt("pfDeletesTx")) && /^Link \d+ video/.test(txt("pfRelinkTx")) && S.els.pfMarkers.className === "pf-todo", [txt("pfState"), txt("pfMarkersTx"), txt("pfCutsTx")].join(" | "));
  check("the markers file card shows the file and how it was found", /\.markers\.json$/.test(txt("fileName")) && /next to the video/.test(txt("fileHow")) && S.els.rAuto.hidden === true, txt("fileName") + " / " + txt("fileHow"));
  check("the main button says Do it all with the counts and a rough time; Check again is hidden; pill Ready", txt("rAllLabel") === "Do it all" && /markers .* cuts .* deletes .* links .* about/.test(txt("rAllSub")) && S.els.rAll.hidden === false && S.els.bCheck.hidden === true && txt("pill") === "Ready", txt("rAllSub"));
  check("the single steps show their counts", /to add/.test(txt("cMarkers")) && /cuts to make/.test(txt("cCuts")) && /gaps to delete/.test(txt("cDel")) && /pairs to link/.test(txt("cLink")));
  const widths = [], texts20 = []; let stopOk = true;
  const sampler = setInterval(() => { widths.push(parseInt(S.els.progFill.style.width || "0", 10)); texts20.push(txt("progText")); if (S.els.rAll.disabled === true && S.els.rStop.disabled !== false) stopOk = false; }, 3);
  r = await press(S, "rAll", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000); clearInterval(sampler);
  check("the real run still finishes exactly as before", /DO IT ALL DONE/.test(r.log) && finished(S, 108));
  check("the bar only moves forward and ends at 100%", widths.every((w, i) => i === 0 || w >= widths[i - 1]) && widths.some((w) => w > 0 && w < 100) && S.els.progFill.style.width === "100%" && / f-done/.test(S.els.progFill.className), widths.slice(-5).join(","));
  check("every step row ends done, with its count", ["stMarkers", "stCuts", "stDeletes", "stRelink", "stFinal"].every((id) => S.els[id].className === "st-done" && S.els[id].hidden === false) && /^\d+$/.test(txt("stCutsCnt")));
  check("the progress line named the steps while running", texts20.some((t) => /Step \d of 5 · Cutting · \d+ \/ \d+/.test(t)) && texts20.some((t) => /Adding the markers/.test(t)) && texts20.some((t) => /Linking video and audio/.test(t)), texts20.filter((t, i) => i % 40 === 0).join(" | "));
  check("Stop was enabled during the run and is disabled again afterwards", stopOk && S.els.rStop.disabled === true);
  check("the status message and pill say Done", /^Done in \d+:\d\d\. The final check passed/.test(txt("statusMsg")) && / ok$/.test(S.els.statusMsg.className) && txt("pill") === "Done" && S.els.statusMsg.hidden === false, txt("statusMsg"));
  pfr = await W.LTRunner.preflight();
  check("after the run the pre-flight says everything is done and offers the final check", pfr.ok && pfr.allDone && txt("rAllLabel") === "Run the final check" && S.els.pfCuts.className === "pf-done" && /Nothing left to do/.test(txt("pfTime")), txt("pfState"));

  console.log("\n==== 21. single step: only its row, its message; the next pre-flight offers Continue ====");
  S = build({ ui: true }); await S.panel.window.LTRunner.preflight();
  r = await press(S, "rMarkers", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("markers only: only the Markers row is shown, done; the message says so", S.els.stMarkers.hidden === false && ["stCuts", "stDeletes", "stRelink", "stFinal"].every((id) => S.els[id].hidden === true) && S.els.stMarkers.className === "st-done" && /^Markers added and checked/.test(S.els.statusMsg.textContent), S.els.statusMsg.textContent);
  r = await press(S, "rCuts", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("only the Cuts row is shown, done; the message says nothing is deleted yet", S.els.stCuts.hidden === false && ["stMarkers", "stDeletes", "stRelink", "stFinal"].every((id) => S.els[id].hidden === true) && S.els.stCuts.className === "st-done" && /^Cuts made and checked\. Nothing is deleted yet/.test(S.els.statusMsg.textContent), S.els.statusMsg.textContent);
  pfr = await S.panel.window.LTRunner.preflight();
  check("pre-flight on the cut timeline: part done, button says Continue, cuts row is done, deletes still to do", pfr.ok && !pfr.fresh && S.els.rAllLabel.textContent === "Continue" && S.els.pfCuts.className === "pf-done" && S.els.pfDeletes.className === "pf-todo" && /Left to do: .*deletes/.test(S.els.rAllSub.textContent) && /fully cut/.test(S.els.pfState.textContent), S.els.pfState.textContent + " / " + S.els.rAllSub.textContent);

  S = build({ ui: true }); await press(S, "rCuts", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  pfr = await S.panel.window.LTRunner.preflight();
  check("a cut timeline whose markers are missing: the pre-flight says why (markers can only be added before the first cut) and how to go on", !pfr.ok && /markers/.test(S.els.pfProblems.textContent) && /Also add the markers/.test(S.els.pfProblems.textContent) && S.els.rAll.hidden === true, S.els.pfProblems.textContent);
  setField(S, "recipeMarkers", { checked: false }); pfr = await S.panel.window.LTRunner.preflight();
  check("with the markers switched off it offers Continue, and the markers row says so", pfr.ok && S.els.rAllLabel.textContent === "Continue" && S.els.pfMarkers.className === "pf-skip");

  console.log("\n==== 22. a timeline the run would refuse: reasons listed, Do it all is replaced by Check again, nothing touched ====");
  S = build({ ui: true, v2: true }); pfr = await S.panel.window.LTRunner.preflight();
  check("pre-flight not ok, reasons shown, rAll hidden, bCheck shown, pill Needs attention, nothing changed", !pfr.ok && /^\u2022 /.test(S.els.pfProblems.textContent) && S.els.rAll.hidden === true && S.els.bCheck.hidden === false && S.els.pill.textContent === "Needs attention" && S.els.pfMarkers.hidden === true && S.tracks.V1.arr.length === 1 && S.calls.v === 0, S.els.pfProblems.textContent);
  S = build({ ui: true }); setField(S, "padBefore", { value: "abc" }); pfr = await S.panel.window.LTRunner.preflight();
  check("a bad setting is named in the pre-flight and the settings error line", !pfr.ok && /Keep before each clip/.test(S.els.pfProblems.textContent) && /Keep before each clip/.test(S.els.setErr.textContent) && S.els.rAll.hidden === true, S.els.pfProblems.textContent);
  setField(S, "padBefore", { value: "0" }); pfr = await S.panel.window.LTRunner.preflight();
  check("fixing it brings Do it all back", pfr.ok && S.els.rAll.hidden === false && S.els.bCheck.hidden === true && S.els.setErr.textContent === "");

  console.log("\n==== 23. Cancel, Stop and a failed check are shown as what they are ====");
  S = build({ ui: true }); await S.panel.window.LTRunner.preflight();
  r = await press(S, "rAll", "no"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("Cancel: 'Cancelled. Nothing was changed.', warn style, pill Cancelled, nothing changed", /^Cancelled\. Nothing was changed/.test(S.els.statusMsg.textContent) && / warn$/.test(S.els.statusMsg.className) && S.els.pill.textContent === "Cancelled" && S.tracks.V1.arr.length === 1 && S.calls.v === 0);
  S = build({ ui: true, stopAtRemove: 10 }); await S.panel.window.LTRunner.preflight();
  r = await press(S, "rAll", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("Stop during the deletes: Deletes row is stopped, earlier rows done, 'Stopped', warn style", S.els.stDeletes.className === "st-stopped" && S.els.stMarkers.className === "st-done" && S.els.stCuts.className === "st-done" && /^Stopped after/.test(S.els.statusMsg.textContent) && / warn$/.test(S.els.statusMsg.className) && S.els.pill.textContent === "Stopped" && S.els.rStop.disabled === true, S.els.statusMsg.textContent + " | " + S.els.stDeletes.className);
  S = build({ ui: true, v2: true }); r = await press(S, "rAll", "yes"); await waitFor(() => LOCKED.every((id) => S.els[id].disabled === false), 2000);
  check("a refusal at the start (no preflight done): 'Refused. Nothing was changed', bad style, the log opens", /^Refused\. Nothing was changed/.test(S.els.statusMsg.textContent) && / bad$/.test(S.els.statusMsg.className) && S.els.logBox.open === true, S.els.statusMsg.textContent);

  console.log("\n==== 24. timecode.js is loaded into ExtendScript from the extension folder: Windows and macOS paths ====");
  for (const [label, url, expect] of [
    ["Windows, user name with a space", "file:///C:/Users/My%20Name/AppData/Roaming/Adobe/CEP/extensions/com.luckytwitch.markers", "C:/Users/My Name/AppData/Roaming/Adobe/CEP/extensions/com.luckytwitch.markers"],
    ["Windows, backslashes", "file:///D:\\Adobe\\CEP\\extensions\\com.luckytwitch.markers", "D:/Adobe/CEP/extensions/com.luckytwitch.markers"],
    ["macOS", "file:///Users/me/Library/Application%20Support/Adobe/CEP/extensions/com.luckytwitch.markers", "/Users/me/Library/Application Support/Adobe/CEP/extensions/com.luckytwitch.markers"]]) {
    S = build({ extUrl: url, extExpect: expect, noMarkersNeeded: true }); await press(S, "rMarkers", "yes");
    r = await press(S, "rCuts", "yes");
    check(label + ": the panel built the right path, loaded timecode.js and the cuts ran", /CUTS DONE/.test(r.log) && S.tracks.V1.arr.length > 100, r.log.split("\n").filter((l) => /could not be loaded|PANEL ERROR|REFUSED|STOPPED/.test(l)).join(" | "));
  }

  console.log(failures.length ? "\n" + failures.length + " CHECK(S) FAILED: " + failures.join("; ") : "\nALL CHECKS PASSED");
  process.exit(failures.length ? 1 : 0);
})();
