// The panel's look: draws what js/runner.js reports. It never edits anything and never calls Premiere itself; everything it knows arrives as events
// from the runner (pre-flight result, phase start/end, log lines, end of run) and goes through shared/progress.js (the pure progress model).
// A problem in here can never disturb a run: the runner guards every listener call.
(function () {
  "use strict";
  var R = window.LTRunner, P = window.LTProgress;
  if (!R || !P || !R.on) return;
  var AUTO = window.LTUI_AUTO !== false;   // tests switch the automatic re-checks off

  function $(id) { return document.getElementById(id); }
  function text(id, t) { var e = $(id); if (e) e.textContent = t; }
  function hide(id, h) { var e = $(id); if (e) e.hidden = !!h; }
  function cls(id, c) { var e = $(id); if (e) e.className = c; }
  function field(id) { var e = $(id); return e && e.value !== undefined ? String(e.value).replace(/^\s+|\s+$/g, "") : ""; }

  var STEP_OF = { rMarkers: "markers", rCuts: "cuts", rDel: "deletes", rLink: "relink" };
  var ROW = { markers: "stMarkers", cuts: "stCuts", deletes: "stDeletes", relink: "stRelink", final: "stFinal" };
  var VERB = { markers: "Adding the markers", cuts: "Cutting", deletes: "Deleting the gaps", relink: "Linking video and audio", final: "Checking the result" };
  var DONE_TEXT = { markers: "Markers added and checked.", cuts: "Cuts made and checked. Nothing is deleted yet.", deletes: "Gaps deleted and checked. Nothing is linked yet.", relink: "Video and audio linked and checked." };

  var pf = null, model = null, runId = "", stopping = false, asking = false, tickTimer = null, refreshTimer = null, pendingRefresh = false, lastCheckAt = 0, checking = false;

  // ---------------------------------------------------------------- the pill (top right)
  function pill(kind, t) { cls("pill", "pill" + (kind ? " p-" + kind : "")); text("pill", t); }
  function idlePill() {
    if (!pf) { pill("", "Starting"); return; }
    if (!pf.ok) pill("warn", "Needs attention");
    else if (pf.allDone) pill("ok", "All done");
    else pill("ok", "Ready");
  }

  // ---------------------------------------------------------------- pre-flight (the "what will happen" card + the main button)
  function row(id, state, t) { cls(id, "pf-" + state); text(id + "Tx", t); hide(id, false); }
  function summary() {
    var s = [field("padBefore") + " s before", field("padAfter") + " s after", "merge " + field("mergeGap") + " s"];
    var ch = $("recipeCutChapters");
    if (ch && ch.checked) s.push("+ chapters");
    text("setSum", " " + s.join(" \u00B7 "));
  }
  function settingsError() {
    var msg = "";
    try { R.getSettings(); } catch (e) { msg = e && e.message ? e.message : String(e); }
    text("setErr", msg);
    return msg;
  }
  function bullets(list) { return list.map(function (x) { return "\u2022 " + x; }).join("\n"); }
  function renderPreflight(r) {
    pf = r; lastCheckAt = Date.now(); checking = false;
    summary(); settingsError();
    // update limitChapter dropdown if chapters available
    var sel = $("limitChapter");
    if (sel && r.file && r.file.parsed && sel.options) {
      var chapters = window.LTCore.chapterList(r.file.parsed);
      var currentVal = sel.value;
      if (sel.options.length !== chapters.length + 1) {
        sel.textContent = "";
        var allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "All chapters (whole file)";
        sel.appendChild(allOpt);
        chapters.forEach(function (ch) {
          var opt = document.createElement("option");
          opt.value = ch.index;
          opt.textContent = ch.name;
          sel.appendChild(opt);
        });
        sel.value = currentVal;
      }
    }
    // markers file
    var f = r.file;
    if (f && f.loaded) { text("fileName", f.name); text("fileHow", f.how + " \u00B7 " + f.markerCount + " markers"); }
    else if (f) { text("fileName", "No markers file"); text("fileHow", f.error || ""); }
    else { text("fileName", "\u2014"); text("fileHow", ""); }
    hide("rAuto", !(f && f.byHand));
    text("pfSeq", r.seq ? "Sequence \"" + r.seq.name + "\" \u00B7 " + (Math.round(r.seq.fps * 1000) / 1000) + " fps" + (r.clip ? " \u00B7 " + r.clip : "") : "");
    text("pfProblems", ""); text("pfNotes", ""); text("pfTime", "");
    var steps = r.steps, c = r.counts;
    if (!r.ok) {
      text("pfState", "Can't start yet");
      ["pfMarkers", "pfCuts", "pfDeletes", "pfRelink"].forEach(function (id) { hide(id, true); });
      text("pfProblems", bullets(r.problems && r.problems.length ? r.problems : ["The timeline could not be checked."]));
      hide("rAll", true); hide("bCheck", false);
      text("cMarkers", ""); text("cCuts", ""); text("cDel", ""); text("cLink", "");
    } else {
      text("pfState", "Timeline: " + r.state);
      if (!r.wantMarkers) row("pfMarkers", "skip", "Markers: not added (switched off in Settings)");
      else if (steps.markers) row("pfMarkers", "todo", "Add " + c.markers + " markers to the clip");
      else row("pfMarkers", "done", "Markers: already on the clip");
      if (steps.cuts) row("pfCuts", "todo", "Cut at " + c.cuts + " points" + (r.fresh ? "" : " (the rest)")); else row("pfCuts", "done", "Cuts: done");
      if (steps.deletes) row("pfDeletes", "todo", "Delete " + c.deletes + " gap pieces"); else row("pfDeletes", "done", "Gaps: deleted");
      if (steps.relink) row("pfRelink", "todo", "Link " + c.links + " video/audio pairs"); else row("pfRelink", "done", "Pairs: linked");
      var anyTodo = r.todo.length > 0;
      text("pfTime", anyTodo ? "Rough time: " + P.fmtApprox(r.est) + ". One confirm, then every step re-checks the timeline before it changes anything." : "Nothing left to do.");
      if (r.notes && r.notes.length) text("pfNotes", bullets(r.notes));
      // the main button
      var pcs = [];
      if (steps.markers) pcs.push(c.markers + " markers");
      if (steps.cuts) pcs.push(c.cuts + " cuts");
      if (steps.deletes) pcs.push(c.deletes + " deletes");
      if (steps.relink) pcs.push(c.links + " links");
      if (r.allDone) { text("rAllLabel", "Run the final check"); text("rAllSub", "Everything is already done and linked"); }
      else if (!r.fresh && anyTodo) { text("rAllLabel", "Continue"); text("rAllSub", "Left to do: " + pcs.join(" \u00B7 ") + " \u00B7 " + P.fmtApprox(r.est)); }
      else if (anyTodo) { text("rAllLabel", "Do it all"); text("rAllSub", pcs.join(" \u00B7 ") + " \u00B7 " + P.fmtApprox(r.est)); }
      else { text("rAllLabel", "Run the final check"); text("rAllSub", "Nothing left to do"); }
      hide("rAll", false); hide("bCheck", true);
      // the single steps
      text("cMarkers", !r.wantMarkers ? "" : steps.markers ? c.markers + " to add." : "Already on the clip.");
      text("cCuts", steps.cuts ? c.cuts + " cuts to make." : "Done.");
      text("cDel", steps.deletes ? c.deletes + " gaps to delete." : "Done.");
      text("cLink", steps.relink ? c.links + " pairs to link." : "Done.");
    }
    if (!model) idlePill();   // after a run the pill keeps that run's result until the next one starts
  }

  // ---------------------------------------------------------------- a run in progress
  function expectedSteps(id) {
    if (STEP_OF[id]) return [STEP_OF[id]];
    var s = pf && pf.ok && pf.steps ? pf.steps : null, out = [];
    if (!s) return ["markers", "cuts", "deletes", "relink", "final"];
    if (s.markers) out.push("markers"); if (s.cuts) out.push("cuts"); if (s.deletes) out.push("deletes"); if (s.relink) out.push("relink");
    out.push("final");
    return out;
  }
  function weights(ids) {
    var w = {}, parts = pf && pf.parts ? pf.parts : null;
    ids.forEach(function (id) { w[id] = id === "final" ? 4 : (parts && parts[id] > 0 ? parts[id] : 1); });
    return w;
  }
  function onStart(e) {
    runId = e.id; stopping = false; asking = false;
    hide("statusMsg", true);
    if (STEP_OF[e.id] || e.id === "rAll") {
      var ids = expectedSteps(e.id);
      model = P.create(ids, weights(ids), Date.now());
      Object.keys(ROW).forEach(function (k) { hide(ROW[k], ids.indexOf(k) < 0); cls(ROW[k], "st-pending"); text(ROW[k] + "Cnt", ""); });
      hide("progCard", false);
      tick();
    } else { model = null; hide("progCard", true); pill("run", "Working"); }
  }
  function render() {
    if (!model) return;
    var now = Date.now(), f = P.fraction(model), fill = $("progFill");
    if (fill) { fill.style.width = Math.round(f * 100) + "%"; fill.className = "fill" + (model.ended ? (model.ok ? " f-done" : (model.outcome === "stopped" || model.outcome === "cancelled" ? " f-warn" : " f-bad")) : ""); }
    model.steps.forEach(function (s) {
      var id = ROW[s.id]; if (!id) return;
      cls(id, "st-" + s.status);
      text(id + "Cnt", s.status === "pending" || s.status === "skipped" ? "" : (s.total > 0 ? (s.status === "done" ? String(s.total) : s.done + " / " + s.total) : ""));
    });
    var cur = model.current && model.by[model.current] ? model.by[model.current] : null, idx = cur ? model.steps.indexOf(cur) + 1 : 0, line;
    if (model.ended) line = model.ok ? "Done" : ({ stopped: "Stopped", cancelled: "Cancelled", refused: "Refused", failed: "Stopped by a failed check" }[model.outcome] || "Stopped");
    else if (asking) line = "Waiting for your answer";
    else if (stopping) line = "Stopping after the current chunk";
    else if (cur) line = (model.steps.length > 1 ? "Step " + idx + " of " + model.steps.length + " \u00B7 " : "") + VERB[cur.id] + (cur.total > 0 ? " \u00B7 " + cur.done + " / " + cur.total : "");
    else line = "Starting";
    text("progText", line);
    var el = P.elapsed(model, now), rem = P.remaining(model, now);
    text("progTime", P.fmtClock(el) + (!model.ended && rem !== null ? " \u00B7 " + P.fmtApprox(rem) + " left" : ""));
    if (!model.ended) pill("run", stopping ? "Stopping" : (asking ? "Waiting" : "Running"));
  }
  function tick() {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    if (!model || model.ended) return;
    render();
    tickTimer = setTimeout(tick, 500);
  }
  function stepLabel(id) { return model && model.by[id] ? model.by[id].label : id; }
  function message(id) {
    var m = model, done = m.steps.filter(function (s) { return s.status === "done"; }).length, t = P.fmtClock(P.elapsed(m, Date.now()));
    if (m.outcome === "done") {
      if (id === "rAll") return { k: "ok", t: "Done in " + t + ". The final check passed. Have a look at a few pieces on the timeline." };
      return { k: "ok", t: (DONE_TEXT[STEP_OF_REV(id)] || "Done.") + " (" + t + ")" };
    }
    if (m.outcome === "cancelled") return { k: "warn", t: "Cancelled. Nothing was changed." };
    if (m.outcome === "stopped") return { k: "warn", t: "Stopped after " + t + ". Everything done so far is consistent. Press the button again to carry on where it stopped." };
    if (m.outcome === "refused") {
      var why = m.reasons.slice(0, 3).join("\n\u2022 ") + (m.reasons.length > 3 ? "\n\u2022 and " + (m.reasons.length - 3) + " more (see the log)" : "");
      return { k: "bad", t: (done ? "Stopped before " + (m.current ? stepLabel(m.current) : "the next step") + " (the steps before it are done):\n\u2022 " : "Refused. Nothing was changed:\n\u2022 ") + why };
    }
    var at = (m.failedAt || "").replace(/^(Markers|Cuts|Deletes|Relink): /, "");
    return { k: "bad", t: "Stopped at \"" + (at || (m.current ? stepLabel(m.current) : "a step")) + "\": " + (m.lastCheck || "see the log") + "\nNothing was retried. Look at the log, then press the button again to resume (it works out what is left), or undo with Ctrl+Z / reopen the saved project." };
  }
  function STEP_OF_REV(id) { return STEP_OF[id] || ""; }
  function openLog() { var l = $("logBox"); if (l) l.open = true; }
  function onEnd(e) {
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    if (model && (STEP_OF[e.id] || e.id === "rAll")) {
      P.onEnd(model, e.ok, Date.now());
      render();
      var m = message(e.id);
      text("statusMsg", m.t); cls("statusMsg", "status " + m.k); hide("statusMsg", false);
      pill(m.k === "ok" ? "ok" : (m.k === "warn" ? "warn" : "bad"), m.k === "ok" ? "Done" : (model.outcome === "stopped" ? "Stopped" : (model.outcome === "cancelled" ? "Cancelled" : "Problem")));
      if (m.k === "bad") openLog();
    } else if (e.id === "rDry") {
      text("statusMsg", e.ok ? "Detailed check passed: a real run would start. Nothing was touched. The checks are in the log." : "Detailed check: a real run would NOT start. The reasons are in the log.");
      cls("statusMsg", "status " + (e.ok ? "ok" : "bad")); hide("statusMsg", false); openLog(); idlePillAfterTool();
    } else if (e.id === "rRemove") {
      text("statusMsg", e.ok ? "The plan's markers were removed and checked. Details are in the log." : "Nothing was removed (cancelled or refused). Details are in the log.");
      cls("statusMsg", "status " + (e.ok ? "ok" : "warn")); hide("statusMsg", false); idlePillAfterTool();
    } else idlePillAfterTool();
    model = e.id === "rAll" || STEP_OF[e.id] ? model : null;
    if (AUTO) scheduleRefresh(100);
  }
  function idlePillAfterTool() { idlePill(); }

  // ---------------------------------------------------------------- when to read the timeline again (read-only; never while something runs)
  function scheduleRefresh(ms) {
    if (!AUTO) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refreshTimer = null; refreshNow(); }, ms);
  }
  function refreshNow() {
    var p = R.preflight();
    if (p && p.then) p.then(function (r) { if (r === null) pendingRefresh = true; }, function () {});
    return p;
  }

  // ---------------------------------------------------------------- the open/closed state of the three collapsible sections is remembered
  var UI_KEY = "ltUi", BOXES = ["stepsBox", "setBox", "logBox"];
  function loadOpen() {
    try { var o = JSON.parse(window.localStorage.getItem(UI_KEY) || "{}"); BOXES.forEach(function (id) { var e = $(id); if (e && o[id] !== undefined) e.open = !!o[id]; }); } catch (ignore) {}
  }
  function saveOpen() {
    try { var o = {}; BOXES.forEach(function (id) { var e = $(id); o[id] = !!(e && e.open); }); window.localStorage.setItem(UI_KEY, JSON.stringify(o)); } catch (ignore) {}
  }

  // ---------------------------------------------------------------- wiring
  R.on("preflight", renderPreflight);
  R.on("start", onStart);
  R.on("end", onEnd);
  R.on("phase", function (e) { if (model && !model.ended) { P.onPhase(model, e); render(); } });
  R.on("phaseEnd", function (e) { if (model && !model.ended) { P.onPhaseEnd(model, e); render(); } });
  R.on("log", function (line) { if (model && !model.ended) { P.onLog(model, line); if (/^\s+\d+\/\d+/.test(line)) render(); } });
  R.on("busy", function (e) {
    var stop = $("rStop"); if (stop) stop.disabled = !(e.on && e.kind === "run");
    if (e.on && e.kind === "check") { checking = true; pill("", "Checking"); }
    if (!e.on && pendingRefresh) { pendingRefresh = false; scheduleRefresh(100); }
  });
  R.on("stop", function () { stopping = true; render(); });
  R.on("ask", function () { asking = true; render(); var b = $("rAskBox"); if (b && b.scrollIntoView) { try { b.scrollIntoView({ block: "nearest" }); } catch (ignore) {} } });
  R.on("askDone", function () { asking = false; render(); });
  R.on("settingsChanged", function () { summary(); settingsError(); scheduleRefresh(600); });
  R.on("fileChanged", function () { scheduleRefresh(50); });

  var b1 = $("bRefresh"), b2 = $("bCheck");
  if (b1) b1.addEventListener("click", function () { refreshNow(); });
  if (b2) b2.addEventListener("click", function () { refreshNow(); });
  BOXES.forEach(function (id) { var e = $(id); if (e) e.addEventListener("toggle", saveOpen); });
  ["padBefore", "padAfter", "mergeGap"].forEach(function (id) { var e = $(id); if (e) e.addEventListener("input", function () { summary(); settingsError(); }); });
  if (window.addEventListener) window.addEventListener("focus", function () { if (AUTO && !checking && Date.now() - lastCheckAt > 3000) scheduleRefresh(150); });

  var recSel = $("recipeSelect");
  if (recSel && window.LTCore && window.LTCore.DEFAULT_RECIPES) {
    recSel.textContent = "";
    window.LTCore.DEFAULT_RECIPES.forEach(function (rec) {
      var opt = document.createElement("option");
      opt.value = rec.name;
      opt.textContent = rec.name;
      recSel.appendChild(opt);
    });
    recSel.addEventListener("change", function () {
      if (R.applyRecipeByName) R.applyRecipeByName(recSel.value);
    });
  }
  var lc = $("limitChapter");
  if (lc) lc.addEventListener("change", function () { R.saveSettings(); });

  loadOpen(); summary(); idlePill();
  if (AUTO) scheduleRefresh(300);
  window.LTUI = { renderPreflight: renderPreflight, render: render, model: function () { return model; }, preflight: function () { return pf; } };
})();
