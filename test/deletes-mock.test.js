"use strict";
// Runs the fake-Premiere harness for the cuts + deletes phases (the REAL runner.js, guard.js, markers-core.js, timecode.js and host.jsx).
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("deletes phase against a fake Premiere: good run, rerun, stop + resume, cancel, refusals, hole and no-ripple caught", () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "mock", "run-mock-deletes.js")], { encoding: "utf8", timeout: 180000 });
  assert.equal(r.status, 0, (r.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).join("\n") + (r.stderr || ""));
  assert.match(r.stdout, /ALL CHECKS PASSED/);
});
