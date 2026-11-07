LuckyTwitch Markers: Premiere Pro CEP panel, developer notes (v0.14.0)

The user-facing text is README.md. This file is the build log of the panel (how each phase was verified in real Premiere) and the layout.

Layout
  install.bat / install.ps1   Windows installer (cep-panel\ AND src\*.js copied into the panel's shared\; removes the old com.luckytwitch.ceptest folder)
  install-mac.command         the same for macOS (LF line endings, executable bit; not tried on a real Mac)
  cep-panel\                  the Premiere panel (CSXS, js\runner.js = the logic, js\ui.js = the look, jsx\host.jsx, index.html)
  src\timecode.js             shared time module (same file runs in Node tests and inside Premiere)
  src\guard.js               the FAILSAFE: facts in, verdict out (pure, tested in Node)
  src\progress.js            the progress model behind the progress bar (pure; tested against a real Premiere log, test\fixtures\doitall-real.log)
  src\markers-core.js        the markers planning layer (shared parsing, options, and cut calculation)
  test\                      Node tests:  npm test   (run it from this folder)
  mock\run-mock-all.js       DO IT ALL, the running lock, the panel's look and the extension paths against a fake Premiere (real runner.js, guard.js, core, host.jsx)
  mock\run-mock-cuts.js      the cuts phase against a fake Premiere
  mock\run-mock-deletes.js   the deletes phase against fake ripple behaviours
  mock\run-mock-run.js       the markers phase (add / rerun / cancel / remove / refuse / lossy) against a fake project item
  mock\run-mock-dry.js       the dry run against 9 fake timelines (1 good, 8 that must refuse or ask)

Release packages (built by .github/workflows/build.yml, job "plugin"):
- LuckyTwitch-Premiere-Plugin-CEP.zxp: 1-click self-signed install via ZXPInstaller / Anastasiy Extension Manager
- LuckyTwitch-Premiere-Plugin-CEP.zip: manual installer (README.md, install.bat, install.ps1, install-mac.command, cep-panel\, src\)
The markers.json sample the tests read is ..\tests\fixtures\markers_sample.json (the one the Python tests keep exact); test\fixtures\ keeps a fallback copy.

History. The text below describes each phase as it was built and verified in real Premiere. Steps 1-4 (the UXP-to-CEP probes: info, selection,
razor, timecode, remove() measurement, scale run, markers probe) were retired in v0.13.0 together with their buttons, scripts and mocks; what
they proved is built into the phases below. In v0.13.0 the Step 9 note applies as written: linkSelection is a toggle, so a relink failure must be
inspected before retrying, and link state is verified with getLinkedItems().
Step 5 (the failsafe + dry run). SAFE: reads and plans, changes nothing. Put the real video on V1/A1 of a fresh sequence, its .markers.json next to the video:
  R1  DRY RUN. Reads the timeline, finds + reads the markers file, runs the failsafe checks and prints the plan
      (markers, cut points, gaps, pairs, rough time). Try it on the good timeline (expect: DRY RUN PASSED, 85 gaps / 169 cuts for your file),
      then try to break it: put a clip on V2, cut V1 once, drop the file next to another video... it must REFUSE and say why.
  Choose markers file... / Use the file next to the video: pick the file by hand if it is not next to the video.
  Copy the log of the good run and of one refused run.
Step 6 (REAL: adds the markers to the clip; the timeline is not touched). Use the sequence you tested R1 on, SAVE the project first:
  R2  ADD THE MARKERS. Failsafe again right now, then adds your plan's markers (real names, comments, colours, lengths) in chunks,
      then reads EVERY marker back from Premiere and compares name, comment, colour, start and end, and the count on the clip.
      Run it twice: the second time it asks (the clip already has markers), then adds 0 and says "110 already there".
  R3  Remove the markers the plan adds: only those (same name, time and comment). Any other marker stays.
  Stop halts after the current chunk (rerun carries on; markers already there are skipped).
  Copy the log of R2, of the second R2, and of R3. Then LOOK at the markers on the clip: colours, accents, lengths.
Step 7 (REAL: CUTS the timeline). On a fresh sequence: the real video alone on V1/A1, its .markers.json next to it. SAVE the project first (Ctrl+S).
  C1  CUT V1 + A1 at the plan's cut points. Reads the whole timeline + the markers file, runs the failsafe, SHOWS what it will do and asks.
      After you press Continue it reads the timeline AGAIN (if anything changed while the box was open it refuses), then razors V1 then A1
      at each point, back to front, in chunks of 10 points (shrinks to as few as 2 if a chunk takes over 0.9 s), one ExtendScript call per chunk.
      After EVERY chunk: V1 and A1 piece counts must equal (pieces before + cuts so far) and nothing may be on other tracks.
      At the end the whole timeline is read back and checked: every edge on a whole frame, no holes, source continuous, V1 = A1 piece by piece,
      every cut is one the plan asked for and every planned cut is there, and the pieces classify as the plan said (gap pieces to delete / pieces to keep).
      Nothing is deleted or relinked in this phase.
  Stop halts after the current chunk. The timeline is then part cut but consistent: press C1 again and it carries on (cuts already made are skipped).
  It refuses on: a clip on V2+/A2+, drop-frame, a cut at a frame the plan never asked for, V1/A1 out of step, a hole, a markers file for another video.
  Copy the log of the run. Then LOOK: the Timeline should show the clip cut into pieces on V1/A1 (nothing removed, nothing moved).
  Also run C1 a second time: it must say every cut is already there, not ask, not razor, and pass the check.
  mock\run-mock-cuts.js runs the real panel + host against a fake Premiere (11 scenarios, asserts, non-zero exit on failure; also run by node --test).
Step 8 (REAL: DELETES the gap pieces, ripple). After C1 has passed on the same sequence. SAVE the project first (Ctrl+S).
  D1  DELETE the gap pieces. Reads every piece on V1/A1 NOW, works out which are gaps from the markers file, runs the failsafe, SHOWS what it will do
      (how many gap pieces, seconds, percent, how long the timeline will be afterwards) and asks. After Continue it reads the timeline AGAIN and refuses
      if anything changed while the box was open. Then, LAST GAP FIRST, in chunks of 5 (1 if a chunk takes over 0.9 s): remove(true, true) on the V1 piece,
      then on the A1 piece.
      After EVERY pair (inside ExtendScript): piece counts down by one on both tracks, the piece that follows starts EXACTLY where the gap began on V1 and A1
      (no hole, no drift), the piece before it still ends there, V1/A1 in sync. The first problem stops the run and names the gap.
      After every chunk: the panel checks the piece counts again and that nothing is on other tracks.
      At the end the whole timeline is read back: every piece must be exactly where an exact ripple delete puts it (positions and source), no hole, V1 = A1,
      0 gap pieces left, the same number of kept pieces as at the start, and the length of the timeline.
      It refuses: a timeline that is not fully cut (a piece holding only part of a clip), V1/A1 out of step, a hole, anything on other tracks, drop-frame,
      a markers file for another video, a plan that deletes more than the Settings limit. If a hole ever shows up the run stops (it does NOT patch it).
  Stop halts after the current chunk. Press D1 again to carry on: it works out what is left from the pieces that are there. A second D1 on a finished
  timeline says no gap piece is left, does not ask, removes nothing, and re-checks the result.
  Nothing is relinked in this phase. mock\run-mock-deletes.js runs the real panel + host against a fake Premiere (10 scenarios, asserts; also run by node --test).
Uninstall: install-dev.bat -Uninstall

Step 10 (v0.12.0): SETTINGS incl. the safety cut (padding).
  New fields in the panel (same meaning as the UXP plugin): keep N s before / after each clip, merge clips closer than N s, also cut at game changes,
  delete limit (%), minimum pieces to keep. They are remembered between sessions and used by EVERY plan: dry run, markers, cuts, deletes, relink checks.
  Empty field = default. A value that is not a number >= 0 refuses the run with the field's name. Every phase logs and shows its settings in the confirm box.
  Keep them the same for C1 / D1 / L1: if padding changes after cutting, D1 REFUSES ("the cuts do not match the current plan") and deletes nothing.
  Test on a fresh sequence: set 10 / 10, press R1 (dry run; the plan shows the longer kept pieces), then C1.

Step 11 (v0.12.0): DO IT ALL.
  New button at the top of THE RUN: markers -> cuts -> deletes -> relink -> final check, as one run built from the SAME phase code as R2 / C1 / D1 / L1.
  - ONE confirm, after a read-only look at the timeline (what is there now, what will be done, settings, rough time). Save with Ctrl+S first.
  - Each step still re-reads the timeline and runs its full failsafe right before it changes anything, checks after every chunk and must pass its own check
    before the next step starts. The first failed check stops the run. Nothing is retried by itself.
  - RESUME: press it again after a Stop or a failure. It works out where the timeline is (fresh / part cut / cut / part deleted / deleted, some pairs linked /
    all done) and only runs what is left. Already-linked pairs are detected with getLinkedItems() (new read-only LT_l_count) and never toggled again.
  - The run only says DO IT ALL DONE after the FINAL CHECK read the whole result back: piece counts, V1/A1 in sync, no gap pieces, no holes, timeline length
    equal to the plan, nothing on other tracks, every pair linked, markers on the clip.
  - Markers can only be added BEFORE the first cut. On an already-cut timeline with missing markers it refuses up front (untick "Do it all also adds the markers").
  Real-Premiere test: fresh sequence, real video alone on V1/A1, save (Ctrl+S), choose your settings, press DO IT ALL, Continue. Then press it AGAIN: it must
  say "Nothing is left to do" and only run the final check. Optional resume test: press Stop during the cuts, press DO IT ALL again.

Step 12 (v0.12.1): RUNNING LOCK (bug fix; no editing logic changed).
  Before: pressing a run button again while the confirm box was open started a second run and orphaned the first (the DO IT ALL header printed twice).
  Now: only one run (or one waiting confirm) at a time.
  - While a run or a confirm is active, every button that reads or changes anything is DISABLED: DO IT ALL, R1, R2, R3, C1, D1, L1, Choose file, Use the file next to the video.
  - Stop and the confirm's Continue / Cancel always stay enabled.
  - A press that still gets through (it should not) is ignored and logs "Ignored: a run is already active...".
  - The buttons come back on at the end of the run, after a failure, after a refusal and after Cancel.
  - Stop pressed WHILE the confirm box is open now acts as Cancel (box closes, nothing changed). Before, that Stop was lost.
  Real-Premiere test: press DO IT ALL; while the confirm box is open, check that the run buttons are greyed out and that clicking them does nothing; press Cancel:
  the buttons come back and nothing was changed. Then press DO IT ALL again, and press Stop while the box is open: same result. Finally one normal run
  (or the "Nothing is left to do" run on a finished timeline) and check the header prints once and the buttons are enabled at the end.

Step 13 (v0.13.0): RENAME + TEST/PROBE CODE REMOVED (no editing logic changed).
  - Panel name "LuckyTwitch Markers", bundle id com.luckytwitch.markers (was LuckyTwitch CEP Test / com.luckytwitch.ceptest). The installer removes the old
    folder %APPDATA%\Adobe\CEP\extensions\com.luckytwitch.ceptest so Premiere does not show two panels.
  - Removed: js\main.js (the 1-9 test buttons and scale test), js\probe.js (markers probe), their buttons, and every probe/test-only function in host.jsx.
    host.jsx now exports exactly the 11 functions the runner calls (LT_g_scan, LT_c_snap, LT_c_cut, LT_d_del, LT_l_link, LT_l_verify, LT_l_count,
    LT_r_mkInit, LT_r_mkChunk, LT_r_mkVerify, LT_r_mkRemove); every function kept is byte-identical to v0.12.1.
    The ltMkSetColor / ltMkSetEnd / ltMkEndOk helpers were only used by the probe (the real markers phase sets colour and end inline): removed too.
  - Retired mocks: run-mock.js, run-mock-step2.js, run-mock-step3.js, run-mock-markers.js.
  - Copy log / Clear are wired by runner.js now (main.js did it before). The CEP version / host lines and an LTCore / LTGuard / cep.fs check are still
    logged at start-up.
  - The LTPROBE guard check stays (harmless; it protects against probe markers left on a clip by the old probe panel). Its message no longer points at the
    removed M7 button: delete such markers by hand in the Markers panel.
  Real-Premiere test: install, restart, open the panel (the title bar and menu say LuckyTwitch Markers; there is only one LuckyTwitch panel). Set your settings,
  press R1, then one normal DO IT ALL (or the resume run on a finished timeline). Copy log and Clear must work.

Step 14 (v0.14.0): THE NEW LAYOUT. The editing logic is untouched; this is what you see.
  Top to bottom:
  - Header: name, version, a status pill (Ready / Checking / Running / Waiting / Stopping / Done / Stopped / Cancelled / Needs attention / All done).
  - Markers file: the file found (and how: next to the video / next to the project / chosen by hand), its marker count, Choose... and (only when chosen by hand)
    "Use the file next to the video".
  - What will happen (the PRE-FLIGHT, read only, refreshed on its own when the panel opens, after every run, after a settings or file change, and when you come back to
    the panel; or press Refresh): sequence, timeline state, the four steps (todo / done / switched off) with counts, a rough time, notes (e.g. "the clip already has markers").
    If the run would be refused, the reasons are listed here and the big button becomes "Check again" (nothing can start while the pre-flight refuses).
  - The big button: "Do it all" (counts + rough time), "Continue" (resumes a stopped run, shows what is left) or "Run the final check" (everything already done). Stop next to it.
    The confirm box (Continue / Cancel) opens right under it. Stop while the box is open = Cancel.
  - Progress (while running and until the next run): bar weighted by each step's rough time, "Step 2 of 5 - Cutting - 120 / 199", elapsed time and time left, one row per step
    (pending / running / done with count / failed / stopped). A single-step button shows only its own row.
  - Result message: green when done ("Done in 0:49. The final check passed..."), amber for Cancel / Stop, red for a refusal or a failed check (with the reason); the Log opens by itself on a problem.
  - Single steps (collapsed): Add markers / Cut / Delete the gaps / Link video and audio, each with what is left to do; Detailed check (log) = the old dry run; Remove the plan's markers.
  - Settings (collapsed; the summary line shows the values): safety cut (before / after / merge), cut at game changes, "Also add the markers", safety limits. A bad value is named at once.
  - Log (collapsed): Copy log / Clear. Which sections are open is remembered.
  Engine changes (small, all covered by tests):
  - runner.js emits events (log, phase, phaseEnd, start, end, busy, ask, stop, settingsChanged, fileChanged, preflight) for ui.js; every listener call is guarded so the panel can never disturb a run.
  - New read-only preflight() built on classify() (the same read "Do it all" does); runs under the same lock as the runs, so a check never overlaps a run.
  - The "what is left to do + rough time" text moved into planTodo(), used by the confirm box and by the pre-flight (same numbers as before).
  - Phases are tagged with their step (markers / cuts / deletes / relink / final) for the progress display. The run buttons now return the run's result.
  - The refusal text for a cut timeline with missing markers now says: Untick "Also add the markers" in Settings.
  Tests: test\progress.test.js (9, incl. a replay of the real Do-it-all log), run-mock-all.js scenarios 20-23 (pre-flight, bar, rows, messages, Cancel, Stop, refusal), package tests (ids used by
  the scripts exist in the page, version shown = manifest, script order).
  Real-Premiere test: install, restart, open the panel. Check: the file card and plan appear by themselves; Do it all shows the counts; run it (or the Continue / final-check case);
  the bar and rows move, Stop works, the result message appears; open Settings, change the padding: the plan updates after a moment; open Single steps; open Log and Copy log.
