// Runs the REAL runner.js (markers phase, remove, confirm), guard.js, markers-core.js and host.jsx against a fake Premiere with a marker collection.
//   node mock/run-mock-run.js
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = path.join(__dirname, "..");
const DUR = 34379.86;

function markersFile(nClips) {
  const markers = [{ kind: "game", name: "Just Chatting", start: 0, end: 9000, comment: "Game: Just Chatting", game: "Just Chatting" },
                   { kind: "game", name: "GTA IV", start: 9000, end: DUR, comment: "Game: GTA IV", game: "GTA IV" }];
  for (let i = 0; i < nClips; i++) {
    const start = 100 + i * 300, end = start + 20 + (i % 7);
    markers.push({ kind: "clip", name: "Clip \u00b7 \u00d1 \ud83d\ude00 " + i + " (bob, " + (i * 3) + " views)", start, end, views: i * 3, comment: "bob \u00b7 " + (i * 3) + " views \u00b7 https://clips.twitch.tv/c" + i, clips: [{ url: "https://clips.twitch.tv/c" + i, creator: "bob", views: i * 3 }] });
  }
  return JSON.stringify({ format: "luckytwitch-markers", version: 1, name: "t", fps: 60, duration: DUR, part: { start: 0, end: DUR }, source: { streamer: "S", title: "T" }, markers });
}

function build(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltrun-"));
  const media = path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.mp4");
  fs.writeFileSync(media, "x");
  fs.writeFileSync(path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.markers.json"), markersFile(108));
  const list = [];
  const mkMarker = (start) => {
    let end = start, color = 0, nm = "";
    const m = { comments: "", type: "Comment" };
    Object.defineProperty(m, "name", { get: () => nm, set: (v) => { nm = String(v); } });
    Object.defineProperty(m, "start", { get: () => ({ seconds: start }) });
    Object.defineProperty(m, "end", { get: () => ({ seconds: end }), set: (v) => { if (typeof v !== "number") throw new Error("bad end"); end = v; } });
    m.setColorByIndex = (i) => { color = o.lossy ? (i + 1) % 8 : i; };
    m.getColorByIndex = () => color;
    return m;
  };
  const markers = { get numMarkers() { return list.length; }, createMarker(s) { const m = mkMarker(s); list.push(m); return m; },
    getFirstMarker: () => list[0] || null, getNextMarker: (m) => list[list.indexOf(m) + 1] || null, deleteMarker(m) { list.splice(list.indexOf(m), 1); } };
  for (let i = 0; i < (o.existing || 0); i++) { const m = markers.createMarker(5 + i); m.name = "mine " + i; m.comments = "keep me"; }
  const pi = { name: "v", getMarkers: () => markers, getMediaPath: () => media };
  const sec = (s) => ({ seconds: s });
  const mk = (s, e, i) => ({ start: sec(s), end: sec(e), inPoint: sec(i), outPoint: sec(i + e - s), projectItem: pi, name: "v" });
  const arr = (a) => Object.assign(a, { numItems: a.length });
  const track = (c) => ({ clips: arr(c) }), group = (t) => Object.assign(t, { numTracks: t.length });
  const seq = { name: "Seq", timebase: "4233600000", zeroPoint: "0", videoTracks: group([track([mk(0, DUR, 0)]), track(o.v2 ? [mk(10, 20, 0)] : []), track([])]), audioTracks: group([track([mk(0, DUR, 0)]), track([]), track([])]) };
  const host = { app: { project: { activeSequence: seq, path: path.join(dir, "Untitled.prproj") }, enableQE() {}, version: "mock" }, qe: { project: { getActiveSequence: () => ({ CTI: { timecode: "00:00:00:00" } }) } } };
  vm.createContext(host);
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
  return { list, els, handlers };
}
// press a button, auto-answer the confirm box (answer = "yes" | "no" | null), wait for the end marker text
function press(S, id, answer, doneRe) {
  return new Promise((resolve) => {
    const start = S.els.log.value.length;
    S.handlers[id]();
    let answered = false;
    const iv = setInterval(() => {
      if (S.els.rAskBox && S.els.rAskBox.style.display === "block" && !answered) {
        answered = true;
        if (answer === "yes") S.handlers.rYes(); else if (answer === "no") S.handlers.rNo(); else { console.log("   (unexpected confirm box: " + S.els.rAskText.textContent.split("\n")[0] + ")"); S.handlers.rNo(); }
      }
      const v = S.els.log.value.slice(start);
      if (doneRe.test(v) || /PANEL ERROR/.test(v)) { clearInterval(iv); resolve(v); }
    }, 5);
  });
}
const show = (v) => console.log(v.split("\n").filter((l) => !/^\s+\[ok\]/.test(l)).join("\n").trim());
const DONE = /MARKERS DONE|DID NOT FINISH|PASS: removed|FAIL: removed|Cancelled|Nothing removed|Cannot work out/;

(async () => {
  let S = build({});
  console.log("==== 1. fresh timeline: add the markers ====");
  show(await press(S, "rMarkers", null, DONE));
  const mine = S.list.filter((m) => !/^mine/.test(m.name));
  console.log("   mock holds " + S.list.length + " markers; example: \"" + mine[3].name + "\" start " + mine[3].start.seconds + " end " + mine[3].end.seconds + " color " + mine[3].getColorByIndex());

  console.log("\n==== 2. run it AGAIN (clip already has the markers): must ask, then add nothing twice ====");
  show(await press(S, "rMarkers", "yes", DONE));
  console.log("   mock holds " + S.list.length + " markers (must still be 110)");

  console.log("\n==== 3. a stray marker of mine stays when the plan's markers are removed (R3) ====");
  const stray = S.list[0]; stray.name = "mine 0"; stray.comments = "keep me";
  show(await press(S, "rRemove", "yes", DONE));
  console.log("   mock holds " + S.list.length + " markers: " + S.list.map((m) => m.name).join(", "));

  console.log("\n==== 4. existing real markers + you press CANCEL: nothing is added ====");
  S = build({ existing: 7 });
  show(await press(S, "rMarkers", "no", DONE));
  console.log("   mock holds " + S.list.length + " markers (must still be 7)");

  console.log("\n==== 5. clip on V2: refused, nothing added ====");
  S = build({ v2: true });
  show(await press(S, "rMarkers", null, DONE));
  console.log("   mock holds " + S.list.length + " markers (must be 0)");

  console.log("\n==== 6. Premiere sets colors wrong: the verify must FAIL ====");
  S = build({ lossy: true });
  show(await press(S, "rMarkers", null, DONE));
})();
