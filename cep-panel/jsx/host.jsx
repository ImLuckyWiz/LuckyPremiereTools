// ExtendScript side of the LuckyTwitch Markers panel. ES3 only: no arrow functions, no JSON, no let/const.
// This file stays pure ASCII (use "\u00b7", never the character itself); strings from the panel arrive as ASCII with \uXXXX escapes.
// LTTime (shared/timecode.js) is loaded into ExtendScript by the panel (js/runner.js, ensureTime) before any call that needs it.
var LT_TICKS = 254016000000;

// ---- helpers every phase uses ----------------------------------------------------------------------

function ltRun(fn) {
  try { return fn(); } catch (e) { return "ERROR: " + e + (e.line ? " (line " + e.line + ")" : ""); }
}
function ltSeq() { return app.project ? app.project.activeSequence : null; }
function ltClear(seq) {
  var sel = seq.getSelection();
  for (var i = 0; i < sel.length; i++) sel[i].setSelected(0, 0);
}
function ltNow() { return new Date().getTime(); }
function ltStartFrame(seq, tb) {
  try { var z = Number(seq.zeroPoint); return z > 0 ? Math.round(z / tb) : 0; } catch (e) { return 0; }
}

// ---- the clip and its markers: markers live on the PROJECT ITEM of the longest V1 clip (the UXP tool's "clip" placement) ----
var LT_MK_PREFIX = "LTPROBE";   // markers left over from the old probe panel: the failsafe refuses to run while any are on the clip
function ltMkOwner() {
  var seq = ltSeq();
  if (!seq) throw new Error("No active sequence.");
  var vt = seq.videoTracks[0], big = null, bigLen = 0, i;
  for (i = 0; i < vt.clips.numItems; i++) { var c = vt.clips[i], ln = c.end.seconds - c.start.seconds; if (ln > bigLen) { bigLen = ln; big = c; } }
  if (!big) throw new Error("V1 has no clips.");
  if (!big.projectItem) throw new Error("The V1 clip has no project item.");
  return { clip: big, pi: big.projectItem, seq: seq };
}
function ltMarkerList(markers) {
  var arr = [], m = markers.getFirstMarker(), guard = 0;
  while (m && guard < 20000) { arr.push(m); m = markers.getNextMarker(m); guard++; }
  return arr;
}
function ltIsProbe(m) { return String(m.name).indexOf(LT_MK_PREFIX) === 0; }
function ltMkColor(m) { try { return m.getColorByIndex(); } catch (e) { return -1; } }


// =====================================================================================================
// STEP 5: the failsafe's eyes. LT_g_scan() READS the timeline and changes nothing. It returns tab-separated lines:
//   seq <name> <fps> <timebase> <playhead timecode>
//   proj <project path>
//   vt <index> <clip count>      at <index> <clip count>          (every video / audio track)
//   clip V|A <track> <start> <end> <in> <out> <media path> <name> (the first clips of V1 and A1)
//   mk <markers on the project item> <LTPROBE ones>
// The panel turns this into the "facts" that shared/guard.js judges.
// =====================================================================================================
function ltTabSafe(s) { return String(s).replace(/[\t\r\n]/g, " "); }
function ltGClipLine(kind, ti, c) {
  var media = "";
  try { media = c.projectItem ? c.projectItem.getMediaPath() : ""; } catch (e) { media = ""; }
  return ["clip", kind, ti, c.start.seconds, c.end.seconds, c.inPoint.seconds, c.outPoint.seconds, ltTabSafe(media), ltTabSafe(c.name)].join("\t");
}
function ltGScan() {
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  var L = [], i, tb = Number(seq.timebase), fps = tb > 0 ? LT_TICKS / tb : 0, tc = "";
  try { app.enableQE(); tc = String(qe.project.getActiveSequence().CTI.timecode); } catch (e) { tc = ""; }
  L.push(["seq", ltTabSafe(seq.name), fps, tb, tc].join("\t"));
  var projPath = ""; try { projPath = String(app.project.path); } catch (e3) {}
  L.push(["proj", ltTabSafe(projPath)].join("\t"));
  for (i = 0; i < seq.videoTracks.numTracks; i++) L.push(["vt", i, seq.videoTracks[i].clips.numItems].join("\t"));
  for (i = 0; i < seq.audioTracks.numTracks; i++) L.push(["at", i, seq.audioTracks[i].clips.numItems].join("\t"));
  var v = seq.videoTracks.numTracks > 0 ? seq.videoTracks[0] : null, a = seq.audioTracks.numTracks > 0 ? seq.audioTracks[0] : null;
  var first = null;
  if (v) for (i = 0; i < v.clips.numItems && i < 3; i++) { L.push(ltGClipLine("V", 0, v.clips[i])); if (!first) first = v.clips[i]; }
  if (a) for (i = 0; i < a.clips.numItems && i < 3; i++) L.push(ltGClipLine("A", 0, a.clips[i]));
  if (first && first.projectItem) {
    var list = ltMarkerList(first.projectItem.getMarkers()), n = 0;
    for (i = 0; i < list.length; i++) if (ltIsProbe(list[i])) n++;
    L.push(["mk", list.length, n].join("\t"));
  }
  return "ok|" + L.join("\n");
}
function LT_g_scan() { return ltRun(ltGScan); }


