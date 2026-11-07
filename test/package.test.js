"use strict";
// Catches a broken package BEFORE it reaches Premiere: an empty or malformed manifest makes the panel vanish from the Extensions menu silently.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const panel = path.join(root, "cep-panel");
const read = (p) => fs.readFileSync(p, "utf8");

test("no file in the package is empty", () => {
  const empty = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (n === "node_modules") continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (fs.statSync(p).size === 0) empty.push(path.relative(root, p));
    }
  })(root);
  assert.deepEqual(empty, []);
});
test("manifest.xml is complete and consistent", () => {
  const m = read(path.join(panel, "CSXS", "manifest.xml"));
  assert.match(m, /^<\?xml[^>]*\?>/);
  assert.ok(m.trim().endsWith("</ExtensionManifest>"), "manifest is cut off");
  const bundle = /ExtensionBundleId="([^"]+)"/.exec(m)[1];
  const ids = [...m.matchAll(/<Extension Id="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(ids.length >= 2 && ids.every((i) => i === ids[0]), "the Extension Id differs between ExtensionList and DispatchInfo");
  assert.ok(ids[0].startsWith(bundle), "extension id must start with the bundle id");
  assert.match(m, /<Host Name="PPRO"/);
  // every open tag has its close tag
  const open = (m.match(/<([A-Za-z][\w]*)(\s[^>]*)?>/g) || []).filter((t) => !t.endsWith("/>")).length;
  const close = (m.match(/<\/[A-Za-z][\w]*>/g) || []).length;
  assert.equal(open, close, "unbalanced XML tags");
  for (const tag of ["MainPath", "ScriptPath"]) {
    const rel = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(m)[1];
    assert.ok(fs.existsSync(path.join(panel, rel)), `${tag} points to a missing file: ${rel}`);
  }
});
test(".debug names the same extension id as the manifest", () => {
  const m = read(path.join(panel, "CSXS", "manifest.xml")), d = read(path.join(panel, ".debug"));
  const id = /<Extension Id="([^"]+)"/.exec(m)[1];
  assert.ok(d.includes(`Id="${id}"`));
});
test("every script and shared file the page loads exists (in the panel or in src/)", () => {
  const html = read(path.join(panel, "index.html"));
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(srcs.length >= 3);
  for (const s of srcs) {
    const inPanel = fs.existsSync(path.join(panel, s));
    const inSrc = s.startsWith("shared/") && fs.existsSync(path.join(root, "src", s.slice(7)));
    assert.ok(inPanel || inSrc, `index.html loads ${s} but it is not in the package`);
  }
});
test("the installer copies every file the panel needs", () => {
  const ps = read(path.join(root, "install.ps1"));
  for (const f of ["js\\runner.js", "js\\ui.js", "jsx\\host.jsx", "shared\\timecode.js", "shared\\markers-core.js", "shared\\guard.js", "shared\\progress.js"]) {
    assert.ok(ps.includes(f), `install.ps1 does not check for ${f}`);
  }
});

