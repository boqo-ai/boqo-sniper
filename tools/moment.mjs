#!/usr/bin/env node
// The moment in hand, for the agent: what chat said, the words, the stills.
// Not part of the vendored engine.
//
//   moment.mjs read <momentDir>
//     {"meta": {...}, "topChat": [{"text","count"}], "chatPerSec": [n, ...], "durationSec": n|null}
//     topChat     the 8 messages chat repeated most from 15 s before the peak to
//                 25 s after it, lower-cased, a word repeated in a row counted
//                 once ("LUL LUL LUL" is "lul"). The whole file when meta has no peak.
//     chatPerSec  messages a second in each 10 s of the file, from its start.
//     durationSec video.mp4's length; null once video.mp4 is deleted.
//   moment.mjs words <words.json> [--around <sec>] [--span 30]
//     {"lines": ["[1:25] He's leaving his king unprotected. (85.36-87.27)", ...]}
//     A line ends at a sentence end, a pause over 0.7 s, or after 8 s; it shows
//     its start as m:ss and its exact first and last word times in seconds.
//     --around keeps the words starting within span/2 of that second; without
//     it, every word.
//   moment.mjs frames <video.mp4> --at <sec> [--offsets "-12,-6,0,2"] --out <dir>
//     {"frames": [{"file","at","offset"}, ...]}
//     One still per offset from --at (960 wide), each time clamped into the
//     file, named by its offset: frame-m12.jpg, frame-m6.jpg, frame-0.jpg,
//     frame-2.jpg. Another call with other offsets adds its stills beside them.
//
// One JSON line on stdout (exit 0), or {"error": "..."} (exit 1).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { toolEnv } from "../engine/env.mjs";
import {
  AFTER_PEAK_SEC,
  BEFORE_PEAK_SEC,
  FRAME_OFFSETS,
  chatRates,
  durationOf,
  frameName,
  frameTimes,
  parseOffsets,
  topChat,
  wordLines,
} from "../lib/moment.mjs";

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${what} ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} ${file} is not valid JSON`);
  }
}

function parseFlags(argv, known) {
  const opt = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!known.includes(a)) throw new Error(`unknown flag ${a}`);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opt[a.slice(2)] = argv[++i];
    } else positional.push(a);
  }
  return { opt, positional };
}

function num(v, name) {
  const n = Number(v);
  if (v === undefined || String(v).trim() === "" || !Number.isFinite(n)) throw new Error(`${name} must be a number of seconds`);
  return n;
}

const USAGE =
  'usage: moment.mjs read <momentDir> | words <words.json> [--around <sec>] [--span 30] | frames <video.mp4> --at <sec> [--offsets "-12,-6,0,2"] --out <dir>';

function cmdRead(argv) {
  const { positional } = parseFlags(argv, []);
  if (positional.length !== 1) throw new Error(USAGE);
  const dir = path.resolve(positional[0]);
  const meta = readJson(path.join(dir, "meta.json"), "meta");
  const chatFile = path.join(dir, "chat.json");
  const chat = fs.existsSync(chatFile) ? readJson(chatFile, "chat") : [];
  if (!Array.isArray(chat)) throw new Error(`chat ${chatFile} is not a list`);
  const video = path.join(dir, "video.mp4");
  const durationSec = fs.existsSync(video) ? Math.round(durationOf(video) * 100) / 100 : null;
  const peak = Number.isFinite(meta.peakOffsetSec) ? meta.peakOffsetSec : null;
  const top = peak === null ? topChat(chat) : topChat(chat, peak - BEFORE_PEAK_SEC, peak + AFTER_PEAK_SEC);
  return { meta, topChat: top, chatPerSec: chatRates(chat, durationSec), durationSec };
}

function cmdWords(argv) {
  const { opt, positional } = parseFlags(argv, ["--around", "--span"]);
  if (positional.length !== 1) throw new Error(USAGE);
  const words = readJson(path.resolve(positional[0]), "words");
  if (!Array.isArray(words)) throw new Error("words file must hold an array of {w, s, e}");
  const around = opt.around === undefined ? null : num(opt.around, "--around");
  const span = opt.span === undefined ? 30 : num(opt.span, "--span");
  if (span <= 0) throw new Error("--span must be positive");
  return { lines: wordLines(words, { around, span }) };
}

function cmdFrames(argv) {
  const { opt, positional } = parseFlags(argv, ["--at", "--out", "--offsets"]);
  if (positional.length !== 1) throw new Error(USAGE);
  if (opt.out === undefined) throw new Error("--out is required");
  const at = num(opt.at, "--at");
  const offsets = opt.offsets === undefined ? FRAME_OFFSETS : parseOffsets(opt.offsets);
  const video = path.resolve(positional[0]);
  if (!fs.existsSync(video)) throw new Error(`no video at ${video}`);
  const out = path.resolve(opt.out);
  fs.mkdirSync(out, { recursive: true });
  const frames = [];
  const times = frameTimes(at, durationOf(video), offsets);
  for (const [i, t] of times.entries()) {
    const offset = offsets[i];
    const name = frameName(offset);
    fs.rmSync(path.join(out, name), { force: true });
    // cwd is the output folder and the output name is relative (no drive colon in any argument ffmpeg parses as options)
    const r = spawnSync(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "4", name],
      { cwd: out, encoding: "utf8", env: toolEnv(), windowsHide: true },
    );
    if (r.error) throw new Error(`ffmpeg could not run: ${r.error.code ?? r.error.message}`);
    const file = path.join(out, name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    if (r.status !== 0 || size === 0) {
      throw new Error(`no frame at ${t} s: ${String(r.stderr).trim().slice(-200) || `ffmpeg exited ${r.status}`}`);
    }
    frames.push({ file, at: t, offset });
  }
  return { frames };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const run = { read: cmdRead, words: cmdWords, frames: cmdFrames }[cmd];
  if (!run) fail(USAGE);
  let result;
  try {
    result = run(rest);
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

main(process.argv.slice(2));