// =====================================================================================================
// STEP 6: the real MARKERS phase (names are the real ones, no LTPROBE prefix). Fast path: the calls the old probe proved
// (createMarker, name, comments, setColorByIndex(i), end = seconds), with ONE verification pass afterwards instead of a read-back per marker.
//   LT_r_mkInit(total, baseSourceSeconds) -> LT_r_mkChunk([{n,c,s,d,k}]) ... -> LT_r_mkVerify([...]) ...   (and LT_r_mkRemove([...]))
// A marker is "already there" when a marker with the same name starts within 10 ms of the same time: a rerun adds nothing twice.
// =====================================================================================================
var LT_RMK = null;
function ltRFind(list, name, start, used) {
  var j;
  for (j = 0; j < list.length; j++) {
    if (used && used[j]) continue;
    if (String(list[j].name) === name && Math.abs(list[j].start.seconds - start) < 0.01) return j;
  }
  return -1;
}
function LT_r_mkInit(total, base) {
  return ltRun(function () {
    var o = ltMkOwner(), list = ltMarkerList(o.pi.getMarkers());
    LT_RMK = { total: total, base: base, done: 0, added: 0, skipped: 0, before: list.length, ms: [] };
    return "ok|" + list.length + " marker(s) on the clip before; " + total + " to add at source offset " + Number(base).toFixed(2) + " s.";
  });
}
function ltRMkChunk(arr) {
  var R = LT_RMK;
  if (!R) return "ERROR: run LT_r_mkInit first.";
  var o = ltMkOwner(), markers = o.pi.getMarkers(), t0 = ltNow(), list = ltMarkerList(markers), i, added = 0, skipped = 0, errs = 0, firstErr = "";
  for (i = 0; i < arr.length; i++) {
    var it = arr[i], start = R.base + it.s;
    if (ltRFind(list, it.n, start, null) >= 0) { skipped++; continue; }
    var m = markers.createMarker(start);
    if (!m) { errs++; firstErr = firstErr || "createMarker returned nothing"; continue; }
    try {
      m.name = it.n; m.comments = it.c; m.setColorByIndex(it.k);
      if (it.d > 0) m.end = start + it.d;
    } catch (e) { errs++; firstErr = firstErr || String(e); }
    list.push(m); added++;
  }
  R.done += arr.length; R.added += added; R.skipped += skipped;
  var ms = ltNow() - t0; R.ms.push(ms);
  if (errs > 0) return "FAIL|" + errs + " marker(s) raised an error while being set up (" + firstErr + ").";
  return "ok|" + R.done + "|" + R.total + "|" + ms + "|" + R.added + " added, " + R.skipped + " already there";
}
function LT_r_mkChunk(arr) { return ltRun(function () { return ltRMkChunk(arr); }); }