test("every ExtendScript function the panel calls exists in host.jsx", () => {
  const host = read(path.join(panel, "jsx", "host.jsx"));
  const defined = new Set([...host.matchAll(/^function (LT_[A-Za-z0-9_]+)\(/gm)].map((x) => x[1]));
  const missing = [];
  for (const f of fs.readdirSync(path.join(panel, "js"))) {
    const js = read(path.join(panel, "js", f));
    for (const m of js.matchAll(/["'`(]\s*(LT_[A-Za-z0-9_]+)\(/g)) if (!defined.has(m[1])) missing.push(f + ": " + m[1]);
    for (const m of js.matchAll(/call\("(LT_[A-Za-z0-9_]+)"\)/g)) if (!defined.has(m[1])) missing.push(f + ": " + m[1]);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test("every settings field the runner reads exists in the page (padding / merge / delete limits / chapters)", () => {
  const html = read(path.join(panel, "index.html")), js = read(path.join(panel, "js", "runner.js"));
  for (const id of ["padBefore", "padAfter", "mergeGap", "maxDeletePct", "minKeepPieces", "recipeCutChapters"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no input #${id}`);
    assert.ok(js.includes(`"${id}"`), `runner.js never reads ${id}`);
  }
  assert.ok(!/normalizeSettings\(C\.DEFAULT_SETTINGS\)/.test(js), "a plan still uses the hardcoded default settings instead of getSettings()");
});

test("Do it all: the button, the markers tick box and the read-only host call it needs exist, and it reuses the verified phase lists", () => {
  const html = read(path.join(panel, "index.html")), js = read(path.join(panel, "js", "runner.js")), host = read(path.join(panel, "jsx", "host.jsx"));
  for (const id of ["rAll", "recipeMarkers"]) assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
  assert.ok(js.includes('bindRun("rAll"'), "the Do it all button is not bound through the running lock (bindRun)");
  for (const id of ["rDry", "rMarkers", "rRemove", "rCuts", "rDel", "rLink", "rChoose", "rAuto"]) assert.ok(js.includes(`bindRun("${id}"`), `#${id} must go through the running lock (bindRun)`);
  for (const id of ["rStop", "rYes", "rNo"]) assert.ok(js.includes(`bind("${id}"`) && !js.includes(`bindRun("${id}"`), `#${id} must stay unlocked (plain bind)`);
  assert.ok(/LOCKED_IDS = \[[^\]]*"rAll"[^\]]*\]/.test(js) && !/LOCKED_IDS = \[[^\]]*"rStop"/.test(js), "the lock list must contain the run buttons and never Stop");
  assert.match(host, /^function LT_l_count\(/m);
  for (const f of ["markersPhaseList", "cutsPhaseList", "deletesPhaseList", "relinkPhaseList"]) assert.ok(js.includes(`${f}(o)`) && js.includes(`${f}({})`), `${f} is not shared by the single button and Do it all`);
  assert.ok(/DO IT ALL DONE/.test(js) && /finalCheck\(/.test(js), "Do it all must end with the final check");
  assert.equal([...host].filter((ch) => ch.charCodeAt(0) > 127).length, 0, "host.jsx must stay ASCII-only");
});

test("the panel is named LuckyTwitch Markers (bundle id com.luckytwitch.markers) and the installer removes the old test panel", () => {
  const m = read(path.join(panel, "CSXS", "manifest.xml")), ps = read(path.join(root, "install.ps1")), html = read(path.join(panel, "index.html"));
  assert.equal(/ExtensionBundleId="([^"]+)"/.exec(m)[1], "com.luckytwitch.markers");
  assert.equal(/ExtensionBundleName="([^"]+)"/.exec(m)[1], "LuckyTwitch Markers");
  assert.equal(/<Menu>([^<]+)<\/Menu>/.exec(m)[1], "LuckyTwitch Markers");
  assert.match(html, /<title>LuckyTwitch Markers<\/title>/);
  assert.ok(ps.includes('$id = "com.luckytwitch.markers"'), "install.ps1 installs under another id than the manifest");
  assert.ok(ps.includes('$oldId = "com.luckytwitch.ceptest"') && /Remove-Item \$oldTarget/.test(ps), "the installer must remove the old com.luckytwitch.ceptest folder");
  for (const f of [path.join(panel, ".debug"), path.join(panel, "CSXS", "manifest.xml")]) assert.ok(!/ceptest|CEP Test/.test(read(f)), `${path.basename(f)} still names the old test panel`);
});

test("no test or probe code is left in the panel (old test buttons, probe scripts, probe-only host functions)", () => {
  const html = read(path.join(panel, "index.html")), host = read(path.join(panel, "jsx", "host.jsx"));
  assert.ok(!fs.existsSync(path.join(panel, "js", "main.js")) && !fs.existsSync(path.join(panel, "js", "probe.js")), "main.js / probe.js must be gone");
  for (const f of ["bInfo", "bSel", "bRazor", "bRelink", "bTc", "bTcRazor", "bRmV", "bRmVA", "bScale", "bStop", "mAll", "mInfo", "mRead", "mPickC", "mPickD", "mPickE", "mImport", "mDel", "mkFile"]) assert.ok(!html.includes(`id="${f}"`), `index.html still has the test control #${f}`);
  assert.ok(!/js\/(main|probe)\.js/.test(html), "index.html still loads main.js / probe.js");
  const defined = [...host.matchAll(/^function (LT_[A-Za-z0-9_]+)\(/gm)].map((x) => x[1]).sort();
  assert.deepEqual(defined, ["LT_c_cut", "LT_c_snap", "LT_d_del", "LT_g_scan", "LT_l_count", "LT_l_link", "LT_l_verify", "LT_r_mkChunk", "LT_r_mkInit", "LT_r_mkRemove", "LT_r_mkVerify"], "host.jsx must export exactly the functions the runner calls");
  // the log buttons used to be wired by main.js: the runner must wire them now
  const js = read(path.join(panel, "js", "runner.js"));
  assert.ok(js.includes('bind("bCopy"') && js.includes('bind("bClear"'), "Copy log / Clear are not wired");
  // every host function the runner calls is exported and nothing in host.jsx is unreachable dead code is covered by the exported-list check above
});

test("every element id the scripts use exists in index.html, and the page shows the manifest's version", () => {
  const html = read(path.join(panel, "index.html")), ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
  const used = new Set();
  for (const f of ["runner.js", "ui.js"]) {
    const js = read(path.join(panel, "js", f));
    for (const m of js.matchAll(/\b(?:getElementById|\$|text|hide|cls|field|fieldEl|fieldText|bind|bindRun|row)\("([A-Za-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of js.matchAll(/"((?:st|pf|r|b|c)[A-Z][A-Za-z0-9]*)"/g)) used.add(m[1]);     // id lists: LOCKED_IDS, ROW, BOXES ...
  }
  for (const id of [...used]) { if (/^(pf\w+)$/.test(id) && ids.has(id + "Tx")) used.add(id + "Tx"); if (/^st[A-Z]/.test(id)) used.add(id + "Cnt"); }
  const missing = [...used].filter((id) => !ids.has(id) && !["rAskBox"].includes(id)).filter((id) => /^(st|pf|r|b|c|set|prog|file|log|pill|ver|stat|pad|merge|max|min|recipe)/.test(id));
  assert.deepEqual(missing, [], "index.html has no element with these ids");
  const ver = /ExtensionBundleVersion="([^"]+)"/.exec(read(path.join(panel, "CSXS", "manifest.xml")))[1];
  assert.equal(/id="ver">v([^<]+)</.exec(html)[1], ver, "the version shown in the panel differs from manifest.xml");
});

test("the page loads its scripts in dependency order (core, guard, progress, runner, ui)", () => {
  const order = [...read(path.join(panel, "index.html")).matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(order, ["shared/markers-core.js", "shared/guard.js", "shared/progress.js", "js/runner.js", "js/ui.js"]);
});

test("the macOS installer installs the same files under the same id as the Windows one", () => {
  const sh = read(path.join(root, "install-mac.command")), ps = read(path.join(root, "install.ps1"));
  assert.ok(sh.startsWith("#!/bin/bash\n"), "install-mac.command needs a bash shebang and LF line endings");
  assert.ok(!sh.includes("\r"), "install-mac.command must use LF line endings (CRLF breaks the shebang on macOS)");
  assert.ok(sh.includes('ID="com.luckytwitch.markers"') && sh.includes('OLD_ID="com.luckytwitch.ceptest"'), "id / old id differ from the Windows installer");
  for (const f of ["js/runner.js", "js/ui.js", "jsx/host.jsx", "shared/timecode.js", "shared/markers-core.js", "shared/guard.js", "shared/progress.js", "CSXS/manifest.xml", "index.html", ".debug"]) assert.ok(sh.includes(f), `install-mac.command does not check for ${f}`);
  for (const v of [9, 10, 11, 12, 13, 14]) { assert.ok(/for v in 9 10 11 12 13 14/.test(sh)); assert.ok(ps.includes("9..14")); }
  assert.ok(sh.includes("PlayerDebugMode"), "unsigned panels must be allowed on macOS too");
});

test("src/markers-core.js exists and exports the planning layer", () => {
  const core = require("../src/markers-core.js");
  assert.equal(typeof core.planMarkers, "function");
  assert.equal(typeof core.planCuts, "function");
});

test("the shared file the page loads for the planning layer is the one in src/ (nothing is read from outside the package)", () => {
  const html = read(path.join(panel, "index.html"));
  assert.ok(html.includes('src="shared/markers-core.js"'));
  assert.ok(fs.readdirSync(path.join(root, "src")).sort().join() === "guard.js,markers-core.js,progress.js,timecode.js", "src/ must hold exactly the four runtime files (the release zip ships all of src/)");
});
