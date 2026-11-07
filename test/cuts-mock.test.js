"use strict";
// Runs the fake-Premiere harness for the cuts phase (the REAL runner.js, guard.js, markers-core.js, timecode.js and host.jsx). It asserts and exits non-zero on any difference.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("cuts phase against a fake Premiere: good run, rerun, stop + resume, cancel, refusals, silent razor failures", () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "mock", "run-mock-cuts.js")], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, (r.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).join("\n") + (r.stderr || ""));
  assert.match(r.stdout, /ALL CHECKS PASSED/);
});
