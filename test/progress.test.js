"use strict";
// The progress model, replayed against a REAL Premiere log (test/fixtures/doitall-real.log) and against hand-made failure/stop/refusal logs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../src/progress.js");

const real = fs.readFileSync(path.join(__dirname, "fixtures", "doitall-real.log"), "utf8").replace(/\r\n/g, "\n").split("\n");
const STEP_OF = { Markers: "markers", Cuts: "cuts", Deletes: "deletes", Relink: "relink", "Final check": "final" };
// replays log lines the way the runner reports them: a phase event at each "[k/n] name" line, a phaseEnd at the "(N ms)" line that closes it
function replay(lines, st, hooks) {
  let cur = null, check = "", t = 0;
  for (const line of lines) {
    const m = /^\[(\d+)\/(\d+)\] (Markers|Cuts|Deletes|Relink|Final check)(?:: )?(.*)$/.exec(line);
    if (m) { cur = { step: STEP_OF[m[3]], idx: +m[1] - 1, name: line, hasVerify: false }; check = ""; P.onPhase(st, { index: cur.idx, step: cur.step, name: m[4] || m[3] }); }
    P.onLog(st, line);
    const c = /^\s+check: (PASS|FAIL) (.*)$/.exec(line);
    if (c && cur) { cur.hasVerify = true; cur.ok = c[1] === "PASS"; check = c[2]; }
    if (/^\s+\(\d+ ms\)$/.test(line) && cur) { P.onPhaseEnd(st, { index: cur.idx, step: cur.step, ok: cur.hasVerify ? cur.ok : true, hasVerify: cur.hasVerify, check }); }
    if (hooks) hooks(line, st, ++t);
  }
}
const REAL_WEIGHTS = { markers: 11, cuts: 20, deletes: 17, relink: 17, final: 4 };

