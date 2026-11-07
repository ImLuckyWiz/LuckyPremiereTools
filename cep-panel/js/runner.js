// The runner: the panel's brain. Gathers facts from Premiere, asks the failsafe (shared/guard.js) whether a run may start, plans the run with
// markers-core.js, and walks a list of PHASES (markers, cuts, deletes, relink, final check), each with its own verify, stopping at the first failure.
// "Do it all" and the single buttons use the SAME phase lists. Needs window.LTCore (shared/markers-core.js) and window.LTGuard (shared/guard.js).
(function () {
  var out = document.getElementById("log");
  // A tiny event channel for the panel's look (js/ui.js). A problem in a listener must never disturb a run, so every call is guarded.
  var listeners = {};
  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  function emit(name, data) { var l = listeners[name], i; if (!l) return; for (i = 0; i < l.length; i++) { try { l[i](data); } catch (ignore) {} } }
  function log(t) { out.value += t + "\n"; out.scrollTop = out.scrollHeight; emit("log", t); }
  function evalJsx(code) { return new Promise(function (res) { window.__adobe_cep__.evalScript(code, res); }); }
  function bind(id, fn) { var e = document.getElementById(id); if (e) e.addEventListener("click", function () { fn().catch(function (e2) { log("PANEL ERROR: " + (e2 && e2.stack ? e2.stack : e2)); }); }); }
  // RUNNING LOCK: only one run (or one waiting confirm) at a time. Every button that reads or changes anything goes through bindRun.
  // Stop and the confirm's Continue/Cancel use plain bind, so they always work.
  var busy = false;
  var LOCKED_IDS = ["rAll", "rDry", "rMarkers", "rRemove", "rCuts", "rDel", "rLink", "rChoose", "rAuto", "bRefresh", "bCheck"];
  function setBusy(on, kind) { busy = on; LOCKED_IDS.forEach(function (id) { var e = document.getElementById(id); if (e) e.disabled = on; }); emit("busy", { on: on, kind: kind || "run" }); }
  function bindRun(id, fn) {
    bind(id, async function () {
      if (busy) { log("Ignored: a run is already active or waiting for your answer. Answer the question, or press Stop."); return; }
      setBusy(true);
      emit("start", { id: id });
      var ok = false;
      try { ok = await fn(); } finally { setBusy(false); emit("end", { id: id, ok: ok === true }); }
    });
  }
  function dirOf(p) { var i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i < 0 ? "" : p.slice(0, i); }
  function baseOf(p) { var i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i < 0 ? p : p.slice(i + 1); }
  function num(x) { return Number(x); }

  var S = { overridePath: null };   // a file the person chose by hand

  // ---- facts ----
  function parseScan(body) {
    var f = { seq: null, proj: "", video: [], audio: [], v1: [], a1: [], markers: null }, lines = body.split("\n"), i;
    for (i = 0; i < lines.length; i++) {
      var p = lines[i].split("\t");
      if (p[0] === "seq") f.seq = { ok: true, name: p[1], fps: num(p[2]), timebase: num(p[3]), tc: p[4] || "", dropFrame: (p[4] || "").indexOf(";") >= 0 };
      else if (p[0] === "proj") f.proj = p[1] || "";
      else if (p[0] === "vt") f.video[num(p[1])] = num(p[2]);
      else if (p[0] === "at") f.audio[num(p[1])] = num(p[2]);
      else if (p[0] === "clip") (p[1] === "V" ? f.v1 : f.a1).push({ start: num(p[3]), end: num(p[4]), inPoint: num(p[5]), outPoint: num(p[6]), media: p[7], name: p[8] });
      else if (p[0] === "mk") f.markers = { existing: num(p[1]), probes: num(p[2]) };
    }
    return f;
  }
  async function scan() {
    var r = String(await evalJsx("LT_g_scan()"));
    if (r.indexOf("ok|") !== 0) return { error: r.replace(/^(FAIL\||ERROR: )/, "") };
    return { facts: parseScan(r.slice(3)) };
  }

  // The markers file: next to the video, then next to the project (cep.fs), or the one chosen by hand.
  function readFileFacts(media, proj) {
    var C = window.LTCore, res = { loaded: false, error: "", name: "", path: "", text: "", parsed: null, matchesMedia: null };
    var path = S.overridePath, how = "chosen by hand";
    if (!path) {
      var folders = [[dirOf(media), "next to the video"], [dirOf(proj), "next to the project"]], i;
      for (i = 0; i < folders.length && !path; i++) {
        if (!folders[i][0]) continue;
        var rd = window.cep.fs.readdir(folders[i][0]);
        if (rd.err !== 0) continue;
        var names = rd.data.filter(function (n) { return /\.markers\.json$/i.test(n); });
        var pick = C.pickMarkersFile(names, baseOf(media));
        if (pick) { path = folders[i][0] + "/" + pick.name; how = folders[i][1] + ", " + pick.how; }
      }
    }
    if (!path) { res.error = "none was found next to the video or the project. Press \"Choose markers file\"."; return res; }
    res.path = path; res.name = baseOf(path); res.how = how;
    var r = window.cep.fs.readFile(path, window.cep.encoding.UTF8);
    if (r.err !== 0) { res.error = "could not read " + path + " (cep.fs error " + r.err + ")"; return res; }
    res.text = r.data;
    try { res.parsed = C.parseMarkersFile(r.data); } catch (e) { res.error = e && e.message ? e.message : String(e); return res; }
    res.loaded = true;
    if (res.parsed && res.parsed.preferences) {
      applyFilePreferences(res.parsed.preferences);
    }
    res.matchesMedia = media ? C.markersNameMatchesMedia(res.name, media) : null;
    return res;
  }

  // ---- settings: typed into the panel, remembered between sessions, used by EVERY plan (dry run, cuts, deletes, relink checks) ----
  // Same names and meaning as the UXP plugin's Settings: padBefore/padAfter = seconds kept around each clip (the "safety cut"),
  // mergeGap = clips closer than this are one, chapters = also cut at every game change, maxDeletePct / minKeepPieces = delete limits.
  var NUM_FIELDS = [["padBefore", "Keep before each clip"], ["padAfter", "Keep after each clip"], ["mergeGap", "Merge clips closer than"], ["maxDeletePct", "Refuse to delete more than"], ["minKeepPieces", "Need at least pieces to keep"]];
  var MAX_PAD = 3600;
  function fieldEl(id) { return document.getElementById(id); }
  function fieldText(id) { var e = fieldEl(id); return e ? String(e.value === undefined ? "" : e.value).replace(/^\s+|\s+$/g, "").replace(",", ".") : ""; }
  // Throws (with a message fit for the log) when a field holds something that is not a number; an EMPTY field means "the default".
  var appliedPrefs = false;
  function applyFilePreferences(prefs) {
    if (!prefs || appliedPrefs) return;
    try {
      var saved = window.localStorage.getItem("ltSettings");
      var padB = fieldEl("padBefore"), padA = fieldEl("padAfter");
      var pb = prefs.padBefore !== undefined ? prefs.padBefore : prefs.pad_before;
      var pa = prefs.padAfter !== undefined ? prefs.padAfter : prefs.pad_after;
      if (padB && pb !== undefined && (fieldText("padBefore") === "0" || fieldText("padBefore") === "" || !saved)) {
        padB.value = String(pb);
      }
      if (padA && pa !== undefined && (fieldText("padAfter") === "0" || fieldText("padAfter") === "" || !saved)) {
        padA.value = String(pa);
      }
      var maxDel = prefs.maxDeletePct !== undefined ? prefs.maxDeletePct : prefs.max_delete_pct;
      var maxEl = fieldEl("maxDeletePct");
      if (maxEl && maxDel !== undefined && (fieldText("maxDeletePct") === "0" || fieldText("maxDeletePct") === "" || !saved)) {
        maxEl.value = String(maxDel);
      }
      appliedPrefs = true;
    } catch (ignore) {}
  }

  function applyRecipeByName(name) {
    var C = window.LTCore;
    var rec = (C.DEFAULT_RECIPES || []).find(function (r) { return r.name === name; });
    if (!rec) return;
    for (var i = 0; i < NUM_FIELDS.length; i++) {
      var id = NUM_FIELDS[i][0];
      var el = fieldEl(id);
      if (el && rec[id] !== undefined) el.value = String(rec[id]);
    }
    var ch = fieldEl("recipeCutChapters");
    if (ch && rec.recipeCutChapters !== undefined) ch.checked = !!rec.recipeCutChapters;
    var rm = fieldEl("recipeMarkers");
    if (rm && rec.recipeMarkers !== undefined) rm.checked = !!rec.recipeMarkers;
    saveSettings();
  }

  function getSettings() {
    var C = window.LTCore, raw = {}, i, id, t, n;
    for (i = 0; i < NUM_FIELDS.length; i++) {
      id = NUM_FIELDS[i][0]; t = fieldText(id);
      if (t === "") continue;
      n = Number(t);
      if (!isFinite(n) || n < 0) throw new Error("Setting \"" + NUM_FIELDS[i][1] + "\" must be a number of 0 or more (it says \"" + t + "\").");
      if ((id === "padBefore" || id === "padAfter" || id === "mergeGap") && n > MAX_PAD) throw new Error("Setting \"" + NUM_FIELDS[i][1] + "\" is above " + MAX_PAD + " s (it says \"" + t + "\").");
      raw[id] = n;
    }
    var ch = fieldEl("recipeCutChapters"); raw.recipeCutChapters = !!(ch && ch.checked);
    var lc = fieldEl("limitChapter"); if (lc && lc.value !== "") raw.limitChapter = lc.value;
    return C.normalizeSettings(raw);
  }
  function describeSettings(s) {
    return "keep " + s.padBefore + " s before and " + s.padAfter + " s after each clip, merge clips closer than " + s.mergeGap + " s, " + (s.recipeCutChapters ? "also cut at game changes" : "clips only") + "; delete limit " + s.maxDeletePct + "%, keep at least " + s.minKeepPieces + " piece(s)" + (s.limitChapter !== null ? " (limited to chapter)" : "");
  }
  function loadSavedSettings() {
    try {
      var saved = JSON.parse(window.localStorage.getItem("ltSettings") || "{}"), i, e;
      for (i = 0; i < NUM_FIELDS.length; i++) { e = fieldEl(NUM_FIELDS[i][0]); if (e && saved[NUM_FIELDS[i][0]] !== undefined) e.value = String(saved[NUM_FIELDS[i][0]]); }
      e = fieldEl("recipeCutChapters"); if (e && saved.recipeCutChapters !== undefined) e.checked = !!saved.recipeCutChapters;
      e = fieldEl("recipeMarkers"); if (e && saved.recipeMarkers !== undefined) e.checked = !!saved.recipeMarkers;
      e = fieldEl("limitChapter"); if (e && saved.limitChapter !== undefined) e.value = String(saved.limitChapter);
    } catch (ignore) {}
  }
  function saveSettings() {
    try {
      var o = {}, i, e;
      for (i = 0; i < NUM_FIELDS.length; i++) o[NUM_FIELDS[i][0]] = fieldText(NUM_FIELDS[i][0]);
      e = fieldEl("recipeCutChapters"); o.recipeCutChapters = !!(e && e.checked);
      e = fieldEl("recipeMarkers"); o.recipeMarkers = !(e && e.checked === false);
      e = fieldEl("limitChapter"); if (e) o.limitChapter = e.value;
      window.localStorage.setItem("ltSettings", JSON.stringify(o));
    } catch (ignore) {}
    try { log("Settings: " + describeSettings(getSettings())); } catch (err) { log("Settings problem: " + err.message); }
    emit("settingsChanged", null);
  }

  // ---- the plan (all of it comes from markers-core.js, the UXP planning layer) ----
  function buildPlan(file, facts) {
    var C = window.LTCore, s = getSettings();
    var v = facts.v1[0], frame = 1 / facts.seq.fps;
    var scope = C.chapterScope(file, s.limitChapter);
    var rawItems = C.planMarkers(file, s, 0).items;
    var items = scope ? C.restrictItems(rawItems, scope) : rawItems;
    var minTime = scope ? Math.max(0, scope.min) : 0;
    var maxTime = scope ? Math.min(v.outPoint, scope.max) : v.outPoint;
    var cs = C.planCutSet(items, { clips: s.recipeCutClips, chapters: s.recipeCutChapters, padBefore: s.padBefore, padAfter: s.padAfter, mergeGap: s.mergeGap, min: minTime, max: maxTime });
    var clips = [{ start: v.start, end: v.end, inPoint: v.inPoint, outPoint: v.outPoint, speed: 1 }];
    var cov = C.coverage(cs.ranges, clips);
    var pending = C.pendingCutPoints(cs.points, clips, frame);
    var pieces = C.simulatePieces(clips, pending);
    var gaps = C.planGapDelete(pieces, cs.ranges, { frame: frame, maxDeletePct: s.maxDeletePct, minKeep: s.minKeepPieces, scope: scope });
    return { settings: s, items: items, ranges: cs.ranges, points: cs.points, pending: pending, clipsInside: cov.inside, clipsTotal: cs.ranges.length, gaps: gaps, markerCount: items.length, scope: scope };
  }
  // Rough time, scaled from the step 3 / probe logs (about 40 ms per marker; 169 cuts 7.7 s, 85 deletes 9.2 s, 85 relinks 8.2 s; cuts grow with the square).
  function estimateSeconds(plan, gapCount) {
    var cuts = 15.7 * Math.pow(plan.pending.length / 199, 2), dels = 0.165 * gapCount, links = 0.168 * gapCount, marks = plan.markerCount * 0.075;
    return { total: marks + cuts + dels + links, marks: marks, cuts: cuts, dels: dels, links: links };
  }

  // ---- the failsafe, gathered fresh every time it is asked ----
  async function gather() {
    var sc = await scan(), facts;
    if (sc.error) return { facts: { seq: null, video: [], audio: [], v1: [], a1: [], markers: null, file: null, plan: null }, scanError: sc.error };
    facts = sc.facts;
    var media = facts.v1.length ? facts.v1[0].media : "";
    var fr = readFileFacts(media, facts.proj);
    facts.file = { loaded: fr.loaded, error: fr.error, name: fr.name, matchesMedia: fr.matchesMedia };
    facts.fileData = fr;
    facts.plan = null;
    if (fr.loaded && facts.seq && facts.seq.fps > 0 && facts.v1.length === 1) {
      try { facts.planFull = buildPlan(fr.parsed, facts); facts.plan = facts.planFull; } catch (e) { facts.planError = e && e.message ? e.message : String(e); }
    }
    return { facts: facts };
  }
  async function check() {
    var g = await gather();
    var verdict = window.LTGuard.evaluate(g.facts);
    if (g.scanError) { verdict.ok = false; verdict.hard.unshift("Could not read the timeline: " + g.scanError); }
    if (g.facts.planError) { verdict.ok = false; verdict.hard.push("The plan could not be worked out: " + g.facts.planError); }
    return { facts: g.facts, verdict: verdict };
  }
  function printVerdict(v) {
    v.checks.forEach(function (c) { log("  " + (c.ok ? "[ok]   " : (c.level === "soft" ? "[ask]  " : "[STOP] ")) + (c.ok || c.level !== "soft" ? c.text : c.problem)); });
  }

  // ---- phases: {name, run(ctx) -> bool, verify(ctx) -> {ok, text}} ----
  async function runPhases(phases, ctx) {
    var T0 = Date.now(), i;
    for (i = 0; i < phases.length; i++) {
      var p = phases[i], t0 = Date.now(), ok = false;
      var checkText = "";
      log("[" + (i + 1) + "/" + phases.length + "] " + p.name);
      emit("phase", { index: i, total: phases.length, name: p.name, step: p.step || "" });
      try { ok = await p.run(ctx); } catch (e) { log("    ERROR: " + (e && e.stack ? e.stack : e)); ok = false; }
      if (ok && p.verify) {
        var v;
        try { v = await p.verify(ctx); } catch (e2) { v = { ok: false, text: "verify threw: " + e2 }; }
        log("    check: " + (v.ok ? "PASS " : "FAIL ") + v.text);
        ok = v.ok; checkText = String(v.text);
      }
      log("    (" + (Date.now() - t0) + " ms)");
      emit("phaseEnd", { index: i, step: p.step || "", ok: ok, hasVerify: !!p.verify, check: checkText });
      if (!ok) { log("STOPPED at \"" + p.name + "\". Nothing after it ran, and nothing was changed by this stop."); return false; }
    }
    log("All " + phases.length + " phases done in " + ((Date.now() - T0) / 1000).toFixed(1) + " s.");
    return true;
  }

  // ---- the DRY RUN: reads and plans, changes nothing ----
  function fmt(s) { return s < 90 ? Math.round(s) + " s" : Math.round(s / 6) / 10 + " min"; }
  async function dryRun() {
    var ctx = {};
    log("=== DRY RUN: reads the timeline and the markers file, plans the run, TOUCHES NOTHING ===");
    return runPhases([
      { name: "Read the timeline and the markers file", run: async function (c) {
          var g = await gather(); c.facts = g.facts;
          if (g.scanError) { log("    Could not read the timeline: " + g.scanError); return false; }
          var f = c.facts;
          log("    sequence \"" + f.seq.name + "\", " + f.seq.fps.toFixed(3) + " fps, playhead timecode " + (f.seq.tc || "(unreadable)"));
          log("    video clips per track: " + f.video.map(function (n, i) { return "V" + (i + 1) + "=" + n; }).join(" ") + ";  audio: " + f.audio.map(function (n, i) { return "A" + (i + 1) + "=" + n; }).join(" "));
          if (f.v1.length) log("    V1 clip: " + baseOf(f.v1[0].media || f.v1[0].name) + ", " + f.v1[0].start.toFixed(2) + " -> " + f.v1[0].end.toFixed(2) + " s, plays source " + f.v1[0].inPoint.toFixed(2) + " -> " + f.v1[0].outPoint.toFixed(2));
          if (f.markers) log("    markers on the clip: " + f.markers.existing + " (" + f.markers.probes + " LTPROBE)");
          var fd = f.fileData;
          log("    markers file: " + (fd.loaded ? fd.name + " (" + fd.how + "), " + fd.parsed.markers.length + " markers in the file" : "NOT loaded: " + fd.error));
          return true;
        } },
      { name: "Failsafe checks", run: async function (c) {
          var v = window.LTGuard.evaluate(c.facts);
          if (c.facts.planError) { v.ok = false; v.hard.push("The plan could not be worked out: " + c.facts.planError); }
          c.verdict = v;
          printVerdict(v);
          if (!v.ok) { log("    The run would be REFUSED:"); v.hard.forEach(function (h) { log("      - " + h); }); return false; }
          if (v.needsConfirm) { log("    The run would ASK you first:"); v.soft.forEach(function (h) { log("      - " + h); }); }
          return true;
        } },
      { name: "The plan", run: async function (c) {
          var pl = c.facts.plan, g = pl.gaps, est = estimateSeconds(pl, g.deleteCount);
          log("    Settings: " + describeSettings(pl.settings));
          log("    1. add " + pl.markerCount + " markers to the clip (" + pl.items.filter(function (x) { return x.kind === "clip"; }).length + " clips, " + pl.items.filter(function (x) { return x.kind === "game"; }).length + " games)");
          log("    2. cut at " + pl.pending.length + " points = " + (pl.pending.length * 2) + " razor calls (V1 + A1), in chunks, back to front, " + pl.ranges.length + " pieces to keep");
          log("    3. delete " + g.deleteCount + " gap pieces (" + (g.deletePct !== undefined ? g.deletePct.toFixed(1) + "% of the timeline" : g.text) + "), keep " + g.keepCount);
          log("    4. relink " + g.keepCount + " video/audio pairs");
          log("    Rough time: " + fmt(est.total) + " (markers " + fmt(est.marks) + ", cuts " + fmt(est.cuts) + ", deletes " + fmt(est.dels) + ", relinks " + fmt(est.links) + "), scaled from your own logs.");
          log("    Before the real run: SAVE the project (Ctrl+S). Do not touch Premiere while it runs.");
          return true;
        } },
    ], ctx).then(function (ok) { log(ok ? "DRY RUN PASSED: a real run would start. Nothing was touched." : "DRY RUN: a real run would NOT start. Nothing was touched."); return ok; });
  }


  // ---- asking the person (an in-panel confirm: window.confirm is not reliable inside CEP panels) ----
  var askResolve = null;
  function ask(lines) {
    return new Promise(function (res) {
      var box = document.getElementById("rAskBox"), txt = document.getElementById("rAskText");
      if (!box || !txt) { res(false); return; }
      txt.textContent = lines.join("\n");
      box.style.display = "block"; askResolve = res;
      emit("ask", lines);
    });
  }
  function answer(v) { var box = document.getElementById("rAskBox"); if (box) box.style.display = "none"; if (askResolve) { var r = askResolve; askResolve = null; r(v); emit("askDone", v); } }
  var stopFlag = false;

  // ---- generic chunked ExtendScript call over a list ----
  function itemLit(it, lit) { return "{n:" + lit(it.name) + ",c:" + lit(it.comment || "") + ",s:" + lit(it.start) + ",d:" + lit(it.duration) + ",k:" + lit(it.color) + "}"; }
  function lit(v) {
    if (typeof v === "number") return isFinite(v) ? String(v) : "0";
    return JSON.stringify(String(v)).replace(/[\u007f-\uffff]/g, function (c) { return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4); });
  }
  function arrLit(items, a, b) { var x = [], i; for (i = a; i < b; i++) x.push(itemLit(items[i], lit)); return "[" + x.join(",") + "]"; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- the real MARKERS phase ----
  function markersPhaseList(o) {
    o = o || {};
    var T = { added: 0, skipped: 0 };
    return [
      { name: "Failsafe (read everything again, right now)", run: async function (c) {
          var r = await check(); c.facts = r.facts; c.verdict = r.verdict;
          printVerdict(r.verdict);
          if (!r.verdict.ok) { log("    REFUSED:"); r.verdict.hard.forEach(function (h) { log("      - " + h); }); return false; }
          if (r.verdict.needsConfirm && !o.noAsk) {
            var yes = await ask(r.verdict.soft.concat(["", "Press Continue to go on, or Cancel to stop. Nothing has been changed yet."]));
            if (!yes) { log("    Cancelled by you. Nothing was changed."); return false; }
            log("    Confirmed by you.");
          }
          return true;
        } },
      { name: "Add the markers to the clip", run: async function (c) {
          var pl = c.facts.plan, items = pl.items, base = c.facts.v1[0].inPoint;
          c.base = base; c.items = items; c.before = c.facts.markers ? c.facts.markers.existing : 0;
          var init = String(await evalJsx("LT_r_mkInit(" + items.length + "," + lit(base) + ")"));
          if (init.indexOf("ok|") !== 0) { log("    " + init); return false; }
          log("    " + init.slice(3));
          var done = 0, worst = 0, t0 = Date.now(), SIZE = 10, last = "";
          while (done < items.length) {
            if (stopFlag) { log("    Stopped by you after " + done + " of " + items.length + ". Run again to carry on: markers already there are skipped."); return false; }
            var b = Math.min(items.length, done + SIZE), w0 = Date.now();
            var r = String(await evalJsx("LT_r_mkChunk(" + arrLit(items, done, b) + ")")), w = Date.now() - w0;
            if (w > worst) worst = w;
            if (r.indexOf("ok|") !== 0) { log("    FAIL at markers " + (done + 1) + "-" + b + ": " + r.replace(/^(FAIL\||ERROR: )/, "")); return false; }
            var p = r.split("|"); done = b; last = p[4];
            if (done % 50 === 0 || done === items.length) log("    " + done + "/" + items.length + " (" + last + ")");
            await sleep(15);
          }
          var m = /(\d+) added, (\d+) already there/.exec(last) || [0, 0, 0];
          T.added = Number(m[1]); T.skipped = Number(m[2]);
          log("    " + T.added + " added, " + T.skipped + " already there, in " + ((Date.now() - t0) / 1000).toFixed(1) + " s (longest call " + worst + " ms).");
          return true;
        },
        verify: async function (c) {
          var items = c.items, base = c.base, i, SIZE = 20, agg = { n: 0, missing: 0, bc: 0, bk: 0, be: 0, ws: 0, we: 0, first: "" };
          for (i = 0; i < items.length; i += SIZE) {
            var r = String(await evalJsx("LT_r_mkVerify(" + arrLit(items, i, Math.min(items.length, i + SIZE)) + "," + lit(base) + ")"));
            if (r.indexOf("ok|") !== 0) return { ok: false, text: r };
            var p = r.split("|");
            agg.n += Number(p[1]); agg.missing += Number(p[2]); agg.bc += Number(p[3]); agg.bk += Number(p[4]); agg.be += Number(p[5]);
            agg.ws = Math.max(agg.ws, Number(p[6])); agg.we = Math.max(agg.we, Number(p[7])); agg.first = agg.first || p[8];
          }
          var sc = await scan(), after = sc.facts && sc.facts.markers ? sc.facts.markers.existing : -1, expect = c.before + T.added;
          var countOk = after === expect;
          var ok = agg.n === items.length && agg.missing === 0 && agg.bc === 0 && agg.bk === 0 && agg.be === 0 && agg.ws < 0.002 && countOk;
          return { ok: ok, text: agg.n + "/" + items.length + " markers read back from Premiere: " + agg.missing + " missing, " + agg.bc + " wrong comments, " + agg.bk + " wrong colors, " + agg.be + " wrong ends, worst start error " + agg.ws.toFixed(4) + " s, worst end error " + agg.we.toFixed(4) + " s; markers on the clip " + c.before + " -> " + after + " (expected " + expect + (countOk ? ", ok" : ", MISMATCH") + ")" + (agg.first ? "; first bad: " + agg.first : "") };
        } },
    ];
  }
  function tagStep(list, step) { list.forEach(function (p) { p.step = step; }); return list; }   // tells the panel which step a phase belongs to (progress display only)
  async function markersPhases() { return runPhases(tagStep(markersPhaseList({}), "markers"), {}).then(function (ok) { log(ok ? "MARKERS DONE. The timeline was not touched." : "MARKERS PHASE DID NOT FINISH. The timeline was not touched; see above."); return ok; }); }

  // Removes exactly the markers the plan would add (same name, time AND comment). Nothing else.
  async function removeMarkers() {
    log("=== REMOVE the markers this plan adds (same name, time and comment; every other marker stays) ===");
    var r = await check();
    if (!r.facts.plan || !r.facts.v1.length) { log("Cannot work out the plan (" + (r.verdict.hard[0] || "no plan") + "). Nothing removed."); return false; }
    var items = r.facts.plan.items, base = r.facts.v1[0].inPoint, before = r.facts.markers ? r.facts.markers.existing : 0;
    var yes = await ask(["Remove up to " + items.length + " markers that match the markers file (same name, time and comment) from the clip?", "The clip has " + before + " markers now. Other markers are kept."]);
    if (!yes) { log("Cancelled. Nothing removed."); return false; }
    var removed = 0, i, SIZE = 20;
    for (i = 0; i < items.length; i += SIZE) {
      var x = String(await evalJsx("LT_r_mkRemove(" + arrLit(items, i, Math.min(items.length, i + SIZE)) + "," + lit(base) + ")"));
      if (x.indexOf("ok|") !== 0) { log("FAIL: " + x); return false; }
      removed += Number(x.split("|")[2]);
      await sleep(15);
    }
    var sc = await scan(), after = sc.facts && sc.facts.markers ? sc.facts.markers.existing : -1;
    log((after === before - removed ? "PASS" : "FAIL") + ": removed " + removed + " marker(s); markers on the clip " + before + " -> " + after + " (expected " + (before - removed) + ").");
    return after === before - removed;
  }

  async function chooseFile() {
    var r = window.cep.fs.showOpenDialogEx(false, false, "Select the .markers.json", "", ["json"]);
    if (r.err !== 0 || !r.data || !r.data.length) { log("Choose markers file: nothing chosen."); return; }
    S.overridePath = r.data[0];
    log("Markers file chosen by hand: " + S.overridePath + "  (used by the dry run and the real run until you press \"Use the file next to the video\")");
    emit("fileChanged", null);
  }
  async function clearChoice() { S.overridePath = null; log("Back to looking next to the video and the project."); emit("fileChanged", null); }

  // =====================================================================================================================
  // The real CUTS phase (step 7). Razors V1 and A1 at the plan's cut points, back to front, in short chunks.
  //   - the failsafe runs twice: before the confirm box and again right after it (the timeline may have changed while the box was open)
  //   - it starts from ONE uncut clip, or from a half-cut timeline of its own making (a stopped run): LTGuard.evaluateCuts accepts only
  //     boundaries the plan asked for, with V1 = A1, no holes, source continuity; anything else is refused
  //   - after EVERY chunk the piece counts of V1/A1 (and clips on other tracks) are compared with what the chunk must have produced
  //   - at the end the whole timeline is read back and checked against the plan (positions, continuity, keep/delete classification)
  // =====================================================================================================================
  async function ensureTime() {
    var t = String(await evalJsx("typeof LTTime"));
    if (t === "object") return true;
    // getSystemPath gives "file:///C:/Users/.../com.luckytwitch.markers" on Windows and "file:///Users/.../com.luckytwitch.markers" on macOS.
    var p = decodeURIComponent(String(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "")).replace(/\\/g, "/");
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);   // "/C:/Users/..." -> "C:/Users/..."; a macOS path keeps its leading slash
    var file = p + "/shared/timecode.js";
    var r = String(await evalJsx("$.evalFile(" + JSON.stringify(file) + "); typeof LTTime"));
    return r === "object";
  }
  function parseSnap(body) {
    var f = { seq: null, proj: "", video: [], audio: [], v1: [], a1: [], media: "", name: "" }, lines = body.split("\n"), i;
    for (i = 0; i < lines.length; i++) {
      var p = lines[i].split("\t");
      if (p[0] === "seq") f.seq = { ok: true, name: p[1], fps: num(p[2]), timebase: num(p[3]), tc: p[4] || "", dropFrame: (p[4] || "").indexOf(";") >= 0 };
      else if (p[0] === "proj") f.proj = p[1] || "";
      else if (p[0] === "vt") f.video[num(p[1])] = num(p[2]);
      else if (p[0] === "at") f.audio[num(p[1])] = num(p[2]);
      else if (p[0] === "pv") f.v1.push({ start: num(p[1]), end: num(p[2]), inPoint: num(p[3]), outPoint: num(p[4]) });
      else if (p[0] === "pa") f.a1.push({ start: num(p[1]), end: num(p[2]), inPoint: num(p[3]), outPoint: num(p[4]) });
      else if (p[0] === "media") { f.media = p[1] || ""; f.name = p[2] || ""; }
    }
    return f;
  }
  async function snapshot() {
    var r = String(await evalJsx("LT_c_snap()"));
    if (r.indexOf("ok|") !== 0) return { error: r.replace(/^(FAIL\||ERROR: )/, "") };
    var snap = parseSnap(r.slice(3));
    if (!snap.seq) return { error: "the timeline snapshot had no sequence line" };
    return { snap: snap };
  }
  function originOf(arr) { return { start: arr[0].start, end: arr[arr.length - 1].end, inPoint: arr[0].inPoint, outPoint: arr[arr.length - 1].outPoint, speed: 1 }; }

  // Reads the timeline + the markers file and judges both guards. mode "partial" (may be half cut) or "complete" (every cut must be there).
  async function cutsCheck(mode) {
    var sn = await snapshot();
    if (sn.error) return { ok: false, hard: ["Could not read the timeline: " + sn.error], checks: [], cv: null, edges: [], remaining: [] };
    var snap = sn.snap, C = window.LTCore, G = window.LTGuard, fps = snap.seq.fps;
    var fr = readFileFacts(snap.media, snap.proj);
    // The strict start-of-run guard judges the ORIGINAL clip (the pieces, joined back together), so it works on a fresh and on a half-cut timeline.
    var facts = { seq: snap.seq, video: snap.video.slice(), audio: snap.audio.slice(), v1: [], a1: [], markers: null, plan: null,
      file: { loaded: fr.loaded, error: fr.error, name: fr.name, matchesMedia: fr.matchesMedia } };
    if (snap.v1.length) { facts.video[0] = 1; facts.v1 = [Object.assign(originOf(snap.v1), { media: snap.media, name: snap.name })]; }
    if (snap.a1.length) { facts.audio[0] = 1; facts.a1 = [originOf(snap.a1)]; }
    var planError = "";
    if (fr.loaded && fps > 0 && facts.v1.length === 1) {
      try { facts.plan = buildPlan(fr.parsed, facts); } catch (e) { planError = e && e.message ? e.message : String(e); }
    }
    var a = G.evaluate(facts), hard = a.hard.slice(), checks = a.checks.slice();
    if (planError) hard.push("The plan could not be worked out: " + planError);
    var out = { snap: snap, facts: facts, plan: facts.plan, fileData: fr, edges: [], remaining: [], cv: null };
    if (facts.plan && facts.v1.length && facts.a1.length) {
      var vo = facts.v1[0], edges = [Math.round(vo.start * fps)];
      facts.plan.pending.forEach(function (t) { edges.push(Math.round(t * fps)); });
      edges.push(Math.round(vo.end * fps));
      var cf = { seq: snap.seq, video: snap.video, audio: snap.audio, v1: snap.v1, a1: snap.a1, mode: mode, expect: { origin: vo, edges: edges } };
      if (mode === "complete") {
        var pieces = snap.v1.map(function (p) { return { start: p.start, end: p.end, inPoint: p.inPoint, outPoint: p.outPoint, speed: 1 }; }), s = facts.plan.settings;
        cf.gaps = C.planGapDelete(pieces, facts.plan.ranges, { frame: 1 / fps, maxDeletePct: s.maxDeletePct, minKeep: s.minKeepPieces, scope: facts.plan.scope });
        cf.expectGaps = { deleteCount: facts.plan.gaps.deleteCount, keepCount: facts.plan.gaps.keepCount };
      }
      var cv = G.evaluateCuts(cf);
      out.cv = cv; out.edges = edges; out.remaining = cv.remaining;
      // evaluateCuts repeats two checks the strict guard already made (drop-frame, other tracks): keep the strict guard's wording, drop the repeat
      var topic = function (t) { return String(t).slice(0, 22); };
      var seen = {}; hard.forEach(function (h) { seen[topic(h)] = 1; });
      cv.hard.forEach(function (h) { if (!seen[topic(h)]) hard.push(h); });
      var okTopics = {}; checks.forEach(function (x) { okTopics[topic(x.text)] = 1; });
      cv.checks.forEach(function (c) { if (c.ok ? !okTopics[topic(c.text)] : !seen[topic(c.problem)]) checks.push(c); });
    }
    out.ok = hard.length === 0; out.hard = hard; out.checks = checks;
    return out;
  }
  function printChecks(checks) {
    var seen = {};
    checks.forEach(function (c) { var t = c.ok ? c.text : c.problem; if (seen[t]) return; seen[t] = 1; log("  " + (c.ok ? "[ok]   " : "[STOP] ") + t); });
  }

  function cutsPhaseList(o) {
    o = o || {};
    return [
      { name: "Failsafe + plan (read everything again, right now)", run: async function (c) {
          if (!(await ensureTime())) { log("    shared/timecode.js could not be loaded into ExtendScript. Reinstall the panel (see the README)."); return false; }
          var r = await cutsCheck("partial");
          printChecks(r.checks);
          if (!r.ok) { log("    REFUSED. Nothing was cut:"); r.hard.forEach(function (h) { log("      - " + h); }); return false; }
          var total = r.edges.length - 2, remaining = r.remaining, made = r.cv.boundaries;
          c.edges = r.edges; c.total = total; c.startPieces = r.snap.v1.length; c.remaining = remaining; c.plan = r.plan;
          log("    settings: " + describeSettings(r.plan.settings));
          log("    plan: " + total + " cuts (" + (total * 2) + " razor calls), " + r.plan.gaps.deleteCount + " gap pieces to delete later, " + r.plan.gaps.keepCount + " to keep." + (made ? " " + made + " cuts are already there from an earlier run." : ""));
          if (remaining.length === 0) { log("    Every planned cut is already there. Nothing to cut; the result is checked below."); return true; }
          if (o.noAsk) { log("    Already confirmed for the whole run: go."); return true; }
          var yes = await ask([
            "About to CUT the timeline at " + remaining.length + " points (" + (remaining.length * 2) + " razor calls on V1 + A1), back to front, in short chunks.",
            "Settings: " + describeSettings(r.plan.settings) + ".",
            made ? made + " of " + total + " cuts are already there from an earlier run; only the missing ones are made." : "The clip becomes " + (total + 1) + " pieces. Nothing is deleted in this phase.",
            "",
            "SAVE the project first (Ctrl+S). Ctrl+Z is only a backup. Do not touch Premiere while it runs.",
            "Press Continue to cut, or Cancel to stop. Nothing has been changed yet."]);
          if (!yes) { log("    Cancelled by you. Nothing was cut."); return false; }
          log("    Confirmed by you. Checking the timeline once more before the first razor...");
          var r2 = await cutsCheck("partial");
          if (!r2.ok || r2.remaining.length !== remaining.length) {
            log("    The timeline changed while the box was open. REFUSED, nothing was cut." + (r2.hard.length ? " " + r2.hard[0] : ""));
            return false;
          }
          log("    Same timeline, same plan: go.");
          return true;
        } },
      { name: "Cut V1 + A1 (back to front, in chunks)", run: async function (c) {
          var rem = c.remaining.slice(), done = 0, size = 10, worst = 0, t0 = Date.now(), chunks = 0, lastLog = 0;
          if (!rem.length) { log("    nothing to cut."); return true; }
          while (done < rem.length) {
            if (stopFlag) { log("    Stopped by you after " + done + " of " + rem.length + " cuts. The timeline is part cut and consistent: press the cut button again to carry on (cuts already made are skipped)."); return false; }
            var b = Math.min(rem.length, done + size), w0 = Date.now();
            var r = String(await evalJsx("LT_c_cut([" + rem.slice(done, b).join(",") + "])")), w = Date.now() - w0;
            if (r.indexOf("ok|") !== 0) { log("    FAIL at cuts " + (done + 1) + "-" + b + ": " + r.replace(/^(FAIL\||ERROR: )/, "") + "\n    The timeline may be part cut. Press the cut button again to see what the failsafe says, or undo (Ctrl+Z)."); return false; }
            var p = r.split("|"), want = c.startPieces + b;
            if (Number(p[3]) !== want || Number(p[4]) !== want || Number(p[5]) !== 0) {
              log("    FAIL after cut " + b + ": V1 has " + p[3] + " pieces and A1 has " + p[4] + " (expected " + want + " on each), " + p[5] + " clip(s) on other tracks (expected 0).\n    Stopped here. Nothing more was cut. Undo (Ctrl+Z) or reopen the saved project.");
              return false;
            }
            done = b; chunks++; if (w > worst) worst = w;
            if (w > 900) size = Math.max(2, Math.floor(size / 2));
            if (done === rem.length || done - lastLog >= 50) { lastLog = done; log("    " + done + "/" + rem.length + " cuts (V1 " + p[3] + " pieces, A1 " + p[4] + "; last chunk " + w + " ms, next chunk " + size + ")"); }
            await sleep(15);
          }
          log("    " + rem.length + " cuts in " + chunks + " chunks, " + ((Date.now() - t0) / 1000).toFixed(1) + " s (longest call " + worst + " ms).");
          return true;
        },
        verify: async function (c) {
          var r = await cutsCheck("complete");
          if (!r.ok) return { ok: false, text: r.hard.join(" | ") };
          var cv = r.cv, g = r.checks.filter(function (x) { return /^Pieces classify/.test(x.text); })[0];
          return { ok: true, text: "V1 " + cv.pieces + " pieces and A1 " + cv.pieces + " pieces; all " + (c.total) + " cuts on planned frames (worst edge error " + cv.worstEdge.toFixed(4) + " frames); no holes; source continuous; V1/A1 match piece by piece; " + (g ? g.text.replace(/^Pieces classify as the plan said: /, "") : "") };
        } },
    ];
  }
  async function cutsPhases() { return runPhases(tagStep(cutsPhaseList({}), "cuts"), {}).then(function (ok) { log(ok ? "CUTS DONE. Nothing is deleted yet (that is the next phase). Ctrl+Z undoes the cuts one by one; the saved project is untouched." : "CUTS PHASE DID NOT FINISH; see above."); return ok; }); }

  // =====================================================================================================================
  // The real DELETES phase (step 8). Ripple-deletes the gap pieces: the V1 piece, then the A1 piece, LAST GAP FIRST.
  //   - works from the pieces that are on the timeline now (no need for the original clip), so it starts from a fully cut timeline and from
  //     a half-deleted one of its own making; the delete plan (which pieces are gaps) is worked out again from the markers file every time
  //   - the failsafe runs twice (before and right after the confirm box); it refuses a timeline that is not fully cut (a piece holding only
  //     part of a range), V1 and A1 out of step, a hole, anything on other tracks, a plan that deletes more than the Settings limit
  //   - after EVERY pair the host checks the counts, that the next piece starts exactly where the gap began on both tracks, and V1/A1 sync
  //   - after every chunk the panel checks the piece counts again; at the end the whole timeline is read back and every piece must be
  //     exactly where an exact ripple delete puts it
  // =====================================================================================================================
  async function deletesCheck(mode, pre) {
    var sn = await snapshot();
    if (sn.error) return { ok: false, hard: ["Could not read the timeline: " + sn.error], checks: [] };
    var snap = sn.snap, C = window.LTCore, G = window.LTGuard, fps = snap.seq.fps, hard = [], gaps = null, pieces = [], ranges = null;
    var fr = readFileFacts(snap.media, snap.proj);
    if (!fr.loaded) hard.push("No markers file: " + (fr.error || "none was found. Choose it by hand."));
    else if (fr.matchesMedia === false) hard.push("The markers file \"" + fr.name + "\" does not match the video on V1.");
    if (fr.loaded && snap.v1.length && fps > 0) {
      try {
        var st = getSettings();
        var scope = C.chapterScope(fr.parsed, st.limitChapter);
        var rawItems = C.planMarkers(fr.parsed, st, 0).items;
        var items = scope ? C.restrictItems(rawItems, scope) : rawItems;
        var minTime = scope ? Math.max(0, scope.min) : 0;
        var maxTime = scope ? Math.min(snap.v1[snap.v1.length - 1].outPoint, scope.max) : snap.v1[snap.v1.length - 1].outPoint;
        var cs = C.planCutSet(items, { clips: st.recipeCutClips, chapters: st.recipeCutChapters, padBefore: st.padBefore, padAfter: st.padAfter, mergeGap: st.mergeGap, min: minTime, max: maxTime });
        pieces = snap.v1.map(function (p) { return { start: p.start, end: p.end, inPoint: p.inPoint, outPoint: p.outPoint, speed: 1 }; });
        ranges = cs.ranges;
        gaps = C.planGapDelete(pieces, ranges, { frame: 1 / fps, maxDeletePct: st.maxDeletePct, minKeep: st.minKeepPieces, scope: scope });
      } catch (e) { hard.push("The delete plan could not be worked out: " + (e && e.message ? e.message : String(e))); }
    }
    var cv = G.evaluateDeletes({ seq: snap.seq, video: snap.video, audio: snap.audio, v1: snap.v1, a1: snap.a1, gaps: gaps, mode: mode,
      expectKeep: pre ? pre.keepCount : null, expect: mode === "complete" && pre ? pre.expect : null });
    var checks = [];
    if (fr.loaded) checks.push({ ok: fr.matchesMedia !== false, text: "Markers file: " + fr.name + ".", problem: "" });
    cv.checks.forEach(function (c) { checks.push(c); });
    return { ok: hard.length === 0 && cv.ok, hard: hard.concat(cv.hard), checks: checks, cv: cv, snap: snap, gaps: gaps, pieces: pieces, ranges: ranges, fileData: fr };
  }
  function gapSpecs(pre, fps) {   // last gap first
    var out = [], i;
    for (i = pre.gapIdx.length - 1; i >= 0; i--) {
      var pc = pre.pieces[pre.gapIdx[i]];
      out.push({ s: Math.round(pc.start * fps), e: Math.round(pc.end * fps), si: Math.round(pc.inPoint * fps) });
    }
    return out;
  }
  function specLit(list, a, b) { var x = [], i; for (i = a; i < b; i++) x.push("{s:" + list[i].s + ",e:" + list[i].e + ",si:" + list[i].si + "}"); return "[" + x.join(",") + "]"; }

  function deletesPhaseList(o) {
    o = o || {};
    return [
      { name: "Failsafe + delete plan (read everything again, right now)", run: async function (c) {
          var r = await deletesCheck("partial", null);
          printChecks(r.checks);
          if (!r.ok) { log("    REFUSED. Nothing was deleted:"); r.hard.forEach(function (h) { log("      - " + h); }); return false; }
          var g = r.gaps, fps = r.snap.seq.fps, pieces = r.pieces;
          var pre = { pieces: pieces, gapIdx: g.del.map(function (d) { return d.index; }).sort(function (a, b) { return a - b; }), keepCount: g.keepCount, startV: pieces.length };
          pre.expect = window.LTGuard.expectAfterDeletes(pieces, pre.gapIdx);
          pre.specs = gapSpecs(pre, fps); pre.fps = fps; c.pre = pre;
          var endNow = pieces[pieces.length - 1].end, endAfter = pre.expect.length ? pre.expect[pre.expect.length - 1].end : 0;
          var stg = getSettings();
          log("    settings: " + describeSettings(stg));
          log("    timeline: " + pieces.length + " pieces; " + g.deleteCount + " gap pieces to delete (" + (g.deletePct !== undefined ? g.deletePct.toFixed(1) + "%" : g.text) + "), " + g.keepCount + " to keep. The timeline would end at " + endAfter.toFixed(2) + " s (now " + endNow.toFixed(2) + " s).");
          if (g.deleteCount === 0) { log("    No gap piece is left on the timeline. Nothing to delete; the result is checked below."); return true; }
          if (o.noAsk) { log("    Already confirmed for the whole run: go."); return true; }
          var yes = await ask([
            "About to RIPPLE-DELETE " + g.deleteCount + " gap pieces (" + Math.round(g.deleteSeconds) + " s, " + g.deletePct.toFixed(1) + "% of the timeline) from V1 and A1, last gap first, in short chunks (V1 piece, then A1 piece).",
            "Settings: " + describeSettings(stg) + ".",
            g.keepCount + " pieces are kept. The timeline will be " + endAfter.toFixed(0) + " s long afterwards (now " + endNow.toFixed(0) + " s).",
            "",
            "SAVE the project first (Ctrl+S). Ctrl+Z is only a backup. Do not touch Premiere while it runs.",
            "Press Continue to delete, or Cancel to stop. Nothing has been changed yet."]);
          if (!yes) { log("    Cancelled by you. Nothing was deleted."); return false; }
          log("    Confirmed by you. Checking the timeline once more before the first delete...");
          var r2 = await deletesCheck("partial", null);
          if (!r2.ok || !r2.gaps || r2.gaps.deleteCount !== g.deleteCount || r2.gaps.keepCount !== g.keepCount || r2.pieces.length !== pieces.length) {
            log("    The timeline changed while the box was open. REFUSED, nothing was deleted." + (r2.hard && r2.hard.length ? " " + r2.hard[0] : ""));
            return false;
          }
          log("    Same timeline, same plan: go.");
          return true;
        } },
      { name: "Delete the gap pieces (V1 then A1, last gap first, in chunks)", run: async function (c) {
          var pre = c.pre, specs = pre.specs, done = 0, size = 5, worst = 0, t0 = Date.now(), chunks = 0, lastLog = 0;
          if (!specs.length) { log("    nothing to delete."); return true; }
          while (done < specs.length) {
            if (stopFlag) { log("    Stopped by you after " + done + " of " + specs.length + " deletes. The timeline is part deleted and consistent: press the delete button again to carry on (it works out what is left)."); return false; }
            var b = Math.min(specs.length, done + size), w0 = Date.now();
            var r = String(await evalJsx("LT_d_del(" + specLit(specs, done, b) + ")")), w = Date.now() - w0;
            if (r.indexOf("ok|") !== 0) { log("    FAIL at deletes " + (done + 1) + "-" + b + ": " + r.replace(/^(FAIL\||ERROR: )/, "") + "\n    The timeline may be part deleted. Press the delete button again to see what the failsafe says, or undo (Ctrl+Z)."); return false; }
            var p = r.split("|"), want = pre.startV - b;
            if (Number(p[1]) !== b - done || Number(p[3]) !== want || Number(p[4]) !== want || Number(p[5]) !== 0) {
              log("    FAIL after delete " + b + ": V1 has " + p[3] + " pieces and A1 has " + p[4] + " (expected " + want + " on each), " + p[5] + " clip(s) on other tracks (expected 0).\n    Stopped here. Nothing more was deleted. Undo (Ctrl+Z) or reopen the saved project.");
              return false;
            }
            done = b; chunks++; if (w > worst) worst = w;
            if (w > 900) size = Math.max(1, Math.floor(size / 2));
            if (done === specs.length || done - lastLog >= 25) { lastLog = done; log("    " + done + "/" + specs.length + " deleted (V1 " + p[3] + " pieces, A1 " + p[4] + "; last chunk " + w + " ms, slowest pair " + p[6] + " ms, next chunk " + size + ")"); }
            await sleep(15);
          }
          log("    " + specs.length + " gap pieces deleted in " + chunks + " chunks, " + ((Date.now() - t0) / 1000).toFixed(1) + " s (longest call " + worst + " ms).");
          return true;
        },
        verify: async function (c) {
          var r = await deletesCheck("complete", c.pre);
          if (!r.ok) return { ok: false, text: r.hard.join(" | ") };
          var cv = r.cv;
          return { ok: true, text: "V1 " + cv.pieces + " pieces and A1 " + cv.pieces + " pieces; every piece exactly where an exact ripple delete puts it (worst error " + cv.worstPos.toFixed(4) + " frames); no holes; V1/A1 in sync; V1 ends at " + cv.endSeconds.toFixed(2) + " s; 0 gap pieces left, " + r.gaps.keepCount + " kept." };
        } },
    ];
  }
  async function deletesPhases() { return runPhases(tagStep(deletesPhaseList({}), "deletes"), {}).then(function (ok) { log(ok ? "DELETES DONE. Nothing is relinked yet (that is the next phase). Ctrl+Z undoes the deletes one by one; the saved project is untouched." : "DELETES PHASE DID NOT FINISH; see above."); return ok; }); }


  // =====================================================================================================================
  // The real RELINK phase. Requires D1's complete, verified post-delete timeline. linkSelection is a toggle.
  // Use TrackItem.getLinkedItems() for detection/verification, not getSelection() cardinality.
  // =====================================================================================================================
  function relinkSpecs(snap) {
    var fps = snap.seq.fps, out = [], i, v;
    for (i = 0; i < snap.v1.length; i++) {
      v = snap.v1[i];
      out.push({ i: i, s: Math.round(v.start * fps), e: Math.round(v.end * fps), si: Math.round(v.inPoint * fps) });
    }
    return out;
  }
  function relinkLit(list, a, b) {
    var out = [], i, p;
    for (i = a; i < b; i++) {
      p = list[i];
      out.push("{i:" + p.i + ",s:" + p.s + ",e:" + p.e + ",si:" + p.si + "}");
    }
    return "[" + out.join(",") + "]";
  }
  function sameTimeline(a, b) {
    var i, keys = ["start", "end", "inPoint", "outPoint"];
    if (!a || !b || a.v1.length !== b.v1.length || a.a1.length !== b.a1.length) return false;
    for (i = 0; i < a.v1.length; i++) {
      for (var k = 0; k < keys.length; k++) if (Math.abs(a.v1[i][keys[k]] - b.v1[i][keys[k]]) > 0.00001 || Math.abs(a.a1[i][keys[k]] - b.a1[i][keys[k]]) > 0.00001) return false;
    }
    return true;
  }
  function relinkPhaseList(o) {
    o = o || {};
    return [
      { name: "Failsafe + relink plan (read the post-delete timeline)", run: async function (c) {
          var r = await deletesCheck("complete", null);
          printChecks(r.checks);
          if (!r.ok) { log("    REFUSED. Nothing was linked:"); r.hard.forEach(function (h) { log("      - " + h); }); return false; }
          if (!r.snap.v1.length || r.snap.v1.length !== r.snap.a1.length) { log("    REFUSED: V1/A1 do not contain matching remaining pieces."); return false; }
          c.before = r.snap; c.specs = relinkSpecs(r.snap);
          log("    timeline: " + c.specs.length + " remaining pairs; expected 0 clips on other tracks. Linking does not move clips.");
          if (!c.specs.length) { log("    No pairs to link."); return true; }
          if (o.noAsk) { log("    Already confirmed for the whole run: go."); return true; }
          var yes = await ask([
            "About to LINK " + c.specs.length + " remaining V1/A1 pairs in chunks of 4.",
            "The panel checks each pair's timeline/source frames, uses getLinkedItems() to skip already-linked pairs, and verifies link relationships and unchanged positions. Save first (Ctrl+S).",
            "",
            "SAVE the project first (Ctrl+S). Do not touch Premiere while it runs.",
            "Continue to link, or Cancel. Nothing has been changed yet."]);
          if (!yes) { log("    Cancelled by you. Nothing was linked."); return false; }
          var r2 = await deletesCheck("complete", null);
          if (!r2.ok || !sameTimeline(c.before, r2.snap) || r2.snap.v1.length !== c.specs.length) {
            log("    The timeline changed while the box was open. REFUSED, no link calls made.");
            return false;
          }
          log("    Same timeline, same plan: go.");
          return true;
        } },
      { name: "Link the remaining V1/A1 pairs (in chunks)", run: async function (c) {
          var done = 0, size = 4, worst = 0, chunks = 0, t0 = Date.now(), specs = c.specs;
          while (done < specs.length) {
            if (stopFlag) { log("    Stopped by you after " + done + " of " + specs.length + " pairs. Inspect the current timeline before resuming; the host uses getLinkedItems() to avoid toggling already-linked pairs."); return false; }
            var b = Math.min(specs.length, done + size), before = await snapshot();
            if (before.error || !sameTimeline(c.before, before.snap)) {
              log("    FAIL before chunk " + (chunks + 1) + ": timeline positions changed. No more links attempted.");
              return false;
            }
            var w0 = Date.now(), raw = String(await evalJsx("LT_l_link(" + relinkLit(specs, done, b) + ")")), w = Date.now() - w0;
            if (raw.indexOf("ok|") !== 0) { log("    FAIL at pairs " + (done + 1) + "-" + b + ": " + raw.replace(/^(FAIL\||ERROR: )/, "") + "\n    Do not blindly retry: inspect these pairs first because linkSelection is a toggle."); return false; }
            var p = raw.split("|");
            if (Number(p[1]) !== b - done || Number(p[4]) !== specs.length || Number(p[5]) !== specs.length || Number(p[6]) !== 0) {
              log("    FAIL after chunk " + (chunks + 1) + ": unexpected pair/count result: " + raw + ". Stop and inspect the timeline.");
              return false;
            }
            var after = await snapshot();
            if (after.error || !sameTimeline(c.before, after.snap)) {
              log("    FAIL after chunk " + (chunks + 1) + ": linking appears to have changed timeline positions/source ranges. Stop and inspect; no more links attempted.");
              return false;
            }
            done = b; chunks++; if (w > worst) worst = w;
            log("    " + done + "/" + specs.length + " pairs processed (" + p[2] + " linked now, " + p[3] + " already linked/skipped; chunk " + w + " ms).");
            await sleep(20);
          }
          log("    " + specs.length + " pairs processed in " + chunks + " chunks, " + ((Date.now() - t0) / 1000).toFixed(1) + " s (longest call " + worst + " ms).");
          return true;
        },
        verify: async function (c) {
          var r = await deletesCheck("complete", null), sn = await snapshot();
          if (!r.ok || sn.error || !sameTimeline(c.before, sn.snap)) return { ok: false, text: (r.hard || []).join(" | ") || "Timeline changed during relinking." };
          var v = String(await evalJsx("LT_l_verify(" + relinkLit(c.specs, 0, c.specs.length) + ")"));
          if (v.indexOf("ok|") !== 0) return { ok: false, text: v.replace(/^(FAIL\||ERROR: )/, "") };
          return { ok: true, text: c.specs.length + " pairs verified linked; timeline/source timings unchanged; V1/A1 remain synchronized; no clips on other tracks." };
        } }
    ];
  }
  async function relinkPhases() { return runPhases(tagStep(relinkPhaseList({}), "relink"), {}).then(function (ok) { log(ok ? "RELINK DONE. All pairs verified linked and timeline positions/source timings are unchanged. Inspect a few pairs manually before moving on to the combined workflow." : "RELINK PHASE DID NOT FINISH; see above."); return ok; }); }


  // =====================================================================================================================
  // DO IT ALL. Markers -> cuts -> deletes -> relink -> final check, as ONE guarded run built from the SAME phase lists the single buttons use
  // (markersPhaseList / cutsPhaseList / deletesPhaseList / relinkPhaseList), so there is no second copy of any Premiere-editing logic.
  //   - ONE confirm, up front, after a read-only look at the timeline. The phases then run with their confirm box switched off (noAsk), but each one
  //     still re-reads the whole timeline and runs its full failsafe right before its first change, checks after every chunk, and must pass its
  //     own verify before the next one starts. The first failed check stops everything; nothing is ever retried by itself.
  //   - it works out where the timeline is NOW and only includes the steps still to do, so a stopped / failed run is resumed by pressing the button
  //     again (fresh -> markers+cuts+deletes+relink; part cut; cut; part deleted; deleted but unlinked; all done -> only the final check).
  //   - it never says DONE until the final check has read the whole result back from Premiere and it passes.
  // =====================================================================================================================
  // How many markers the clip has now and how many the plan wants (read-only). Markers can only be ADDED to an uncut timeline (the strict failsafe
  // needs one clip on V1), so on a cut timeline "not there yet" is a reason to refuse, not something the run can repair.
  async function markerCounts(fileData) {
    var sc = await scan(), have = sc.facts && sc.facts.markers ? sc.facts.markers.existing : -1, want = -1;
    try { want = window.LTCore.planMarkers(fileData.parsed, getSettings(), 0).items.length; } catch (e) { want = -1; }
    return { have: have, want: want };
  }
  async function linkCount(snap) {
    var specs = relinkSpecs(snap), r = String(await evalJsx("LT_l_count(" + relinkLit(specs, 0, specs.length) + ")"));
    if (r.indexOf("ok|") !== 0) return { error: r.replace(/^(FAIL\||ERROR: )/, "") };
    var p = r.split("|");
    return { pairs: Number(p[1]), linked: Number(p[2]), unlinked: Number(p[3]), unknown: Number(p[4]) };
  }
  function markersWanted() { var e = fieldEl("recipeMarkers"); return !e || e.checked === undefined || e.checked !== false; }
  function sumRanges(ranges) { var t = 0, i; for (i = 0; i < ranges.length; i++) t += ranges[i].end - ranges[i].start; return t; }
  function sub(list, tag, step) {   // every phase list gets its own context object, so phases can never see each other's variables
    var c = {};
    return list.map(function (p) { return { name: tag + p.name, step: step, run: function () { return p.run(c); }, verify: p.verify ? function () { return p.verify(c); } : null }; });
  }

  // Reads (changes nothing) and works out what is left to do. Returns {refuse:[...]} or the description of the run.
  async function classify(wantMarkers) {
    var out = { steps: { markers: false, cuts: false, deletes: false, relink: false }, soft: [], lines: [], keepCount: 0, deleteCount: 0, cutsLeft: 0, cutsTotal: 0, state: "", allDone: false };
    if (!(await ensureTime())) return { refuse: ["shared/timecode.js could not be loaded into ExtendScript. Reinstall the panel (see the README)."] };
    var cc = await cutsCheck("partial");
    if (cc.ok) {
      var fresh = cc.snap.v1.length === 1;
      out.plan = cc.plan; out.snap = cc.snap; out.ranges = cc.plan.ranges; out.keepCount = cc.plan.gaps.keepCount; out.deleteCount = cc.plan.gaps.deleteCount;
      out.cutsTotal = cc.edges.length - 2; out.cutsLeft = cc.remaining.length;
      out.state = fresh ? "a fresh, uncut timeline" : (cc.remaining.length ? "part cut (" + (out.cutsTotal - out.cutsLeft) + " of " + out.cutsTotal + " cuts already there)" : "fully cut, nothing deleted yet");
      if (fresh && wantMarkers) {
        var st = await check();
        if (!st.verdict.ok) return { refuse: st.verdict.hard };
        out.soft = st.verdict.soft || [];
        out.steps.markers = true; out.markerCount = st.facts.plan.items.length;
      } else if (!fresh && wantMarkers) {
        var mk1 = await markerCounts(cc.fileData);
        if (mk1.have < 0 || mk1.want < 0 || mk1.have < mk1.want) return { refuse: ["The timeline is already cut but the clip has " + mk1.have + " of the " + mk1.want + " markers the plan needs, and markers can only be added BEFORE the first cut. Untick \"Also add the markers\" in Settings to finish without them, or undo the cuts first."] };
        out.lines.push("Markers: " + mk1.have + " already on the clip (plan " + mk1.want + "); not touched.");
      }
      out.steps.cuts = cc.remaining.length > 0; out.steps.deletes = out.deleteCount > 0; out.steps.relink = out.keepCount > 0;
      return out;
    }
    var dc = await deletesCheck("partial", null);
    if (!dc.ok) return { refuse: ["This is not a timeline the run can start from. As a fresh / part-cut timeline: " + (cc.hard[0] || "refused") + "  As a cut / part-deleted timeline: " + (dc.hard[0] || "refused")] };
    out.snap = dc.snap; out.ranges = dc.ranges; out.keepCount = dc.gaps.keepCount; out.deleteCount = dc.gaps.deleteCount;
    var lc = await linkCount(dc.snap);
    if (lc.error) return { refuse: ["Could not read the link state: " + lc.error] };
    if (lc.unknown > 0) return { refuse: [lc.unknown + " pair(s) have a link state Premiere does not report (getLinkedItems). The run will not guess."] };
    if (out.deleteCount > 0 && lc.linked > 0) return { refuse: ["Some pieces are already linked while " + out.deleteCount + " gap pieces are still on the timeline. Undo the links (or the whole run) first: deleting linked pieces is not what was tested."] };
    out.state = out.deleteCount > 0 ? "part deleted (" + out.deleteCount + " gap pieces still there)" : (lc.linked === lc.pairs ? "everything done and linked" : "deleted, " + lc.linked + " of " + lc.pairs + " pairs linked");
    if (wantMarkers) {
      var mk2 = await markerCounts(dc.fileData);
      if (mk2.have < 0 || mk2.want < 0 || mk2.have < mk2.want) return { refuse: ["The timeline is already cut but the clip has " + mk2.have + " of the " + mk2.want + " markers the plan needs, and markers can only be added BEFORE the first cut. Untick \"Also add the markers\" in Settings to finish without them, or undo the cuts first."] };
      out.lines.push("Markers: " + mk2.have + " already on the clip (plan " + mk2.want + "); not touched.");
    }
    out.steps.deletes = out.deleteCount > 0; out.steps.relink = lc.linked < lc.pairs || out.deleteCount > 0;
    out.allDone = !out.steps.deletes && !out.steps.relink;
    return out;
  }

  // The last step: reads the WHOLE result back and judges it against the plan. Only a pass here lets the run say DONE.
  async function finalCheck(cl, wantMarkers) {
    var d = await deletesCheck("complete", null);
    if (!d.ok) return { ok: false, text: d.hard.join(" | ") };
    var snap = d.snap, fps = snap.seq.fps, n = snap.v1.length, bad = [], bits = [];
    if (n !== cl.keepCount) bad.push("V1 has " + n + " pieces but the plan keeps " + cl.keepCount);
    if (snap.a1.length !== n) bad.push("A1 has " + snap.a1.length + " pieces, V1 has " + n);
    var expLen = sumRanges(d.ranges || cl.ranges), gotLen = n ? snap.v1[n - 1].end - snap.v1[0].start : 0, tol = (n + 2) / fps;
    if (Math.abs(gotLen - expLen) > tol) bad.push("the timeline is " + gotLen.toFixed(2) + " s long but the plan keeps " + expLen.toFixed(2) + " s (allowed rounding " + tol.toFixed(2) + " s)");
    if (n && Math.abs(snap.v1[0].start) > 0.00001) bad.push("the first piece does not start at 0");
    bits.push(n + " pieces on V1 and A1, " + gotLen.toFixed(2) + " s long (plan " + expLen.toFixed(2) + " s), no gap pieces, no holes, nothing on other tracks");
    var specs = relinkSpecs(snap), v = String(await evalJsx("LT_l_verify(" + relinkLit(specs, 0, specs.length) + ")"));
    if (v.indexOf("ok|") !== 0) bad.push("links: " + v.replace(/^(FAIL\||ERROR: )/, "")); else bits.push(specs.length + " pairs verified linked");
    if (wantMarkers) {
      var fr = d.fileData, sc = await scan(), have = sc.facts && sc.facts.markers ? sc.facts.markers.existing : -1, want = -1;
      try { want = window.LTCore.planMarkers(fr.parsed, getSettings(), 0).items.length; } catch (e) { bad.push("markers: could not work out the plan (" + e + ")"); }
      if (want >= 0) { if (have < want) bad.push("markers: " + have + " on the clip, the plan needs " + want + " (markers can only be added before the first cut)"); else bits.push(have + " markers on the clip (plan " + want + ")"); }
    }
    return { ok: bad.length === 0, text: bad.length ? bad.join(" | ") : bits.join("; ") };
  }

  // What is left to do on the timeline just read by classify(), in words, with a rough time (scaled from real logs). Used by the confirm box AND by the panel's pre-flight.
  function planTodo(cl) {
    var S = cl.steps, est = 0, todo = [], parts = { markers: 0, cuts: 0, deletes: 0, relink: 0 };
    if (S.markers) { todo.push("add " + cl.markerCount + " markers to the clip"); parts.markers = 3 + cl.markerCount * 0.075; }
    if (S.cuts) { todo.push("cut at " + cl.cutsLeft + " points (" + (cl.cutsLeft * 2) + " razor calls on V1 + A1)"); parts.cuts = 4 + 15.7 * Math.pow(cl.cutsLeft / 199, 2); }
    if (S.deletes) { todo.push("ripple-delete " + cl.deleteCount + " gap pieces"); parts.deletes = 3 + 0.165 * cl.deleteCount; }
    if (S.relink) { todo.push("link " + cl.keepCount + " video/audio pairs"); parts.relink = 3 + 0.168 * cl.keepCount; }
    est = parts.markers + parts.cuts + parts.deletes + parts.relink + 4;
    return { todo: todo, est: est, parts: parts };
  }

  async function doItAll() {
    var wantMarkers = markersWanted(), st0 = Date.now();
    log("=== DO IT ALL: markers -> cuts -> deletes -> relink -> final check (one confirm; stops at the first failed check) ===");
    try { log("Settings: " + describeSettings(getSettings())); } catch (e) { log("REFUSED. Nothing was changed: " + e.message); return false; }
    var cl = await classify(wantMarkers);
    if (cl.refuse) { log("REFUSED. Nothing was changed:"); cl.refuse.forEach(function (h) { log("  - " + h); }); return false; }
    var S = cl.steps, pt = planTodo(cl), est = pt.est, todo = pt.todo;
    log("Timeline now: " + cl.state + ".");
    cl.lines.forEach(function (l) { log("  " + l); });
    if (cl.allDone) log("Nothing is left to do. Only the final check runs.");
    else {
      todo.forEach(function (t, i) { log("  " + (i + 1) + ". " + t); });
      var yes = await ask(["DO IT ALL on the " + cl.state + ":"].concat(todo.map(function (t, i) { return "  " + (i + 1) + ". " + t; }), ["", "Settings: " + describeSettings(getSettings()) + ".", "Rough time: " + fmt(est) + "."].concat(cl.soft.length ? ["", "Note: " + cl.soft.join(" ")] : [], ["", "SAVE the project first (Ctrl+S). Ctrl+Z is only a backup. Do not touch Premiere while it runs.", "Every step re-checks the timeline before it changes anything and the run stops at the first failed check.", "Press Continue to run everything, or Cancel to stop. Nothing has been changed yet."])));
      if (!yes) { log("Cancelled by you. Nothing was changed."); return false; }
      log("Confirmed by you. Each step now re-reads the timeline right before it changes anything.");
    }
    var phases = [], o = { noAsk: true };
    if (S.markers) phases = phases.concat(sub(markersPhaseList(o), "Markers: ", "markers"));
    if (S.cuts) phases = phases.concat(sub(cutsPhaseList(o), "Cuts: ", "cuts"));
    if (S.deletes) phases = phases.concat(sub(deletesPhaseList(o), "Deletes: ", "deletes"));
    if (S.relink) phases = phases.concat(sub(relinkPhaseList(o), "Relink: ", "relink"));
    phases.push({ name: "Final check: read the whole result back from Premiere", step: "final", run: async function () { return true; }, verify: function () { return finalCheck(cl, wantMarkers); } });
    stopFlag = false;
    var ok = await runPhases(phases, {});
    log(ok ? "DO IT ALL DONE in " + ((Date.now() - st0) / 1000).toFixed(1) + " s. The final check passed (see above). Look at a few pieces on the timeline." : "DO IT ALL DID NOT FINISH. See the last STOPPED line above. Nothing was retried. Press the button again to resume: it works out what is left (or undo with Ctrl+Z / reopen the saved project).");
    return ok;
  }

  // PRE-FLIGHT for the panel: READ ONLY. Reads the timeline, finds the markers file, works out what a "Do it all" would do right now.
  // Nothing is changed and nothing is asked. The real run still re-reads everything itself right before each step; this is only what the panel shows.
  async function preflight() {
    var res = { ok: false, problems: [], notes: [], seq: null, clip: "", file: null, state: "", steps: null, counts: null, todo: [], est: 0, parts: null, allDone: false, fresh: false, wantMarkers: markersWanted() };
    try { getSettings(); } catch (e) { res.problems.push(e.message); return res; }
    var sc = await scan();
    if (sc.error) { res.problems.push("Could not read the timeline: " + sc.error); return res; }
    var f = sc.facts, media = f.v1.length ? f.v1[0].media : "";
    res.seq = f.seq ? { name: f.seq.name, fps: f.seq.fps } : null;
    if (f.v1.length) res.clip = baseOf(media || f.v1[0].name || "");
    var fr = readFileFacts(media, f.proj);
    res.file = { loaded: fr.loaded, name: fr.name || "", how: fr.how || "", error: fr.error || "", markerCount: fr.loaded ? fr.parsed.markers.length : 0, byHand: !!S.overridePath };
    if (!fr.loaded) { res.problems.push("Markers file: " + fr.error); return res; }
    var cl = await classify(res.wantMarkers);
    if (cl.refuse) { res.problems = cl.refuse.slice(); return res; }
    var pt = planTodo(cl);
    res.ok = true; res.state = cl.state; res.steps = cl.steps; res.allDone = cl.allDone; res.fresh = cl.state.indexOf("fresh") >= 0;
    res.counts = { markers: cl.markerCount || 0, cuts: cl.cutsLeft || 0, deletes: cl.deleteCount || 0, links: cl.keepCount || 0 };
    res.todo = pt.todo; res.est = pt.est; res.parts = pt.parts;
    res.notes = (cl.soft || []).concat(cl.lines || []);
    return res;
  }
  // Runs preflight() under the same lock as the runs (so a check can never overlap a run) and tells the panel. Returns null when something else is busy.
  async function refreshPreflight() {
    if (busy) return null;
    setBusy(true, "check");
    var res;
    try { res = await preflight(); } catch (e) { res = { ok: false, problems: ["The check itself failed: " + (e && e.message ? e.message : e)], notes: [], todo: [] }; } finally { setBusy(false, "check"); }
    emit("preflight", res);
    return res;
  }

  loadSavedSettings();
  (function () {
    var ids = NUM_FIELDS.map(function (f) { return f[0]; }).concat(["recipeCutChapters", "recipeMarkers"]), i, e;
    for (i = 0; i < ids.length; i++) { e = fieldEl(ids[i]); if (e && e.addEventListener) e.addEventListener("change", saveSettings); }
  })();
  bindRun("rAll", async function () { stopFlag = false; return await doItAll(); });
  bindRun("rDry", dryRun);
  bindRun("rMarkers", async function () { stopFlag = false; return await markersPhases(); });
  bindRun("rCuts", async function () { stopFlag = false; return await cutsPhases(); });
  bindRun("rDel", async function () { stopFlag = false; return await deletesPhases(); });
  bindRun("rLink", async function () { stopFlag = false; return await relinkPhases(); });
  bindRun("rRemove", removeMarkers);
  bind("rYes", async function () { answer(true); });
  bind("rNo", async function () { answer(false); });
  bind("rStop", async function () {
    stopFlag = true; emit("stop", null);
    if (askResolve) { log("Stop pressed while waiting for your answer: treated as Cancel. Nothing was changed."); answer(false); return; }
    log("Stop requested: it halts after the current chunk.");
  });
  bindRun("rChoose", chooseFile);
  bindRun("rAuto", clearChoice);
  window.LTRunner = { on: on, preflight: refreshPreflight, runPhases: runPhases, gather: gather, check: check, cutsCheck: cutsCheck, buildPlan: buildPlan, getSettings: getSettings, saveSettings: saveSettings, loadSavedSettings: loadSavedSettings, applyRecipeByName: applyRecipeByName, applyFilePreferences: applyFilePreferences, doItAll: doItAll, describeSettings: describeSettings, printVerdict: printVerdict, log: log, state: S };
  bind("bClear", async function () { out.value = ""; });
  bind("bCopy", async function () { out.select(); document.execCommand("copy"); });
  try {
    if (window.__adobe_cep__ && window.__adobe_cep__.getCurrentApiVersion) {
      var api = JSON.parse(window.__adobe_cep__.getCurrentApiVersion());
      log("CEP runtime version: " + api.major + "." + api.minor + "." + api.micro + "  (registry key: HKCU\\Software\\Adobe\\CSXS." + api.major + ")");
    }
    if (window.__adobe_cep__ && window.__adobe_cep__.getHostEnvironment) {
      var env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
      log("Host: " + env.appName + " " + env.appVersion);
    }
  } catch (e0) { log("Could not read the CEP / host version: " + e0); }
  log("Runner ready. LTCore " + (window.LTCore ? "loaded" : "NOT loaded: check shared/markers-core.js") + "; LTGuard " + (window.LTGuard ? "loaded" : "NOT loaded: check shared/guard.js") + "; cep.fs " + (window.cep && window.cep.fs ? "available" : "MISSING (the markers file cannot be read)") + ".");
})();
