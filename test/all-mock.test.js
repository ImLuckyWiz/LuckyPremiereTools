"use strict";
// Runs the fake-Premiere harness for DO IT ALL (the REAL runner.js, guard.js, markers-core.js, timecode.js and host.jsx). It asserts and exits non-zero on any difference.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("Do it all against a fake Premiere: one confirm, resume from every state, Stop, failures stop the run, never DONE without the final check", () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "mock", "run-mock-all.js")], { encoding: "utf8", timeout: 240000 });
  assert.equal(r.status, 0, (r.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).join("\n") + (r.stderr || ""));
  assert.match(r.stdout, /ALL CHECKS PASSED/);
});
