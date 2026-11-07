"use strict";
// LTProgress: the panel's progress model. PURE (no DOM, no Premiere): events and log lines in, a description of "where the run is" out.
// The panel (js/ui.js) feeds it what js/runner.js reports (phase start / phase end / log lines / end of the run) and draws the result.
// It never decides anything about the editing: it only reads what the runner already said. Tested in Node against a real Premiere log.
(function (root) {
  var LABEL = { markers: "Markers", cuts: "Cuts", deletes: "Delete the gaps", relink: "Link video and audio", final: "Final check" };
  // The runner's chunk lines:  "    50/110 (50 added, ...)"  "    50/199 cuts (...)"  "    25/100 deleted (...)"  "    4/100 pairs processed (...)"
  var COUNT_RE = /^\s{2,}(\d+)\/(\d+)\s*(?:\(|cuts\b|deleted\b|pairs processed\b)/;

  function addStep(st, id, weight) {
    if (st.by[id]) return st.by[id];
    var s = { id: id, label: LABEL[id] || id, status: "pending", done: 0, total: 0, weight: weight > 0 ? weight : 1 };
    st.steps.push(s); st.by[id] = s;
    return s;
  }
  // ids: the steps this run is expected to have, in order. weights: {id: seconds} (rough time per step) so the bar moves in proportion to the real time.
  function create(ids, weights, now) {
    var st = { steps: [], by: {}, current: null, phaseName: "", startedAt: now || 0, endedAt: null, ended: false, ok: null, outcome: "",
      userStop: false, cancelled: false, sawDone: false, failedAt: "", lastCheck: "", reasons: [], _collect: false };
    var i;
    for (i = 0; i < (ids || []).length; i++) addStep(st, ids[i], weights ? weights[ids[i]] : 0);
    return st;
  }
  function onPhase(st, ev) {
    if (!ev || !ev.step) return st;
    var s = addStep(st, ev.step);
    if (s.status === "pending") s.status = "running";
    st.current = ev.step; st.phaseName = ev.name || "";
    return st;
  }
  // A step is DONE when its phase that has a verify passed (the last phase of every step is the one with the verify). A failed phase marks the step.
  function onPhaseEnd(st, ev) {
    if (!ev || !ev.step) return st;
    var s = st.by[ev.step];
    if (!s) return st;
    if (ev.check) st.lastCheck = ev.check;
    if (ev.ok) { if (ev.hasVerify) { s.status = "done"; if (s.total) s.done = s.total; } }
    else s.status = st.userStop ? "stopped" : "failed";
    return st;
  }
  function onLog(st, line) {
    line = String(line);
    var m = COUNT_RE.exec(line);
    if (m && st.current && st.by[st.current]) { st.by[st.current].done = Number(m[1]); st.by[st.current].total = Number(m[2]); }
    if (/Stopped by you/.test(line)) st.userStop = true;
    if (/^Cancelled/.test(line)) st.cancelled = true;
    if (/^STOPPED at "/.test(line)) { var f = /^STOPPED at "(.*?)"\./.exec(line); st.failedAt = f ? f[1] : line; }
    if (/DO IT ALL DONE|^(MARKERS|CUTS|DELETES|RELINK) DONE/.test(line)) st.sawDone = true;
    var r = /^\s+\[STOP\]\s+(.*)$/.exec(line);
    if (r) st.reasons.push(r[1]);
    if (/^REFUSED/.test(line)) st._collect = true;
    else if (st._collect) { var d = /^\s+- (.*)$/.exec(line); if (d) st.reasons.push(d[1]); else st._collect = false; }
    return st;
  }
  function onEnd(st, ok, now) {
    var i, s;
    st.ended = true; st.ok = !!ok; st.endedAt = now || st.endedAt;
    for (i = 0; i < st.steps.length; i++) {
      s = st.steps[i];
      if (ok) { if (s.status === "pending") s.status = "skipped"; else if (s.status === "running") s.status = "done"; }
      else if (s.status === "running") s.status = st.userStop ? "stopped" : "failed";
    }
    st.outcome = ok ? "done" : st.cancelled ? "cancelled" : st.userStop ? "stopped" : st.reasons.length ? "refused" : "failed";
    return st;
  }
  // 0..1, weighted by each step's rough time. Skipped steps do not count.
  function fraction(st) {
    var wsum = 0, num = 0, i, s, f;
    if (st.ended && st.ok) return 1;
    for (i = 0; i < st.steps.length; i++) {
      s = st.steps[i];
      if (s.status === "skipped") continue;
      wsum += s.weight;
      f = s.status === "done" ? 1 : (s.total > 0 ? Math.min(1, s.done / s.total) : 0);
      num += s.weight * f;
    }
    return wsum > 0 ? num / wsum : 0;
  }
  function elapsed(st, now) { return Math.max(0, ((st.ended ? st.endedAt : now) - st.startedAt) / 1000); }
  // Seconds left, or null while there is too little to go on.
  function remaining(st, now) {
    if (st.ended) return 0;
    var f = fraction(st), e = elapsed(st, now);
    return f >= 0.08 && e > 1 ? e * (1 - f) / f : null;
  }
  // "0:47", "12:05"
  function fmtClock(s) { s = Math.max(0, Math.round(s)); var m = Math.floor(s / 60), r = s % 60; return m + ":" + (r < 10 ? "0" : "") + r; }
  // "about 45 s", "about 2 min"
  function fmtApprox(s) { return s < 90 ? "about " + Math.max(1, Math.round(s)) + " s" : "about " + Math.round(s / 60) + " min"; }

  var api = { LABEL: LABEL, create: create, addStep: addStep, onPhase: onPhase, onPhaseEnd: onPhaseEnd, onLog: onLog, onEnd: onEnd, fraction: fraction, elapsed: elapsed, remaining: remaining, fmtClock: fmtClock, fmtApprox: fmtApprox };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LTProgress = api;
})(typeof window !== "undefined" ? window : globalThis);
