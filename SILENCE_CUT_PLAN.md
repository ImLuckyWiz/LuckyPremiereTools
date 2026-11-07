# Silence Cut for the Premiere panel — Implementation Plan

> **Feature:** find silence in the video on the timeline and cut it out (auto-editor style), inside the existing CEP panel.
> **Repo:** `luckytwitch-premiere-markers-cep` (panel "LuckyTwitch Markers", currently **v0.15.0**) → target **v0.16.0**.
> **Written for:** an implementer (Claude or Gemini Flash) working one task at a time. Section 9 is the work list; everything else is the reasoning and the specs those tasks point to.
> **Status (updated after Phase 0/1):** read the last section, "Phase 0/1 outcome", first: it supersedes the text below where they differ (ffprobe instead of `ffmpeg -i` for start times, ffmpeg search paths, Node 17.7.2). Original status: plan only. No file in the repo has been changed. Every claim marked **VERIFIED** was measured or run while writing this plan (details in section 1).

---

## 0. TL;DR

1. The reverse-engineered auto-editor doc is **mostly right** (threshold → margin → smoothing → chunkify is exactly what the source does). It has **3 mistakes that would have caused bugs**: `-ac 1` downmix, `-ar 8000`, and "Node is already available in the panel" (it is not). Details in section 1.
2. **The best way in is an adapter, not a rewrite.** The panel's cut/delete/relink engine is plan-driven and already verified in real Premiere. A silence analysis only has to produce a list of *keep ranges* (loud parts, in source seconds). If those are written as a `.markers.json`-shaped file where every loud range is a `clip` marker, the **existing planner, failsafe, cut, delete, relink and final-check code runs unchanged**. **VERIFIED** end to end in Node (section 3.3).
3. New code is small: one pure module (`src/silence-core.js`), one Node-side analyzer (`cep-panel/js/silence.js`), a "mode" switch in `runner.js`, a UI card, and a manifest change to enable Node.
4. **The real problem is not analysis, it is cutting speed.** Analysis takes ~6 s per hour of audio. But the panel's razor step grows with the **square** of the cut count (its own timing model): ~1 min for 100 cuts, ~10 min for 1000 cuts, ~32 min for 2000. A talky VOD can produce thousands. So the plan has a cut budget, presets that cut less, and an R&D phase for a faster engine (section 7).
5. **Owner decisions recorded (section 11):** detect ffmpeg (including LuckyDownloader's install paths) + let the user choose a path; enabling Node in the manifest is approved; Silence will be a mode in the same panel.

---

## 1. Verdict on the reverse-engineering document

I re-read auto-editor's real source (cloned `wyattblue/auto-editor`, HEAD `a602b0e`) and also ran the real released binary (`auto-editor 29.3.1` from PyPI) on test media, then compared with a JS port.

### 1.1 Claim by claim

| # | Claim in the doc | Verdict | What to do |
|---|---|---|---|
| 1 | Frame-quantized boolean mask, one loudness value per video frame | **Correct** | Keep. |
| 2 | Per frame: peak `abs(sample)/32767` | **Correct** (`src/analyze/audio.nim`, `readChunk`) | Keep. |
| 3 | "Each frame is exactly `sampleRate/fps` samples (1600 at 30 fps)" | **Partly wrong.** True only at 30 fps. At 29.97 it is 1601.6. auto-editor keeps a **fractional size and carries the rounding error** (`accumulatedError`) | Port the carry. **VERIFIED:** with the carry, 1798/1798 frames match auto-editor's own `levels` output (max diff 0.0000). Plain per-frame rounding was off by up to 0.0058. |
| 4 | Threshold `level >= 0.04` (≈ −28 dB) | **Correct** (`>=`, default 0.04 → −27.96 dB) | Keep `>=`. |
| 5 | `mutMargin` algorithm | **Correct**, but the doc leaves out **negative** margins (shrink loud sections) | Port both signs (cheap), UI only needs positive. |
| 6 | `smoothing` algorithm (minclip then mincut, repeat until stable) | **Correct** (`src/lib/editutil.nim`) | Port exactly, including the "stop if equal to 2 states back" guard (a lone short run would otherwise flip forever). |
| 7 | Diagram shows margin and smoothing as two parallel branches | **Misleading.** They run **in sequence: margin first, then smoothing** (`src/conductor.nim` lines ~494-495) | Order: threshold → margin → smoothing → chunkify. |
| 8 | Defaults ~0.2 s margin, mincut/minclip | **Correct.** auto-editor defaults: margin `0.2s` both sides, smooth `0.2s,0.1s` (mincut 0.2 s, minclip 0.1 s) | Use as the "Tight" preset. |
| 9 | Extract with `ffmpeg … -ar 8000 -ac 1 -f s16le -` | **Two bugs.** (a) `-ac 1` **averages channels**. If the mic is on one channel only (very common for streamers) the level halves. **VERIFIED:** left-only mic, `-ac 1` → **213 of 1798 frames** on the wrong side of the threshold; `-ac 2` → **0**. auto-editor takes the max over all channels. (b) `-ar 8000` low-passes and shaves peaks: 7/1798 frames disagree at 8 kHz, 4 at 16 kHz, **0 at 48 kHz** | Use **`-ac 2 -ar 48000`**. Speed cost is nil: **VERIFIED** 1 hour of audio took ~6 s end to end at both 16 kHz and 48 kHz (decoding dominates). |
| 10 | "Node.js is available inside the CEP panel (`runner.js`)" | **Wrong today.** `manifest.xml` has an empty `<CEFCommandLine/>`, and `runner.js` only uses `window.cep.fs` (no `require`) | Manifest must add `--enable-nodejs` and `--mixed-context` (task P0-1). |
| 11 | "Pass the `keep === false` chunks straight to the existing cut & ripple-delete functions" | **Not directly.** The engine is not "give me gaps"; it is "give me keep ranges in source seconds" and it re-derives and re-checks everything from them, every phase | Use the adapter (section 3). It needs the *loud* ranges, not the silent ones. |
| 12 | ffmpeg is just there | **Not in this repo.** No file mentions ffmpeg. Premiere does not ship one | Detect existing install (including LuckyDownloader's copy) + let user choose path (section 6.2, Q1 settled). |
| 13 | "Analysis takes only a few seconds even for hour-long VODs" | **Correct** (~6 s/hour measured). | But it hides the real cost: cutting (section 7). |
| 14 | `chunkify` | **Correct** | Keep. |

### 1.2 What I could not reproduce, honestly

- The PyPI binary (29.3.1) is **older than the clone** and has no `--smooth` option, so I could not make it produce the exact margin+smoothing result of the clone's HEAD. What *is* proven: the loudness levels match exactly (1798/1798), and the margin and smoothing functions are ported line by line from the cloned source and fuzz-tested. **Task T1-9 adds a golden test against a build of the clone** so this gets closed with real data.

---

## 2. Goal, scope, user flow

### Goal
On a timeline that holds one video clip (V1) and its audio (A1), remove the silent stretches: cut at the edges of every speech section, ripple-delete the silence, relink video and audio. Same safety model as today (failsafe before, check after every chunk, final read-back).

### In scope
- A new **"Silence" mode** in the same panel (the markers mode stays exactly as it is).
- Analysis of the media file with ffmpeg, auto-editor's exact maths, parameters in the UI (threshold, margins, min silence to cut, min speech to keep).
- A summary before anything is touched (how much silence, how many cuts, rough time).
- Reuse of Do-it-all / single steps / Stop / resume / final check.

### Out of scope (for v0.16.0)
- Speed-up of silence (auto-editor `--when-silent speed:N`), only cutting.
- Multi-clip timelines, anything on V2+/A2+ (the existing failsafe already refuses these).
- Combining Twitch clip markers and silence in one run.
- A faster non-razor engine (R&D only, Phase 7).
- Waveform preview UI (optional Phase 6).

### User flow
```
1. Put the video alone on V1/A1 of a fresh sequence, save (Ctrl+S).      (same as today)
2. Panel -> mode "Silence".
3. Press "Analyze"  -> ffmpeg reads the audio (seconds), panel shows:
      "412 silences, 1h 07m of 3h 02m would be removed (37%), 824 cuts, about 9 min to run."
4. Adjust preset / threshold / margins -> Analyze again (instant once levels are cached, Phase 6).
5. Press "Do it all" -> one confirm -> cuts -> delete silences -> relink -> final check.
```

---

## 3. What exists in the repo, and why the adapter works

### 3.1 Map of the relevant code (v0.15.0)

| File | Role | Touch for this feature? |
|---|---|---|
| `cep-panel/jsx/host.jsx` | ExtendScript: `LT_g_scan`, `LT_c_snap`, `LT_c_cut` (razor), `LT_d_del` (ripple delete), `LT_l_link/verify/count`, markers functions. ES3, pure ASCII | **No change.** It cuts at frames and deletes pieces it is told about; it does not know where they came from. |
| `cep-panel/js/runner.js` (946 lines) | The brain: `scan`, `readFileFacts`, `getSettings`, `buildPlan`, `cutsCheck`, `deletesCheck`, phase lists, `classify`, `doItAll`, `preflight`, lock (`bindRun`, `LOCKED_IDS`) | **Yes, small, listed in 6.4.** |
| `cep-panel/js/ui.js` | Panel look, driven by events from the runner | **Yes** (mode UI). |
| `cep-panel/index.html` | Layout, ids, script order | **Yes.** |
| `cep-panel/CSXS/manifest.xml` | Extension manifest; `<CEFCommandLine/>` is empty | **Yes** (enable Node). |
| `src/markers-core.js` | Pure planning: `parseMarkersFile`, `planMarkers`, `planCutSet`, `pendingCutPoints`, `simulatePieces`, `planGapDelete`, `pickMarkersFile`, `markersNameMatchesMedia` | **One small change** (6.5). |
| `src/guard.js` | The failsafe (pure) | **No change.** |
| `src/timecode.js` | frames ⇄ timecode, shared with ExtendScript | No change. |
| `src/progress.js` | Progress model | No change expected. |
| `install.ps1`, `install-mac.command`, `tools/package_cep.py` | Installers/packaging | **Yes** (file lists, 6.7). |
| `test/*.test.js`, `mock/*.js` | `node --test` suite and fake-Premiere harness | **Yes** (new tests, section 10). |

### 3.2 The key insight
The engine thinks in **keep ranges in source seconds**:

```
.markers.json -> parseMarkersFile -> planMarkers(items) -> planCutSet(items,{pads,mergeGap})
   -> ranges (keep, source s) + points -> pendingCutPoints (snapped to sequence frames)
   -> simulatePieces -> planGapDelete (which pieces are "keep", which are "gap")
```
Every phase (`cutsCheck`, `deletesCheck`, `finalCheck`, `classify`) **re-reads the plan file and recomputes** this chain. That is what makes stop/resume and the failsafe work. A silence analysis can feed the first arrow and nothing else has to know.

### 3.3 Adapter feasibility — VERIFIED
I took real analysis output (60 s speech-like test video), wrote it as a `luckytwitch-markers` v1 object where each loud range is `{kind:"clip", start, end, views:0}`, and ran it through the repo's **unmodified** `src/markers-core.js`:

```
parsed markers 13, skipped 0, markersNameMatchesMedia("speech.silence.markers.json","…/speech.mp4") = true
ranges 13 -> cut points 24 -> pieces 25 -> keep 13, gap 12, planGapDelete.ok = true
worst distance of a cut point from a whole frame: 1e-5 frames
ms-rounding of the planner never moves a cut to another frame (23.976, 25, 29.97, 30, 50, 59.94, 60 fps, 1 hour each: 0 bad frames)
```
So the planner accepts it, classifies keep/gap correctly, and cut points land on exact frames.

### 3.4 What the adapter forces us to handle (all in section 6.4/6.5)
1. Silence mode must **force** `padBefore = padAfter = mergeGap = 0`, no chapter cuts, no limit chapter. Otherwise a pad left over from Twitch use (say 10 s) would be added around every speech section. This is the #1 trap.
2. Silence mode must **never add markers** (it would add thousands). `markersWanted()` returns false.
3. The plan file must **not** carry a `preferences` key, because `applyFilePreferences` would overwrite the user's pad fields with it.
4. The plan file must be named so `markersNameMatchesMedia` accepts it: `<video stem>.silence.markers.json` (stem of the plan file starts with the video's stem).
5. In Twitch mode, `pickMarkersFile` could wrongly auto-pick the silence file ("name starts like the video's"). It must skip `*.silence.markers.json`.
6. Wording ("markers file", "keep N s before…") must change in silence mode.

---

## 4. Decisions

| ID | Decision | Why |
|---|---|---|
| D1 | **Adapter:** silence analysis writes a sidecar plan file in the markers-file format; the engine is untouched | The engine took many real-Premiere test rounds to verify (see `DEVELOPMENT.md`). Re-implementing would reopen all of it. Proven in 3.3. |
| D2 | **Analysis runs in Node inside the panel**, spawning ffmpeg | Needs `--enable-nodejs --mixed-context` in the manifest. `cep.fs` cannot run processes. |
| D3 | **`-ac 2 -ar 48000 -f s16le`**, peak over all interleaved samples | Parity with auto-editor (section 1.1 #3, #9). |
| D4 | **Frame grid = the sequence's fps** (from `LT_g_scan`), analysis time = source time | The cut points are sequence frames; the plan is in source seconds. |
| D5 | **Pure module `src/silence-core.js`** (no Node/DOM/Premiere), tested in Node like `markers-core.js` | Same style as the repo; Flash can test it without Premiere. Reference code in Appendix A. |
| D6 | **Same panel, mode switch** (`Twitch markers` / `Silence`) | Reuses preflight, progress, lock, log, confirm. Confirmed by owner (Q3). |
| D7 | **Cut budget** (`maxCuts`, default 1500) + presets that cut less | Cutting time is quadratic in cuts (section 7). |
| D8 | **The plan is frozen once the first cut is made** | Resume re-derives the plan from the sidecar every phase. Re-analyzing mid-run would change the plan under a half-cut timeline. Analyze is disabled unless the timeline is fresh. |
| D9 | Cutting works **without ffmpeg** once a valid sidecar exists | ffmpeg is only needed by Analyze. |

---

## 5. Architecture and data flow

```
 Premiere (ExtendScript)                 Panel page (Chromium + Node)                         Disk
 ───────────────────────                 ────────────────────────────                         ────
 LT_g_scan ──► V1 media path, seq fps ─► runner.js (mode = "silence")
                                              │
                          [Analyze button]    ▼
                                         silence.js  ── spawn ffmpeg ─────────────►  video file
                                              │   stdout: s16le stereo 48 kHz PCM stream
                                              ▼
                                         PeakAccumulator (silence-core.js)  → levels[frame]
                                              │
                                         analyze(): threshold → margin → smoothing → chunkify
                                              │  keep ranges (source seconds)
                                              ▼
                                         buildSilenceFile() ──────────────────────►  <stem>.silence.markers.json
                                              │                                         (the "sidecar plan")
 [Do it all]  ◄── unchanged engine ◄──────────┘ readFileFacts() reads the sidecar like a markers file
   cutsCheck → LT_c_cut → deletesCheck → LT_d_del → relink → finalCheck
```

---

## 6. Module specs

### 6.1 `src/silence-core.js` (new, pure)
Loaded in the page like `markers-core.js` (UMD tail: `module.exports` + `window.LTSilence`). **The tested reference implementation is in Appendix A: start from it, do not rewrite it.**

Exports (all pure):

| Function | Contract |
|---|---|
| `DEFAULTS` | `{threshold:0.04, marginBefore:0.2, marginAfter:0.2, minCut:0.2, minClip:0.1}` (auto-editor defaults) |
| `PRESETS` | `Tight` (auto-editor defaults), `Balanced` (`minCut 0.6`, margins `0.25`), `Chunky` (`minCut 1.5`, margins `0.3`). Default for VODs: **Balanced** |
| `toFrames(sec, fps)` | `Math.round(sec*fps)` (same as auto-editor `toTb`) |
| `PeakAccumulator(sampleRate, fps, channels)` | `.push(Int16Array)` any chunk size, `.finish()` → `levels[]` (0..1, one per frame). Fractional bucket with carried error, peak over all interleaved channels |
| `levelsToMask`, `applyMargin`, `applySmoothing`, `chunkify` | Ports of auto-editor (`edit.nim`, `editutil.nim`, `timeline.nim`) |
| `analyze(levels, fps, params)` | Full pipeline → `{mask, chunks, ranges, stats}`; `ranges` = loud ranges in **source seconds**; `stats = {frames, keepFrames, cutFrames, silences}` |
| `buildSilenceFile(ranges, meta)` | Sidecar object (Appendix C) that `parseMarkersFile` accepts |
| `parseFfmpegInfo(stderrText)` | **To write.** From the text of `ffmpeg -i file` (stderr) → `{duration, audioStreams:[{index, rate, channels}], audioStart}`. Pure, tested on fixtures (single stream, OBS multi-track, no audio) |
| `summarize(ranges, durationSec, fps, planCounts)` | **To write.** → `{speechSec, silenceSec, removedPct, silences, cuts, estSeconds}` using the cut-time model in section 7 |
| `hashParams(obj)` | **To write.** Small deterministic string hash (no `crypto`, this file stays pure) used for staleness |
| `thresholdToDb(x)`, `dbToThreshold(db)` | `20*log10` helpers for the UI hint (0.04 → −27.96 dB) |

Rules: no `require`, no `window` use except the UMD tail, plain data in/out, never throws on empty input (all-silent and all-loud files are valid inputs).

### 6.2 `cep-panel/js/silence.js` (new, Node side)
Loaded after `runner.js`'s dependencies; exposes `window.LTSilenceRun`. Uses `require("child_process")` and `require("fs")` guarded by `typeof require === "function"`; if missing, Analyze says "Node is not enabled for this panel; reinstall" and nothing else breaks.

**API**
```js
LTSilenceRun.findFfmpeg(userPath)  -> Promise<{path, version} | {error}>
LTSilenceRun.probe(ffmpegPath, media) -> Promise<{duration, audioStreams, audioStart} | {error}>
LTSilenceRun.measure(ffmpegPath, media, fps, {stream, onProgress, isStopped}) -> Promise<{levels, seconds} | {error}>
```

**Locate ffmpeg, in this order:** (1) path from the panel setting (chosen by user); (2) env `LT_FFMPEG`; (3) LuckyDownloader's ffmpeg location(s) (most users already have it installed via LuckyDownloader — exact paths verified in task P0-4); (4) `ffmpeg` on PATH; (5) standard fixed locations: Windows `C:\ffmpeg\bin\ffmpeg.exe`, WinGet/Scoop/Chocolatey shims; macOS `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg` (**macOS apps started from the Dock do not inherit the shell PATH**, so PATH alone will fail on many Macs). Validate each candidate with `ffmpeg -version` (timeout 5 s). If none works: error text + the **Choose ffmpeg…** button (`cep.fs.showOpenDialogEx`), which saves the chosen path to the panel setting.

**measure() command**
```
ffmpeg -v error -nostdin -i <media> -vn -map 0:a:<k> -ac 2 -ar 48000 -f s16le -
```
- One ffmpeg process **per audio stream**; default = all streams, combined with **per-frame max of the levels** (same as auto-editor's "any stream loud → loud"). OBS recordings often have several tracks (mix + mic + game). The UI lets you pick one later.
- `spawn(path, args, {windowsHide:true, stdio:["ignore","pipe","pipe"]})`. Collect stderr (cap 64 KB).
- Feed the chunks to `PeakAccumulator(48000, fps, 2)`. **Alignment trap:** a Node `Buffer` from a stream can have an odd `byteOffset`; never build an `Int16Array` view on it directly. Copy into an aligned `ArrayBuffer` and carry a leftover odd byte to the next chunk.
- Progress: bytes received / (duration × 48000 × 2 × 2), reported at most every 250 ms through `onProgress` (the runner turns it into the usual `    N/M` log lines the progress bar already understands).
- Stop: `isStopped()` polled per chunk → `child.kill()`; return `{error:"stopped"}`.
- Failure handling: `error` event (ENOENT/EACCES), non-zero exit, **fewer frames than 90% of duration×fps** (truncated output), ffmpeg stderr text in the log.
- Measured cost: ~6 s per hour of audio (decode-bound). An 8 h file streams ~2.8 GB through the pipe; the loop must not keep chunks, only the running bucket.

**Audio start offset (risk R4):** if the audio stream's start time differs from the video's, bucket *i* is not at `i/fps` in Premiere's source time. `parseFfmpegInfo` returns `audioStart`; `analyze` ranges are shifted by it before writing the sidecar. Task P0-3 measures this on real Twitch VODs; if it is always < 1 frame, shift only when `|audioStart| >= 0.5/fps`.

### 6.3 The sidecar plan file
- Name: `<video stem>.silence.markers.json`, written **next to the video**; if that folder is not writable, next to the project; if neither, `<userData>/LuckyTwitchMarkers/<stem>.silence.markers.json` (silence mode always selects the file explicitly, so location does not matter to the engine).
- Format: Appendix C. Must pass `parseMarkersFile`. **No `preferences` key.**
- `source` carries the staleness data: media path, size, mtime (via Node `fs.statSync`), sequence fps, analyzer version (`"1"`), params, params hash, count of ranges.
- **Stale** = media size/mtime changed, or sequence fps differs, or analyzer version differs. Stale + fresh timeline → "needs analysis". Stale + already-cut timeline → refuse with a clear message (D8).
- Writing: write to `<name>.tmp` then rename, so a crash never leaves half a plan.

### 6.4 `cep-panel/js/runner.js` changes (the complete list)
Keep the existing style (`var`, `function`, `async` as already used). Every item has a test (section 10).

| ID | Where | Change |
|---|---|---|
| R1 | `S` state | Add `S.mode = "twitch" \| "silence"`; persist in `localStorage.ltMode`; load in `loadSavedSettings()` |
| R2 | `getSettings()` | After building `raw`: `if (S.mode === "silence") { raw.padBefore = 0; raw.padAfter = 0; raw.mergeGap = 0; raw.recipeCutChapters = false; delete raw.limitChapter; }`. **Do not** write these back into the input fields |
| R3 | `markersWanted()` | `if (S.mode === "silence") return false;` first line |
| R4 | `readFileFacts(media, proj)` | In silence mode: path = the sidecar path for `media` (not folder scan). Missing → `res.error` + `res.needsAnalysis = true`. Stale → same with `res.stale = true`. Skip `applyFilePreferences`. Keep the `matchesMedia` check |
| R5 | `describeSettings(s)` | In silence mode return e.g. `"silence cut: threshold 0.04, margins 0.2/0.2 s, cut silences of at least 0.6 s, keep speech of at least 0.1 s"` (read from the sidecar's `source.params`) |
| R6 | `LOCKED_IDS` | Add `rAnalyze`, `rDiscard`, `rFfmpeg`, `rMode` |
| R7 | New `analyzeSilence()` | A `bindRun("rAnalyze", …)` run built on `runPhases`. Phases: (1) read the timeline + failsafe-lite (fresh timeline required: V1 has exactly 1 clip; drop-frame refused; media path non-empty); (2) find ffmpeg; (3) probe; (4) measure (progress); (5) `analyze` + `summarize`; (6) write the sidecar; (7) **dry-plan check**: run `buildPlan` + `planGapDelete` on the fresh sidecar and print the summary. Never touches the timeline |
| R8 | `preflight()` | Silence mode and `res.file.error` with `needsAnalysis` → `res.ok = false`, `res.needsAnalysis = true`, **no red problem**; add `res.silence = {summary…}` when a valid sidecar exists |
| R9 | `doItAll()` | Silence mode without a valid sidecar → refuse with "Press Analyze first". Nothing else changes: it already works from `classify()` |
| R10 | Cut budget | In `classify()`, if `cutsTotal > settings.maxCuts` return `{refuse:[…]}` with the estimate and the options (bigger min silence, higher threshold, or raise the limit). The limit is a silence-mode setting |
| R11 | `window.LTRunner` | Export `setMode`, `getMode`, `analyzeSilence`, `getSilenceParams` for `ui.js` |
| R12 | Events | `emit("analysis", {summary})`, `emit("modeChanged", mode)` |

### 6.5 `src/markers-core.js` change
`pickMarkersFile(names, mediaFileName)`: filter out names ending `.silence.markers.json` (both in the `cands` list). New tests: a folder with only a silence file returns `null`; a folder with both returns the Twitch file.

### 6.6 UI (`index.html`, `ui.js`)
- **Mode** `<select id="rMode">` in the header area: *Twitch markers* / *Silence*.
- In **Silence** mode hide: the markers-file card (`fileCard`), the padding/merge/chapter/markers settings groups, **Add markers** and **Remove the plan's markers**. Show:
  - **Silence plan card:** state line (*Not analyzed* / *Analyzed 12:03, plan is current* / *Out of date*), `Analyze` (`rAnalyze`), `Discard plan` (`rDiscard`, only on a fresh timeline), the summary (`silSummary`), ffmpeg line with `Choose ffmpeg…` (`rFfmpeg`).
  - **Silence settings** (inside the existing Settings box): `silPreset`, `silThreshold` (0–1, with a live dB hint in `silDb`), `silMarginB`, `silMarginA`, `silMinCut`, `silMinClip`, `silMaxCuts`. Stored under `localStorage.ltSilence`. Bad values are named at once, like the existing fields.
- New pill state: **Needs analysis**.
- Keep all existing ids. New ids starting with `sil` are not covered by the package test's prefix regex, so **extend that regex** (task P4-6) to include `sil`.
- Wording: "markers file" → "silence plan" in silence mode only.

### 6.7 Manifest, installers, packaging
- `manifest.xml`: replace `<CEFCommandLine/>` with
  ```xml
  <CEFCommandLine>
    <Parameter>--enable-nodejs</Parameter>
    <Parameter>--mixed-context</Parameter>
  </CEFCommandLine>
  ```
  Verify in real Premiere (P0-1): `typeof require === "function"` in the panel, and `window.cep.fs` still works.
- Bump version to **0.16.0** in: `package.json`, `manifest.xml` (two places), `index.html` (`id="ver"`). The package test compares them.
- New shared file `src/silence-core.js`: copied automatically by `install.ps1`, `install-mac.command` and `tools/package_cep.py` (they glob `src/*.js`), **but** the explicit "must exist" lists must be updated: `install.ps1` (`$need` list and the final verify list), `install-mac.command` (the `for rel in …` list), and `test/package.test.js` ("the installer copies every file…", "loads its scripts in dependency order").
- New panel file `cep-panel/js/silence.js`: the whole `js/` folder is copied; add it to the same explicit lists.
- Script order in `index.html` becomes: `shared/markers-core.js`, `shared/silence-core.js`, `shared/guard.js`, `shared/progress.js`, `js/silence.js`, `js/runner.js`, `js/ui.js`. Update the order test.

### 6.8 `host.jsx`: no change
Do **not** edit `host.jsx`. The razor, delete and link calls, and all their per-step checks, are already correct for arbitrary frames. If a task seems to need a host change, stop and ask.

---

## 7. Performance and the cut-count problem

### 7.1 The numbers
Analysis: ~6 s per hour (measured). Cutting: the panel's own estimate (`estimateSeconds` / `planTodo` in `runner.js`) models razor time as `15.7 × (cuts/199)²` seconds, deletes as `0.165 s` per gap, relinks as `0.168 s` per pair. That model was fitted to real runs of **169–199 cuts**; the table is an **extrapolation** (must be measured, task P0-2).

Assuming gaps ≈ cuts / 2:

| Cuts | Gaps | Cut | Delete | Relink | **Total** |
|---:|---:|---:|---:|---:|---:|
| 100 | 50 | 8 s | 11 s | 11 s | **~0.6 min** |
| 200 | 100 | 20 s | 20 s | 20 s | **~1.1 min** |
| 500 | 250 | 103 s | 44 s | 45 s | **~3.3 min** |
| 1000 | 500 | 400 s | 86 s | 87 s | **~9.6 min** |
| 2000 | 1000 | 1590 s | 168 s | 171 s | **~32 min** |
| 4000 | 2000 | 6347 s | 333 s | 339 s | **~117 min** |

In my synthetic test of random alternating speech/silence, 3 hours at 60 fps gave 5,600 chunks; a real talky VOD will vary a lot. **Do not promise "any length".**

### 7.2 What the plan does about it
1. **Cut budget (R10):** `maxCuts` default **1500**. Above it, the run is refused with the estimate and what to change.
2. **Honest estimate** in the summary and the confirm box, using the table's formula (put the formula in `silence-core.summarize` and make `runner.planTodo` the single source if possible).
3. **Presets that cut less:** `Balanced` (min silence 0.6 s) is the default; `Chunky` (1.5 s) for long, talky VODs. Silences shorter than the min are kept, which is what removes most cuts.
4. **Warn at > 300 cuts** in the confirm box ("this will take about N min; leave Premiere alone").
5. **Phase 7 (R&D, optional):** a non-razor engine. auto-editor itself exports **FCP7 XML** (`src/exports/fcp7.nim`), which Premiere imports as a new sequence in seconds regardless of the cut count. Nobody has verified here that linked video/audio, markers and the failsafe model survive that route. It needs a spike before any promise.

---

## 8. Safety invariants (never break these)

1. **Never edit `host.jsx` razor/delete/link code** or `guard.js` thresholds to "make silence fit". If a guard refuses a silence plan, the plan is wrong or the case is genuinely unsupported.
2. **Analyze never touches the timeline.** It reads, measures, writes one sidecar file.
3. **A half-cut timeline is never re-planned.** Analyze/Discard are disabled unless V1 has exactly one clip (D8).
4. **Silence mode never adds markers and never uses padding** (R2, R3). Test it.
5. **Sidecar writes are atomic** (tmp + rename).
6. **Every ExtendScript call is still chunked and checked** by the existing phases. Do not add a "fast path".
7. **The panel must still load and work when Node or ffmpeg is missing**: Twitch mode and cutting-from-an-existing-sidecar keep working; only Analyze is disabled with a clear message.
8. **Do not weaken** the "refuse if > maxDeletePct" check silently: silence plans delete a lot (40–80% is normal), so the **UI** may suggest raising it, but the default stays at the existing 99.

---

## 9. Work plan

Do the tasks **in order**. After each task: `npm run check` and `npm test` must be at least as green as the baseline (see 9.0). One task per commit.

### 9.0 Baseline
On the uploaded zip, `npm test` = **126 tests, 124 pass, 2 fail**. Both failures **pre-exist** and are caused by the zip, not by code: `test/fixtures/doitall-real.log` is missing (`progress.test.js`), and `install-mac.command` has CRLF line endings (mac installer test). Do not "fix" them as part of this feature; just do not add failures.

### Phase 0 — Spikes (real Premiere, small, answer unknowns first)
- [x] **P0-1 Node in the panel (Windows verified; macOS still open).** Add the two `CEFCommandLine` parameters. In the panel log print `typeof require`, `process.versions.node`, and run `require("child_process").spawnSync("ffmpeg",["-version"])`. Also confirm `window.cep.fs.readdir` still works. *Done when:* the log shows Node available on at least one Windows and one macOS Premiere (v14+ and a recent one).
- [x] **P0-2 Cut scaling (razor phase measured; delete and relink NOT measured, see "Phase 0/1 outcome").** On a real timeline cut with 500 and then 1000 pieces (use the existing `Cut` button with a synthetic markers file), record seconds for the razor phase. *Done when:* a 3-row table replaces the extrapolation in section 7.1.
- [x] **P0-3 Audio start offset (see "Phase 0/1 outcome").** For 5 real Twitch VOD files (and an OBS file), run `ffmpeg -i file` and record the audio stream `start:` value. *Done when:* a one-line conclusion ("always < 1 frame" or "shift needed") is in this file.
- [x] **P0-4 LuckyDownloader ffmpeg location (see "Phase 0/1 outcome").** Inspect LuckyDownloader (or ask/check standard install/appData paths on Windows and macOS) to record the exact path(s) where it stores or installs `ffmpeg`. *Done when:* the exact path list for step (3) of `findFfmpeg` in section 6.2 is recorded in this file.

### Phase 1 — Pure core (no Premiere)
- [x] **P1-1** Create `src/silence-core.js` from Appendix A (copy, add the UMD tail: `module.exports` + `if (typeof window !== "undefined") window.LTSilence = …`). *Done when:* `node -e "require('./src/silence-core.js')"` works.
- [x] **P1-2** Add `PRESETS`, `thresholdToDb`, `dbToThreshold`, `hashParams`. *Done when:* unit tests (10.1) for them pass.
- [x] **P1-3** `parseFfmpegInfo(stderr)` with 3 fixtures in `test/fixtures/` (single stream; OBS 3 audio streams; video with no audio). *Done when:* tests pass on all three.
- [x] **P1-4** `summarize(...)` with the section 7 time model. *Done when:* the table rows in 7.1 are reproduced by a test (within 1 s).
- [x] **P1-5** `test/silence-core.test.js` per 10.1 (levels parity, margin, smoothing, chunkify, edge cases).
- [x] **P1-6** `test/silence-adapter.test.js`: build a silence file, run it through the **unmodified** `markers-core` chain exactly as in section 3.3, assert keep/gap counts, `planGapDelete.ok`, cut points on whole frames at 6 frame rates.
- [x] **P1-7** Change `pickMarkersFile` (6.5) + tests.
- [x] **P1-8** Add the new file to `npm run check` in `package.json`.
- [x] **P1-9 (SKIPPED by owner decision: rely on the component tests; see "Phase 0/1 outcome").** Golden test against real auto-editor. Build auto-editor from the clone (or use a release that has `--smooth`; check with `auto-editor --help | grep smooth`). Generate fixtures per Appendix B for 2 media files (mono; stereo with left-only mic) and commit the expected `levels` and keep ranges. *Done when:* `silence-core` reproduces the expected levels within 1e-4 and the keep ranges **exactly**.

### Phase 2 — Node analyzer
- [x] **P2-1** `cep-panel/js/silence.js`: `findFfmpeg` (order in 6.2) with an injectable `spawn`/`fs` so it can be mocked.
- [x] **P2-2** `probe` using `parseFfmpegInfo`.
- [x] **P2-3** `measure` (stream → accumulator, aligned buffers, progress, stop, error cases).
- [x] **P2-4** `test/silence-run.test.js` using a **fake ffmpeg** (a small Node script emitting synthetic PCM, chosen via the injectable path). Cases: success; ENOENT; exit code 1; truncated output; stop mid-stream; odd-length chunks; 2 audio streams combined by max.

### Phase 3 — Runner integration
- [ ] **P3-1** R1–R3 (mode, settings override, no markers) + tests that read `getSettings()` in silence mode with non-zero pad fields and see zeros.
- [ ] **P3-2** Sidecar read/write (6.3) incl. staleness, atomic write, fallback folders. Tests with a temp dir.
- [ ] **P3-3** R4, R5, R8 (`readFileFacts`, `describeSettings`, `preflight` incl. `needsAnalysis`).
- [ ] **P3-4** R7 `analyzeSilence()` phases + R11/R12 events.
- [ ] **P3-5** R9, R10 (Do it all guard, cut budget).
- [ ] **P3-6** Mock scenarios (10.3) added to `mock/run-mock-all.js` or a new `mock/run-mock-silence.js` (prefer extending the existing fake Premiere over copying it).

### Phase 4 — UI
- [ ] **P4-1** `index.html`: mode select, silence plan card, silence settings, new ids (6.6), script tags in the new order.
- [ ] **P4-2** `ui.js`: show/hide per mode, render the summary, "Needs analysis" pill, settings validation messages, remember the mode.
- [ ] **P4-3** Wire `rAnalyze`, `rDiscard`, `rFfmpeg`, `rMode`.
- [ ] **P4-4** Confirm box text for silence (cut count, minutes removed, estimate, ">300 cuts" warning).
- [ ] **P4-5** Result messages (green/amber/red) reuse the existing ones; add the analysis result message.
- [ ] **P4-6** Extend the package test's id-prefix regex with `sil`; add tests "every silence id exists in the page" and "script order".

### Phase 5 — Packaging, docs, real-Premiere test
- [ ] **P5-1** Installers' explicit file lists (6.7); `tools/package_cep.py` still copies `shared/*.js` and `js/`. *Done when:* the package/install tests pass and a built zip contains both new files.
- [ ] **P5-2** Version 0.16.0 in the 4 places.
- [ ] **P5-3** `README.md`: new "Silence mode" section (what it does, ffmpeg requirement, presets table, the cut-count warning). `DEVELOPMENT.md`: a "Step 15 (v0.16.0)" log in the same style as steps 5–14, with the real-Premiere test recipe.
- [ ] **P5-4 Real-Premiere run (manual, by the owner):** checklist in 10.4.

### Phase 6 — Nice to have (only after Phase 5 is verified)
- [ ] **P6-1** Cache the `levels` next to the sidecar (`Uint16Array` base64 + media stat + fps) so changing threshold/margins re-evaluates **instantly** without re-decoding.
- [ ] **P6-2** Audio-track picker (populated from `parseFfmpegInfo`).
- [ ] **P6-3** Tiny waveform/level preview with the threshold line (SVG in the panel).
- [ ] **P6-4** Use the clip's in/out to decode only the played part (`-ss`/`-t`), for trimmed clips.

### Phase 7 — R&D (separate decision)
- [ ] **P7-1** Spike: generate FCP7 XML for the keep ranges, import into Premiere, check that V1/A1 stay linked, positions are frame-exact, and the final-check model can validate it. Compare time against section 7.1. Only then decide whether it replaces razor+delete for large cut counts.

---

## 10. Tests

### 10.1 Unit — `test/silence-core.test.js` (pure, Node)
- `PeakAccumulator`: sine at known amplitude gives that level; **chunk-size independence** (feed 1 sample at a time vs 4096 vs the whole buffer → identical levels); fractional rates (29.97, 59.94, 23.976) keep the frame count within ±1 of `duration × fps`; stereo with left-only signal gives the same level as mono; `-32768` clamps to 1.0.
- `applyMargin`: start margin only, end margin only, both, margin larger than the gap (merges), at array edges, **negative margins shrink**.
- `applySmoothing`: minclip removes short blips; mincut fills short gaps; both interacting; empty array; single element (**must terminate**; note the result of a lone run shorter than both limits is the 2-state loop-guard outcome, same as auto-editor); 300-array random fuzz terminates and `chunkify` lengths sum to the array length.
- `analyze`: all silent → `ranges = []`; all loud → one range `[0, n/fps]`; silence at the start and at the end; threshold exactly equal to a level counts as loud (`>=`).
- `toFrames` rounding; `thresholdToDb(0.04) ≈ -27.96`.
- `buildSilenceFile` output passes `parseMarkersFile` with `skipped === 0` and has **no** `preferences`.
- `parseFfmpegInfo` on the 3 fixtures.

### 10.2 Parity / golden
- `test/silence-golden.test.js`: fixtures from P1-9. Levels within 1e-4, keep ranges identical. If the fixture generator is absent, skip with a clear message (never silently pass).

### 10.3 Mock harness scenarios (real `runner.js`, `guard.js`, `markers-core.js`, `host.jsx`, fake Premiere + fake `require`)
Continue the numbering after scenario 23 of `mock/run-mock-all.js`.
1. Silence mode, no sidecar → preflight `needsAnalysis`, no red problem, Do it all refuses with "Analyze first".
2. Analyze on a fresh timeline (fake ffmpeg PCM) → sidecar written, summary shown, timeline untouched.
3. Do it all in silence mode on that sidecar → cuts, deletes, relink, final check pass; **no markers added**; V1 piece count = speech sections.
4. **Pad trap:** pad fields set to 10/10 and `mergeGap` 5 before running in silence mode → plan unchanged (pads ignored), and Twitch mode still uses them afterwards.
5. Stale sidecar (media size changed) on a fresh timeline → "needs analysis"; on a cut timeline → refused, nothing changed.
6. Analyze refused on a part-cut timeline.
7. Cut budget: sidecar with 2000 cuts, `maxCuts` 1500 → refused with the estimate; raising the limit allows it.
8. Stop during analysis → no sidecar written, timeline untouched; stop during cuts → resume works from the same sidecar.
9. ffmpeg missing (fake ENOENT) → Analyze fails with the "Choose ffmpeg…" message; Twitch mode still runs.
10. Resume after Premiere "restart" (new runner instance, same sidecar on disk) continues correctly.
11. All-silent file → refusal "no speech found, lower the threshold" (from the guard's "0 of 0 clips" check, with a friendlier line).
12. Twitch mode with a folder that contains both files → picks the real markers file.

### 10.4 Manual checklist in real Premiere (owner)
1. Install, restart, open the panel; Twitch mode behaves exactly as v0.15.0 (run one normal Do it all on a small file).
2. Silence mode, fresh sequence with a 10-minute talking clip, **save**. Analyze → read the summary → Do it all → confirm → watch the bar → final check passes.
3. Look: first and last frame of several pieces (no clipped word starts/ends), A1 still linked to V1, sequence length ≈ the summary.
4. Press Do it all again → "Nothing is left to do", only the final check.
5. Stop mid-cut, close and reopen Premiere, press Do it all → resumes.
6. A file whose mic is **left channel only**: confirm the result is not much more aggressive than a stereo file.
7. A file with 2–3 audio tracks (OBS): note which track is analyzed.
8. Record timings for 200 / 500 / 1000 cuts and put them in section 7.1.

---

## 11. Risks and open questions

### Risks
| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Razor time grows ~quadratically with cut count | Hour-long runs on talky VODs | Cut budget, presets, honest estimate, P0-2 measurement, Phase 7 spike |
| R2 | Node/ffmpeg not available or blocked | Analyze unusable | Clear messages, choose-path button, panel keeps working otherwise (invariant 7) |
| R3 | macOS GUI apps lack shell PATH | "ffmpeg not found" on Mac | Fixed Homebrew paths, choose button |
| R4 | Audio start offset ≠ video start | Cuts shifted by a few frames | `audioStart` shift, P0-3 |
| R5 | `getMediaPath()` empty/offline/proxy | Cannot analyze | Failsafe-lite refuses with the path it saw |
| R6 | Sidecar next to video not writable | Cannot save plan | Fallback folders (6.3) |
| R7 | Several audio tracks | Wrong "silence" | Default = all tracks max, picker in Phase 6 |
| R8 | `--mixed-context` behaviour differs across Premiere versions | Panel fails to load in some version | P0-1 on min and max supported versions; keep `require` guarded |
| R9 | Variable-frame-rate sources | Frame grid mismatch | Plan is in seconds, snapped to the *sequence* grid by the existing code; note in README |
| R10 | The engine's guards are strict (A1 must equal V1, no V2/A2) | Users hit refusals | Same refusals as Twitch mode; keep the existing texts |
| R11 | Silence plan name collides with Twitch auto-pick | Wrong file loaded in Twitch mode | 6.5 change + test |

### Owner decisions & remaining defaults (settled items marked ✅)
- **Q1 ffmpeg (✅ Settled):** Detect automatically and let the user choose a path (`Choose ffmpeg…`). Most users already have ffmpeg via LuckyDownloader, so auto-detection checks LuckyDownloader's location(s) before falling back to `PATH` and standard install paths (section 6.2, task P0-4).
- **Q2 Manifest (✅ Settled):** Approved to enable Node (`--enable-nodejs --mixed-context`) in `CSXS/manifest.xml`.
- **Q3 Same panel or a second panel? (✅ Settled):** Same panel, mode switch (`Twitch markers` / `Silence`).
- **Q4 Default preset for Twitch VODs:** **Balanced (min silence 0.6 s)**.
- **Q5 Max cuts default:** **1500**, with a clear way to raise it.
- **Q6 Panel name:** "LuckyTwitch Markers" no longer describes it. **Keep the bundle id; rename only the display name later.**

---

## 12. Rules for the implementer

1. Read sections 3, 6 and 8 before touching code. Do tasks in order; one task per commit.
2. **ES3 + pure ASCII in `host.jsx`** (and you should not be editing it). `runner.js`/`ui.js` keep their current style. `silence-core.js` may use modern JS like `markers-core.js`, but stays free of `require`, `window` (except the UMD tail) and Premiere APIs.
3. Windows line endings: the repo files are CRLF; keep each file's existing line endings. `install-mac.command` must be LF.
4. Every new behaviour gets a test. Mock scenarios use the **real** runner/guard/host, not stubs of them.
5. Never "fix" a failing guard by loosening it. Report it.
6. When something is unverified (a Premiere/CEP behaviour), write it in the Phase 0 table and ask; do not guess.
7. Definition of done for the feature: Phases 1–5 checked, `npm test` has no new failures, the section 10.4 checklist is signed off by the owner on Windows and macOS, `README.md` and `DEVELOPMENT.md` updated.

---

## Appendix A — Reference `src/silence-core.js` (tested)

This is the code used for the numbers in section 1 and 3.3. Copy it, then add the items in 6.1 marked "to write" and the UMD tail.

```js
"use strict";
// Reference implementation (see PLAN section 6.1). Pure: no Premiere, no Node APIs, no DOM.
const DEFAULTS = { threshold: 0.04, marginBefore: 0.2, marginAfter: 0.2, minCut: 0.2, minClip: 0.1 };

const toFrames = (sec, fps) => Math.round(sec * fps);   // same as auto-editor toTb: round(seconds * timebase)

/** Streaming peak-per-video-frame, same bucket arithmetic as auto-editor (fractional samples/frame with carried error). */
class PeakAccumulator {
  constructor(sampleRate, fps, channels) {
    if (!(sampleRate > 0) || !(fps > 0)) throw new Error("PeakAccumulator: bad sampleRate/fps");
    this.ch = channels > 0 ? channels : 1;               // samples arrive INTERLEAVED; the peak is taken over every channel (like auto-editor)
    this.exact = sampleRate / fps; this.err = 0; this.levels = []; this.peak = 0; this.count = 0; this.size = this._next();
  }
  _next() { const w = this.exact + this.err; const cur = Math.max(1, Math.round(w)); this.err = w - cur; return cur * this.ch; }
  /** samples: Int16Array of interleaved s16 samples (any chunking: buckets carry over between calls). */
  push(samples) {
    let peak = this.peak, count = this.count, size = this.size;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], v = s < 0 ? -s : s;
      if (v > peak) peak = v;
      if (++count >= size) { this.levels.push(Math.min(peak, 32767) / 32767); peak = 0; count = 0; size = this._next(); }
    }
    this.peak = peak; this.count = count; this.size = size;
  }
  /** Flushes a partial last bucket (auto-editor also emits it). Returns the levels array (one value per video frame). */
  finish() { if (this.count > 0) { this.levels.push(Math.min(this.peak, 32767) / 32767); this.count = 0; this.peak = 0; } return this.levels; }
}

const levelsToMask = (levels, threshold) => levels.map((v) => v >= threshold);

function applyMargin(arr, startM, endM) {            // in place; frames; negative values shrink (as auto-editor)
  const starts = [], ends = [], n = arr.length;
  for (let j = 1; j < n; j++) if (arr[j] !== arr[j - 1]) (arr[j] ? starts : ends).push(j);
  if (startM > 0) for (const i of starts) for (let k = Math.max(i - startM, 0); k < i; k++) arr[k] = true;
  if (startM < 0) for (const i of starts) for (let k = i; k < Math.min(i - startM, n); k++) arr[k] = false;
  if (endM > 0) for (const i of ends) for (let k = i; k < Math.min(i + endM, n); k++) arr[k] = true;
  if (endM < 0) for (const i of ends) for (let k = Math.max(i + endM, 0); k < i; k++) arr[k] = false;
  return arr;
}

const same = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
function applySmoothing(val, mincut, minclip) {      // returns a NEW array; exact port of editutil.smoothing (incl. the 2-state loop guard)
  let prev = null, prev2 = null;
  while (!same(prev, val) && !same(prev2, val)) {
    prev2 = prev; prev = val.slice(); const next = prev.slice(), n = prev.length;
    let startP = 0, active = false;
    for (let j = 0; j < n; j++) {
      if (prev[j] === true) {
        if (!active) { startP = j; active = true; }
        if (j === n - 1 && j - startP + 1 < minclip) for (let i = startP; i < n; i++) next[i] = false;
      } else if (active) { if (j - startP < minclip) for (let i = startP; i < j; i++) next[i] = false; active = false; }
    }
    startP = 0; active = false;
    for (let j = 0; j < n; j++) {
      if (prev[j] === false) {
        if (!active) { startP = j; active = true; }
        if (j === n - 1 && j - startP + 1 < mincut) for (let i = startP; i < n; i++) next[i] = true;
      } else if (active) { if (j - startP < mincut) for (let i = startP; i < j; i++) next[i] = true; active = false; }
    }
    val = next;
  }
  return val;
}

/** Boolean mask -> [{start, end, keep}] in FRAMES (end exclusive). */
function chunkify(arr) {
  if (!arr.length) return [];
  const out = []; let s = 0;
  for (let j = 1; j < arr.length; j++) if (arr[j] !== arr[j - 1]) { out.push({ start: s, end: j, keep: arr[j - 1] }); s = j; }
  out.push({ start: s, end: arr.length, keep: arr[arr.length - 1] });
  return out;
}

/** levels -> keep ranges in SOURCE SECONDS: the full pipeline threshold -> margin -> smoothing -> chunkify. */
function analyze(levels, fps, params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const mask = levelsToMask(levels, p.threshold);
  applyMargin(mask, toFrames(p.marginBefore, fps), toFrames(p.marginAfter, fps));
  const out = applySmoothing(mask, toFrames(p.minCut, fps), toFrames(p.minClip, fps));
  const chunks = chunkify(out), ranges = [];
  let keepFrames = 0;
  for (const c of chunks) if (c.keep) { ranges.push({ start: c.start / fps, end: c.end / fps }); keepFrames += c.end - c.start; }
  return { mask: out, chunks, ranges, stats: { frames: out.length, keepFrames, cutFrames: out.length - keepFrames, silences: chunks.filter((c) => !c.keep).length } };
}
/** keep ranges (source seconds) -> an object that markers-core.parseMarkersFile() accepts: every LOUD range is a "clip" marker. */
function buildSilenceFile(ranges, meta) {
  return {
    format: "luckytwitch-markers", version: 1, name: meta.name, fps: meta.fps, duration: meta.duration,
    part: { start: 0, end: meta.duration }, source: { tool: "luckytwitch-silence", analyzer: meta.analyzer, params: meta.params, media: meta.media },
    markers: ranges.map((r, i) => ({ kind: "clip", name: "Speech " + (i + 1), start: r.start, end: r.end, views: 0, comment: "" })),
  };
}
module.exports = { buildSilenceFile, DEFAULTS, toFrames, PeakAccumulator, levelsToMask, applyMargin, applySmoothing, chunkify, analyze };
```

Known edge: the analysis can yield one more frame than auto-editor at the very end (a partial last bucket). The planner clamps to the clip length, so this is harmless; the golden test should compare up to `min(len)`.

---

## Appendix B — Commands

**Extract audio (what `measure()` runs, one process per audio stream `k`):**
```
ffmpeg -v error -nostdin -i "<media>" -vn -map 0:a:<k> -ac 2 -ar 48000 -f s16le -
```

**Probe (stderr is parsed; exit code 1 is normal here):**
```
ffmpeg -i "<media>"
```

**Golden data from real auto-editor** (use a build that has `--smooth`):
```
# per-frame levels, one number per line, for the sequence frame rate:
auto-editor levels "<media>" --edit audio --timebase 30000/1001
# keep ranges after threshold + margin + smoothing, as v3 JSON (clips carry source start "offset" and length "dur", in frames):
auto-editor "<media>" --edit audio:0.04 --margin 0.2s --smooth 0.2s,0.1s --export v3 -o out.v3
```
Test media recipe used in this plan's verification: a 60 s H.264+AAC file at 29.97 fps with pink-noise "speech" bursts and gaps (mono), and the same file with the audio panned to the **left channel only** (`pan=stereo|c0=c0|c1=0*c0`).

---

## Appendix C — Sidecar example (`<stem>.silence.markers.json`)

```json
{
  "format": "luckytwitch-markers",
  "version": 1,
  "name": "IlloJuan - 2026-09-21 - part1",
  "fps": 59.94,
  "duration": 34379.86,
  "part": { "start": 0, "end": 34379.86 },
  "source": {
    "tool": "luckytwitch-silence",
    "analyzer": "1",
    "params": { "threshold": 0.04, "marginBefore": 0.25, "marginAfter": 0.25, "minCut": 0.6, "minClip": 0.1 },
    "paramsHash": "9f2c41aa",
    "media": { "path": "D:/vods/IlloJuan - 2026-09-21 - part1.mp4", "size": 7340032000, "mtimeMs": 1790000000000 },
    "sequenceFps": 59.94,
    "ranges": 412
  },
  "markers": [
    { "kind": "clip", "name": "Speech 1", "start": 3.5035, "end": 41.2412, "views": 0, "comment": "" },
    { "kind": "clip", "name": "Speech 2", "start": 44.0444, "end": 58.9589, "views": 0, "comment": "" }
  ]
}
```
No `preferences` key (it would overwrite the user's pad fields, see 3.4 item 3).

---

## Appendix D — Silence settings and presets

| Setting (UI) | Field id | Default | Meaning (auto-editor name) |
|---|---|---|---|
| Preset | `silPreset` | Balanced | fills the fields below |
| Threshold | `silThreshold` | 0.04 (≈ −28 dB) | frame is loud if its peak ≥ this (`audio:0.04`) |
| Margin before | `silMarginB` | 0.25 s | speech starts this much earlier (`--margin`, start) |
| Margin after | `silMarginA` | 0.25 s | speech ends this much later (`--margin`, end) |
| Min silence to cut | `silMinCut` | 0.6 s | shorter silences stay (`mincut`) |
| Min speech to keep | `silMinClip` | 0.1 s | shorter sounds are dropped (`minclip`) |
| Max cuts | `silMaxCuts` | 1500 | refuse to start above this (section 7) |

| Preset | Threshold | Margins | Min silence | Min speech | Use for |
|---|---|---|---|---|---|
| Tight | 0.04 | 0.2 / 0.2 | 0.2 s | 0.1 s | auto-editor defaults; short clean talking-head files |
| **Balanced** | 0.04 | 0.25 / 0.25 | 0.6 s | 0.1 s | normal stream recordings |
| Chunky | 0.04 | 0.3 / 0.3 | 1.5 s | 0.2 s | long, talky VODs; fewest cuts, fastest run |

---

## Findings while implementing (added by the implementer; newest last)

1. **`ffmpeg -i` does not print a stream's own start time (affects 6.1, 6.2, R4, P0-3).** Checked with real ffmpeg 6.1.1 on a file whose audio starts 0.228 s after the video (`ffprobe` says `start_time=0.228000`): `ffmpeg -i` prints only the *container* `start: 0.000000` on the Duration line, and nothing per stream. So `parseFfmpegInfo` cannot return the `audioStart` the plan describes. It returns `containerStart` instead (the only value ffmpeg prints) and each audio stream also gets `title`. **Decision needed from the owner** (see the message that came with this change): read the per-stream start with `ffprobe` (ships next to ffmpeg in the usual builds, but is not guaranteed in LuckyDownloader's copy), or accept the offset risk and rely on P0-3 measuring it, or measure the offset another way.
2. **Phase 0 status:** P0-1 and P0-2 have code ready (manifest change + temporary Node check log; `tools/make_synthetic_markers.js`) but still need to be *run in real Premiere by the owner*. P0-3 and P0-4 need the owner's files / machine and are not done.
3. **`test/package.test.js`:** the test that pins the exact file list of `src/` was updated in P1-1 (five runtime files now), because adding `silence-core.js` would otherwise be a new failure. The other explicit lists named in 6.7 are still for P5-1.
4. **The "ms rounding never moves a cut" claim (section 3.3) holds only for frame-aligned times.** Re-checked: 0 bad frames for every whole-frame time, 1 hour at 23.976, 25, 29.97, 30, 59.94, 60 fps. But a time that is exactly half way between two frames (e.g. 430.82 s at 25 fps = frame 10770.5) can round to either neighbour. This is harmless here because `analyze()` only produces `frame / fps` values on the sequence grid (D4), and `test/silence-adapter.test.js` pins that. It would matter if a plan were ever built on a different grid than the sequence's (e.g. the P6-4 trimmed-clip idea): keep the analysis fps equal to the sequence fps.
5. **Section 7.1 totals** include `planTodo`'s fixed 4 s final-check allowance (the three columns alone sum to less for small cut counts). `silence-core.estimateRunSeconds` reproduces all six table rows with that allowance (test in `silence-core.test.js`).

---

## Phase 0/1 outcome (supersedes earlier text where they differ)

### P0-1 Node in the panel: VERIFIED on Windows, macOS still open
Panel log from the owner's real Premiere (screenshot): CEP runtime 12.0.1; host PPRO 26.5.0; `typeof require = function`; **Node 17.7.2**; `spawnSync ffmpeg -version` exit 0 (WinGet build N-125875-g5d4d3bdc61-20260731); `cep.fs.readdir` err 0 (74 entries); "Runner ready. LTCore loaded; LTGuard loaded; cep.fs available". So `--enable-nodejs --mixed-context` works and the old modules still load.
- **Consequence:** the Node side runs **Node 17.7.2**. Write `silence.js` for it: no `fetch`, no Node 18+ APIs (`Array.prototype.findLast`, `fs.glob`, `AbortSignal.any`...). The test runner here is Node 22, so a test passing is not proof the API exists in 17.
- **Open:** the same check on macOS Premiere (R8). The spike "Node check" log stays until Phase 2 replaces it.

### P0-2 Cut scaling: MEASURED (razor phase only)
Real Premiere 26.5.0 on Windows, the owner's Zentreya VOD (3130.01 s), 60 fps sequence, one clip on V1/A1, synthetic plans, every check PASS (no holes, source continuous, all cuts on planned frames, worst edge error 0.0000):

| Cuts | Razor calls | Cut phase | Whole run (incl. 2.5 s preflight) | Longest single call | Panel's old model (section 7.1) |
|---:|---:|---:|---:|---:|---:|
| 500 | 1000 | **62.1 s** | 65.4 s | 1001 ms | 103 s |
| 1000 | 2000 | **250.0 s** | 254.6 s | 1317 ms | 400 s |

- **Quadratic confirmed:** 1000 cuts took 4.03x the time of 500 (a perfect square law is 4.0x). Fit: cut phase ~ **2.5e-4 x cuts^2 seconds** (62 s at 500, 250 s at 1000; ~560 s = 9.4 min at the default budget of 1500, ~1000 s = 16.7 min at 2000, extrapolated).
- The old model (`4 + 15.7 x (cuts/199)^2`) **overestimates by about 40%** at these sizes. It is safe (too slow, never too fast) but it is not the truth. Retuning it also changes the estimates Twitch mode shows, so it is an owner decision, not done yet.
- **Delete phase measured later (500-cut timeline, second run):** 251 gaps deleted in **64.7 s** (0.258 s per gap; the panel's model says 0.165 s), whole delete run 70.7 s; the same 500 cuts took 68.8 s that run (62.1 s the first time: expect about 10% run-to-run noise). The owner decided NOT to retune the panel's estimate (speed depends on the machine); it stays as is.
- **Not measured:** the relink phase.

### P0-3 Audio start offset (ffprobe `start_time`, owner's files)
| File | video start | audio start |
|---|---:|---:|
| Twitch VOD 1 (Zentreya 2907686941) | 0 | 0.006 |
| Twitch VOD 2 (Vexoria part 1) | 0 | 0 |
| Twitch VOD 3 (Vexoria part 2) | 0 | 0 |
| Twitch VOD 4 (2919628658) | 0.016667 | 0 |
| Twitch VOD 5 (2906131741) | 0.032667 | 0 |
| OBS "How to Fish" | 0 | 0.163 (another OBS test file: 0.229) |

**Conclusion:** Twitch VODs: audio vs video differ by at most 2 frames at 60 fps (6 ms to 33 ms); **OBS recordings: the audio starts 163-229 ms late, which is as big as the margins, so a shift is required.** Decision: read starts with `ffprobe` (LuckyDownloader ships it, see P0-4); `silence-core.audioShift(videoStart, audioStart, fps)` = audioStart - videoStart, and 0 if smaller than half a frame. Verified here: `ffmpeg ... -vn -f s16le -` does NOT pad a late audio start (audio starting 0.478 s late decoded to exactly its own length), so bucket i sits at `shift + i/fps`.
**Unverified:** that Premiere's time zero is the video's first frame. For OBS files all origins agree; for the 1-2 frame Twitch cases the possible error is at most 2 frames. Add to the 10.4 checklist: run Silence on the OBS file and check the cuts land on speech, not 0.16 s early.

### P0-4 Where ffmpeg/ffprobe live (from LuckyDownloader `core/runtime.py`, `core/tools.py`)
`findFfmpeg` step (3) uses, in this order (each also for `ffprobe`; validate with `-version`):
- **Windows:** env `LUCKYDOWNLOADER_TOOLS_DIR`, env `LUCKYTWITCH_TOOLS_DIR`; `%LOCALAPPDATA%\LuckyDownloader\tools\`; legacy `%LOCALAPPDATA%\LuckyTwitch\tools\`; then PATH (`where.exe`).
- **macOS:** same two env vars; `~/Library/Application Support/LuckyDownloader/tools/`; legacy `~/Library/Application Support/LuckyTwitch/tools/`; then `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`; then PATH.
- Portable/app-bundle locations (`<APP_DIR>`, `<APP_DIR>/bin`) are LuckyDownloader's own and not known to the panel: skip them.
ffprobe is looked up in the same folder as the ffmpeg that was found first, then by the same list.

### P1-9 Golden test against real auto-editor: SKIPPED (owner decision)
Not possible here: auto-editor HEAD needs FFmpeg >= 7.1 (this machine has 6.1); release 29.3.1 has `--margin` but no `--smooth`. Owner chose to rely on the component tests in `test/silence-core.test.js` (margin, min cut / min clip smoothing, chunkify, peak accumulator, per specification). **Risk accepted:** the whole pipeline has never been compared output-for-output with real auto-editor. If Silence results ever differ from auto-editor on the same file, this is the first place to look.

### Changes in this step
`src/silence-core.js`: new `parseFfprobeStarts(csv)` and `audioShift(videoStart, audioStart, fps)`; 3 real ffprobe fixtures; 4 new tests. `parseFfmpegInfo` is unchanged and stays the source of duration, rate, channels, titles. Sections 6.1/6.2/R4 above are superseded by this: `probe()` = `ffmpeg -i` (info) + `ffprobe` (starts), and `analyze()` ranges for stream k are shifted by `audioShift(videoStart, audioStarts[k], fps)` before the per-frame max over streams is taken... **correction, recorded so Phase 2 does not copy the old text:** shift each stream's *levels* (or ranges) first, then combine; do not combine first.

---

## Phase 2 outcome (Node analyzer)

**Delivered:** `cep-panel/js/silence.js` (`findFfmpeg`, `probe`, `measure`, `candidatePaths`, all with injectable `spawn/env/platform/home/now`), `shiftLevels` and `combineMax` in `src/silence-core.js`, `mock/fake-ffmpeg.js` (a fake ffmpeg/ffprobe that is a real child process), `test/silence-run.test.js` (27 tests). `npm run check` now covers `silence.js`.
- **Not wired yet (by design):** `silence.js` is not loaded by `index.html` and not in the installers' file lists (P4-1, P5-1). Nothing in the panel calls it, so the panel behaves exactly as before. The temporary "Node check" log in `runner.js` stays until Phase 3/4 replaces it with real ffmpeg detection.
- **Shifts happen per stream, then streams are combined** (the correction recorded in "Phase 0/1 outcome"): `measure` applies `shiftLevels(levels, round(shift*fps), round(duration*fps))` to each stream and then `combineMax`. The caller passes `streams: [{index, shift}]` with `shift = audioShift(videoStart, audioStart, fps)` from `probe()`.
- **ffprobe is optional:** without it `probe()` returns `startsKnown: false` and a warning; the caller decides whether to continue with shift 0 (OBS files can then be 0.2 s off). Phase 3 must show that warning in the log.
- **Search order (as built):** chosen path, `LT_FFMPEG`, `LUCKYDOWNLOADER_TOOLS_DIR`, `LUCKYTWITCH_TOOLS_DIR`, per-OS LuckyDownloader/LuckyTwitch folders, macOS Homebrew/MacPorts folders, bare name (PATH), Windows `C:\ffmpeg\bin` + WinGet Links + Scoop shims + Chocolatey. The last three Windows entries are the usual locations but were **not verified on the owner's machine**; every candidate is validated by running `-version` (5 s limit), so a wrong guess costs nothing.
- **Bug found by the tests and fixed:** an env var that is empty or only spaces was used as a folder name; now treated as not set.
- **Real tools (sandbox, ffmpeg 6.1.1):** `findFfmpeg` found them on PATH; `probe` read an audio start of 0.478 s; `measure` decoded 600 s of audio in 1.17 s (about 7 s per hour, matching section 7's ~6 s/hour) with a flat heap (6 MB), and a 10-second on/off tone gave exactly the 60 expected speech ranges with the Balanced preset. **Not run inside Premiere/CEP** (Node 17.7.2, `--mixed-context`): the code uses only `child_process.spawn`, `Buffer`, typed arrays and timers, but that is unverified until Phase 4 loads it in the panel.
- **Fake-ffmpeg lesson:** `node --test` runs every `.js` under `test/`, so helpers live in `mock/`. The fake once truncated its own output with `process.exit`; the 90% truncation check in `measure` caught it, which is the check doing its job.
