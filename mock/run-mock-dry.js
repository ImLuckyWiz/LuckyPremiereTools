// Runs the REAL runner.js, guard.js, markers-core.js and host.jsx (LT_g_scan) against a fake Premiere. 85 clips -> 169 cut points.
//   node mock/run-mock-dry.js
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = path.join(__dirname, "..");
const DUR = 34379.86;

function markersFile(media, nClips) {
  const markers = [{ kind: "game", name: "Just Chatting", start: 0, end: 9000, comment: "Game: Just Chatting", game: "Just Chatting" },
                   { kind: "game", name: "GTA IV", start: 9000, end: DUR, comment: "Game: GTA IV", game: "GTA IV" }];
  for (let i = 0; i < nClips; i++) {
    const start = 100 + i * 400, end = i === nClips - 1 ? DUR : start + 20 + (i % 7);
    markers.push({ kind: "clip", name: "Clip \u00b7 \u00d1 " + i + " (bob, " + (i * 3) + " views)", start, end, views: i * 3, comment: "bob \u00b7 " + (i * 3) + " views \u00b7 https://clips.twitch.tv/c" + i, clips: [{ url: "https://clips.twitch.tv/c" + i, creator: "bob", views: i * 3 }] });
  }
  return JSON.stringify({ format: "luckytwitch-markers", version: 1, name: "t", fps: 60, duration: DUR, part: { start: 0, end: DUR }, source: { streamer: "S", title: "T" }, markers });
}

function scenario(name, o) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ltdry-"));
    const media = path.join(dir, "IlloJuan - 2026-09-21 - 2880250748 - part1.mp4");
    fs.writeFileSync(media, "x");
    if (!o.noFile) fs.writeFileSync(path.join(dir, (o.otherFile ? "Someone Else - 2025-01-01 - 999 - part1" : "IlloJuan - 2026-09-21 - 2880250748 - part1") + ".markers.json"), markersFile(media, 85));

    const list = [];
    for (let i = 0; i < (o.existing || 0); i++) list.push({ name: (o.probes ? "LTPROBE x " : "real ") + i });
    const markers = { getFirstMarker: () => list[0] || null, getNextMarker: (m) => list[list.indexOf(m) + 1] || null };
    const pi = { name: "v", getMarkers: () => markers, getMediaPath: () => media };
    const sec = (s) => ({ seconds: s });
    const mk = (s, e, i, o2) => Object.assign({ start: sec(s), end: sec(e), inPoint: sec(i), outPoint: sec(i + e - s), projectItem: pi, name: "v" }, o2 || {});
    const arr = (a) => Object.assign(a, { numItems: a.length });
    const V1 = [mk(0, DUR, 0)], A1 = [mk(0, DUR, 0)];
    for (let i = 1; i < (o.v1Count || 1); i++) V1.push(mk(i, i + 1, i));
    if (o.v1Shift) V1[0] = mk(5, DUR + 5, 0);
    const track = (clips) => ({ clips: arr(clips) });
    const group = (tr) => Object.assign(tr, { numTracks: tr.length });
    const seq = { name: "Seq", timebase: "4233600000", zeroPoint: "0",
      videoTracks: group([track(V1), track(o.v2 ? [mk(10, 20, 0)] : []), track([])]), audioTracks: group([track(A1), track(o.a2 ? [mk(10, 20, 0)] : []), track([])]) };
    const host = { app: { project: { activeSequence: seq, path: path.join(dir, "Untitled.prproj") }, enableQE() {}, version: "mock" },
      qe: { project: { getActiveSequence: () => ({ CTI: { timecode: o.dropFrame ? "00:00:10;00" : "00:00:10:00" } }) } } };
    vm.createContext(host);
    vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/jsx/host.jsx"), "utf8"), host);

    const els = {}, handlers = {};
    const el = (id) => els[id] || (els[id] = { value: "", scrollTop: 0, scrollHeight: 0, addEventListener(ev, fn) { handlers[id] = fn; } });
    const cepfs = { readdir: (p) => { try { return { err: 0, data: fs.readdirSync(p) }; } catch (e) { return { err: 2 }; } }, readFile: (p) => { try { return { err: 0, data: fs.readFileSync(p, "utf8") }; } catch (e) { return { err: 2 }; } } };
    const panel = { window: { __adobe_cep__: { evalScript(code, cb) { setImmediate(() => cb(String(vm.runInContext(code, host)))); } }, cep: { fs: cepfs, encoding: { UTF8: "UTF-8" } } },
      document: { getElementById: el }, setTimeout, Promise, Date, JSON, String, Number, Object, Math, Array, isFinite, console };
    vm.createContext(panel);
    vm.runInContext(fs.readFileSync(path.join(root, "src/markers-core.js"), "utf8") + "\nwindow.LTCore = LT_CORE_API;", panel);
    vm.runInContext(fs.readFileSync(path.join(root, "src/guard.js"), "utf8"), panel);
    vm.runInContext(fs.readFileSync(path.join(root, "cep-panel/js/runner.js"), "utf8"), panel);
    console.log("\n==== " + name + " ====");
    handlers.rDry();
    const iv = setInterval(() => {
      if (/DRY RUN PASSED|would NOT start|PANEL ERROR/.test(els.log.value)) {
        clearInterval(iv);
        console.log(els.log.value.split("\n").slice(1).filter((l) => !/^Runner ready/.test(l)).join("\n"));
        resolve();
      }
    }, 10);
  });
}
(async () => {
  await scenario("GOOD: fresh timeline, 85 clips", {});
  await scenario("clip on V2", { v2: true });
  await scenario("audio on A2", { a2: true });
  await scenario("V1 already cut (3 clips)", { v1Count: 3 });
  await scenario("markers file of ANOTHER video", { otherFile: true });
  await scenario("no markers file", { noFile: true });
  await scenario("drop-frame sequence", { dropFrame: true });
  await scenario("LTPROBE leftovers on the clip", { existing: 4, probes: true });
  await scenario("real markers already on the clip (should ASK, still pass)", { existing: 7 });
})();