// Checks a chunk of the plan against what Premiere holds NOW (one listing per call). Returns ok|checked|missing|badComment|badColor|badEnd|worstStart|worstEnd|firstBad
function ltRMkVerify(arr, base) {
  var o = ltMkOwner(), list = ltMarkerList(o.pi.getMarkers()), used = {}, i, missing = 0, bc = 0, bk = 0, be = 0, ws = 0, we = 0, first = "";
  for (i = 0; i < arr.length; i++) {
    var it = arr[i], start = base + it.s, j = ltRFind(list, it.n, start, used);
    if (j < 0) { missing++; if (!first) first = it.n; continue; }
    used[j] = true;
    var m = list[j], es = Math.abs(m.start.seconds - start), ee = it.d > 0 ? Math.abs(m.end.seconds - (start + it.d)) : 0;
    if (es > ws) ws = es;
    if (ee > we) we = ee;
    if (String(m.comments) !== it.c) { bc++; if (!first) first = it.n + " (comment)"; }
    if (ltMkColor(m) !== it.k) { bk++; if (!first) first = it.n + " (color)"; }
    if (ee > 0.002) { be++; if (!first) first = it.n + " (end)"; }
  }
  return "ok|" + [arr.length, missing, bc, bk, be, ws.toFixed(5), we.toFixed(5), first].join("|");
}
function LT_r_mkVerify(arr, base) { return ltRun(function () { return ltRMkVerify(arr, base); }); }

// Removes exactly the markers a plan would add (same name, start within 10 ms AND same comment). Anything else is left alone.
function ltRMkRemove(arr, base) {
  var o = ltMkOwner(), markers = o.pi.getMarkers(), list = ltMarkerList(markers), used = {}, i, removed = 0, notFound = 0;
  for (i = 0; i < arr.length; i++) {
    var it = arr[i], start = base + it.s, j, hit = -1;
    for (j = 0; j < list.length; j++) {
      if (used[j]) continue;
      if (String(list[j].name) === it.n && Math.abs(list[j].start.seconds - start) < 0.01 && String(list[j].comments) === it.c) { hit = j; break; }
    }
    if (hit < 0) { notFound++; continue; }
    used[hit] = true;
    markers.deleteMarker(list[hit]); removed++;
  }
  return "ok|" + arr.length + "|" + removed + "|" + notFound;
}
function LT_r_mkRemove(arr, base) { return ltRun(function () { return ltRMkRemove(arr, base); }); }


// =====================================================================================================
// STEP 7: the real CUTS phase. Stateless on purpose: every call is given what it needs, so a stopped run can simply be started again.
//   LT_c_snap()         READ ONLY. The whole of V1 and A1 (every piece), the clip counts of every track, the playhead timecode.
//   LT_c_cut([frames])  razors V1 then A1 at each frame (frames are SEQUENCE frames, whole numbers, already ordered by the panel: back to front),
//                       returns ok|<points done>|<ms>|<V1 pieces>|<A1 pieces>|<clips on other tracks> so the panel can check after EVERY chunk.
// Frames -> timecode is LTTime.framesToTimecode (shared/timecode.js), the same call the razor test proved with 0 frames of error.
// =====================================================================================================
function ltCSnap() {
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  var L = [], i, tb = Number(seq.timebase), fps = tb > 0 ? LT_TICKS / tb : 0, tc = "";
  try { app.enableQE(); tc = String(qe.project.getActiveSequence().CTI.timecode); } catch (e) { tc = ""; }
  L.push(["seq", ltTabSafe(seq.name), fps, tb, tc].join("\t"));
  var projPath = ""; try { projPath = String(app.project.path); } catch (e3) {}
  L.push(["proj", ltTabSafe(projPath)].join("\t"));
  for (i = 0; i < seq.videoTracks.numTracks; i++) L.push(["vt", i, seq.videoTracks[i].clips.numItems].join("\t"));
  for (i = 0; i < seq.audioTracks.numTracks; i++) L.push(["at", i, seq.audioTracks[i].clips.numItems].join("\t"));
  var v = seq.videoTracks.numTracks > 0 ? seq.videoTracks[0] : null, a = seq.audioTracks.numTracks > 0 ? seq.audioTracks[0] : null, c;
  if (v) {
    for (i = 0; i < v.clips.numItems; i++) {
      c = v.clips[i];
      L.push(["pv", c.start.seconds, c.end.seconds, c.inPoint.seconds, c.outPoint.seconds].join("\t"));
    }
    if (v.clips.numItems > 0) {
      var media = ""; try { media = v.clips[0].projectItem ? v.clips[0].projectItem.getMediaPath() : ""; } catch (e4) { media = ""; }
      L.push(["media", ltTabSafe(media), ltTabSafe(v.clips[0].name)].join("\t"));
    }
  }
  if (a) {
    for (i = 0; i < a.clips.numItems; i++) {
      c = a.clips[i];
      L.push(["pa", c.start.seconds, c.end.seconds, c.inPoint.seconds, c.outPoint.seconds].join("\t"));
    }
  }
  return "ok|" + L.join("\n");
}
function LT_c_snap() { return ltRun(ltCSnap); }