test("real log: every step goes pending -> running -> done, in order, and the bar never goes backwards", () => {
  const st = P.create(["markers", "cuts", "deletes", "relink", "final"], REAL_WEIGHTS, 0);
  let last = -1, seenRunning = {};
  replay(real, st, (line) => {
    const f = P.fraction(st);
    assert.ok(f >= last - 1e-9, `the bar went back at: ${line} (${f} < ${last})`);
    last = f;
    if (st.current && st.by[st.current].status === "running") seenRunning[st.current] = true;
  });
  P.onEnd(st, true, 49300);
  assert.deepEqual(st.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
  assert.deepEqual(Object.keys(seenRunning), ["markers", "cuts", "deletes", "relink", "final"]);
  assert.equal(P.fraction(st), 1);
  assert.equal(st.outcome, "done");
  assert.ok(st.sawDone);
});

test("real log: chunk lines give the right counts for each step", () => {
  const st = P.create(["markers", "cuts", "deletes", "relink", "final"], REAL_WEIGHTS, 0);
  const got = {};
  replay(real, st, (line) => { if (st.current && st.by[st.current].total) got[st.current] = st.by[st.current].done + "/" + st.by[st.current].total; });
  assert.equal(got.markers, "110/110");
  assert.equal(got.cuts, "199/199");
  assert.equal(got.deletes, "100/100");
  assert.equal(got.relink, "100/100");
});

test("real log: the failsafe / summary lines are never mistaken for progress", () => {
  const st = P.create(["markers", "cuts"], null, 0);
  P.onPhase(st, { step: "markers", name: "x" });
  for (const l of ["    110 added, 0 already there, in 6.1 s (longest call 659 ms).", "    199 cuts in 22 chunks, 11.2 s (longest call 934 ms).", "  [ok]   Delete plan: 100 pieces, 28,989 s, 84.3%; keep 100 pieces, 5,391 s.", "    plan: 199 cuts (398 razor calls), 100 gap pieces to delete later, 100 to keep.", "    check: PASS 110/110 markers read back from Premiere: 0 missing"]) P.onLog(st, l);
  assert.equal(st.by.markers.total, 0);
  P.onLog(st, "    50/110 (50 added, 0 already there)");
  assert.deepEqual([st.by.markers.done, st.by.markers.total], [50, 110]);
});

test("the bar follows the rough time of each step (weights), not the number of steps", () => {
  const st = P.create(["markers", "cuts"], { markers: 10, cuts: 30 }, 0);
  P.onPhase(st, { step: "markers", name: "m" }); P.onPhaseEnd(st, { step: "markers", ok: true, hasVerify: true });
  assert.ok(Math.abs(P.fraction(st) - 0.25) < 1e-9);
  P.onPhase(st, { step: "cuts", name: "c" }); P.onLog(st, "    100/200 cuts (V1 101 pieces");
  assert.ok(Math.abs(P.fraction(st) - (10 + 15) / 40) < 1e-9);
});

test("a failed check marks that step failed, keeps the earlier ones done, and reports the reason", () => {
  const st = P.create(["markers", "cuts", "deletes"], null, 0);
  P.onPhase(st, { step: "markers", name: "m" }); P.onPhaseEnd(st, { step: "markers", ok: true, hasVerify: true, check: "PASS" });
  P.onPhase(st, { step: "cuts", name: "c" });
  P.onLog(st, "    50/199 cuts (V1 51 pieces");
  P.onPhaseEnd(st, { step: "cuts", ok: false, hasVerify: true, check: "V1 has 40 pieces and A1 has 41" });
  P.onLog(st, 'STOPPED at "Cuts: Cut V1 + A1 (back to front, in chunks)". Nothing after it ran, and nothing was changed by this stop.');
  P.onEnd(st, false, 5000);
  assert.deepEqual(st.steps.map((s) => s.status), ["done", "failed", "pending"]);
  assert.equal(st.outcome, "failed");
  assert.equal(st.lastCheck, "V1 has 40 pieces and A1 has 41");
  assert.match(st.failedAt, /Cut V1 \+ A1/);
});

test("Stop: the step is 'stopped' (not failed) and the outcome is 'stopped'", () => {
  const st = P.create(["cuts"], null, 0);
  P.onPhase(st, { step: "cuts", name: "c" });
  P.onLog(st, "    Stopped by you after 100 of 199 cuts. The timeline is part cut and consistent: press the cut button again to carry on.");
  P.onPhaseEnd(st, { step: "cuts", ok: false, hasVerify: false });
  P.onLog(st, 'STOPPED at "Cuts: Cut V1 + A1". Nothing after it ran');
  P.onEnd(st, false, 9000);
  assert.equal(st.by.cuts.status, "stopped");
  assert.equal(st.outcome, "stopped");
});

test("a refusal collects its reasons; a Cancel is a cancel", () => {
  let st = P.create(["markers", "cuts"], null, 0);
  P.onLog(st, "REFUSED. Nothing was changed:");
  P.onLog(st, "  - Nothing on V2+ or A2+. (1 clip on V2)");
  P.onLog(st, "  - V1 holds exactly one clip.");
  P.onLog(st, "Something else");
  P.onLog(st, "  - not a reason any more");
  P.onEnd(st, false, 10);
  assert.equal(st.outcome, "refused");
  assert.deepEqual(st.reasons, ["Nothing on V2+ or A2+. (1 clip on V2)", "V1 holds exactly one clip."]);
  st = P.create(["markers"], null, 0);
  P.onLog(st, "Cancelled by you. Nothing was changed.");
  P.onEnd(st, false, 10);
  assert.equal(st.outcome, "cancelled");
  st = P.create(["markers"], null, 0);
  P.onPhase(st, { step: "markers", name: "m" });
  P.onLog(st, "  [STOP] The clip already has 3 markers.");
  P.onPhaseEnd(st, { step: "markers", ok: false, hasVerify: false });
  P.onEnd(st, false, 10);
  assert.equal(st.outcome, "refused");
});

test("steps the run skipped are 'skipped' and do not hold the bar back (resume run)", () => {
  const st = P.create(["markers", "cuts", "deletes"], null, 0);
  P.onPhase(st, { step: "deletes", name: "d" }); P.onPhaseEnd(st, { step: "deletes", ok: true, hasVerify: true });
  P.onEnd(st, true, 3000);
  assert.deepEqual(st.steps.map((s) => s.status), ["skipped", "skipped", "done"]);
  assert.equal(P.fraction(st), 1);
});

test("elapsed, remaining and the time formats", () => {
  const st = P.create(["a", "b"], { a: 1, b: 1 }, 1000);
  assert.equal(P.remaining(st, 1500), null);
  P.onPhase(st, { step: "a", name: "a" }); P.onPhaseEnd(st, { step: "a", ok: true, hasVerify: true });
  assert.equal(Math.round(P.elapsed(st, 11000)), 10);
  assert.equal(Math.round(P.remaining(st, 11000)), 10);   // half done after 10 s
  assert.equal(P.fmtClock(47), "0:47"); assert.equal(P.fmtClock(125), "2:05");
  assert.equal(P.fmtApprox(57), "about 57 s"); assert.equal(P.fmtApprox(200), "about 3 min");
  P.onEnd(st, false, 21000);
  assert.equal(P.remaining(st, 99999), 0);
});
