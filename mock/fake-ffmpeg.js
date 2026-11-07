"use strict";
// Fake ffmpeg / ffprobe for test/silence-run.test.js. Usage: node fake-ffmpeg.js <ffmpeg|ffprobe> <the arguments the real tool would get>
// The "media file" is a JSON spec the test wrote: {duration, video:{start}, audio:[{rate, channels, title, start, pattern:[{sec, amp}]}], mode}
//   pattern: consecutive stretches of the decoded audio; every sample in a stretch is +amp / -amp alternating (amp 0 = digital silence).
//   mode: "ok" (default) | "odd" (chunks of odd byte length, to split 16-bit samples) | "slow" (many small chunks, 15 ms apart) |
//         "truncate" (stops after 40% of the audio, exit 0) | "fail" (exit 1 with a message) | "garbage" (not a media file)
const fs = require("node:fs");
const tool = process.argv[2], args = process.argv.slice(3);
const out = (s) => process.stdout.write(s), errOut = (s) => process.stderr.write(s);

if (args.includes("-version")) { out(tool + " version fake-1.0 Copyright (c) the test suite\n"); process.exit(0); }

const i = args.indexOf("-i");
const specPath = tool === "ffprobe" ? args[args.length - 1] : i >= 0 ? args[i + 1] : null;
let spec = null;
try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); } catch (e) { /* not a spec: behaves like an unreadable file */ }
if (!spec || spec.mode === "garbage") { errOut(specPath + ": Invalid data found when processing input\n"); process.exit(1); }

const hms = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s - h * 3600 - m * 60; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + x.toFixed(2).padStart(5, "0"); };
const audio = spec.audio || [];

if (tool === "ffprobe") {
  if (spec.mode === "fail") { errOut("ffprobe: simulated failure\n"); process.exit(1); }
  let idx = 0;
  const lines = [];
  if (spec.video) lines.push(idx++ + ",video," + (spec.video.start || 0).toFixed(6));
  for (const a of audio) lines.push(idx++ + ",audio," + (a.start || 0).toFixed(6));
  out(lines.join("\n") + "\n");
  process.exit(0);
}

const mapArg = args.indexOf("-map") >= 0 ? args[args.indexOf("-map") + 1] : null;
if (!mapArg) {                                          // `ffmpeg -i file`: info on stderr, then the usual complaint, exit 1
  let n = 0, t = "Input #0, matroska,webm, from '" + specPath + "':\n  Duration: " + hms(spec.duration || 0) + ", start: 0.000000, bitrate: 1000 kb/s\n";
  if (spec.video) t += "  Stream #0:" + n++ + ": Video: h264, yuv420p, 1920x1080, 60 fps\n";
  audio.forEach((a) => { t += "  Stream #0:" + n++ + ": Audio: aac, " + (a.rate || 48000) + " Hz, " + ((a.channels || 2) === 1 ? "mono" : "stereo") + ", fltp\n"; if (a.title) t += "    Metadata:\n      title           : " + a.title + "\n"; });
  errOut(t + "At least one output file must be specified\n");
  process.exit(1);
}

const k = Number(/^0:a:(\d+)$/.exec(mapArg)[1]), a = audio[k];
if (!a) { errOut("Stream map '" + mapArg + "' matches no streams.\n"); process.exit(1); }
if (spec.mode === "fail") { errOut("simulated decoder failure\nsecond line\n"); process.exit(1); }

// build the PCM: stereo, 48000 Hz, 16-bit little endian
const parts = (a.pattern || []).map((p) => { const n = Math.round(p.sec * 48000), b = Buffer.alloc(n * 4); for (let s = 0; s < n; s++) { const v = s % 2 ? -p.amp : p.amp; b.writeInt16LE(v, s * 4); b.writeInt16LE(v, s * 4 + 2); } return b; });
let pcm = Buffer.concat(parts);
if (spec.mode === "truncate") pcm = pcm.subarray(0, Math.floor(pcm.length * 0.4) & ~3);

let pos = 0;
const sizes = spec.mode === "odd" ? [4097, 3, 8191, 1, 5001] : spec.mode === "slow" ? [48000] : [65536];
let si = 0;
function next() {
  if (pos >= pcm.length) { process.stdout.end(); return; }   // end(), not process.exit(): exit would drop what is still in the pipe
  const size = Math.min(sizes[si++ % sizes.length], pcm.length - pos);
  const ok = process.stdout.write(pcm.subarray(pos, pos + size));
  pos += size;
  if (spec.mode === "slow") setTimeout(next, 15); else if (ok) setImmediate(next); else process.stdout.once("drain", next);
}
next();