function ltCOthers(seq) {
  var n = 0, i;
  for (i = 1; i < seq.videoTracks.numTracks; i++) n += seq.videoTracks[i].clips.numItems;
  for (i = 1; i < seq.audioTracks.numTracks; i++) n += seq.audioTracks[i].clips.numItems;
  return n;
}
function ltCCut(frames) {
  if (typeof LTTime === "undefined") return "FAIL|LTTime is not loaded in ExtendScript (shared/timecode.js did not load).";
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  if (!frames || !frames.length) return "FAIL|No cut points were given.";
  app.enableQE();
  var tb = Number(seq.timebase), fps = LTTime.fpsFromTimebase(tb), start = ltStartFrame(seq, tb);
  var q = qe.project.getActiveSequence(), t0 = ltNow(), i, f, tc, n = 0;
  for (i = 0; i < frames.length; i++) {
    f = Number(frames[i]);
    if (!(f >= 0) || Math.floor(f) !== f) return "FAIL|Bad cut frame " + frames[i] + " (not a whole number). " + n + " cut(s) were done before it.";
    tc = LTTime.framesToTimecode(f, fps, start);
    q.getVideoTrackAt(0).razor(tc);
    q.getAudioTrackAt(0).razor(tc);
    n++;
  }
  return "ok|" + n + "|" + (ltNow() - t0) + "|" + seq.videoTracks[0].clips.numItems + "|" + seq.audioTracks[0].clips.numItems + "|" + ltCOthers(seq);
}
function LT_c_cut(frames) { return ltRun(function () { return ltCCut(frames); }); }



// =====================================================================================================
// STEP 9: relink the remaining V1/A1 pairs. linkSelection() is a TOGGLE and the selection count afterwards proves nothing: link state is read with
// getLinkedItems(). Never call linkSelection twice on a detected pair.
// Specs are {i,s,e,si}: piece index and expected timeline/source-in frames.
// =====================================================================================================
function ltLLinkedState(v, a) {
  var items, i, x, tol = 0.00001;
  if (!v || typeof v.getLinkedItems !== "function") return -1;
  try { items = v.getLinkedItems(); } catch (e) { return -1; }
  if (!items) return 0;
  for (i = 0; i < items.length; i++) {
    x = items[i];
    if (x === a) return 1;
    // ExtendScript may return a different wrapper for the same TrackItem; compare timing too.
    try {
      if (x && x.mediaType === "Audio" && a.mediaType === "Audio" &&
          Math.abs(x.start.seconds - a.start.seconds) < tol && Math.abs(x.end.seconds - a.end.seconds) < tol &&
          Math.abs(x.inPoint.seconds - a.inPoint.seconds) < tol) return 1;
    } catch (ignore) {}
  }
  return 0;
}
function ltLLink(specs) {
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  if (!specs || !specs.length) return "FAIL|No pairs were given.";
  var tb = Number(seq.timebase), fps = tb > 0 ? LT_TICKS / tb : 0;
  if (!(fps > 0)) return "FAIL|The frame rate could not be read.";
  var vt = seq.videoTracks[0], at = seq.audioTracks[0], done = 0, linked = 0, skipped = 0, i, sp, v, a, err, sel, state;
  if (ltCOthers(seq) !== 0) return "FAIL|Clips exist on tracks other than V1/A1.";
  for (i = 0; i < specs.length; i++) {
    sp = specs[i];
    if (sp.i < 0 || sp.i >= vt.clips.numItems || sp.i >= at.clips.numItems) return "FAIL|Pair index " + sp.i + " is outside the current timeline.";
    v = vt.clips[sp.i]; a = at.clips[sp.i];
    err = Math.max(
      Math.abs(v.start.seconds * fps - sp.s), Math.abs(v.end.seconds * fps - sp.e), Math.abs(v.inPoint.seconds * fps - sp.si),
      Math.abs(a.start.seconds * fps - sp.s), Math.abs(a.end.seconds * fps - sp.e), Math.abs(a.inPoint.seconds * fps - sp.si)
    );
    if (err > 0.01) return "FAIL|Pair " + (sp.i + 1) + " no longer matches the checked timeline (worst difference " + err.toFixed(3) + " frames). No link call was made for this pair.";
    state = ltLLinkedState(v, a);
    if (state === 1) { skipped++; done++; continue; }
    if (state < 0) return "FAIL|Pair " + (sp.i + 1) + ": Premiere does not expose getLinkedItems() here, so existing link state cannot be determined safely. No link call was made for this pair.";
    ltClear(seq);
    a.setSelected(1, 0);
    v.setSelected(1, 1);
    sel = seq.getSelection();
    if (!sel || sel.length !== 2) {
      ltClear(seq);
      return "FAIL|Pair " + (sp.i + 1) + ": could not confirm exactly the audio and video are selected (" + (sel ? sel.length : 0) + " selected). No link call was made for this pair; " + done + " pair(s) handled before it.";
    }
    seq.linkSelection(); // toggle: exactly once; do not infer link state from post-link selection count
    linked++;
    ltClear(seq);
    done++;
  }
  return "ok|" + done + "|" + linked + "|" + skipped + "|" + vt.clips.numItems + "|" + at.clips.numItems + "|" + ltCOthers(seq);
}
function LT_l_link(specs) { return ltRun(function () { return ltLLink(specs); }); }

