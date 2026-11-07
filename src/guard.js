// LTGuard: the failsafe. Decides, from FACTS the panel has read, whether a run may start. Reads nothing from Premiere itself, so it is
// plain data in, verdict out, and fully testable in Node. The panel (js/runner.js) gathers the facts; the same function is meant to be
// called again before every destructive phase.
//
// facts = {
//   seq:     {ok, name, fps, dropFrame} | null
//   video:   [clip counts per video track, V1 first],  audio: [clip counts per audio track, A1 first]
//   v1, a1:  [{start, end, inPoint, outPoint, media, name}]   (seconds; a few clips are enough, counts are in video/audio)
//   markers: {existing, probes} | null                          (markers on the clip's project item)
//   file:    {loaded, error, name, matchesMedia} | null
//   plan:    {clipsInside, clipsTotal, pending, gaps: {ok, problems[], text}} | null
// }
// Returns {ok, hard: [text], soft: [text], checks: [{ok, level, text}]}.
//   hard = the run must not start (no override). soft = ask the person first (the panel shows a confirm).
var LTGuard = (function () {
  function norm(p) { return String(p || "").replace(/\\/g, "/").toLowerCase(); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function evaluate(f) {
    f = f || {};
    var checks = [], hard = [], soft = [];
    function add(level, ok, text, problem) {
      checks.push({ ok: !!ok, level: level, text: text, problem: problem || text });
      if (!ok) (level === "soft" ? soft : hard).push(problem || text);
    }

    // ---- the sequence ----
    var seq = f.seq, fps = seq && seq.fps > 0 ? seq.fps : 0, frame = fps ? 1 / fps : 0;
    if (!seq || !(fps > 0)) add("hard", false, "No active sequence.", "There is no active sequence. Open the sequence that holds the video and try again.");
    else {
      add("hard", !seq.dropFrame, "The sequence is " + fps.toFixed(3) + " fps, non-drop timecode.",
        "The sequence uses drop-frame timecode (the playhead timecode has a \";\"). The cut maths is non-drop only, and a wrong cut is worse than no cut. Switch the sequence's timecode display to non-drop, or use a non-drop sequence.");
    }

    // ---- nothing else on the timeline ----
    var video = f.video || [], audio = f.audio || [], others = [], i;
    for (i = 1; i < video.length; i++) if (video[i] > 0) others.push("V" + (i + 1) + " (" + plural(video[i], "clip", "clips") + ")");
    for (i = 1; i < audio.length; i++) if (audio[i] > 0) others.push("A" + (i + 1) + " (" + plural(audio[i], "clip", "clips") + ")");
    add("hard", others.length === 0, "Nothing on V2+ or A2+.",
      "There are clips on " + others.join(", ") + ". Every track under a gap shifts when the gap is deleted, so this tool only runs on a timeline that holds just the source file. Remove them (or use a fresh sequence) and try again.");

    // ---- exactly one video clip and one audio clip, still whole ----
    var nv = video.length ? video[0] : 0, na = audio.length ? audio[0] : 0;
    add("hard", nv === 1, "V1 holds exactly one clip.",
      nv === 0 ? "V1 is empty. Put the source video on V1." : "V1 holds " + nv + " clips. This tool starts from ONE uncut clip. If a previous run stopped half way, undo it (Ctrl+Z) or reopen the saved project.");
    add("hard", na === 1, "A1 holds exactly one clip.",
      na === 0 ? "A1 is empty. The video's audio must be on A1." : "A1 holds " + na + " clips. This tool starts from ONE uncut clip. If a previous run stopped half way, undo it (Ctrl+Z) or reopen the saved project.");

    var v = nv === 1 && f.v1 && f.v1[0] ? f.v1[0] : null, a = na === 1 && f.a1 && f.a1[0] ? f.a1[0] : null;
    if (v && frame) {
      add("hard", Math.abs(v.start) <= frame, "The clip starts at the start of the sequence.",
        "The video clip starts at " + v.start.toFixed(3) + " s, not at the start of the sequence. Move it to 0 and try again.");
      var span = v.end - v.start, played = v.outPoint - v.inPoint;
      add("hard", Math.abs(span - played) <= frame, "The clip plays at normal speed, untrimmed on the timeline.",
        "The clip is " + span.toFixed(3) + " s on the timeline but plays " + played.toFixed(3) + " s of the source: it has a speed change. The cut maths assumes normal speed.");
    }
    if (v && a && frame) {
      var same = Math.abs(v.start - a.start) <= frame && Math.abs(v.end - a.end) <= frame && Math.abs(v.inPoint - a.inPoint) <= frame && Math.abs(v.outPoint - a.outPoint) <= frame;
      add("hard", same, "A1 plays exactly what V1 plays.",
        "The audio clip does not match the video clip (V1 " + v.start.toFixed(3) + "-" + v.end.toFixed(3) + ", source " + v.inPoint.toFixed(3) + "-" + v.outPoint.toFixed(3) +
        "; A1 " + a.start.toFixed(3) + "-" + a.end.toFixed(3) + ", source " + a.inPoint.toFixed(3) + "-" + a.outPoint.toFixed(3) + ").");
      if (v.media && a.media) add("hard", norm(v.media) === norm(a.media), "V1 and A1 come from the same media file.", "V1 and A1 come from different media files (" + v.media + " and " + a.media + ").");
    }

    // ---- the markers file ----
    var file = f.file;
    if (!file || !file.loaded) add("hard", false, "A markers file is loaded.", "No markers file: " + (file && file.error ? file.error : "none was found next to the video or the project. Choose it by hand.") );
    else {
      add("hard", true, "Markers file: " + (file.name || "loaded") + ".");
      add("hard", file.matchesMedia !== false, "The markers file belongs to this video.",
        "The markers file \"" + file.name + "\" does not match the video on V1. Running it would put another stream's markers and cuts on this one.");
    }

    // ---- markers already on the clip ----
    var mk = f.markers;
    if (mk) {
      add("hard", !(mk.probes > 0), "No LTPROBE test markers left on the clip.",
        mk.probes + " LTPROBE test marker(s) are still on the clip from the old markers probe. Delete them by hand in the Markers panel (their names start with LTPROBE), then run again.");
      add("soft", !(mk.existing - (mk.probes || 0) > 0), "The clip has no markers yet.",
        "The clip already has " + plural(mk.existing - (mk.probes || 0), "marker", "markers") + ". The run would add its markers next to them (nothing is removed). Continue?");
    }

    // ---- the plan itself ----
    var plan = f.plan;
    if (plan) {
      add("hard", plan.clipsInside > 0 && plan.clipsTotal > 0, plan.clipsInside + " of " + plan.clipsTotal + " clips fall inside what the timeline plays.",
        plan.clipsInside + " of " + plan.clipsTotal + " clips fall inside what the timeline plays: nothing to cut.");
      if (plan.gaps) add("hard", !!plan.gaps.ok, "Delete plan: " + (plan.gaps.text || "ok") + ".",
        "The delete plan is not safe: " + (plan.gaps.problems && plan.gaps.problems.length ? plan.gaps.problems.join(" ") : "unknown reason"));
    }

    return { ok: hard.length === 0, needsConfirm: hard.length === 0 && soft.length > 0, hard: hard, soft: soft, checks: checks };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // evaluateCuts: the MID-RUN guard. After the first razor V1/A1 legitimately hold many clips, so instead of "exactly one clip" this asks
  // "is the timeline what the cuts phase can have produced?". Pure: facts in, verdict out.
  //   f = { seq:{fps, dropFrame}, video:[clips per video track], audio:[clips per audio track],
  //         v1:[{start,end,inPoint,outPoint}] (ALL pieces, seconds, in timeline order), a1: same for A1,
  //         expect:{ origin:{start,end,inPoint,outPoint}, edges:[frame numbers, ascending, first = clip start, last = clip end] },
  //         mode:"partial" | "complete",
  //         gaps:{ok,deleteCount,keepCount,problems} | null, expectGaps:{deleteCount,keepCount} | null }   (gaps only checked in "complete")
  //   partial  = a run that may be half done (every boundary must be one the plan asked for; nothing else may be cut)
  //   complete = every planned cut is there and nothing else
  // Returns {ok, hard, soft:[], checks, pieces, boundaries, remaining:[frames still to cut, descending], worstEdge}.
  // ---------------------------------------------------------------------------------------------------------------
  var CUT_TOL = 0.01; // frames
  function evaluateCuts(f) {
    f = f || {};
    var checks = [], hard = [];
    function add(ok, text, problem) {
      checks.push({ ok: !!ok, level: "hard", text: text, problem: problem || text });
      if (!ok) hard.push(problem || text);
    }
    var seq = f.seq, fps = seq && seq.fps > 0 ? seq.fps : 0, ex = f.expect || {}, o = ex.origin, edges = ex.edges || [];
    var V = f.v1 || [], A = f.a1 || [], i, res = { pieces: V.length, boundaries: 0, remaining: [], worstEdge: 0 };
    function out() { var r = { ok: hard.length === 0, needsConfirm: false, hard: hard, soft: [], checks: checks }; for (var k in res) r[k] = res[k]; return r; }

    if (!fps) { add(false, "", "There is no active sequence, or its frame rate could not be read."); return out(); }
    add(!seq.dropFrame, "The sequence is " + fps.toFixed(3) + " fps, non-drop timecode.",
      "The sequence uses drop-frame timecode. The cut maths is non-drop only.");
    if (!o || edges.length < 2) { add(false, "", "No cut plan to compare the timeline with."); return out(); }

    // nothing else on the timeline
    var video = f.video || [], audio = f.audio || [], others = [];
    for (i = 1; i < video.length; i++) if (video[i] > 0) others.push("V" + (i + 1) + " (" + video[i] + ")");
    for (i = 1; i < audio.length; i++) if (audio[i] > 0) others.push("A" + (i + 1) + " (" + audio[i] + ")");
    add(others.length === 0, "Nothing on V2+ or A2+.", "There are clips on " + others.join(", ") + ". Every track under a gap shifts when a gap is deleted; this tool only runs on a timeline that holds just the source file.");

    // piece counts
    var maxPieces = edges.length - 1;
    add(V.length >= 1 && V.length === A.length, "V1 and A1 have the same number of pieces (" + V.length + ").",
      "V1 has " + V.length + " pieces but A1 has " + A.length + ". A razor reached one track and not the other. Undo it (Ctrl+Z) or reopen the saved project.");
    if (f.mode === "complete") add(V.length === maxPieces, "V1 has all " + maxPieces + " planned pieces.", "V1 has " + V.length + " pieces, the plan needs " + maxPieces + ".");
    else add(V.length <= maxPieces, "V1 has " + V.length + " of at most " + maxPieces + " pieces.", "V1 has " + V.length + " pieces, more than the plan allows (" + maxPieces + "): something was cut that the plan did not ask for.");
    if (!(V.length >= 1 && V.length === A.length)) return out();

    // every edge sits on a whole frame; no holes or overlaps; the pieces cover exactly the original clip
    var worst = 0, offGrid = 0, firstOff = "", holes = 0, firstHole = "", d;
    function onGrid(name, p, n) {
      var a = p.start * fps, b = p.end * fps, e = Math.max(Math.abs(a - Math.round(a)), Math.abs(b - Math.round(b)));
      if (e > worst) worst = e;
      if (e > CUT_TOL) { offGrid++; if (!firstOff) firstOff = name + " piece #" + n + " (" + p.start.toFixed(4) + "-" + p.end.toFixed(4) + " s)"; }
    }
    for (i = 0; i < V.length; i++) {
      onGrid("V1", V[i], i + 1); onGrid("A1", A[i], i + 1);
      if (i > 0) {
        d = Math.max(Math.abs(V[i].start - V[i - 1].end), Math.abs(A[i].start - A[i - 1].end)) * fps;
        if (d > CUT_TOL) { holes++; if (!firstHole) firstHole = "between pieces #" + i + " and #" + (i + 1) + " (" + d.toFixed(3) + " frames)"; }
      }
    }
    res.worstEdge = worst;
    add(offGrid === 0, "Every cut edge is on a whole frame (worst error " + worst.toFixed(4) + " frames).", offGrid + " piece edge(s) are not on a whole frame, first: " + firstOff + ".");
    add(holes === 0, "No holes or overlaps between pieces on V1/A1.", holes + " hole(s) or overlap(s) between pieces, first " + firstHole + ".");
    var s0 = Math.abs(V[0].start - o.start) * fps, e0 = Math.abs(V[V.length - 1].end - o.end) * fps;
    add(s0 <= CUT_TOL && e0 <= CUT_TOL, "The pieces cover exactly the original clip.", "The pieces do not cover the original clip (start off by " + s0.toFixed(3) + " frames, end off by " + e0.toFixed(3) + " frames).");

    // source continuity: each piece plays exactly the source it played before the cut, at normal speed
    var badSrc = 0, firstSrc = "";
    for (i = 0; i < V.length; i++) {
      [["V1", V[i]], ["A1", A[i]]].forEach(function (pr) {
        var p = pr[1], wantIn = o.inPoint + (p.start - o.start), err = Math.max(Math.abs(p.inPoint - wantIn), Math.abs((p.outPoint - p.inPoint) - (p.end - p.start))) * fps;
        if (err > CUT_TOL) { badSrc++; if (!firstSrc) firstSrc = pr[0] + " piece at " + p.start.toFixed(3) + " s plays source " + p.inPoint.toFixed(3) + ", expected " + wantIn.toFixed(3); }
      });
    }
    add(badSrc === 0, "Source continuity: every piece plays the source it played before the cut.", badSrc + " piece(s) do not play the expected source, first: " + firstSrc + ".");

    // V1 and A1 identical piece by piece
    var unsync = 0, firstUn = "";
    for (i = 0; i < V.length; i++) {
      d = Math.max(Math.abs(V[i].start - A[i].start), Math.abs(V[i].end - A[i].end), Math.abs(V[i].inPoint - A[i].inPoint), Math.abs(V[i].outPoint - A[i].outPoint)) * fps;
      if (d > CUT_TOL) { unsync++; if (!firstUn) firstUn = "piece #" + (i + 1) + " (" + d.toFixed(3) + " frames)"; }
    }
    add(unsync === 0, "V1 and A1 match piece by piece.", unsync + " piece(s) differ between V1 and A1, first " + firstUn + ".");

    // which cuts exist, which are missing, which were never planned
    var want = {}, have = {}, unexpected = [], remaining = [];
    for (i = 1; i < edges.length - 1; i++) want[edges[i]] = true;
    for (i = 1; i < V.length; i++) { var b = Math.round(V[i].start * fps); have[b] = true; if (!want[b]) unexpected.push(b); }
    for (i = edges.length - 2; i >= 1; i--) if (!have[edges[i]]) remaining.push(edges[i]);
    res.boundaries = V.length - 1; res.remaining = remaining;
    add(unexpected.length === 0, "Every cut on the timeline is one the plan asked for.",
      unexpected.length + " cut(s) are at frames the plan did not ask for (first at frame " + unexpected[0] + "). Undo them (Ctrl+Z) or reopen the saved project.");
    if (f.mode === "complete") add(remaining.length === 0, "All " + (edges.length - 2) + " planned cuts are there.", remaining.length + " planned cut(s) are missing (first missing at frame " + remaining[remaining.length - 1] + ").");

    if (f.mode === "complete" && f.expectGaps) {
      var g = f.gaps;
      add(!!g && g.ok === true && g.deleteCount === f.expectGaps.deleteCount && g.keepCount === f.expectGaps.keepCount,
        "Pieces classify as the plan said: " + (g ? g.deleteCount + " to delete, " + g.keepCount + " to keep" : "?") + ".",
        g ? "The pieces now on the timeline give " + g.deleteCount + " to delete / " + g.keepCount + " to keep (plan: " + f.expectGaps.deleteCount + " / " + f.expectGaps.keepCount + ")" + (g.problems && g.problems.length ? ": " + g.problems.join(" ") : ".") : "The delete plan could not be worked out from the cut timeline.");
    }
    return out();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The DELETES phase. It works from the pieces that are on the timeline NOW (it never needs the original clip), so it starts from a fully
  // cut timeline and also from a half-deleted one of its own making.
  //   expectAfterDeletes(pieces, gapIdx): the pieces (seconds) after the gap pieces with these indexes were ripple-deleted: each kept piece
  //     moves left by the total length of the deleted gaps before it; its source range does not change.
  //   evaluateDeletes(f): f = { seq, video, audio, v1, a1 (all pieces, seconds), gaps: planGapDelete(...) on the CURRENT v1 pieces | null,
  //     expect: [{start,end,inPoint,outPoint}] | null (exact expected pieces; "complete" mode), expectKeep: number | null,
  //     mode: "partial" | "complete" }
  //   Always: non-drop, nothing on other tracks, V1 = A1 piece by piece, every edge on a whole frame, no holes or overlaps, starts at 0, each
  //   piece plays at normal speed, source order never goes backwards, the delete plan is safe (gaps.ok). "complete" adds: no gap piece left,
  //   the kept pieces are the ones the plan kept, and (with expect) every piece is exactly where an exact ripple delete puts it.
  // ---------------------------------------------------------------------------------------------------------------
  function expectAfterDeletes(pieces, gapIdx) {
    var gone = {}, i, shift = 0, out = [];
    for (i = 0; i < (gapIdx || []).length; i++) gone[gapIdx[i]] = true;
    for (i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      if (gone[i]) { shift += p.end - p.start; continue; }
      out.push({ start: p.start - shift, end: p.end - shift, inPoint: p.inPoint, outPoint: p.outPoint });
    }
    return out;
  }
  function evaluateDeletes(f) {
    f = f || {};
    var checks = [], hard = [];
    function add(ok, text, problem) {
      checks.push({ ok: !!ok, level: "hard", text: text, problem: problem || text });
      if (!ok) hard.push(problem || text);
    }
    var seq = f.seq, fps = seq && seq.fps > 0 ? seq.fps : 0, V = f.v1 || [], A = f.a1 || [], i, d, res = { pieces: V.length, worstPos: 0, endSeconds: 0 };
    function out() { var r = { ok: hard.length === 0, needsConfirm: false, hard: hard, soft: [], checks: checks }; for (var k in res) r[k] = res[k]; return r; }
    if (!fps) { add(false, "", "There is no active sequence, or its frame rate could not be read."); return out(); }
    add(!seq.dropFrame, "The sequence is " + fps.toFixed(3) + " fps, non-drop timecode.", "The sequence uses drop-frame timecode. The cut maths is non-drop only.");

    var video = f.video || [], audio = f.audio || [], others = [];
    for (i = 1; i < video.length; i++) if (video[i] > 0) others.push("V" + (i + 1) + " (" + video[i] + ")");
    for (i = 1; i < audio.length; i++) if (audio[i] > 0) others.push("A" + (i + 1) + " (" + audio[i] + ")");
    add(others.length === 0, "Nothing on V2+ or A2+.", "There are clips on " + others.join(", ") + ". A ripple delete shifts every track; this tool only runs on a timeline that holds just the source file.");

    add(V.length >= 1 && V.length === A.length, "V1 and A1 have the same number of pieces (" + V.length + ").",
      "V1 has " + V.length + " pieces but A1 has " + A.length + ". A delete reached one track and not the other. Undo it (Ctrl+Z) or reopen the saved project.");
    if (!(V.length >= 1 && V.length === A.length)) return out();

    var worst = 0, off = 0, firstOff = "", holes = 0, firstHole = "", speed = 0, firstSp = "", back = 0, firstBack = "", un = 0, firstUn = "";
    for (i = 0; i < V.length; i++) {
      [["V1", V[i]], ["A1", A[i]]].forEach(function (pr) {
        var p = pr[1], a = p.start * fps, b = p.end * fps, e = Math.max(Math.abs(a - Math.round(a)), Math.abs(b - Math.round(b)));
        if (e > worst) worst = e;
        if (e > CUT_TOL) { off++; if (!firstOff) firstOff = pr[0] + " piece #" + (i + 1); }
        var sp = Math.abs((p.outPoint - p.inPoint) - (p.end - p.start)) * fps;
        if (sp > CUT_TOL) { speed++; if (!firstSp) firstSp = pr[0] + " piece #" + (i + 1); }
      });
      if (i > 0) {
        d = Math.max(Math.abs(V[i].start - V[i - 1].end), Math.abs(A[i].start - A[i - 1].end)) * fps;
        if (d > CUT_TOL) { holes++; if (!firstHole) firstHole = "between pieces #" + i + " and #" + (i + 1) + " (" + d.toFixed(3) + " frames)"; }
        if ((V[i].inPoint - V[i - 1].outPoint) * fps < -CUT_TOL) { back++; if (!firstBack) firstBack = "piece #" + (i + 1); }
      }
      d = Math.max(Math.abs(V[i].start - A[i].start), Math.abs(V[i].end - A[i].end), Math.abs(V[i].inPoint - A[i].inPoint), Math.abs(V[i].outPoint - A[i].outPoint)) * fps;
      if (d > CUT_TOL) { un++; if (!firstUn) firstUn = "piece #" + (i + 1) + " (" + d.toFixed(3) + " frames)"; }
    }
    add(off === 0, "Every piece edge is on a whole frame (worst error " + worst.toFixed(4) + " frames).", off + " piece edge(s) are not on a whole frame, first: " + firstOff + ".");
    add(holes === 0, "No holes or overlaps between pieces on V1/A1.", holes + " hole(s) or overlap(s) between pieces, first " + firstHole + ".");
    add(Math.abs(V[0].start) * fps <= CUT_TOL, "The first piece starts at the start of the sequence.", "The first piece starts at " + V[0].start.toFixed(3) + " s, not at 0.");
    add(speed === 0, "Every piece plays at normal speed.", speed + " piece(s) play at a changed speed, first: " + firstSp + ".");
    add(back === 0, "The source never goes backwards from piece to piece.", back + " piece(s) play source that goes backwards from where the previous piece ended, first: " + firstBack + ".");
    add(un === 0, "V1 and A1 match piece by piece.", un + " piece(s) differ between V1 and A1, first " + firstUn + ".");
    res.endSeconds = V[V.length - 1].end;

    var g = f.gaps;
    add(!!g && g.ok === true, "The delete plan is safe for the pieces on the timeline: " + (g ? g.text : "?") + ".",
      g ? "The delete plan is not safe: " + (g.problems && g.problems.length ? g.problems.join(" ") : "unknown reason") : "The delete plan could not be worked out from the timeline.");
    if (f.expectKeep !== undefined && f.expectKeep !== null && g) add(g.keepCount === f.expectKeep, g.keepCount + " pieces are kept.", g.keepCount + " pieces are kept, but " + f.expectKeep + " were when the run started: a kept piece went missing.");

    if (f.mode === "complete") {
      add(!!g && g.deleteCount === 0, "No gap piece is left on the timeline.", (g ? g.deleteCount : "?") + " gap piece(s) are still on the timeline.");
      if (f.expect) {
        var E = f.expect, bad = 0, firstBad = "", wp = 0;
        if (E.length !== V.length) add(false, "", "V1 has " + V.length + " pieces, an exact ripple delete leaves " + E.length + ".");
        else {
          for (i = 0; i < E.length; i++) {
            [["V1", V[i]], ["A1", A[i]]].forEach(function (pr) {
              var p = pr[1], e = Math.max(Math.abs(p.start - E[i].start), Math.abs(p.end - E[i].end), Math.abs(p.inPoint - E[i].inPoint), Math.abs(p.outPoint - E[i].outPoint)) * fps;
              if (e > wp) wp = e;
              if (e > CUT_TOL) { bad++; if (!firstBad) firstBad = pr[0] + " piece #" + (i + 1) + " is at " + p.start.toFixed(3) + "-" + p.end.toFixed(3) + " s (source " + p.inPoint.toFixed(3) + "), expected " + E[i].start.toFixed(3) + "-" + E[i].end.toFixed(3) + " s (source " + E[i].inPoint.toFixed(3) + ")"; }
            });
          }
          res.worstPos = wp;
          add(bad === 0, "Every piece is exactly where an exact ripple delete puts it (worst error " + wp.toFixed(4) + " frames; V1 ends at " + V[V.length - 1].end.toFixed(3) + " s).", bad + " piece position(s) are not where an exact ripple delete puts them, first: " + firstBad + ".");
        }
      }
    }
    return out();
  }

  var API = { evaluate: evaluate, evaluateCuts: evaluateCuts, evaluateDeletes: evaluateDeletes, expectAfterDeletes: expectAfterDeletes };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.LTGuard = API;
  return API;
})();