function ltLVerify(specs) {
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  var vt = seq.videoTracks[0], at = seq.audioTracks[0], i, sp, v, a, fps, tb, err, bad = [], state;
  if (!specs || vt.clips.numItems !== specs.length || at.clips.numItems !== specs.length) return "FAIL|The remaining piece counts do not match the relink plan.";
  tb = Number(seq.timebase); fps = tb > 0 ? LT_TICKS / tb : 0;
  if (!(fps > 0)) return "FAIL|The frame rate could not be read.";
  for (i = 0; i < specs.length; i++) {
    sp = specs[i]; v = vt.clips[sp.i]; a = at.clips[sp.i];
    if (!v || !a) { bad.push("pair " + (i + 1) + " is missing"); continue; }
    err = Math.max(
      Math.abs(v.start.seconds * fps - sp.s), Math.abs(v.end.seconds * fps - sp.e), Math.abs(v.inPoint.seconds * fps - sp.si),
      Math.abs(a.start.seconds * fps - sp.s), Math.abs(a.end.seconds * fps - sp.e), Math.abs(a.inPoint.seconds * fps - sp.si)
    );
    if (err > 0.01) bad.push("pair " + (i + 1) + " timeline/source timing changed by " + err.toFixed(3) + " frames");
    state = ltLLinkedState(v, a);
    if (state === 0) bad.push("pair " + (i + 1) + " is not linked");
    else if (state < 0) bad.push("pair " + (i + 1) + " link state cannot be verified by getLinkedItems()");
  }
  if (ltCOthers(seq) !== 0) bad.push("clips exist on tracks other than V1/A1");
  if (bad.length) return "FAIL|" + bad.slice(0, 5).join("; ") + (bad.length > 5 ? "; and " + (bad.length - 5) + " more" : "");
  return "ok|" + specs.length;
}
function LT_l_verify(specs) { return ltRun(function () { return ltLVerify(specs); }); }

// READ-ONLY: how many of the V1/A1 pairs are linked right now (used to resume a combined run). Changes nothing.
// ok|pairs|linked|unlinked|unknown   (unknown = getLinkedItems() unavailable or the piece did not match the spec)
function ltLCount(specs) {
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  var vt = seq.videoTracks[0], at = seq.audioTracks[0], i, sp, v, a, st, linked = 0, unlinked = 0, unknown = 0;
  if (!specs || vt.clips.numItems !== specs.length || at.clips.numItems !== specs.length) return "FAIL|The piece counts do not match the pairs given.";
  for (i = 0; i < specs.length; i++) {
    sp = specs[i]; v = vt.clips[sp.i]; a = at.clips[sp.i];
    if (!v || !a) { unknown++; continue; }
    st = ltLLinkedState(v, a);
    if (st === 1) linked++; else if (st === 0) unlinked++; else unknown++;
  }
  return "ok|" + specs.length + "|" + linked + "|" + unlinked + "|" + unknown;
}
function LT_l_count(specs) { return ltRun(function () { return ltLCount(specs); }); }


// =====================================================================================================
// STEP 8: the real DELETES phase. Stateless (every call is given the gaps to delete), so a stopped run just starts again.
//   LT_d_del([{s,e,si}, ...])  ripple-deletes each gap piece, V1 piece first, then the A1 piece (protocol proven in step 2: deleting the A1 piece
//                              after the V1 piece closes the gap on every track). s,e = the gap's timeline frames, si = its source in-point frame.
//                              The panel passes the gaps LAST FIRST, so a delete never moves a gap that is still to come.
//   After EVERY pair: V1/A1 piece counts down by one, the piece that follows starts exactly where the gap began on BOTH tracks (no hole, no
//   drift), the piece before it ends there, V1 and A1 still in sync. The first problem stops the call and says which gap.
//   Returns ok|<pairs done>|<ms>|<V1 pieces>|<A1 pieces>|<clips on other tracks>|<slowest pair ms>
// =====================================================================================================
function ltDFind(track, fps, s, e, si) {
  var cl = track.clips, i, c;
  for (i = cl.numItems - 1; i >= 0; i--) {
    c = cl[i];
    if (Math.abs(c.start.seconds * fps - s) < 0.5 && Math.abs(c.end.seconds * fps - e) < 0.5) {
      if (Math.abs(c.inPoint.seconds * fps - si) < 0.5) return { clip: c, idx: i };
      return null;
    }
  }
  return null;
}
function ltDDel(specs) {
  var seq = ltSeq();
  if (!seq) return "FAIL|No active sequence.";
  if (!specs || !specs.length) return "FAIL|No gaps were given.";
  var tb = Number(seq.timebase), fps = tb > 0 ? LT_TICKS / tb : 0;
  if (!(fps > 0)) return "FAIL|The frame rate could not be read.";
  var vt = seq.videoTracks[0], at = seq.audioTracks[0], t0 = ltNow(), done = 0, worst = 0, i, sp, fv, fa, nv, na, pv, pa, bad, tp0;
  for (i = 0; i < specs.length; i++) {
    sp = specs[i]; tp0 = ltNow();
    var nV0 = vt.clips.numItems, nA0 = at.clips.numItems;
    fv = ltDFind(vt, fps, sp.s, sp.e, sp.si);
    if (!fv) return "FAIL|gap at frame " + sp.s + ": the V1 piece is not where it was planned (" + done + " pair(s) done before it).";
    fv.clip.remove(true, true);
    fa = ltDFind(at, fps, sp.s, sp.e, sp.si);
    if (!fa) return "FAIL|gap at frame " + sp.s + ": the A1 piece was not found after the V1 delete (V1 is already missing it: undo with Ctrl+Z).";
    fa.clip.remove(true, true);
    if (vt.clips.numItems !== nV0 - 1 || at.clips.numItems !== nA0 - 1) return "FAIL|gap at frame " + sp.s + ": piece counts V1 " + vt.clips.numItems + " / A1 " + at.clips.numItems + ", expected " + (nV0 - 1) + " / " + (nA0 - 1) + ".";
    bad = "";
    if (fv.idx < vt.clips.numItems && fv.idx < at.clips.numItems) {
      nv = vt.clips[fv.idx]; na = at.clips[fv.idx];
      var dv = nv.start.seconds * fps - sp.s, da = na.start.seconds * fps - sp.s;
      if (Math.abs(dv) > 0.01 || Math.abs(da) > 0.01) bad = "the next piece starts " + dv.toFixed(3) + " frames (V1) / " + da.toFixed(3) + " frames (A1) from where the gap began (a hole or a drift)";
      else if (Math.abs(nv.start.seconds - na.start.seconds) * fps > 0.01) bad = "V1 and A1 are out of sync after the delete";
    }
    if (!bad && fv.idx > 0) {
      pv = vt.clips[fv.idx - 1]; pa = at.clips[fv.idx - 1];
      if (Math.abs(pv.end.seconds * fps - sp.s) > 0.01 || Math.abs(pa.end.seconds * fps - sp.s) > 0.01) bad = "the piece before the gap no longer ends where the gap began";
    }
    if (bad) return "FAIL|gap at frame " + sp.s + ": " + bad + ". Stopped here (" + done + " pair(s) done before it); timeline left as is.";
    done++;
    sp = ltNow() - tp0; if (sp > worst) worst = sp;
  }
  return "ok|" + done + "|" + (ltNow() - t0) + "|" + vt.clips.numItems + "|" + at.clips.numItems + "|" + ltCOthers(seq) + "|" + worst;
}
function LT_d_del(specs) { return ltRun(function () { return ltDDel(specs); }); }
